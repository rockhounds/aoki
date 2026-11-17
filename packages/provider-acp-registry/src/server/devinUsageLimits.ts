import type { ServerProviderUsageWindow } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

const DEVIN_ACCOUNT_URL = "https://server.codeium.com";
const PlanStatus = Schema.Struct({
  planInfo: Schema.optionalKey(
    Schema.Struct({
      isDevin: Schema.optionalKey(Schema.Boolean),
      billingStrategy: Schema.optionalKey(Schema.String),
      hideDailyQuota: Schema.optionalKey(Schema.Boolean),
      hideWeeklyQuota: Schema.optionalKey(Schema.Boolean),
    }),
  ),
  dailyQuotaRemainingPercent: Schema.optionalKey(Schema.Finite),
  dailyQuotaResetAtUnix: Schema.optionalKey(Schema.String),
  weeklyQuotaRemainingPercent: Schema.optionalKey(Schema.Finite),
  weeklyQuotaResetAtUnix: Schema.optionalKey(Schema.String),
});
const AccountStatus = Schema.Struct({
  userStatus: Schema.Struct({
    userId: Schema.optionalKey(Schema.String),
    teamId: Schema.optionalKey(Schema.String),
    planStatus: Schema.optionalKey(PlanStatus),
  }),
});
const decodeTomlString = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.String));

export const devinDataDirectory = Effect.fn("DevinUsage.dataDirectory")(function* (
  environment: NodeJS.ProcessEnv,
) {
  const path = yield* Path.Path;
  const home = environment.HOME || environment.USERPROFILE || (yield* HostProcess.HomeDirectory);
  return path.join(environment.XDG_DATA_HOME || path.join(home, ".local", "share"), "devin");
});

export function devinQuotaWindows(
  status: typeof PlanStatus.Type,
  now: number,
): readonly ServerProviderUsageWindow[] {
  if (!status.planInfo?.isDevin) return [];
  const quotaBilling = status.planInfo.billingStrategy === "BILLING_STRATEGY_QUOTA";
  const windows: ServerProviderUsageWindow[] = [];
  for (const [id, kind, label, hidden, percent, reset, minutes] of [
    [
      "daily",
      "other",
      "Daily",
      status.planInfo.hideDailyQuota,
      status.dailyQuotaRemainingPercent,
      status.dailyQuotaResetAtUnix,
      1440,
    ],
    [
      "weekly",
      "weekly",
      "Weekly",
      status.planInfo.hideWeeklyQuota,
      status.weeklyQuotaRemainingPercent,
      status.weeklyQuotaResetAtUnix,
      10080,
    ],
  ] as const) {
    if (hidden) continue;
    const epoch = Number(reset) * 1000;
    const resetsAt = epoch > now ? DateTime.make(epoch) : undefined;
    // Connect's protobuf JSON omits scalar zeroes. A reset identifies the active quota.
    const remaining = percent ?? (quotaBilling && resetsAt?._tag === "Some" ? 0 : undefined);
    if (remaining === undefined || remaining < 0 || remaining > 100) continue;
    windows.push({
      id,
      kind,
      label,
      usedPercent: 100 - remaining,
      windowDurationMins: minutes,
      ...(resetsAt?._tag === "Some" ? { resetsAt: DateTime.formatIso(resetsAt.value) } : {}),
    });
  }
  return windows;
}

export const readDevinAccountUsage = Effect.fn("DevinUsage.readAccountUsage")(function* (
  environment: NodeJS.ProcessEnv,
  now: number,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = path.join(yield* devinDataDirectory(environment), "credentials.toml");
  const contents = yield* fs.readFileString(file).pipe(
    Effect.catchTags({
      PlatformError: (error) =>
        error.reason._tag === "NotFound" ? Effect.succeed("") : Effect.fail(error),
    }),
  );
  // Devin serializes these two root fields as TOML basic strings.
  const key = decodeTomlString(/^windsurf_api_key\s*=\s*("[^\r\n]+")\s*$/m.exec(contents)?.[1]);
  const host = decodeTomlString(/^api_server_url\s*=\s*("[^\r\n]+")\s*$/m.exec(contents)?.[1]);
  if (
    key._tag === "None" ||
    !key.value ||
    host._tag === "None" ||
    host.value.replace(/\/$/, "") !== DEVIN_ACCOUNT_URL
  )
    return undefined;

  const client = yield* HttpClient.HttpClient;
  const status = yield* client
    .execute(
      HttpClientRequest.post(
        `${DEVIN_ACCOUNT_URL}/exa.seat_management_pb.SeatManagementService/GetUserStatus`,
      ).pipe(
        HttpClientRequest.setHeader("Connect-Protocol-Version", "1"),
        HttpClientRequest.bodyJsonUnsafe({
          metadata: {
            apiKey: key.value,
            ideName: "devin",
            extensionName: "devin",
            ideVersion: "0.3.0",
            extensionVersion: "0.3.0",
            locale: "en",
          },
        }),
      ),
    )
    .pipe(
      Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap(HttpClientResponse.schemaBodyJson(AccountStatus)),
    );
  const { planStatus, teamId, userId } = status.userStatus;
  if (!planStatus) return undefined;
  return {
    windows: devinQuotaWindows(planStatus, now),
    identity: userId ? `${teamId ?? ""}\0${userId}` : key.value,
  };
});
