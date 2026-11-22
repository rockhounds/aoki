import * as Effect from "effect/Effect";
import { Atom } from "effect/reactivity";
import * as Schema from "effect/Schema";
import { cliReleaseIndexPageUrl, newestCliReleaseVersion } from "@t3tools/shared/cliRelease";

/**
 * The newest published CLI release per channel, as GitHub's release index reports it.
 * An update offer is honest only when it names a version this feed actually publishes;
 * the client's own version proves nothing about what exists to install.
 */
export interface CliReleaseFeed {
  readonly stable?: string;
  readonly nightly?: string;
}

export const EMPTY_CLI_RELEASE_FEED: CliReleaseFeed = {};

const Release = Schema.Struct({
  tag_name: Schema.String,
  draft: Schema.optionalKey(Schema.Boolean),
});
const decodeReleases = Schema.decodeUnknownSync(Schema.Array(Release));

// The index pages newest-first, so the first match per channel is that channel's newest.
// Nightlies release far more often, so a stable release can sit several pages deep.
const MAX_RELEASE_PAGES = 10;

export class CliReleaseFeedLoadError extends Schema.TaggedError<CliReleaseFeedLoadError>()(
  "CliReleaseFeedLoadError",
  { cause: Schema.Unknown },
) {}

export async function fetchCliReleaseFeed(signal?: AbortSignal): Promise<CliReleaseFeed> {
  let stable: string | undefined;
  let nightly: string | undefined;
  for (
    let page = 1;
    page <= MAX_RELEASE_PAGES && (stable === undefined || nightly === undefined);
    page += 1
  ) {
    const response = await fetch(cliReleaseIndexPageUrl(page), {
      signal: signal ?? null,
      headers: { Accept: "application/vnd.github+json" },
    });
    if (!response.ok) {
      throw new Error(`Could not check releases (HTTP ${response.status}).`);
    }
    const releases = decodeReleases(await response.json());
    stable ??= newestCliReleaseVersion(releases, "stable");
    nightly ??= newestCliReleaseVersion(releases, "nightly");
    if (releases.length < 100) break;
  }
  return {
    ...(stable === undefined ? {} : { stable }),
    ...(nightly === undefined ? {} : { nightly }),
  };
}

/** Checked once per app session; a release appearing mid-session is offered after reload. */
export const cliReleaseFeedAtom = Atom.make(
  Effect.tryPromise({
    try: (signal) => fetchCliReleaseFeed(signal),
    catch: (cause) => new CliReleaseFeedLoadError({ cause }),
  }),
).pipe(Atom.keepAlive, Atom.withLabel("cli-release-feed"));
