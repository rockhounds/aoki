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
jj sync                 # = scripts/aoki/sync-upstream.sh
jj sync --status        # in progress? show the stack
jj sync --continue      # after resolving conflicts / fixing verification
jj sync --abort         # jj op restore to before the sync
```

What it does: `jj git fetch --remote upstream`, then `jj rebase -b main -d 'trunk()'`. Lockfile-only
conflicts are resolved automatically by regenerating `pnpm-lock.yaml` from that change's manifests.
Then it runs `pnpm install --frozen-lockfile && pnpm typecheck` in a separate verify workspace
(`~/.cache/aoki/verify-aoki`). Exit code 2 means conflicts remain, 3 means verification failed; in
both cases fix the named change in place and `--continue`, or `--abort`.

`main` is rewritten by every sync, so once Aoki has its own remote, publish with
`jj git push --bookmark main` (jj does the lease check).

## Aoki-specific files

- `AOKI.md`: this file
- `scripts/aoki/`: fork maintenance scripts

## Toolchain

Upstream pins Node `26.12.1` and pnpm `12.14.0` (see `package.json`). On this machine:

```bash
export PATH=~/.local/node-v26.12.1/bin:~/.local/bin:$PATH   # node, pnpm, jj
pnpm install
pnpm dev
```
