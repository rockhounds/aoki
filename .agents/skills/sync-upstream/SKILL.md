---
name: sync-upstream
description: Bring Aoki up to date with upstream T3 Code. Runs `jj sync`, which uses omnifork to carry Aoki's changes, then resolves what is left, verifies, records the sync, and improves the tooling. Use when asked to sync, update, rebase onto, or catch up with upstream or T3 Code, to say how far behind Aoki is, or to work on omnifork.
---

<!-- SPDX-FileCopyrightText: 2026 Aoki contributors -->
<!-- SPDX-License-Identifier: MIT -->

# Sync Aoki with upstream T3 Code

`jj sync` is the only way to sync. It runs `scripts/aoki/sync-upstream.sh`. [AOKI.md](../../../AOKI.md)
describes the history model it keeps.

| Tool      | Owns                                                                                                                                                                                                                 |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| jj        | The history: one rebase of every Aoki change, conflicts recorded in the change that has them, undo through the operation log.                                                                                        |
| omnifork  | What jj won't do. It learns each change's sweeping edits (the rename, the rebrand) from the change itself and applies them to upstream's new code, so they arrive done instead of as conflicts and missed old names. |
| `jj sync` | Aoki policy around the two: the local-only guard, the lockfile, verification, the synced base, the sync log.                                                                                                         |

omnifork is ours. Its source is the jj repo at `~/omnifork` (`OMNIFORK_DIR`), `jj sync` builds it on
every run, and it is meant to get better with every sync. Do not rebase the stack by hand, call
`omnifork sync` yourself (it skips Aoki's checks and records), or write a one-off script to merge
conflicts. When the same kind of conflict shows up many times, that is a gap in omnifork: fix
omnifork, then run `jj sync` again.

## Before

1. `jj sync --status`. Carry on with a sync in progress; do not start over.
2. Look at the stack with `jj log -r 'main@upstream..@'`. Everything above upstream moves, landed
   on `main` or not, and so does uncommitted work in `@`. Say what is there before you start. Other
   workspaces go stale and recover with `jj workspace update-stale`.
3. To report how far behind Aoki is without syncing, run `jj git fetch --remote upstream` and count
   `jj log -r 'heads(::@ & ::main@upstream)..main@upstream'`. The fetch only moves `main@upstream`.

## Run

Run `jj sync` and act on its exit code. Run it again after every fix, from wherever `@` is.

**2, conflicts.** Only the lowest conflicted change is listed, because every change above it
inherits its conflicts and waits to be carried.

- `jj new <change>`, fix the files, `jj squash`, `jj sync`.
- The resolution is upstream's new content with the Aoki change's intent applied. Upstream deleted
  the file: delete it. Upstream moved the text: apply the change where it went. Upstream rewrote
  the line so the old name is gone: take upstream's line.
- Never resolve in a change above the lowest one, and never in a new change.

**2, places to review.** `.jj/omnifork/reviews.txt` lists upstream lines that still use an old name
omnifork had no rule for. It left upstream's text. Decide each: where Aoki's name belongs, put it in
the change named there the same way. The list is reported once, so the next `jj sync` goes on.

**3, verification.** The SwiftUI request check or `pnpm typecheck` failed at the top of the stack.
Fix it in the change responsible. A request upstream removed from the contracts needs the SwiftUI
client moved off it, in a `fix(swift-ios)` change of its own if no Aoki change owns that code.

## Before calling it done

1. `vp run check:changed` at the top of the stack. After a sync its failures are mostly old names
   in upstream's new tests, fixtures, and environment variables. Fix each in the change that owns
   the name.
2. Leave the version alone. A sync records its T3 Code base in `upstream.json`; it is not a release
   ([AOKI.md](../../../AOKI.md#versioning)).
3. Report the new base and this sync's line in `scripts/aoki/sync-log.jsonl`, and say what is
   unpushed. Moving `main` and pushing are the maintainer's call.
4. Remove what you created: scratch files, workspaces, build output.

## Retro

Every sync ends with one. This is how the next sync gets cheaper.

1. Replay the sync with the values from its line in `scripts/aoki/sync-log.jsonl`:
   `omnifork replay --fork <fork_before> --onto <to> --expect <fork_after>`. It reruns the sync in
   a scratch repository, resolves conflicts the way you did, and prints the conflicted files left
   to a person, the places listed for review, and the files where its result differs from the one
   you accepted. Those ids only resolve in the checkout that ran the sync.
2. Put every conflict you resolved, review place you fixed, and failure from verification or
   `check:changed` in one of these, and do it:
   - **omnifork could have carried it.** Change omnifork. Add a test in its `tests/sync.rs`, then
     replay this sync and an earlier one from the log to show the number that improves and that no
     other gets worse. Commit in `~/omnifork` with jj.
   - **The Aoki change is shaped to conflict.** It edits upstream's file where a new `aoki/` file
     or a smaller edit would do. Reshape the change.
   - **A check would have caught it before a person did.** Add it to `sync-upstream.sh`, as
     `check_swift_rpc` was added after a removed request broke the phone app.
   - **The steps here were wrong or missing.** Rewrite the part of this file that misled you. Do
     not append a history of what happened.
3. Compare the new log line with the earlier ones. If conflicted files or review places went up
   for a similar number of upstream commits, say why in your report.
