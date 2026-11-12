#!/usr/bin/env node

// SPDX-FileCopyrightText: 2026 Aoki contributors
// SPDX-License-Identifier: MIT

// One Aoki version across every surface: the root package.json's "version" is
// the source of truth, scripts/aoki/upstream.json records the synced T3 Code
// base. Check with no flags; --stamp rewrites every surface.

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

const UpstreamRecord = Schema.Struct({
  commit: Schema.String,
  version: Schema.String,
});

const decodeJson = <S extends Schema.Top>(schema: S) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(schema));

class VersionStampError extends Schema.TaggedError<VersionStampError>()("VersionStampError", {
  message: Schema.String,
}) {}

interface Replacement {
  readonly pattern: RegExp;
  readonly value: string;
}

interface FileSurface {
  readonly relativePath: string;
  readonly replacements: ReadonlyArray<Replacement>;
  readonly extracts: ReadonlyArray<{ readonly label: string } & Replacement>;
}

const packageVersionField = /"version": "[^"]*"/g;

export const aokiVersion = Effect.fn("aokiVersion")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const repoRoot = path.join(import.meta.dirname, "..", "..");
  const stamp = process.argv.includes("--stamp");

  const rootVersion = (yield* decodeJson(Schema.Struct({ version: Schema.String }))(
    yield* fs.readFileString(path.join(repoRoot, "package.json")),
  )).version;
  const upstream = yield* decodeJson(UpstreamRecord)(
    yield* fs.readFileString(path.join(repoRoot, "scripts", "aoki", "upstream.json")),
  );
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(rootVersion)) {
    return yield* new VersionStampError({
      message: `root version "${rootVersion}" is not a release semver.`,
    });
  }

  const marketingVersionSetting = /MARKETING_VERSION = [^;]+;/g;
  const upstreamVersionSetting = /AOKI_UPSTREAM_VERSION = "[^"]*";/g;
  const projectVersionSetting = /CURRENT_PROJECT_VERSION = [^;]+;/g;

  // Apple build numbers are integers, so the one Aoki version cannot appear
  // there verbatim. Derive it instead of maintaining a second, confusing
  // counter: 0.3.5 becomes 305, 1.2.3 becomes 10203. Monotonic while major,
  // minor, and patch stay below 100.
  const [major = 0, minor = 0, patch = 0] = rootVersion.split("-")[0]!.split(".").map(Number);
  const iosBuildNumber = major * 10000 + minor * 100 + patch;

  const surfaces: ReadonlyArray<FileSurface> = [
    ...(
      [
        "apps/server/package.json",
        "apps/web/package.json",
        "apps/desktop/package.json",
        "packages/contracts/package.json",
      ] as const
    ).map((relativePath) => ({
      relativePath,
      replacements: [{ pattern: packageVersionField, value: `"version": "${rootVersion}"` }],
      extracts: [
        {
          label: "version",
          pattern: packageVersionField,
          value: `"version": "${rootVersion}"`,
        },
      ],
    })),
    {
      relativePath: "apps/swift-ios/T3Code.xcodeproj/project.pbxproj",
      replacements: [
        { pattern: marketingVersionSetting, value: `MARKETING_VERSION = ${rootVersion};` },
        { pattern: projectVersionSetting, value: `CURRENT_PROJECT_VERSION = ${iosBuildNumber};` },
        {
          pattern: upstreamVersionSetting,
          value: `AOKI_UPSTREAM_VERSION = "${upstream.version}";`,
        },
      ],
      extracts: [
        {
          label: "MARKETING_VERSION",
          pattern: marketingVersionSetting,
          value: `MARKETING_VERSION = ${rootVersion};`,
        },
        {
          label: "CURRENT_PROJECT_VERSION",
          pattern: projectVersionSetting,
          value: `CURRENT_PROJECT_VERSION = ${iosBuildNumber};`,
        },
        {
          label: "AOKI_UPSTREAM_VERSION",
          pattern: upstreamVersionSetting,
          value: `AOKI_UPSTREAM_VERSION = "${upstream.version}";`,
        },
      ],
    },
  ];

  let drift = 0;
  for (const surface of surfaces) {
    const filePath = path.join(repoRoot, surface.relativePath);
    const content = yield* fs.readFileString(filePath);
    let stamped = content;
    for (const extract of surface.extracts) {
      const actual = [...content.matchAll(extract.pattern)].map((match) => match[0]);
      const wrong = actual.filter((value) => value !== extract.value);
      if (actual.length === 0) {
        yield* Effect.log(`MISS  ${surface.relativePath}: no ${extract.label} setting`);
        drift += 1;
      } else if (wrong.length > 0) {
        yield* Effect.log(
          `DRIFT ${surface.relativePath}: ${extract.label} ${wrong.join(", ")} != ${extract.value}`,
        );
        drift += 1;
      }
    }
    if (stamp) {
      for (const replacement of surface.replacements) {
        stamped = stamped.replace(replacement.pattern, replacement.value);
      }
      if (stamped !== content) yield* fs.writeFileString(filePath, stamped);
    }
  }

  if (drift > 0 && !stamp) {
    return yield* new VersionStampError({
      message: `${drift} surfaces drift from Aoki ${rootVersion}; rerun with --stamp.`,
    });
  }
  yield* Effect.log(`Aoki ${rootVersion}, based on T3 Code ${upstream.version}`);
});

if (import.meta.main) {
  aokiVersion().pipe(
    Effect.catchTags({
      VersionStampError: Effect.fn("VersionStampError")(function* (error: VersionStampError) {
        yield* Effect.logError(error.message);
        process.exitCode = 1;
      }),
    }),
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
