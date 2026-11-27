<!-- SPDX-FileCopyrightText: 2026 Aoki contributors -->
<!-- SPDX-License-Identifier: MIT -->

# Aoki

Aoki is a reinterpretation / tracking fork of [T3 Code](https://github.com/pingdotgg/t3code).
Aoki keeps a small stack of changes on top of upstream. See [README.md](README.md)
for the upstream documentation and [AGENTS.md](AGENTS.md) for repo conventions.

## License and attribution

Upstream T3 Code retains its unchanged MIT [LICENSE](LICENSE). Aoki contributions are
MIT-licensed under [LICENSE.aoki](LICENSE.aoki). [NOTICE](NOTICE) explains attribution for
original Aoki files, modified upstream files, and third-party material. New Aoki files carry
SPDX copyright and license headers; existing upstream and third-party notices stay intact.

"T3 Code" and the T3 logo are T3 Tools' marks and are not covered by the MIT license. Aoki ships
under its own name, and may be described as "based on T3 Code", but nothing should imply
endorsement by T3 Tools.

## Version control: jj

This repo is a colocated [Jujutsu](https://jj-vcs.dev) repo. Use `jj`, not `git`, for history
operations. (`git` still works read-only, and git hooks do **not** run under jj: run `vp fmt` /
`vp lint` yourself before describing a change as done.)

| Name       | Meaning                                                           |
| ---------- | ----------------------------------------------------------------- |
| `upstream` | git remote → `https://github.com/pingdotgg/t3code.git`            |
| `trunk()`  | revset alias for `main@upstream`; immutable                       |
| `main`     | bookmark at the top of the Aoki stack                             |
| `aoki()`   | revset alias for `trunk()..main`: every Aoki change, nothing else |

The aliases and `jj sync` are repo-level jj config, which lives outside the checkout. A new clone
sets them once:

```bash
jj config set --repo 'revset-aliases."trunk()"' 'main@upstream'
jj config set --repo 'revset-aliases."aoki()"' 'trunk()..main'
jj config set --repo aliases.sync '["util", "exec", "--", "bash", "-c", "exec \"$(jj root)/scripts/aoki/sync-upstream.sh\" \"$@\"", ""]'
```

### History model

`main` is upstream's history plus a linear stack of meaningful Aoki changes, and nothing else:

```
◆ trunk()  (upstream main)
○ chore(aoki): establish licensing and attribution
○ chore(aoki): set up Aoki as a tracking fork of T3 Code
○ feat(aoki): …
○ feat(aoki): …                                             ← main
```

There are no sync commits and no merge commits. A sync re-merges each Aoki change onto the new
`trunk()` (`jj rebase`, a 3-way merge per change) and every change keeps its change id. jj records
conflicts inside the affected change instead of stopping, so a sync never ends up half-applied, and
every earlier state stays in `jj op log`.

Rules that keep it that way:

- One change = one meaningful Aoki change. Fixes to an existing Aoki change go _into_ that change
  (`jj new <rev>` … `jj squash`, or `jj absorb`), not on top of the stack.
- Conflict resolutions and sync fixes go into the change that caused them, never into a new commit.
- Keep the diff against upstream small and localized (new files under `aoki/`-named paths rather
  than edits to upstream files) so syncs rarely conflict.

### Syncing with upstream

```bash
jj sync                 # = scripts/aoki/sync-upstream.sh; run it again after every fix
jj sync --status        # in progress? what to resolve next
jj sync --abort         # jj op restore to before the sync
```

A sync fetches upstream and moves every Aoki change above it, on `main` or not, onto the new
`trunk()`. Three tools share the work:

- **jj** does the rebase, records conflicts in the change that has them, and keeps every earlier
  state in `jj op log`.
- **omnifork** does what jj won't. A change like the rename edits the same names all over the tree,
  so a plain rebase conflicts with every upstream edit near them and leaves upstream's new code on
  the old names. omnifork learns those edits from the change itself and applies them to upstream's
  new code before merging, so only real disagreements are left as conflicts. It carries the stack
  from the bottom and stops at the first change that still conflicts; the next run goes on from
  there. Old names it cannot decide are listed in `.jj/omnifork/reviews.txt`.
- **`jj sync`** adds Aoki's policy. It regenerates `pnpm-lock.yaml` when that is the only conflict,
  checks that the SwiftUI client only sends requests upstream's contracts still have, runs
  `pnpm install --frozen-lockfile && pnpm typecheck` in a separate verify workspace
  (`~/.cache/aoki/verify-aoki`), runs the local-only guard, and records the sync.

Exit code 2 means conflicts or places to review remain, 3 means verification failed. Fix the named
change in place and run `jj sync` again, or `--abort`. The
[sync-upstream skill](.agents/skills/sync-upstream/SKILL.md) has the steps around the command and
the retro that follows every sync.

Each sync appends a line to `scripts/aoki/sync-log.jsonl`: the upstream range, the top of the
stack before and after, and how many conflicted files and review places were left to a person.
`omnifork replay` reruns a logged sync in a scratch repository and scores it against the result
that was accepted, which is how a change to omnifork is judged.

omnifork is developed alongside Aoki and is not published yet. Its source is a separate jj repo,
`~/omnifork` on the maintainer's machines (`OMNIFORK_DIR` names another path), and `jj sync` builds
it with cargo on every run.

`main` is rewritten by every sync, so once Aoki has its own remote, publish with
`jj git push --bookmark main` (jj does the lease check).

## Aoki-specific files

- `AOKI.md`: this file
- `scripts/aoki/`: fork maintenance scripts and the sync log
- `.agents/skills/sync-upstream/`: how to run a sync and what to improve after it

## Versioning

The root `package.json`'s `version` is the one Aoki version. `node scripts/aoki/version.ts`
checks the server, web, desktop, and contracts packages and the SwiftUI app's
`MARKETING_VERSION`. Use `--stamp` to update those version fields.
`scripts/aoki/version.test.ts` fails CI on drift. An upstream sync does not change the version, since
the base below records it. Bump the patch when Aoki ships a fix or feature, and the minor only for a
release worth announcing.

`scripts/aoki/upstream.json` records the T3 Code base the stack is synced to; `jj sync` updates it
and squashes the record into the Aoki change that owns the file. Surfaces that show a version also
show it as "based on T3 Code <version>". The React Native app keeps upstream's own App Store
version line (`AOKI_MOBILE_VERSION`).

## Upstream services

Aoki does not contact T3 Tools' services unless you opt in:

- **Product analytics** are off. The server sends events only when `AOKI_TELEMETRY_KEY` and
  `AOKI_TELEMETRY_HOST` point at your own PostHog project. [Telemetry](docs/user/telemetry.md) describes the data and controls.
- **Releases** come from `rockhounds/aoki`: `aoki update`, server self-update, the mobile apps'
  update checks, desktop release links, and the server archive that desktop SSH environments
  install on the remote machine. `.github/workflows/release-cli.yml` builds the five CLI
  archives and publishes them for `v*.*.*` tags; the first release is v0.3.4. Upstream's
  `release.yml` stays dormant here: it queues on self-hosted runners and signing secrets the
  fork does not run.
- **The model list** refreshes from `apps/server/src/provider/model-manifest.json` on Aoki's
  `main`.
- **T3 Connect** (Clerk sign-in and the relay) exists only in builds made with T3 Connect values
  in `.env` (see `.env.example`). Copied thread links still open `app.t3.codes`.

## Naming

Aoki ships under its own identity and does not read T3 Code's: the `aoki` CLI and `@rockhounds/aoki` npm package,
`~/.aoki` (or `AOKI_HOME`), `AOKI_*` environment variables, `aoki.json` project files, the
`aoki://` URL scheme, `io.github.rockhounds.aoki` app and bundle IDs, and the `/etc/aoki`,
`Aoki`, and `Rockhounds\Aoki` managed-policy locations. Names that point at T3 Tools' services,
upstream repositories, or recorded provider transcripts stay as they are.

## Local-only work

The Garden companion lives in `apps/aoki-companion` on an unbookmarked change above the
main app. Build and publish the main app from its own changes. The companion has its own
version and can be built from the private change.

`scripts/aoki/check-local-only.sh` fails if any local-only path is reachable from a bookmark, and
`jj sync` runs it before finishing. The `local-only` workflow fails CI if a pushed tree contains
the companion directory.

Move local-only work between your machines with `git bundle` or a direct fetch by commit id
(the guard treats every jj bookmark as a push target), and push with `jj git push --bookmark main`
so nothing else travels.

## Toolchain

Upstream pins Node `26.12.1` and pnpm `12.14.0` (see `package.json`). On this machine:

```bash
export PATH=~/.local/node-v26.12.1/bin:~/.local/bin:$PATH   # node, pnpm, jj
pnpm install
pnpm dev
```

## iPhone builds

Aoki's iOS bundle identifier is `io.github.rockhounds.aoki` (with `.dev` and `.preview`
for those variants). Set `AOKI_APPLE_TEAM_ID` to your Apple signing team. For Expo
cloud builds, also set `AOKI_EXPO_OWNER` and `AOKI_EXPO_PROJECT_ID` to your own
account and project. Upstream's signing team and Expo project are not used.
Over-the-air updates stay disabled until an Aoki Expo project is configured.

For a self-contained build distributed directly to registered iPhones through
Expo, use `eas build --platform ios --profile aoki-device` from `apps/mobile`.
This profile uses ad hoc distribution and disables over-the-air updates.
The Apple team must have a paid Developer Program membership and a provisioning
profile that includes the target iPhone. For a free Personal Team, use the local
Xcode build described in [the mobile development guide](apps/mobile/README.md).

## SwiftUI app

`apps/swift-ios` is the native SwiftUI client. Upstream has not merged it into its
main branch, so Aoki imported it from the upstream branch
`t3code/rebuild-mobile-app-swift` at build 68 (`f021c92cc9`) and keeps its own
changes on top. The React Native app in `apps/mobile` is independent of the native
Xcode project. See [the native build guide](apps/swift-ios/README.md) for local
iPhone builds.
