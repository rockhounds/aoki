#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Aoki contributors
# SPDX-License-Identifier: MIT

# Sync Aoki onto the latest upstream T3 Code.
#
#   scripts/aoki/sync-upstream.sh            start a sync, or carry on with the one in progress
#   scripts/aoki/sync-upstream.sh --status   show sync state and what to resolve next
#   scripts/aoki/sync-upstream.sh --abort    restore the repo to the operation before the sync
#
# Options: --no-verify   skip `pnpm install --frozen-lockfile && pnpm typecheck` (the SwiftUI request
#                        check still runs)
#
# Exit codes: 0 synced / up to date, 2 conflicts or places to review remain, 3 verification failed,
# 1 other error. After 2 or 3, fix the change that is named and run this again.
#
# Who does what:
#   jj        the history: one rebase of every Aoki change onto upstream, conflicts recorded in the
#             change that has them, every earlier state in the operation log
#   omnifork  what jj won't: carries each change onto upstream's new code written in Aoki's names,
#             so a rename or rebrand arrives applied instead of as conflicts and missed names
#   this      Aoki policy: the local-only guard, the lockfile, verification, the synced base, and
#             one line per sync in sync-log.jsonl
#
# The steps around this script are in .agents/skills/sync-upstream/SKILL.md.
set -euo pipefail

# A sync rewrites the working copy, this file included. bash reads a script as it runs it, so
# everything lives in a function that is parsed before the first command.
main() {

export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
NODE_BIN="${AOKI_NODE_BIN:-$HOME/.local/node-v26.12.1/bin}"
[[ -d "$NODE_BIN" ]] && export PATH="$NODE_BIN:$PATH"

ROOT="$(jj root)"
OMNIFORK_DIR="${OMNIFORK_DIR:-$HOME/omnifork}"
STATE="$ROOT/.jj/aoki-sync"
REVIEWS="$ROOT/.jj/omnifork/reviews.txt"
VERIFY_WS="${AOKI_VERIFY_WS:-$HOME/.cache/aoki/verify-$(basename "$ROOT")}"
TRUNK='main@upstream'
# Every Aoki change, landed on main or not. Upstream's other branches are immutable.
STACK="(($TRUNK)..) & mutable()"
VERIFY=1
MODE=sync

while [[ $# -gt 0 ]]; do
  case "$1" in
    --continue) ;;
    --abort) MODE=abort ;;
    --status) MODE=status ;;
    --no-verify) VERIFY=0 ;;
    -h|--help) sed -n '5,25p' "$0"; exit 0 ;;
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
commit_ids() { j log --no-graph -r "$1" -T 'commit_id ++ "\n"' "${@:2}"; }
commit() { j log --no-graph -r "$1" -T 'commit_id' --limit 1; }
count() { j log --no-graph -r "$1" -T '"x\n"' | wc -l | tr -d ' '; }

# The top of the stack this checkout works on: where verification runs and what the log records.
# Resolving conflicts moves @ down the stack, so a sync remembers its top by change id.
tip() {
  if [[ -f "$STATE/start" ]]; then
    local change main_tip
    change="$(cut -d' ' -f3 "$STATE/start")"
    main_tip="$(commit "change_id($change) & ::main")"
    if [[ -n "$main_tip" ]]; then
      printf '%s\n' "$main_tip"
    else
      commit "$change"
    fi
  else
    commit "heads((($TRUNK)..@) ~ empty()) | (main ~ ::@)"
  fi
}

# Put an empty working copy on the top of the stack, where the sync's records are written.
settle() {
  [[ -n "$(revs "@ & ($1)::")" ]] && return 0
  [[ -z "$(revs '@ & empty()')" ]] \
    && die "the working copy has changes below the top of the stack; squash them into the change they belong to, then run this again"
  j new "$1"
}

# Built from its source on every run, so a fix to omnifork applies to the next sync.
omnifork() {
  [[ -f "$OMNIFORK_DIR/Cargo.toml" ]] \
    || die "omnifork is not at $OMNIFORK_DIR (set OMNIFORK_DIR). It carries the Aoki changes through a sync; see AOKI.md."
  cargo build --release --quiet --manifest-path "$OMNIFORK_DIR/Cargo.toml" || die "omnifork does not build"
  (cd "$ROOT" && OMNIFORK_RERUN="jj sync" "$OMNIFORK_DIR/target/release/omnifork" "$@")
}

# The lowest conflicted changes. Everything above one inherits its conflicts, so only these can
# be resolved.
conflicted() {
  j log --no-graph -r "roots(conflicts() & ($STACK))" -T 'commit_id ++ "\n"'
}
conflict_paths() { j resolve --list -r "$1" 2>/dev/null | sed -E 's/ +[0-9]+-sided conflict.*$//'; }

