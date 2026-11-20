---
name: sync-upstream
description: Bring Aoki up to date with upstream T3 Code. Runs `jj sync`, which uses omnifork to carry Aoki's changes, then resolves what is left, verifies, runs the mandatory retro that improves omnifork, and records the sync. Use when asked to sync, update, rebase onto, or catch up with upstream or T3 Code, to say how far behind Aoki is, or to work on omnifork.
---

<!-- SPDX-FileCopyrightText: 2026 Aoki contributors -->
<!-- SPDX-License-Identifier: MIT -->

# Sync Aoki with upstream T3 Code

`jj sync` is the only way to sync. It runs `scripts/aoki/sync-upstream.sh`. [AOKI.md](../../../AOKI.md)
describes the history model it keeps.

| Tool      | Owns                                                                                                                                                                                                                                         |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| jj        | The history: one rebase of every Aoki change, conflicts recorded in the change that has them, undo through the operation log.                                                                                                                |
| omnifork  | What jj won't do: making a tracking fork easy to keep. It learns each change's intent from the change itself (the rename, the rebrand, any sweeping edit) and applies it to upstream's new code, so it arrives done instead of as conflicts. |
| `jj sync` | Aoki policy around the two: the local-only guard, the lockfile, verification, the synced base, the sync log.                                                                                                                                 |

omnifork is ours. Its source is the jj repo at `~/omnifork` (`OMNIFORK_DIR`), and `jj sync` builds it on
every run, so a fix to omnifork applies to the next sync.

## Rules that are never optional

The maintainer has given these instructions repeatedly. Do not skip, defer, shorten, or ask
permission for any of them. Asking permission to do one is skipping it.

