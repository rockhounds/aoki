#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Aoki contributors
# SPDX-License-Identifier: MIT

# Sync Aoki onto the latest upstream T3 Code, jj-natively.
#
#   scripts/aoki/sync-upstream.sh             fetch upstream and move the Aoki stack onto trunk()
#   scripts/aoki/sync-upstream.sh --continue  re-check after resolving conflicts / fixing verify failures
#   scripts/aoki/sync-upstream.sh --abort     restore the repo to the operation before the sync
#   scripts/aoki/sync-upstream.sh --status    show sync state and the Aoki stack
#
# Options: --no-verify   skip `pnpm install --frozen-lockfile && pnpm typecheck`
#
# Exit codes: 0 synced / up to date, 2 conflicts remain, 3 verification failed, 1 other error.
#
# Model: the Aoki stack is `trunk()..main` (trunk() = main@upstream). A sync is one `jj rebase`
# of that stack onto the new trunk(): every Aoki commit is re-merged onto upstream, keeps its change
# id, and no sync/merge commits are ever created. Conflicts are recorded in the affected commits;
# resolve them in place (`jj new <rev>` ... `jj squash`, or `jj resolve -r <rev>`) so the fix lands in
# the commit that caused it. Lockfile-only conflicts are resolved automatically by regenerating
# pnpm-lock.yaml from that commit's manifests.
set -euo pipefail

NODE_BIN="${AOKI_NODE_BIN:-$HOME/.local/node-v26.12.1/bin}"
[[ -d "$NODE_BIN" ]] && export PATH="$NODE_BIN:$PATH"
export PATH="$HOME/.local/bin:$PATH"

ROOT="$(jj root)"
STATE="$ROOT/.jj/aoki-sync-op"
VERIFY_WS="${AOKI_VERIFY_WS:-$HOME/.cache/aoki/verify-$(basename "$ROOT")}"
VERIFY=1
MODE=start

while [[ $# -gt 0 ]]; do
  case "$1" in
    --continue) MODE=continue ;;
    --abort) MODE=abort ;;
    --status) MODE=status ;;
    --no-verify) VERIFY=0 ;;
    -h|--help) sed -n '5,21p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 1 ;;
  esac
  shift
done

log() { printf '\033[1;34m[aoki-sync]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[aoki-sync]\033[0m %s\n' "$1" >&2; exit "${2:-1}"; }

j() { jj -R "$ROOT" --quiet "$@"; }
# Ops in the verify workspace can rewrite ancestors of the main workspace's @; catch it up.
refresh() { jj -R "$ROOT" --quiet workspace update-stale >/dev/null 2>&1 || true; }
revs() { j log --no-graph -r "$1" -T 'change_id.short(12) ++ "\n"' "${@:2}"; }

conflicted() { revs 'conflicts() & aoki()' --reversed; }

# Make sure the verify workspace exists and its working copy sits on top of $1.
ws_at() {
  if [[ ! -d "$VERIFY_WS/.jj" ]]; then
    mkdir -p "$(dirname "$VERIFY_WS")"
    j workspace forget aoki-verify 2>/dev/null || true
    j workspace add --name aoki-verify -r "$1" "$VERIFY_WS"
  else
    (cd "$VERIFY_WS" && jj --quiet workspace update-stale 2>/dev/null || true
     cd "$VERIFY_WS" && jj --quiet new "$1")
  fi
}

# Resolve conflicts that only touch pnpm-lock.yaml: take the parent's lockfile, regenerate it from
# this commit's (already merged) manifests, and fold the result into the conflicted commit.
auto_resolve() {
  local rev paths progress=1
  while [[ "$progress" == 1 ]]; do
    progress=0
    for rev in $(conflicted); do
      paths="$(j resolve --list -r "$rev" 2>/dev/null | awk '{print $1}')"
      [[ "$paths" == "pnpm-lock.yaml" ]] || continue
      log "regenerating pnpm-lock.yaml in $rev"
      ws_at "$rev"
      (cd "$VERIFY_WS" && jj --quiet restore --from "$rev-" pnpm-lock.yaml \
        && pnpm install --lockfile-only --silent && jj --quiet squash)
      refresh
      progress=1
      break # descendants were rebased; re-query
    done
  done
}

verify() {
  [[ "$VERIFY" == 1 ]] || { log "skipping verification (--no-verify)"; return 0; }
  log "verifying main in $VERIFY_WS: pnpm install --frozen-lockfile && pnpm typecheck"
  ws_at main
  (cd "$VERIFY_WS" && pnpm install --frozen-lockfile --silent && pnpm typecheck)
}

finish() {
  auto_resolve
  local left
  left="$(conflicted)"
  if [[ -n "$left" ]]; then
    log "conflicts remain in these Aoki commits:"
    j log -r 'conflicts() & aoki()' --no-graph -T '"  " ++ change_id.short(12) ++ " " ++ description.first_line() ++ "\n"'
    for rev in $left; do j resolve --list -r "$rev" | sed 's/^/      /'; done
    die "resolve each in place (jj new <rev>; fix; jj squash), then: $0 --continue   (or --abort)" 2
  fi
  verify || die "verification failed; fix it in the commit responsible (jj new <rev>; fix; jj squash), then: $0 --continue   (or --abort)" 3
  rm -f "$STATE"
  log "done: main = $(j log --no-graph -r main -T 'commit_id.short() ++ " " ++ description.first_line()')"
  log "on $(j log --no-graph -r 'trunk()' -T 'commit_id.short() ++ " " ++ description.first_line()'), Aoki stack:"
  j log -r 'aoki()' --no-graph -T '"  " ++ change_id.short(8) ++ " " ++ description.first_line() ++ "\n"'
}

case "$MODE" in
  status)
    if [[ -f "$STATE" ]]; then log "sync in progress (pre-sync op $(cat "$STATE"))"; else log "no sync in progress"; fi
    j log -r 'aoki() | trunk()'
    exit 0 ;;
  abort)
    [[ -f "$STATE" ]] || { log "no sync in progress"; exit 0; }
    op="$(cat "$STATE")"
    j op restore "$op"
    rm -f "$STATE"
    log "restored repo to operation $op (before the sync)"
    exit 0 ;;
  continue)
    [[ -f "$STATE" ]] || die "no sync in progress"
    finish
    exit 0 ;;
esac

[[ -f "$STATE" ]] && die "a sync is already in progress (use --status, --continue or --abort)"

pre_op="$(j op log -n1 --no-graph -T 'self.id().short(16)')"
log "fetching upstream"
j git fetch --remote upstream

if [[ -z "$(revs 'trunk() ~ ::main')" ]]; then
  log "main already contains trunk() ($(j log --no-graph -r 'trunk()' -T 'commit_id.short()')); nothing to do"
  exit 0
fi

echo "$pre_op" >"$STATE"
log "moving the Aoki stack ($(revs 'aoki()' | wc -l) commits) onto trunk(): $(j log --no-graph -r 'trunk()' -T 'commit_id.short() ++ " " ++ description.first_line()')"
# -b main: every commit in trunk()..main plus all their descendants (your @, side branches) moves.
j rebase -b main -d 'trunk()'
finish
