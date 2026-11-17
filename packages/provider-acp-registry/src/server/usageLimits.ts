import type { ServerProviderUsageLimits, ServerProviderUsageWindow } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  clampPercent,
  makeUnavailableUsageLimits,
  makeUsageLimits,
} from "@t3tools/provider-core/server/usageLimits";
import * as Digest from "effect/crypto/Digest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import type { AcpRegistrySettings } from "../settings.ts";

export type AcpUsageAgent = "commandCode" | "factoryDroid";

export function acpUsageAgent(
  settings: Pick<AcpRegistrySettings, "agentId" | "commandPath" | "authMethodId">,
): AcpUsageAgent | undefined {
  const executable = settings.commandPath.split(/[\\/]/).pop() ?? "";
  if (settings.agentId === "factory-droid" || executable === "droid") return "factoryDroid";
  if (
    settings.agentId === "command-code" ||
    settings.authMethodId === "command-code-cli" ||
    executable === "cmd" ||
    executable === "cmdc"
  ) {
    return "commandCode";
  }
  return undefined;
}

export const fingerprintCredential = Effect.fn("AcpRegistryUsage.fingerprint")(function* (
  value: string,
) {
  const digest = yield* Digest.Digest;
  return yield* digest
    .digest(Digest.sha256, new TextEncoder().encode(value))
    .pipe(Effect.map(Hex.encode), Effect.orDie);
});

const homeDirectory = Effect.fn("AcpRegistryUsage.homeDirectory")(function* (
  environment: NodeJS.ProcessEnv,
) {
  return environment.HOME || environment.USERPROFILE || (yield* HostProcess.HomeDirectory);
});

const readOptionalFile = (path: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) => fs.readFileString(path)).pipe(
    Effect.catchTags({
      PlatformError: (error) =>
        error.reason._tag === "NotFound" ? Effect.undefined : Effect.fail(error),
    }),
  );

export const getUsageJson = <S extends Schema.Top>(url: string, token: string, schema: S) =>
  Effect.flatMap(HttpClient.HttpClient, (client) =>
    client.execute(HttpClientRequest.get(url).pipe(HttpClientRequest.bearerToken(token))),
  ).pipe(
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap(HttpClientResponse.schemaBodyJson(schema)),
  );

function futureIso(value: number | string | null | undefined, now: number): string | undefined {
  const at = typeof value === "number" ? value : Date.parse(value ?? "");
  return Number.isFinite(at) && at > now ? DateTime.formatIso(DateTime.makeUnsafe(at)) : undefined;
}

// Command Code

const CommandCodeAuth = Schema.Struct({
  apiKey: Schema.optionalKey(Schema.String),
  userName: Schema.optionalKey(Schema.String),
});
const decodeCommandCodeAuth = Schema.decodeEffect(Schema.fromJsonString(CommandCodeAuth));

const COMMAND_CODE_API_URL = "https://api.commandcode.ai";

/** The key `cmd` stores after sign-in, or `COMMAND_CODE_API_KEY`. */
export const readCommandCodeCredential = Effect.fn("AcpRegistryUsage.readCommandCodeCredential")(
  function* (environment: NodeJS.ProcessEnv) {
    const path = yield* Path.Path;
    const contents = yield* readOptionalFile(
      path.join(yield* homeDirectory(environment), ".commandcode", "auth.json"),
    );
    const auth = contents === undefined ? {} : yield* decodeCommandCodeAuth(contents);
    const apiKey = environment.COMMAND_CODE_API_KEY?.trim() || auth.apiKey?.trim();
    return apiKey
      ? {
          apiKey,
          baseUrl: environment.COMMANDCODE_API_URL?.trim() || COMMAND_CODE_API_URL,
          ...(auth.userName ? { userName: auth.userName } : {}),
        }
      : undefined;
  },
);