# Make sure the verify workspace exists and its working copy sits on top of $1.
ws_at() {
  if [[ ! -d "$VERIFY_WS/.jj" ]]; then
    [[ -z "$(ls -A "$VERIFY_WS" 2>/dev/null)" ]] \
      || die "$VERIFY_WS exists but is not a jj workspace; move it aside (or set AOKI_VERIFY_WS) and run this again"
    mkdir -p "$(dirname "$VERIFY_WS")"
    j workspace forget aoki-verify 2>/dev/null || true
    j workspace add --name aoki-verify -r "$1" "$VERIFY_WS"
  else
    (cd "$VERIFY_WS" && jj --quiet workspace update-stale 2>/dev/null || true
     cd "$VERIFY_WS" && jj --quiet new "$1")
  fi
}

# Resolve a conflict that only touches pnpm-lock.yaml: take the parent's lockfile, regenerate it
# from this change's (already merged) manifests, and fold the result into the change.
resolve_lockfile() {
  local rev
  for rev in $(conflicted); do
    [[ "$(conflict_paths "$rev")" == "pnpm-lock.yaml" ]] || continue
    log "regenerating pnpm-lock.yaml in $rev"
    ws_at "$rev" || return 1
    (cd "$VERIFY_WS" && jj --quiet restore --from "$rev-" pnpm-lock.yaml \
      && pnpm install --lockfile-only --silent && jj --quiet squash)
    refresh
    return 0
  done
  return 1
}

# Remember which files were left in conflict, for the sync log.
note_conflicts() {
  local rev
  for rev in $(conflicted); do
    conflict_paths "$rev" | sed "s|^|$rev\t|" >>"$STATE/conflicts"
  done
}

show_conflicts() {
  local rev
  for rev in $(conflicted); do
    j log --no-graph -r "$rev" -T '"  " ++ change_id.short(12) ++ " " ++ description.first_line() ++ "\n"'
    conflict_paths "$rev" | sed 's/^/      /'
  done
}

# The SwiftUI client is not typechecked here. A request upstream removed only fails on the phone,
# so every request the client names must still be in the contracts. SWIFT_RPC_KEPT lists the ones
# it still sends on purpose, as a fallback for hosts that predate the removal.
SWIFT_RPC_KEPT=" scheduledTasks.list "
check_swift_rpc() {
  local git_dir request requests missing=()
  git_dir="$(cd "$ROOT" && jj git root)"
  requests="$(
    git --git-dir "$git_dir" grep -hoE '((request|subscribe)\( *|case [A-Za-z0-9]+ = )"[A-Za-z]+\.[A-Za-z.]+"' "$1" \
      -- 'apps/swift-ios/*.swift' ':!apps/swift-ios/Tests' | sed -E 's/.*"([^"]+)"$/\1/' | sort -u
  )"
  [[ -n "$requests" ]] || { log "found no requests in apps/swift-ios; update check_swift_rpc"; return 1; }
  for request in $requests; do
    [[ "$SWIFT_RPC_KEPT" == *" $request "* ]] && continue
    git --git-dir "$git_dir" grep -qF "\"$request\"" "$1" -- packages/contracts/src || missing+=("$request")
  done
  [[ ${#missing[@]} -eq 0 ]] && return 0
  log "the SwiftUI client sends requests that upstream's contracts no longer have:"
  printf '  %s\n' "${missing[@]}"
  return 1
}

verify() {
  check_swift_rpc "$1" || return 1
  [[ "$VERIFY" == 1 ]] || { log "skipping verification (--no-verify)"; return 0; }
  log "verifying the top of the stack in $VERIFY_WS: pnpm install --frozen-lockfile && pnpm typecheck"
  ws_at "$1" || return 1
  (cd "$VERIFY_WS" && pnpm install --frozen-lockfile --silent && pnpm typecheck) || return 1
  # Upstream moves a surface's version in its own commits; Aoki's version is not part of the sync.
  (cd "$VERIFY_WS" && node scripts/aoki/version.ts) \
    || { log "a surface's version drifted; node scripts/aoki/version.ts --stamp fixes it without changing Aoki's version"; return 1; }
}

# Fold a file this script wrote into the Aoki change that owns it, never into @.
fold() {
  local owner
  owner="$(j log --no-graph -r "files(\"$1\") & ($TRUNK)..@" --reversed -T 'commit_id ++ "\n"' | head -1)"
  [[ -n "$owner" ]] || die "no Aoki change below @ owns $1; cannot record the sync"
  [[ "$(commit @)" == "$owner" ]] || j squash --from @ --into "$owner" "$1"
}

# Record the synced T3 Code base in upstream.json and the sync itself in sync-log.jsonl.
record() {
  local to version desired from before after reviews
  to="$(commit "$TRUNK")"
  version="$(
    j file show -r "$TRUNK" apps/server/package.json 2>/dev/null \
      | sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' | head -1
  )"
  [[ -n "$to" && -n "$version" ]] || die "cannot read $TRUNK to record the synced T3 Code version"
  desired="$(printf '{\n  "commit": "%s",\n  "version": "%s"\n}' "$to" "$version")"
  if [[ "$(cat "$ROOT/scripts/aoki/upstream.json" 2>/dev/null || true)" != "$desired" ]]; then
    printf '%s\n' "$desired" >"$ROOT/scripts/aoki/upstream.json"
    fold scripts/aoki/upstream.json
    log "recorded synced base: T3 Code $version (${to:0:8})"
  fi

  read -r from before _ <"$STATE/start"
  after="$1"
  reviews="$([[ -f "$REVIEWS" ]] && grep -c '^      (' "$REVIEWS" || true)"
  printf '{"date":"%s","from":"%s","to":"%s","t3":"%s","upstream_commits":%s,"changes":%s,"fork_before":"%s","fork_after":"%s","conflicted_changes":%s,"conflicted_files":%s,"reviews":%s,"runs":%s,"omnifork":"%s"}\n' \
    "$(date -u +%F)" "$from" "$to" "$version" "$(count "$from..$to")" "$(count "($TRUNK)..$after")" \
    "$before" "$after" \
    "$(sort -u "$STATE/conflicts" 2>/dev/null | cut -f1 | sort -u | wc -l | tr -d ' ')" \
    "$(sort -u "$STATE/conflicts" 2>/dev/null | wc -l | tr -d ' ')" \
    "${reviews:-0}" \
    "$(wc -l <"$STATE/runs" | tr -d ' ')" \
    "$(git -C "$OMNIFORK_DIR" describe --always --dirty 2>/dev/null)" >>"$ROOT/scripts/aoki/sync-log.jsonl"
  fold scripts/aoki/sync-log.jsonl
}

case "$MODE" in
  status)
    if [[ -d "$STATE" ]]; then
      log "sync in progress"
      if [[ -n "$(conflicted)" ]]; then log "resolve these, lowest first:"; show_conflicts; fi
      [[ -s "$REVIEWS" ]] && log "places to review: $REVIEWS"
    else
      log "no sync in progress"
    fi
    j log -r "($TRUNK)..$(tip) | $TRUNK"
    exit 0 ;;
  abort)
    [[ -d "$STATE" ]] || { log "no sync in progress"; exit 0; }
    omnifork undo || log "omnifork had no sync to undo"
    rm -rf "$STATE"
    exit 0 ;;
