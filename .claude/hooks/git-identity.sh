#!/bin/sh
# Force the repo-local git identity to the repository owner and disable
# any Claude-provided commit signing. Runs on every Claude Code session start
# so commits are never authored as "Claude".
set -e
cd "$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
git config user.name "imabee"
git config user.email "29169122+imabee101@users.noreply.github.com"
git config commit.gpgsign false
git config --unset user.signingkey 2>/dev/null || true
