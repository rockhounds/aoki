import { DEFAULT_HOSTED_APP_URL } from "@t3tools/shared/connectAuth";
import { afterEach, expect, it, vi } from "vite-plus/test";

import assetLinks from "../web/public/.well-known/assetlinks.json";

// Keep config parsing independent of local env files and build credentials.
vi.mock("../../scripts/lib/public-config.ts", () => ({
  loadRepoEnv: () => ({
    APP_VARIANT: process.env.APP_VARIANT,
    AOKI_APPLE_TEAM_ID: process.env.AOKI_APPLE_TEAM_ID,
    AOKI_EXPO_OWNER: process.env.AOKI_EXPO_OWNER,
    AOKI_EXPO_PROJECT_ID: process.env.AOKI_EXPO_PROJECT_ID,
    T3CODE_IOS_PERSONAL_TEAM: process.env.T3CODE_IOS_PERSONAL_TEAM,
    T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID: process.env.T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID,
    T3CODE_MOBILE_UPDATES_ENABLED: process.env.T3CODE_MOBILE_UPDATES_ENABLED,
  }),
}));

afterEach(() => {
  vi.unstubAllEnvs();
});

async function loadConfig(
  variant: string | undefined,
  overrides: Record<string, string | undefined> = {},
) {
  vi.resetModules();
  vi.stubEnv("APP_VARIANT", variant);
  for (const key of [
    "AOKI_APPLE_TEAM_ID",
    "AOKI_EXPO_OWNER",
    "AOKI_EXPO_PROJECT_ID",
    "T3CODE_IOS_PERSONAL_TEAM",
    "T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID",
    "T3CODE_MOBILE_UPDATES_ENABLED",
  ]) {
    vi.stubEnv(key, overrides[key]);
  }
  return (await import("./app.config.ts")).default;
}

it.each(["prod", ""])("rejects APP_VARIANT=%j before selecting production IDs", async (value) => {
  await expect(loadConfig(value)).rejects.toThrow(
    "APP_VARIANT must be development, preview, or production.",
  );
});

it.each([
  [undefined, "io.github.rockhounds.aoki", "com.t3tools.t3code"],
  ["development", "io.github.rockhounds.aoki.dev", "com.t3tools.t3code.dev"],
  ["preview", "io.github.rockhounds.aoki.preview", "com.t3tools.t3code.preview"],
  ["production", "io.github.rockhounds.aoki", "com.t3tools.t3code"],
])("isolates the iOS build identity for APP_VARIANT=%j", async (value, iosId, androidId) => {
  const config = await loadConfig(value);
  expect(config.ios?.bundleIdentifier).toBe(iosId);
  expect(config.ios?.entitlements?.["keychain-access-groups"]).toEqual([
    `$(AppIdentifierPrefix)${iosId}`,
  ]);
  expect(config.android?.package).toBe(androidId);
  expect(config.ios?.appleTeamId).toBeUndefined();
  expect(config.owner).toBeUndefined();
  expect(config.extra?.eas.projectId).toBeUndefined();
  expect(config.updates?.enabled).toBe(false);
  expect(config.updates?.url).toBeUndefined();
  // Copied thread links open this app only while app.t3.codes lists it. Its iOS association
  // file names upstream's app IDs, so Aoki's iOS identifiers are checked for the domain only.
  const host = new URL(DEFAULT_HOSTED_APP_URL).host;
  expect(config.ios?.associatedDomains).toContain(`applinks:${host}`);
  expect(config.android?.intentFilters?.[0]?.data).toEqual([
    { scheme: "https", host, pathPrefix: "/threads/" },
  ]);
  expect(assetLinks.map((link) => link.target.package_name)).toContain(androidId);
});

it.each([
  { personalTeam: false, bundleId: "io.github.rockhounds.aoki" },
  { personalTeam: true, bundleId: "io.github.rockhounds.aoki.personal" },
])(
  "uses supplied signing and Expo settings with personalTeam=$personalTeam",
  async ({ personalTeam, bundleId }) => {
    const projectId = "11111111-2222-4333-8444-555555555555";
    const config = await loadConfig("production", {
      AOKI_APPLE_TEAM_ID: "EXAMPLE123",
      AOKI_EXPO_OWNER: "aoki-test",
      AOKI_EXPO_PROJECT_ID: projectId,
      T3CODE_IOS_PERSONAL_TEAM: personalTeam ? "1" : undefined,
      T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID: personalTeam ? bundleId : undefined,
      T3CODE_MOBILE_UPDATES_ENABLED: "0",
    });
    expect(config.ios?.bundleIdentifier).toBe(bundleId);
    expect(config.ios?.entitlements?.["keychain-access-groups"]).toEqual([
      `$(AppIdentifierPrefix)${bundleId}`,
    ]);
    expect(config.ios?.appleTeamId).toBe("EXAMPLE123");
    expect(config.owner).toBe("aoki-test");
    expect(config.extra?.eas.projectId).toBe(projectId);
    expect(config.updates?.url).toBe(`https://u.expo.dev/${projectId}`);
    expect(config.updates?.enabled).toBe(false);
    expect(config.plugins?.includes("./plugins/withoutIosPersonalTeamCapabilities.cjs")).toBe(
      personalTeam,
    );
  },
);
