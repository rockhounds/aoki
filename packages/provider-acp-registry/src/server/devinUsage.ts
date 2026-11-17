// @effect-diagnostics nodeBuiltinImport:off -- node:sqlite opens the native session database read-only.
import * as NodeSqlite from "node:sqlite";
import {
  EMPTY_TOTALS,
  tokenCount,
  type ProviderUsageReader,
  type ProviderUsageScan,
  type UsageRecord,
} from "@t3tools/provider-core/server/usage";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import type { AcpRegistrySettings } from "../settings.ts";
import { devinDataDirectory } from "./devinUsageLimits.ts";
import { acpUsageAgent } from "./usageLimits.ts";

class DevinSessionUsageReadError extends Schema.TaggedError<DevinSessionUsageReadError>()(
  "DevinSessionUsageReadError",
  { cause: Schema.Defect() },
) {}

export const readDevinSessionUsage = Effect.fn("DevinUsage.readSessionUsage")(function* (
  databasePath: string,
  windowStartMs: number,
) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.exists(databasePath).pipe(
    Effect.flatMap((exists) => {
      if (!exists) return Effect.succeed([] as readonly UsageRecord[]);
      return Effect.try({
        try: () => {
          const database = new NodeSqlite.DatabaseSync(databasePath, { readOnly: true });
          try {
            const rows = database
              .prepare(`
            SELECT session_id, created_at,
                   json_extract(chat_message, '$.metadata.request_id') AS request_id,
                   json_extract(chat_message, '$.metadata.generation_model') AS model,
                   json_extract(chat_message, '$.metadata.metrics.input_tokens') AS input,
                   json_extract(chat_message, '$.metadata.metrics.output_tokens') AS output,
                   json_extract(chat_message, '$.metadata.metrics.cache_read_tokens') AS cache_read,
                   json_extract(chat_message, '$.metadata.metrics.cache_creation_tokens') AS cache_write
            FROM message_nodes
            WHERE created_at >= ? AND json_valid(chat_message)
              AND json_extract(chat_message, '$.role') = 'assistant'
              AND json_type(chat_message, '$.metadata.metrics') = 'object'
            ORDER BY row_id DESC
          `)
              .iterate(Math.ceil(windowStartMs / 1000));
            const byRequest = new Map<string, UsageRecord>();
            for (const row of rows) {
              if (
                typeof row.request_id !== "string" ||
                !row.request_id ||
                byRequest.has(row.request_id) ||
                typeof row.session_id !== "string" ||
                typeof row.created_at !== "number" ||
                typeof row.model !== "string" ||
                !row.model.trim()
              )
                continue;
              const totals = {
                ...EMPTY_TOTALS,
                uncachedInputTokens: tokenCount(row.input),
                outputTokens: tokenCount(row.output),
                cachedInputTokens: tokenCount(row.cache_read),
                cacheCreationTokens: tokenCount(row.cache_write),
              };
              if (Object.values(totals).every((value) => value === 0)) continue;
              byRequest.set(row.request_id, {
                provider: "devin",
                timestampMs: row.created_at * 1000,
                model: row.model,
                sessionId: row.session_id,
                totals,
                reportedCostUsd: null,
                speed: "standard",
                dedupeKey: `devin:${row.request_id}`,
              });
            }
            return [...byRequest.values()];
          } finally {
            database.close();
          }
        },
        catch: (cause) => new DevinSessionUsageReadError({ cause }),
      });
    }),
  );
});

export const devinUsageReader: ProviderUsageReader<
  AcpRegistrySettings,
  FileSystem.FileSystem | Path.Path
> = {
  kind: "scan",
  provider: "devin",
  scan: Effect.fn("DevinUsage.scan")(function* ({ instances, windowStartMs }) {
    const path = yield* Path.Path;
    const homes = yield* Effect.forEach(
      instances.filter(
        (instance) =>
          instance.configured && instance.config && acpUsageAgent(instance.config) === "devin",
      ),
      (instance) => devinDataDirectory(instance.environment),
    );
    return yield* Effect.forEach(new Set(homes), (dir) => {
      const file = path.join(dir, "cli", "sessions.db");
      return readDevinSessionUsage(file, windowStartMs).pipe(
        Effect.map((records): ProviderUsageScan => ({ dir, files: [{ path: file, records }] })),
        Effect.orElseSucceed((): ProviderUsageScan => ({
          dir,
          files: null,
          message: "Could not read Devin session usage.",
        })),
      );
    });
  }),
};
