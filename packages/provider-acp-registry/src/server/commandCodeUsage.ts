import type {
  UsageRecord,
  ProviderUsageReader,
  ProviderUsageScan,
} from "@t3tools/provider-core/server/usage";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { AcpRegistrySettings } from "../settings.ts";
import {
  acpUsageAgent,
  fingerprintCredential,
  getUsageJson,
  readCommandCodeCredential,
  type AcpRegistryUsageEnv,
} from "./usageLimits.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
// Today's and yesterday's totals still move; re-read them at most this often.
const OPEN_DAY_TTL_MS = 5 * 60 * 1000;
const READ_ERROR = "Command Code account usage could not be read.";

const UsageSummary = Schema.Struct({
  totalTokensIn: Schema.optionalKey(Schema.NullOr(Schema.Finite)),
  totalTokensOut: Schema.optionalKey(Schema.NullOr(Schema.Finite)),
  totalCost: Schema.optionalKey(Schema.NullOr(Schema.Finite)),
});
type UsageSummary = typeof UsageSummary.Type;

interface DayTotals {
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly cost: number;
}

interface AccountCache {
  readonly days: Map<string, DayTotals>;
  openDaysReadAtMs: number;
  failure: { readonly atMs: number } | null;
}

const isoDay = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms)).slice(0, 10);
const dayStartMs = (day: string) => Date.parse(`${day}T00:00:00.000Z`);
const count = (value: number | null | undefined) => Math.max(0, Math.round(value ?? 0));

/** The API only totals usage since an instant, so day D is summary(D) minus summary(D + 1). */
export function commandCodeDayTotals(
  day: string,
  summaries: ReadonlyMap<string, UsageSummary>,
): DayTotals {
  const from = summaries.get(day) ?? {};
  const after = summaries.get(isoDay(dayStartMs(day) + DAY_MS)) ?? {};
  return {
    tokensIn: count((from.totalTokensIn ?? 0) - (after.totalTokensIn ?? 0)),
    tokensOut: count((from.totalTokensOut ?? 0) - (after.totalTokensOut ?? 0)),
    cost: Math.max(0, (from.totalCost ?? 0) - (after.totalCost ?? 0)),
  };
}

export function commandCodeUsageRecords(
  days: ReadonlyMap<string, DayTotals>,
  sinceMs: number,
): ReadonlyArray<UsageRecord> {
  const records: UsageRecord[] = [];
  for (const [day, totals] of days) {
    if (dayStartMs(day) + DAY_MS <= sinceMs) continue;
    if (totals.tokensIn + totals.tokensOut === 0 && totals.cost === 0) continue;
    records.push({
      provider: "commandCode",
      // Account totals are per UTC day; midday keeps them on that date in most time zones.
      timestampMs: dayStartMs(day) + DAY_MS / 2,
      model: "Command Code",
      sessionId: "",
      totals: {
        uncachedInputTokens: totals.tokensIn,
        cachedInputTokens: 0,
        cacheCreationTokens: 0,
        outputTokens: totals.tokensOut,
        reasoningTokens: 0,
      },
      reportedCostUsd: totals.cost > 0 ? totals.cost : null,
      speed: "standard",
      dedupeKey: JSON.stringify(["commandCode-account", day]),
    });
  }
  return records.sort((left, right) => left.timestampMs - right.timestampMs);
}

const accounts = new Map<string, AccountCache>();
const refreshes = new Map<string, Deferred.Deferred<void>>();

const refreshAccount = Effect.fn("CommandCodeUsage.refreshAccount")(function* (
  credential: { readonly apiKey: string; readonly baseUrl: string },
  cache: AccountCache,
  retentionStartMs: number,
) {
  const nowMs = yield* Clock.currentTimeMillis;
  const today = isoDay(nowMs);
  const openFrom = isoDay(nowMs - DAY_MS);
  const refreshOpenDays = nowMs - cache.openDaysReadAtMs >= OPEN_DAY_TTL_MS;
  const wanted: string[] = [];
  for (let at = dayStartMs(isoDay(retentionStartMs)); at <= nowMs; at += DAY_MS) {
    const day = isoDay(at);
    if (!cache.days.has(day) || (day >= openFrom && refreshOpenDays)) wanted.push(day);
  }
  for (const day of cache.days.keys()) {
    if (dayStartMs(day) + DAY_MS <= retentionStartMs) cache.days.delete(day);
  }
  if (wanted.length === 0) return;
  const bounds = [
    ...new Set(wanted.flatMap((day) => [day, isoDay(dayStartMs(day) + DAY_MS)])),
  ].filter((day) => day <= today);
  const summaries = new Map(
    yield* Effect.forEach(
      bounds,
      (day) =>
        getUsageJson(
          `${credential.baseUrl}/alpha/usage/summary?since=${day}T00:00:00.000Z`,
          credential.apiKey,
          UsageSummary,
        ).pipe(Effect.map((summary) => [day, summary] as const)),
      { concurrency: 8 },
    ),
  );
  for (const day of wanted) cache.days.set(day, commandCodeDayTotals(day, summaries));
  if (wanted.includes(today)) cache.openDaysReadAtMs = nowMs;
});