const CommandCodeWhoami = Schema.Struct({
  user: Schema.optionalKey(
    Schema.NullOr(Schema.Struct({ userName: Schema.optionalKey(Schema.NullOr(Schema.String)) })),
  ),
  org: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        id: Schema.String,
        login: Schema.optionalKey(Schema.NullOr(Schema.String)),
      }),
    ),
  ),
});
const CommandCodeWindow = Schema.Struct({
  used: Schema.Finite,
  cap: Schema.Finite,
  resetAt: Schema.optionalKey(Schema.NullOr(Schema.Finite)),
});
const CommandCodeCredits = Schema.Struct({
  credits: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        monthlyCredits: Schema.optionalKey(Schema.NullOr(Schema.Finite)),
        purchasedCredits: Schema.optionalKey(Schema.NullOr(Schema.Finite)),
        freeCredits: Schema.optionalKey(Schema.NullOr(Schema.Finite)),
      }),
    ),
  ),
  windowLimits: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        fiveHour: Schema.optionalKey(Schema.NullOr(CommandCodeWindow)),
        weekly: Schema.optionalKey(Schema.NullOr(CommandCodeWindow)),
      }),
    ),
  ),
});
const CommandCodeSubscription = Schema.Struct({
  data: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        status: Schema.optionalKey(Schema.NullOr(Schema.String)),
        planId: Schema.optionalKey(Schema.NullOr(Schema.String)),
        currentPeriodEnd: Schema.optionalKey(Schema.NullOr(Schema.String)),
      }),
    ),
  ),
});

// Monthly credits each plan grants; the API reports only what is left, as `cmd`'s /usage does.
const COMMAND_CODE_PLAN_CREDITS: ReadonlyArray<readonly [string, number]> = [
  ["individual-provider", 15],
  ["individual-go-v1", 10],
  ["individual-pro-v1", 80],
  ["individual-goat", 70],
  ["individual-ultra", 300],
  ["individual-max", 150],
  ["individual-pro", 30],
  ["individual-go", 10],
  ["teams-pro", 40],
];

export function commandCodeUsageWindows(input: {
  readonly credits: typeof CommandCodeCredits.Type;
  readonly subscription: typeof CommandCodeSubscription.Type | null;
  readonly now: number;
}): ReadonlyArray<ServerProviderUsageWindow> {
  const windows: ServerProviderUsageWindow[] = [];
  const limits = input.credits.windowLimits;
  for (const [id, kind, label, windowDurationMins] of [
    ["fiveHour", "session", "Session", 5 * 60],
    ["weekly", "weekly", "Weekly", 7 * 24 * 60],
  ] as const) {
    const window = limits?.[id];
    if (!window || window.cap <= 0) continue;
    const resetsAt = futureIso(window.resetAt, input.now);
    windows.push({
      id,
      kind,
      label,
      usedPercent: clampPercent((window.used / window.cap) * 100),
      windowDurationMins,
      ...(resetsAt ? { resetsAt } : {}),
    });
  }
  const subscription = input.subscription?.data;
  const planId = (subscription?.planId ?? "").toLowerCase().replaceAll("_", "-");
  const plan = COMMAND_CODE_PLAN_CREDITS.find(([prefix]) => planId.startsWith(prefix));
  if (subscription?.status === "active" && plan) {
    const credits = input.credits.credits;
    const monthly = Math.max(0, credits?.monthlyCredits ?? 0);
    const extra =
      Math.max(0, credits?.purchasedCredits ?? 0) + Math.max(0, credits?.freeCredits ?? 0);
    const pool = Math.max(plan[1], monthly) + extra;
    const resetsAt = futureIso(subscription.currentPeriodEnd, input.now);
    windows.push({
      id: "monthly",
      kind: "monthly",
      label: "Monthly credits",
      usedPercent: clampPercent(((pool - monthly - extra) / pool) * 100),
      ...(resetsAt ? { resetsAt } : {}),
    });
  }
  return windows;
}

