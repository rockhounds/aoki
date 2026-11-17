import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { commandCodeDayTotals, commandCodeUsageRecords } from "./commandCodeUsage.ts";
import {
  acpUsageAgent,
  commandCodeUsageWindows,
  decryptDroidAuthFile,
  factoryUsageWindows,
} from "./usageLimits.ts";

const now = Date.parse("2026-11-17T12:00:00.000Z");
const hour = 60 * 60 * 1000;

describe("acpUsageAgent", () => {
  it("recognizes registry, local, and renamed installs", () => {
    const settings = { agentId: "", commandPath: "", authMethodId: "" };
    assert.strictEqual(acpUsageAgent({ ...settings, agentId: "devin" }), "devin");
    assert.strictEqual(acpUsageAgent({ ...settings, commandPath: "C:\\bin\\devin.exe" }), "devin");
    assert.strictEqual(acpUsageAgent({ ...settings, agentId: "factory-droid" }), "factoryDroid");
    assert.strictEqual(
      acpUsageAgent({ ...settings, commandPath: "/home/me/.local/bin/droid" }),
      "factoryDroid",
    );
    assert.strictEqual(
      acpUsageAgent({
        ...settings,
        commandPath: "/opt/bin/node",
        authMethodId: "command-code-cli",
      }),
      "commandCode",
    );
    assert.strictEqual(acpUsageAgent({ ...settings, commandPath: "C:\\bin\\cmd" }), "commandCode");
    assert.strictEqual(acpUsageAgent({ ...settings, agentId: "gemini" }), undefined);
  });
});

describe("commandCodeUsageWindows", () => {
  it("reads rolling windows and derives monthly use from the plan's grant", () => {
    const windows = commandCodeUsageWindows({
      credits: {
        credits: { monthlyCredits: 7.5, purchasedCredits: 0, freeCredits: 0 },
        windowLimits: {
          fiveHour: { used: 1, cap: 4, resetAt: now + 2 * hour },
          weekly: { used: 3, cap: 2, resetAt: now - hour },
        },
      },
      subscription: {
        data: {
          status: "active",
          planId: "individual_go_v1",
          currentPeriodEnd: "2026-12-01T00:00:00.000Z",
        },
      },
      now,
    });
    assert.deepStrictEqual(windows, [
      {
        id: "fiveHour",
        kind: "session",
        label: "Session",
        usedPercent: 25,
        windowDurationMins: 300,
        resetsAt: "2026-11-17T14:00:00.000Z",
      },
      {
        id: "weekly",
        kind: "weekly",
        label: "Weekly",
        usedPercent: 100,
        windowDurationMins: 7 * 24 * 60,
      },
      {
        id: "monthly",
        kind: "monthly",
        label: "Monthly credits",
        usedPercent: 25,
        resetsAt: "2026-12-01T00:00:00.000Z",
      },
    ]);
  });

  it("omits the monthly window without an active known plan", () => {
    const credits = { credits: { monthlyCredits: 5 }, windowLimits: null };
    assert.deepStrictEqual(commandCodeUsageWindows({ credits, subscription: null, now }), []);
    assert.deepStrictEqual(
      commandCodeUsageWindows({
        credits,
        subscription: { data: { status: "canceled", planId: "individual-pro-v1" } },
        now,
      }),
      [],
    );
  });
});

describe("factoryUsageWindows", () => {
  it("shows standard windows and only the core windows in use", () => {
    const windows = factoryUsageWindows(
      {
        standard: {
          fiveHour: { usedPercent: 12.4, windowEnd: "2026-11-17T15:00:00.000Z" },
          weekly: { usedPercent: 40 },
          monthly: null,
        },
        core: {
          fiveHour: { usedPercent: 0 },
          weekly: { usedPercent: 5, windowEnd: "2026-11-20T00:00:00.000Z" },
        },
      },
      now,
    );
    assert.deepStrictEqual(
      windows.map(({ id, kind, label, usedPercent, resetsAt }) => ({
        id,
        kind,
        label,
        usedPercent,
        resetsAt,
      })),
      [
        {
          id: "fiveHour",
          kind: "session",
          label: "Session",
          usedPercent: 12.4,
          resetsAt: "2026-11-17T15:00:00.000Z",
        },
        { id: "weekly", kind: "weekly", label: "Weekly", usedPercent: 40, resetsAt: undefined },
        {
          id: "core-weekly",
          kind: "other",
          label: "Core weekly",
          usedPercent: 5,
          resetsAt: "2026-11-20T00:00:00.000Z",
        },
      ],
    );
  });
});

describe("decryptDroidAuthFile", () => {
  it.effect("opens Droid's iv:tag:ciphertext auth file with its key", () =>
    Effect.gen(function* () {
      const key = Buffer.alloc(32, 1).toString("base64");
      const stored = "AgICAgICAgICAgIC:91e/6wNgELniOT/0vcqWig==:fPSoKikyso6MuNOjOcngiIDB85I=";
      assert.strictEqual(yield* decryptDroidAuthFile(stored, key), '{"access_token":"t"}');
      const wrongKey = yield* Effect.flip(
        decryptDroidAuthFile(stored, Buffer.alloc(32, 3).toString("base64")),
      );
      assert.strictEqual(wrongKey._tag, "DroidCredentialError");
    }),
  );
});

describe("Command Code account history", () => {
  it("derives each day from consecutive since-totals and drops empty or old days", () => {
    const summaries = new Map([
      ["2026-11-15", { totalTokensIn: 900, totalTokensOut: 90, totalCost: 0.9 }],
      ["2026-11-16", { totalTokensIn: 600, totalTokensOut: 60, totalCost: 0.5 }],
      ["2026-11-17", { totalTokensIn: 600, totalTokensOut: 60, totalCost: 0.5 }],
    ]);
    const days = new Map(
      ["2026-11-14", "2026-11-15", "2026-11-16", "2026-11-17"].map(
        (day) => [day, commandCodeDayTotals(day, summaries)] as const,
      ),
    );
    assert.deepStrictEqual(days.get("2026-11-16"), { tokensIn: 0, tokensOut: 0, cost: 0 });
    assert.deepStrictEqual(days.get("2026-11-17"), { tokensIn: 600, tokensOut: 60, cost: 0.5 });
    const records = commandCodeUsageRecords(days, Date.parse("2026-11-15T00:00:00.000Z"));
    assert.deepStrictEqual(
      records.map((record) => ({
        at: record.timestampMs,
        input: record.totals.uncachedInputTokens,
        output: record.totals.outputTokens,
        cost: record.reportedCostUsd,
      })),
      [
        { at: Date.parse("2026-11-15T12:00:00.000Z"), input: 300, output: 30, cost: 0.9 - 0.5 },
        { at: Date.parse("2026-11-17T12:00:00.000Z"), input: 600, output: 60, cost: 0.5 },
      ],
    );
  });
});
