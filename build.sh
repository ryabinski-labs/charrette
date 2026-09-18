#!/usr/bin/env bash
# Build and install the local `charrette` CLI.
#
# `pnpm build` alone doesn't touch pnpm-lock.yaml, but it also doesn't
# catch when pnpm-workspace.yaml (overrides, etc.) has drifted from what's
# committed -- that's exactly what broke CI in dbed321. Running `pnpm
# install` first keeps the lockfile honest, and this script tells you
# loudly if that leaves it dirty so it doesn't sit uncommitted again.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

pnpm install
pnpm build
pnpm link-cli

if ! git diff --quiet -- pnpm-lock.yaml; then
  echo
  echo "pnpm-lock.yaml changed during install -- commit and push it:"
  echo "  git add pnpm-lock.yaml && git commit -m 'chore: update lockfile' && git push"
  echo
fi

echo "charrette installed: $(charrette --version 2>/dev/null || readlink "$HOME/.local/bin/charrette")"