const readCommandCodeUsageLimits = Effect.fn("AcpRegistryUsage.readCommandCodeUsageLimits")(
  function* (environment: NodeJS.ProcessEnv, checkedAt: string) {
    const credential = yield* readCommandCodeCredential(environment);
    if (!credential) return undefined;
    const { apiKey, baseUrl } = credential;
    const whoami = yield* getUsageJson(
      `${baseUrl}/alpha/whoami?limits=1`,
      apiKey,
      CommandCodeWhoami,
    );
    const orgQuery = whoami.org?.id ? `?orgId=${encodeURIComponent(whoami.org.id)}` : "";
    const [credits, subscription] = yield* Effect.all(
      [
        getUsageJson(`${baseUrl}/alpha/billing/credits${orgQuery}`, apiKey, CommandCodeCredits),
        getUsageJson(
          `${baseUrl}/alpha/billing/subscriptions${orgQuery}`,
          apiKey,
          CommandCodeSubscription,
        ).pipe(Effect.orElseSucceed(() => null)),
      ],
      { concurrency: "unbounded" },
    );
    const login = whoami.org?.login ?? whoami.user?.userName ?? credential.userName;
    return {
      ...makeUsageLimits({
        checkedAt,
        windows: commandCodeUsageWindows({ credits, subscription, now: Date.parse(checkedAt) }),
      }),
      credentialFingerprint: yield* fingerprintCredential(`command-code\0${apiKey}`),
      ...(login
        ? {
            externalUsage: {
              label: "Command Code usage",
              url: `https://commandcode.ai/${encodeURIComponent(login)}/settings/usage`,
            },
          }
        : {}),
    } satisfies ServerProviderUsageLimits;
  },
);

// Factory Droid

const DroidStoredAuth = Schema.Struct({ access_token: Schema.optionalKey(Schema.String) });
const decodeDroidStoredAuth = Schema.decodeEffect(Schema.fromJsonString(DroidStoredAuth));
const DroidTokenClaims = Schema.Struct({
  exp: Schema.optionalKey(Schema.Finite),
  sub: Schema.optionalKey(Schema.String),
  email: Schema.optionalKey(Schema.String),
});
const decodeDroidTokenClaims = Schema.decodeUnknownOption(Schema.fromJsonString(DroidTokenClaims));

class DroidCredentialError extends Schema.TaggedError<DroidCredentialError>()(
  "DroidCredentialError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not decrypt Droid's stored sign-in.";
  }
}

const decodeBase64 = (value: string) => Uint8Array.from(Buffer.from(value, "base64"));

/** Droid keeps `iv:tag:ciphertext` (AES-256-GCM, base64) in auth.v2.file and the key beside it. */
export const decryptDroidAuthFile = (stored: string, key: string) =>
  Effect.tryPromise({
    try: async () => {
      const [iv, tag, data] = stored.trim().split(":").map(decodeBase64);
      if (!iv || !tag || !data) throw new Error("Unexpected auth file format.");
      const cryptoKey = await globalThis.crypto.subtle.importKey(
        "raw",
        decodeBase64(key.trim()),
        "AES-GCM",
        false,
        ["decrypt"],
      );
      const sealed = new Uint8Array(data.length + tag.length);
      sealed.set(data);
      sealed.set(tag, data.length);
      const plain = await globalThis.crypto.subtle.decrypt(
        { name: "AES-GCM", iv, tagLength: tag.length * 8 },
        cryptoKey,
        sealed,
      );
      return new TextDecoder().decode(plain);
    },
    catch: (cause) => new DroidCredentialError({ cause }),
  });

const FactoryWindow = Schema.Struct({
  usedPercent: Schema.Finite,
  windowEnd: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
const FactoryTier = Schema.Struct({
  fiveHour: Schema.optionalKey(Schema.NullOr(FactoryWindow)),
  weekly: Schema.optionalKey(Schema.NullOr(FactoryWindow)),
  monthly: Schema.optionalKey(Schema.NullOr(FactoryWindow)),
});
const FactoryLimits = Schema.Struct({
  hasActiveSubscription: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
  limits: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        standard: Schema.optionalKey(Schema.NullOr(FactoryTier)),
        core: Schema.optionalKey(Schema.NullOr(FactoryTier)),
      }),
    ),
  ),
});

const FACTORY_USAGE_URL = "https://app.factory.ai/settings/usage";

