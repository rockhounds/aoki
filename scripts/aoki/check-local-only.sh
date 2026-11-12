#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Aoki contributors
# SPDX-License-Identifier: MIT

# Local-only work must never be reachable from a bookmark: bookmarks are what `jj git push`
# publishes. Exit 1 if any local-only path is, so a sync (or any manual run) stops before a
# push can ship it. The list of local-only paths lives here and in .github/workflows/local-only.yml;
# keep the two in sync, and document the rule in AOKI.md ("Local-only work").

set -euo pipefail

ROOT="$(jj root 2>/dev/null)" || { echo "not a jj repo" >&2; exit 1; }
j() { jj -R "$ROOT" --quiet "$@"; }

LOCAL_ONLY=(
  apps/aoki-companion/Sources/CompanionGarden.swift
  apps/aoki-companion/Sources/CompanionGardenView.swift
  apps/aoki-companion/Sources/GardenLandscape.swift
  apps/aoki-companion/Sources/GardenViewport.swift
  apps/aoki-companion/Tests/CompanionGardenTests.swift
)

revset=""
for path in "${LOCAL_ONLY[@]}"; do
  revset="${revset:+$revset | }files(\"$path\")"
done

hits="$(
  j log --no-graph -r "(trunk()..bookmarks()) & ($revset)" \
    -T 'commit_id.short() ++ " " ++ description.first_line() ++ "\n"' 2>/dev/null || true
)"
if [[ -n "$hits" ]]; then
  printf '\033[1;31m[aoki]\033[0m local-only work is reachable from a bookmark:\n%s\n' "$hits" >&2
  printf 'Strip it before pushing (see AOKI.md, "Local-only work").\n' >&2
  exit 1
fi
