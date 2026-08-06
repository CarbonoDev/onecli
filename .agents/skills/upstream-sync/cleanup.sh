#!/usr/bin/env bash
# Tears down the worktrees created by scan.sh. Safe to run repeatedly.
# The merge trial is intentionally destructive to itself only — the primary
# working tree is never touched.

set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
WORKTREE_DIR="$REPO_ROOT/.claude/worktrees"

for wt in merge-trial upstream-ref; do
  if [[ -d "$WORKTREE_DIR/$wt" ]]; then
    git -C "$WORKTREE_DIR/$wt" merge --abort 2>/dev/null || true
    git worktree remove --force "$WORKTREE_DIR/$wt" && echo "removed $wt"
  fi
done

git worktree prune