1. **Every sync goes through `jj sync`, and so through omnifork.** Never rebase by hand, call
   `omnifork sync` yourself (it skips Aoki's checks and records), or write a one-off script to
   merge conflicts.
2. **Every sync must improve omnifork.** Aoki is the canary project for omnifork. The retro is a
   step of the sync, not a follow-up, and a sync without it is unfinished.
3. **Every edit a person makes after omnifork ran is a gap until shown otherwise.** That covers
   conflict resolutions, review places, `check:changed` fixes, test fixes, and version stamping.
   Each one ends in an omnifork change with a test, or in one of the other three retro outcomes,
   written down in the report. "It was only a few old names in tests" is not an outcome.
4. **Editing by hand is only how you get the stack green.** Do it in the change that owns the name.
   It is never the end of the task.
5. **Do not report done, summarize, or hand back before the done gate below is met.** If you cannot
   finish (rate limit, disk, tool failure), say the sync is incomplete and list the gate items still
   open. Never present a sync as finished with the retro "to follow".
6. **Do not move `main` or push** unless the maintainer asks.

## Start with a todo list

Before running anything, write a todo list with every numbered step below, including each retro step
and the report. Keep it current. A sync whose list still has open retro items is not done.

## 1. Before

1. `jj sync --status`. Carry on with a sync in progress; do not start over.
2. Look at the stack with `jj log -r 'main@upstream..@'`. Everything above upstream moves, landed
   on `main` or not, and so does uncommitted work in `@`. Say what is there before you start. Other
   workspaces go stale and recover with `jj workspace update-stale`.
3. To report how far behind Aoki is without syncing, run `jj git fetch --remote upstream` and count
   `jj log -r 'heads(::@ & ::main@upstream)..main@upstream'`. The fetch only moves `main@upstream`.
   That is a status question: no retro is owed when nothing was synced.

## 2. Run

Run `jj sync` and act on its exit code. Run it again after every fix, from wherever `@` is.

**2, conflicts.** Only the lowest conflicted change is listed, because every change above it
inherits its conflicts and waits to be carried.

- `jj new <change>`, fix the files, `jj squash`, `jj sync`.
- The resolution is upstream's new content with the Aoki change's intent applied. Upstream deleted
  the file: delete it. Upstream moved the text: apply the change where it went. Upstream rewrote
  the line so the old name is gone: take upstream's line.
- Never resolve in a change above the lowest one, and never in a new change.
- Write down each file you resolved and why. The retro needs the list.
- jj's immutable-pinned originals make change ids **divergent**: `jj new <change>` then fails with
  `Change ID is divergent`. Never pipe jj output through `tail` alone — the error hides there and a
  failed `jj new` silently leaves every later edit in the wrong change. Target the copy in the
  stack instead: `jj new 'change_id(<change>) & ::main'`, or the commit id. Squashing into the wrong
  copy conflicts the change with itself.
- `jj squash` opens an editor to combine descriptions when the working-copy commit has one, and a
  non-tty editor failure rolls the whole squash back after it already rewrote the stack. Run jj
  with `EDITOR=true` whenever a shell does not have a terminal.
- Edits to lines that appear in many stacked changes (renames, formatting) conflict in every
  descendant that also touches them. Prefer `jj absorb`; for formatting and other generated output
  that absorb cannot place, a small cleanup change at the top of the stack beats a cascade.

**2, places to review.** `.jj/omnifork/reviews.txt` lists upstream lines that still use an old name
omnifork had no rule for. It left upstream's text. Decide each: where Aoki's name belongs, put it in
the change named there the same way. The list is reported once, so the next `jj sync` goes on. Copy
the list somewhere outside the worktree before you fix it; the retro needs it.

**3, verification.** The SwiftUI request check or `pnpm typecheck` failed at the top of the stack.
Fix it in the change responsible. A request upstream removed from the contracts needs the SwiftUI
client moved off it, in a `fix(swift-ios)` change of its own if no Aoki change owns that code.

## 3. Verify the result

1. `vp run check:changed` at the top of the stack, with a timeout long enough for the test step
   (`CHECK_CHANGED_TIMEOUT=3000`). After a sync its failures are mostly old names in upstream's new
   tests, fixtures, and environment variables. Fix each in the change that owns the name
   (`jj absorb`, then `jj squash --into <change>` for what is left) and record each one for the
   retro.
2. A failure that does not come from the sync (a missing Playwright browser, an environment
   variable such as `GIT_SSH_COMMAND` set by the agent harness) is not a gap. Say so in the report,
   with the evidence that it fails the same way without the sync.
3. Leave Aoki's version alone. A sync records its T3 Code base in `upstream.json`; it is not a
   release ([AOKI.md](../../../AOKI.md#versioning)). If the version test fails because upstream moved
   a surface's version, `node scripts/aoki/version.ts --stamp` fixes it without changing Aoki's
   version. `jj sync` verification now fails on that drift before `check:changed` does, but the
   stamp is still a hand edit, so it goes to the retro.
4. Note the commit at the top of the stack when `check:changed` is green. That is the **accepted
   result** the retro replays against. It is not the `fork_after` in the sync log, which is written
   before these fixes.

## 4. Retro (mandatory)

Every sync that moved the stack ends with this. It is how the next sync gets cheaper, and it is the
reason Aoki syncs through omnifork.

1. **Replay the sync.** From the checkout that ran it (the ids only resolve there):

   `omnifork replay --fork <fork_before> --onto <to> --expect <accepted result>`

   `fork_before` and `to` come from the sync's line in `scripts/aoki/sync-log.jsonl`. When several
   `jj sync` runs happened before the stack was accepted, use the first `fork_before` and the last
   `to`. `<accepted result>` is the commit from step 3.4, not the logged `fork_after`. Replay prints
   the conflicted files left to a person, the places listed for review, and the files where
   omnifork's result differs from the accepted one. Keep the output; it is the "before" number.

2. **Sort every hand edit** (each conflict resolved, review place fixed, and failure from
   verification or `check:changed`) into one of these, and do it. Start from the assumption that
   omnifork could have carried it, and only choose another outcome when you can say why.
   - **omnifork could have carried it.** Change omnifork. Add a test in its `tests/sync.rs` that
     fails first, then replay this sync and an earlier one from the log to show the number that
     improves and that no other gets worse. Commit in `~/omnifork` with jj.
   - **The Aoki change is shaped to conflict.** It edits upstream's file where a new `aoki/` file
     or a smaller edit would do. Reshape the change.
   - **A check would have caught it before a person did.** Add it to `sync-upstream.sh`, as
     `check_swift_rpc` was added after a removed request broke the phone app.
   - **The steps here were wrong or missing.** Rewrite the part of this file that misled you. Do
     not append a history of what happened.
3. **Replay again** with the changed omnifork and the same arguments. Compare with the "before"
   output. If a number got worse, the change is not done.
4. **Compare the new sync-log line with earlier ones.** If conflicted files or review places went up
   for a similar number of upstream commits, say why in the report.

## 5. Done gate

The sync is done only when every line is true. Check them against the todo list, not from memory.

- [ ] `jj sync` exited 0 and `check:changed` is green, or each failure is shown not to come from
      the sync.
- [ ] The replay ran before and after, and its output is in the report.
- [ ] Every hand edit has an outcome from step 4.2, and each omnifork outcome has a commit in
      `~/omnifork` with a test.
- [ ] Nothing was resolved by rebasing, scripting, or calling `omnifork sync` outside `jj sync`.
- [ ] Scratch files, replay repositories (`--keep`), extra workspaces, and build output you created
      are removed.

## 6. Report

Say all of this, in this order, in the message that ends the sync:

1. The new T3 Code base and this sync's line in `scripts/aoki/sync-log.jsonl`.
2. What is unpushed, and where `main` is. Moving `main` and pushing are the maintainer's call.
3. A table with one row per hand edit: what it was, the retro outcome, and the omnifork commit,
   reshaped change, or added check that answers it.
4. The replay numbers before and after, and the omnifork commit ids.
5. Anything not improved, with the reason. If any gate line is open, say "incomplete" first.
