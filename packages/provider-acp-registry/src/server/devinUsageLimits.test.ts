// @effect-diagnostics nodeBuiltinImport:off -- the history fixture uses Devin's native SQLite format.
import * as NodeSqlite from "node:sqlite";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { readDevinSessionUsage } from "./devinUsage.ts";
import { devinQuotaWindows } from "./devinUsageLimits.ts";

describe("Devin quota windows", () => {
  it("converts remaining quota to usage and honors the plan's hidden quotas", () => {
    const reset = "1795334400";
    const now = 1795300000000;
    expect(
      devinQuotaWindows(
        {
          dailyQuotaRemainingPercent: 100,
          dailyQuotaResetAtUnix: reset,
          weeklyQuotaResetAtUnix: reset,
          planInfo: {
            isDevin: true,
            hideDailyQuota: true,
            billingStrategy: "BILLING_STRATEGY_QUOTA",
          },
        },
        now,
      ),
    ).toEqual([
      {
        id: "weekly",
        kind: "weekly",
        label: "Weekly",
        usedPercent: 100,
        resetsAt: "2026-11-22T08:00:00.000Z",
        windowDurationMins: 10080,
      },
    ]);
    expect(
      devinQuotaWindows({ dailyQuotaRemainingPercent: 73, planInfo: { isDevin: true } }, now),
    ).toMatchObject([{ id: "daily", usedPercent: 27 }]);
    expect(devinQuotaWindows({ weeklyQuotaRemainingPercent: 30 }, now)).toEqual([]);
  });
});

it.effect("reads Devin token history once per request across native branches", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped();
    const file = path.join(dir, "sessions.db");
    const database = new NodeSqlite.DatabaseSync(file);
    try {
      database.exec(`CREATE TABLE message_nodes (
        row_id INTEGER PRIMARY KEY, session_id TEXT, created_at INTEGER, chat_message TEXT
      )`);
      const insert = database.prepare("INSERT INTO message_nodes VALUES (NULL, 'session', ?, ?)");
      for (const [createdAt, requestId, role] of [
        [10, "old", "assistant"],
        [20, "kept", "assistant"],
        [20, "kept", "assistant"],
        [20, "prompt", "user"],
      ] as const) {
        insert.run(
          createdAt,
          JSON.stringify({
            role,
            metadata: {
              request_id: requestId,
              generation_model: "devin-model",
              metrics: {
                input_tokens: 12,
                cache_read_tokens: 40,
                cache_creation_tokens: 5,
                output_tokens: 8,
              },
            },
          }),
        );
      }
    } finally {
      database.close();
    }
    expect(yield* readDevinSessionUsage(file, 15_000)).toEqual([
      {
        provider: "devin",
        model: "devin-model",
        sessionId: "session",
        timestampMs: 20_000,
        dedupeKey: "devin:kept",
        reportedCostUsd: null,
        speed: "standard",
        totals: {
          uncachedInputTokens: 12,
          cachedInputTokens: 40,
          cacheCreationTokens: 5,
          outputTokens: 8,
          reasoningTokens: 0,
        },
      },
    ]);
  }).pipe(Effect.provide(NodeServices.layer)),
);
