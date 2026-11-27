// SPDX-FileCopyrightText: 2026 Aoki contributors
// SPDX-License-Identifier: MIT
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - Offline entry point called by omnifork.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

type Catalog = Record<string, unknown>;
const equal = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

export function mergeCatalog(base: Catalog, fork: Catalog, upstream: Catalog) {
  const merged: Catalog = Object.create(null);
  for (const key of new Set([...Object.keys(upstream), ...Object.keys(fork)])) {
    const before = base[key];
    const ours = fork[key];
    const theirs = upstream[key];
    if (equal(ours, theirs) || equal(before, theirs)) {
      if (ours !== undefined) merged[key] = ours;
    } else if (equal(before, ours)) {
      if (theirs !== undefined) merged[key] = theirs;
    } else {
      return undefined;
    }
  }
  return merged;
}

export function retainProductNames(
  base: Catalog,
  fork: Catalog,
  baseEnglish: Catalog,
  forkEnglish: Catalog,
) {
  const translations = { ...fork };
  for (const [key, ours] of Object.entries(fork)) {
    const before = base[key];
    const english = forkEnglish[key];
    if (
      typeof before === "string" &&
      typeof english === "string" &&
      english === baseEnglish[key] &&
      english.includes("T3 Code") &&
      typeof ours === "string" &&
      ours.replaceAll("Aoki-Code", "T3-Code").replaceAll("Aoki", "T3 Code") === before
    ) {
      translations[key] = before;
    }
  }
  return translations;
}

export function matchesSource(catalog: Catalog, source: Catalog) {
  return (
    Object.keys(catalog).length === Object.keys(source).length &&
    Object.entries(source).every(([key, value]) => equal(catalog[key], value))
  );
}

export function mergeSourceCatalog(
  base: Catalog,
  fork: Catalog,
  upstream: Catalog,
  source: Catalog,
) {
  const merged: Catalog = Object.create(null);
  for (const key of new Set([
    ...Object.keys(upstream),
    ...Object.keys(fork),
    ...Object.keys(source),
  ])) {
    if (!Object.hasOwn(source, key)) continue;
    const before = base[key];
    const ours = fork[key];
    const theirs = upstream[key];
    if (ours === undefined || theirs === undefined || equal(ours, theirs)) {
      merged[key] = theirs ?? ours ?? source[key];
    } else if (equal(before, theirs) || equal(theirs, source[key])) {
      merged[key] = ours;
    } else if (equal(before, ours) || equal(ours, source[key])) {
      merged[key] = theirs;
    } else {
      return undefined;
    }
  }
  return merged;
}

function scanSource(gitDir: string, upstream: string, surface: string, cli: string): Catalog {
  const scratch = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "aoki-catalog-source-"));
  try {
    const app = `apps/${surface}`;
    const archive = NodeChildProcess.execFileSync(
      "git",
      [
        "--git-dir",
        gitDir,
        "archive",
        upstream,
        "package.json",
        `${app}/package.json`,
        `${app}/gt.config.json`,
        `${app}/src`,
        "packages/client-runtime/src",
        "packages/shared/src",
      ],
      { maxBuffer: 64 * 1024 * 1024 },
    );
    NodeChildProcess.execFileSync("tar", ["-x", "-C", scratch], { input: archive });
    const appDir = NodePath.join(scratch, app);
    const config = JSON.parse(NodeFS.readFileSync(NodePath.join(appDir, "gt.config.json"), "utf8"));
    const configPath = NodePath.join(scratch, "gt.config.json");
    NodeFS.writeFileSync(
      configPath,
      JSON.stringify({
        ...config,
        locales: [],
        files: { gt: { output: NodePath.join(scratch, "[locale].json") } },
      }),
    );
    NodeChildProcess.execFileSync(process.execPath, [cli, "generate", "--config", configPath], {
      cwd: appDir,
    });
    return JSON.parse(
      NodeFS.readFileSync(NodePath.join(scratch, `${config.defaultLocale}.json`), "utf8"),
    );
  } finally {
    NodeFS.rmSync(scratch, { recursive: true, force: true });
  }
}

function main([gitDir, base, fork, upstream, output, ...paths]: string[]) {
  if (!gitDir || !base || !fork || !upstream || !output)
    throw new Error("Missing catalog revisions");
  const verify =
    process.env.AOKI_VERIFY_WS ?? NodePath.join(NodeOS.homedir(), ".cache/aoki/verify-aoki");
  const read = (rev: string, path: string): Catalog =>
    JSON.parse(
      NodeChildProcess.execFileSync("git", ["--git-dir", gitDir, "show", `${rev}:${path}`], {
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
      }),
    );

  for (const surface of ["mobile", "web"]) {
    const directory = `apps/${surface}/src/i18n/translations/`;
    const files = paths.filter((path) => path.startsWith(directory));
    const cli = NodePath.join(verify, `apps/${surface}/node_modules/gt/bin/main.js`);
    const formatter = NodePath.join(verify, "node_modules/.bin/vp");
    if (files.length === 0 || !NodeFS.existsSync(cli)) continue;
    if (surface === "web" && !NodeFS.existsSync(formatter)) continue;
    const englishPath = `${directory}en.json`;
    const baseEnglish = read(base, englishPath);
    const forkEnglish = read(fork, englishPath);
    const upstreamEnglish = read(upstream, englishPath);
    const source = scanSource(gitDir, upstream, surface, cli);
    const keyed = mergeCatalog(baseEnglish, forkEnglish, upstreamEnglish);
    const english =
      keyed && matchesSource(keyed, source)
        ? keyed
        : Object.fromEntries(
            [
              ...new Set([
                ...Object.keys(upstreamEnglish),
                ...Object.keys(forkEnglish),
                ...Object.keys(source),
              ]),
            ]
              .filter((key) => Object.hasOwn(source, key))
              .map((key) => [key, source[key]]),
          );

    for (const path of files) {
      let catalog = english;
      if (path !== englishPath) {
        const before = read(base, path);
        const translated = mergeSourceCatalog(
          before,
          retainProductNames(before, read(fork, path), baseEnglish, forkEnglish),
          read(upstream, path),
          english,
        );
        if (!translated) continue;
        catalog = translated;
      }
      const target = NodePath.join(output, path);
      NodeFS.mkdirSync(NodePath.dirname(target), { recursive: true });
      const raw = JSON.stringify(catalog, null, 2) + "\n";
      const formatted =
        surface === "web"
          ? NodeChildProcess.execFileSync(formatter, ["fmt", `--stdin-filepath=${path}`], {
              cwd: verify,
              input: raw,
              encoding: "utf8",
              maxBuffer: 16 * 1024 * 1024,
            })
          : raw;
      NodeFS.writeFileSync(target, formatted);
    }
  }
}

if (process.argv[1] && import.meta.url === NodeURL.pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2));
}