esac

if [[ ! -d "$STATE" ]]; then
  free_gb="$(df -Pk "$ROOT" | awk 'NR==2 {print int($4 / 1048576)}')"
  [[ "$free_gb" -ge 5 ]] || die "only ${free_gb}G free; a sync needs about 5G for the verify workspace"
  before="$(tip)"
  [[ -n "$before" ]] || die "no Aoki change found above $TRUNK"
  mkdir -p "$STATE"
  echo "$(commit "heads(::$before & ::($TRUNK))") $before $(revs "$before")" >"$STATE/start"
fi
date -u +%FT%TZ >>"$STATE/runs"

while :; do
  rc=0
  sync_args=(sync --no-verify)
  [[ ! -f "$STATE/fetched" ]] || sync_args+=(--no-fetch)
  omnifork "${sync_args[@]}" || rc=$?
  refresh
  if [[ "$rc" == 0 || "$rc" == 2 ]]; then
    touch "$STATE/fetched"
  fi
  [[ "$rc" == 0 ]] && break
  [[ "$rc" == 2 ]] || die "omnifork failed; the repo is as it left it (--abort restores it)"
  resolve_lockfile && continue
  note_conflicts
  if [[ -n "$(conflicted)" ]]; then
    die "resolve the changes above in place (jj new <change>; fix; jj squash), lowest first, then run this again (or --abort)" 2
  fi
  die "decide the places listed in $REVIEWS, fix the ones that need Aoki's name in the change named there, then run this again" 2
done

read -r from _ <"$STATE/start"
top="$(tip)"
[[ -n "$top" ]] || die "the change that was the top of the stack is gone; put @ on the new top and run this again"
[[ -n "$(revs "($TRUNK) & ::$top")" ]] \
  || die "the Aoki stack is still on its previous base; check whether a release tag made the fork stack immutable" 2
if [[ "$from" == "$(commit "$TRUNK")" ]]; then
  rm -rf "$STATE"
  log "already on $TRUNK ($(j log --no-graph -r "$TRUNK" -T 'commit_id.short()')); nothing to do"
  exit 0
fi

verify "$top" || die "verification failed; fix it in the change responsible (jj new <change>; fix; jj squash), then run this again (or --abort)" 3
settle "$top"
"$ROOT/scripts/aoki/check-local-only.sh"
record "$top"
rm -rf "$STATE"
log "done: on $(j log --no-graph -r "$TRUNK" -T 'commit_id.short() ++ " " ++ description.first_line()'), Aoki stack:"
j log -r "($TRUNK)..$(tip)" --no-graph -T '"  " ++ change_id.short(8) ++ " " ++ description.first_line() ++ "\n"'
log "next: vp run check:changed at the top of the stack, then the retro in .agents/skills/sync-upstream/SKILL.md"

}

main "$@"
