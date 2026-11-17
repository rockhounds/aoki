// SPDX-FileCopyrightText: 2026 Aoki contributors
// SPDX-License-Identifier: MIT

import {
  tokenCount,
  totalTokens,
  type ProviderUsageReader,
  type ProviderUsageScan,
  type UsageRecord,
} from "@t3tools/provider-core/server/usage";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import type { AcpRegistrySettings } from "../settings.ts";
import { acpUsageAgent } from "./usageLimits.ts";

const SETTINGS_SUFFIX = ".settings.json";
const decodeSettings = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      tokenUsage: Schema.optionalKey(
        Schema.NullOr(
          Schema.Struct({
            inputTokens: Schema.optionalKey(Schema.Finite),
            outputTokens: Schema.optionalKey(Schema.Finite),
            cacheCreationTokens: Schema.optionalKey(Schema.Finite),
            cacheReadTokens: Schema.optionalKey(Schema.Finite),
            thinkingTokens: Schema.optionalKey(Schema.Finite),
          }),
        ),
      ),
    }),
  ),
);

const scanSessions = Effect.fn("FactoryDroidUsage.scanSessions")(function* (
  dir: string,
  windowStartMs: number,
): Effect.fn.Return<ProviderUsageScan, never, FileSystem.FileSystem | Path.Path> {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const entries = yield* fs.readDirectory(dir, { recursive: true }).pipe(Effect.result);
  if (Result.isFailure(entries)) {
    return {
      dir,
      files: null,
      ...(entries.failure.reason._tag === "NotFound"
        ? {}
        : { message: "Could not read Factory Droid session usage." }),
    };
  }

  const reads = yield* Effect.forEach(
    entries.success.filter((name) => name.endsWith(SETTINGS_SUFFIX)),
    Effect.fnUntraced(
      function* (name) {
        const file = path.join(dir, name);
        const stat = yield* fs.stat(file);
        const timestampMs = Option.getOrUndefined(stat.mtime)?.getTime();
        if (stat.type !== "File" || timestampMs === undefined || timestampMs < windowStartMs)
          return;
        const { tokenUsage: usage } = yield* fs
          .readFileString(file)
          .pipe(Effect.flatMap(decodeSettings));
        if (usage == null) return;
        const outputTokens = tokenCount(usage.outputTokens);
        const totals = {
          uncachedInputTokens: tokenCount(usage.inputTokens),
          outputTokens,
          cacheCreationTokens: tokenCount(usage.cacheCreationTokens),
          cachedInputTokens: tokenCount(usage.cacheReadTokens),
          reasoningTokens: Math.min(outputTokens, tokenCount(usage.thinkingTokens)),
        };
        if (totalTokens(totals) === 0) return;
        const sessionId = path.basename(name, SETTINGS_SUFFIX);
        // Droid saves a session total, which can span models and dates.
        const record: UsageRecord = {
          provider: "factoryDroid",
          timestampMs,
          model: "Factory Droid",
          sessionId,
          totals,
          reportedCostUsd: null,
          speed: "standard",
          dedupeKey: `factoryDroid:${sessionId}`,
        };
        return { path: file, records: [record] };
      },
      Effect.catchTags({
        PlatformError: (error) =>
          error.reason._tag === "NotFound" ? Effect.undefined : Effect.fail(error),
      }),
      Effect.result,
    ),
    { concurrency: 16 },
  );
  return {
    dir,
    files: reads.flatMap((read) => (Result.isSuccess(read) && read.success ? [read.success] : [])),
    ...(reads.some(Result.isFailure)
      ? { status: "partial", message: "Some Factory Droid session usage could not be read." }
      : {}),
  };
});

export const factoryDroidUsageReader: ProviderUsageReader<
  AcpRegistrySettings,
  FileSystem.FileSystem | Path.Path
> = {
  kind: "scan",
  provider: "factoryDroid",
  scan: Effect.fn("FactoryDroidUsage.scan")(function* ({ instances, windowStartMs }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dirs = yield* Effect.forEach(
      instances.filter(
        ({ configured, config }) =>
          configured && config && acpUsageAgent(config) === "factoryDroid",
      ),
      Effect.fnUntraced(function* ({ environment }) {
        const home =
          environment.HOME || environment.USERPROFILE || (yield* HostProcess.HomeDirectory);
        const dir = path.join(
          environment.FACTORY_DIR?.trim() || path.join(home, ".factory"),
          "sessions",
        );
        return yield* fs.realPath(dir).pipe(Effect.orElseSucceed(() => dir));
      }),
    );
    return yield* Effect.forEach(new Set(dirs), (dir) => scanSessions(dir, windowStartMs));
  }),
};