const startRefresh = (
  key: string,
  credential: { readonly apiKey: string; readonly baseUrl: string },
  cache: AccountCache,
  retentionStartMs: number,
) =>
  // Enroll and fork atomically so interruption cannot strand a registered refresh.
  Effect.uninterruptible(
    Effect.gen(function* () {
      const current = refreshes.get(key);
      if (current !== undefined) return current;
      const done = Deferred.makeUnsafe<void>();
      refreshes.set(key, done);
      // Detached: a departing client must not cancel a read later scans reuse.
      yield* refreshAccount(credential, cache, retentionStartMs).pipe(
        Effect.matchEffect({
          onFailure: () =>
            Clock.currentTimeMillis.pipe(Effect.map((atMs) => (cache.failure = { atMs }))),
          onSuccess: () => Effect.sync(() => (cache.failure = null)),
        }),
        Effect.ensuring(
          Effect.suspend(() => {
            refreshes.delete(key);
            return Deferred.succeed(done, undefined);
          }),
        ),
        Effect.forkDetach,
      );
      return done;
    }),
  );

function needsRefresh(cache: AccountCache, nowMs: number, retentionStartMs: number): boolean {
  if (cache.failure && nowMs - cache.failure.atMs < OPEN_DAY_TTL_MS) return false;
  if (nowMs - cache.openDaysReadAtMs >= OPEN_DAY_TTL_MS) return true;
  for (let at = dayStartMs(isoDay(retentionStartMs)); at <= nowMs; at += DAY_MS) {
    if (!cache.days.has(isoDay(at))) return true;
  }
  return false;
}

/** Account-wide history covers every machine, so its fixed source identity dedupes environments. */
export const commandCodeUsageReader: ProviderUsageReader<AcpRegistrySettings, AcpRegistryUsageEnv> =
  {
    kind: "scan",
    provider: "commandCode",
    scan: Effect.fn("CommandCodeUsage.scan")(function* ({
      instances,
      windowStartMs,
      retentionCutoffMs,
      awaitRefresh,
    }) {
      const credentials = yield* Effect.forEach(
        instances.filter(
          (instance) =>
            instance.configured &&
            instance.config !== undefined &&
            acpUsageAgent(instance.config) === "commandCode",
        ),
        (instance) =>
          readCommandCodeCredential(instance.environment).pipe(
            Effect.orElseSucceed(() => undefined),
          ),
      );
      const unique = new Map(
        credentials.flatMap((credential) =>
          credential ? [[`${credential.baseUrl}\0${credential.apiKey}`, credential] as const] : [],
        ),
      );
      const nowMs = yield* Clock.currentTimeMillis;
      return yield* Effect.forEach(
        unique.values(),
        Effect.fnUntraced(function* (credential) {
          const key = yield* fingerprintCredential(
            `command-code\0${credential.baseUrl}\0${credential.apiKey}`,
          );
          let cache = accounts.get(key);
          if (!cache) {
            cache = { days: new Map(), openDaysReadAtMs: 0, failure: null };
            accounts.set(key, cache);
          }
          let refreshing = false;
          if (needsRefresh(cache, nowMs, retentionCutoffMs)) {
            const refresh = yield* startRefresh(key, credential, cache, retentionCutoffMs);
            if (awaitRefresh) yield* Deferred.await(refresh);
            else refreshing = true;
          }
          const source = `commandcode-account:${key}`;
          if (cache.days.size === 0) {
            return {
              dir: source,
              ...(refreshing
                ? { files: [], refreshing: true }
                : { files: null, message: READ_ERROR }),
            } satisfies ProviderUsageScan;
          }
          return {
            dir: source,
            hostId: "commandcode.ai",
            volumeId: key,
            files: [{ path: source, records: commandCodeUsageRecords(cache.days, windowStartMs) }],
            ...(cache.failure && !refreshing
              ? { status: "partial", message: READ_ERROR }
              : { status: "ok" }),
            ...(refreshing ? { refreshing: true } : {}),
          } satisfies ProviderUsageScan;
        }),
      );
    }),
  };