/** Core windows only show while that tier is in use. */
export function factoryUsageWindows(
  limits: NonNullable<(typeof FactoryLimits.Type)["limits"]>,
  now: number,
): ReadonlyArray<ServerProviderUsageWindow> {
  const windows: ServerProviderUsageWindow[] = [];
  for (const tier of ["standard", "core"] as const) {
    for (const [id, kind, label, windowDurationMins] of [
      ["fiveHour", "session", "Session", 5 * 60],
      ["weekly", "weekly", "Weekly", 7 * 24 * 60],
      ["monthly", "monthly", "Monthly", undefined],
    ] as const) {
      const window = limits[tier]?.[id];
      if (!window || (tier === "core" && !(window.usedPercent > 0))) continue;
      const resetsAt = futureIso(window.windowEnd, now);
      windows.push({
        id: tier === "core" ? `core-${id}` : id,
        kind: tier === "core" ? "other" : kind,
        label: tier === "core" ? `Core ${label.toLowerCase()}` : label,
        usedPercent: clampPercent(window.usedPercent),
        ...(windowDurationMins ? { windowDurationMins } : {}),
        ...(resetsAt ? { resetsAt } : {}),
      });
    }
  }
  return windows;
}

// Only reads Droid's token: refreshing it here could rotate Droid's refresh token and sign it out.
const readFactoryUsageLimits = Effect.fn("AcpRegistryUsage.readFactoryUsageLimits")(function* (
  environment: NodeJS.ProcessEnv,
  checkedAt: string,
) {
  let token = environment.FACTORY_API_KEY?.trim();
  if (!token) {
    const path = yield* Path.Path;
    const dir = path.join(yield* homeDirectory(environment), ".factory");
    const stored = yield* readOptionalFile(path.join(dir, "auth.v2.file"));
    const key = yield* readOptionalFile(path.join(dir, "auth.v2.key"));
    if (stored === undefined || key === undefined) return undefined;
    token = (yield* decodeDroidStoredAuth(yield* decryptDroidAuthFile(stored, key))).access_token;
    if (!token) return undefined;
  }
  const claims = decodeDroidTokenClaims(
    Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"),
  );
  const exp = claims._tag === "Some" ? claims.value.exp : undefined;
  if (exp !== undefined && exp * 1000 <= Date.parse(checkedAt)) {
    return makeUnavailableUsageLimits({
      checkedAt,
      reason: "probeFailed",
      message: "Droid's sign-in has expired. It renews the next time Droid runs.",
    });
  }
  const body = yield* getUsageJson(
    "https://api.factory.ai/api/billing/limits",
    token,
    FactoryLimits,
  );
  if (!body.limits?.standard) {
    return makeUnavailableUsageLimits({
      checkedAt,
      reason: "probeFailed",
      message:
        body.hasActiveSubscription === false
          ? "No active Factory subscription."
          : "Factory reported no usage limits.",
    });
  }
  const account = claims._tag === "Some" ? (claims.value.sub ?? claims.value.email) : undefined;
  return {
    ...makeUsageLimits({
      checkedAt,
      windows: factoryUsageWindows(body.limits, Date.parse(checkedAt)),
    }),
    credentialFingerprint: yield* fingerprintCredential(`factory-droid\0${account ?? token}`),
    externalUsage: { label: "Factory usage", url: FACTORY_USAGE_URL },
  } satisfies ServerProviderUsageLimits;
});

const AGENT_LABEL: Record<AcpUsageAgent, string> = {
  commandCode: "Command Code",
  factoryDroid: "Factory",
};

/** Undefined when the agent has no stored sign-in to read usage with. */
export const readAcpRegistryUsageLimits = Effect.fn("AcpRegistryUsage.readUsageLimits")(function* (
  agent: AcpUsageAgent,
  environment: NodeJS.ProcessEnv,
) {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const read =
    agent === "commandCode"
      ? readCommandCodeUsageLimits(environment, checkedAt)
      : readFactoryUsageLimits(environment, checkedAt);
  return yield* read.pipe(
    Effect.timeout("10 seconds"),
    Effect.tapCause((cause) => Effect.logDebug("ACP usage limits read failed", { agent, cause })),
    Effect.orElseSucceed(() =>
      makeUnavailableUsageLimits({
        checkedAt,
        reason: "probeFailed",
        message: `${AGENT_LABEL[agent]} could not read usage limits.`,
      }),
    ),
  );
});

export type AcpRegistryUsageEnv =
  | FileSystem.FileSystem
  | Path.Path
  | HttpClient.HttpClient
  | Digest.Digest;
