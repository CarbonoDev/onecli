#!/usr/bin/env bash
# Upstream sync scan: computes the delta between the last reviewed upstream commit
# and upstream HEAD, measures real merge conflicts in a throwaway worktree, and
# emits a machine-readable summary for the review workflow to consume.
#
# Usage: scan.sh [--out DIR] [--upstream-ref REF] [--base COMMIT]
#
# Writes <out>/scan.json plus ours.txt / theirs.txt / overlap.txt / conflicts.txt.
# Read-only with respect to the primary working tree; all mutation happens in
# .claude/worktrees/ (gitignored) and is torn down by cleanup.sh.

set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
STATE_FILE="$REPO_ROOT/docs/upstream-sync/state.json"
WORKTREE_DIR="$REPO_ROOT/.claude/worktrees"

OUT_DIR=""
UPSTREAM_REF="upstream/main"
BASE_OVERRIDE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --out) OUT_DIR="$2"; shift 2 ;;
    --upstream-ref) UPSTREAM_REF="$2"; shift 2 ;;
    --base) BASE_OVERRIDE="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

if [[ -z "$OUT_DIR" ]]; then
  OUT_DIR="$(mktemp -d)"
fi
mkdir -p "$OUT_DIR"

# --- preconditions -----------------------------------------------------------

if ! git remote get-url upstream >/dev/null 2>&1; then
  echo "error: no 'upstream' remote. Add it with:" >&2
  echo "  git remote add upstream https://github.com/onecli/onecli.git" >&2
  exit 1
fi

echo "==> fetching upstream"
git fetch upstream --tags --quiet

# --- resolve the base (last reviewed) commit ---------------------------------

if [[ -n "$BASE_OVERRIDE" ]]; then
  BASE="$BASE_OVERRIDE"
elif [[ -f "$STATE_FILE" ]]; then
  BASE="$(jq -r '.lastReviewedCommit' "$STATE_FILE")"
else
  echo "error: no $STATE_FILE and no --base given." >&2
  echo "Bootstrap with: --base \$(git merge-base HEAD $UPSTREAM_REF)" >&2
  exit 1
fi

if ! git cat-file -e "${BASE}^{commit}" 2>/dev/null; then
  echo "error: base commit '$BASE' not found locally. Try 'git fetch upstream --tags'." >&2
  exit 1
fi

BASE_FULL="$(git rev-parse "$BASE")"
UPSTREAM_FULL="$(git rev-parse "$UPSTREAM_REF")"
OURS_FULL="$(git rev-parse HEAD)"
OURS_BRANCH="$(git rev-parse --abbrev-ref HEAD)"

if [[ "$BASE_FULL" == "$UPSTREAM_FULL" ]]; then
  echo "==> up to date: nothing new upstream since $BASE"
  jq -n --arg base "$BASE_FULL" --arg upstream "$UPSTREAM_FULL" \
    '{upToDate: true, base: $base, upstream: $upstream, commits: [], conflicts: []}' \
    > "$OUT_DIR/scan.json"
  echo "$OUT_DIR"
  exit 0
fi

# --- what landed upstream ----------------------------------------------------

echo "==> delta $BASE..$UPSTREAM_REF"
git log --no-merges --format='%H%x1f%h%x1f%an%x1f%aI%x1f%s' "$BASE..$UPSTREAM_REF" > "$OUT_DIR/commits.tsv"

# Releases crossed in this delta. --contains also matches tags sitting exactly on
# BASE (the release we last reviewed), so drop those — they are not new.
git tag --contains "$BASE" --merged "$UPSTREAM_REF" 2>/dev/null \
  | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' \
  | while read -r tag; do
      [[ "$(git rev-list -n1 "$tag")" != "$BASE_FULL" ]] && echo "$tag"
    done | sort -V > "$OUT_DIR/tags.txt" || true

git diff --name-only "$BASE..$OURS_FULL"     | sort > "$OUT_DIR/ours.txt"
git diff --name-only "$BASE..$UPSTREAM_FULL" | sort > "$OUT_DIR/theirs.txt"
comm -12 "$OUT_DIR/ours.txt" "$OUT_DIR/theirs.txt" > "$OUT_DIR/overlap.txt"

git diff --stat "$BASE..$UPSTREAM_FULL" | tail -1 > "$OUT_DIR/diffstat.txt"

# Deletions upstream are the highest-risk class for a fork: our code may import them.
git diff --name-status --diff-filter=D "$BASE..$UPSTREAM_FULL" | cut -f2 > "$OUT_DIR/upstream-deletions.txt"

# --- measure the real conflicts ----------------------------------------------

echo "==> merge trial"
MERGE_TRIAL="$WORKTREE_DIR/merge-trial"
UPSTREAM_WT="$WORKTREE_DIR/upstream-ref"

git worktree remove --force "$MERGE_TRIAL"  2>/dev/null || true
git worktree remove --force "$UPSTREAM_WT"  2>/dev/null || true

git worktree add --detach "$UPSTREAM_WT" "$UPSTREAM_FULL" --quiet
git worktree add --detach "$MERGE_TRIAL" "$OURS_FULL" --quiet

# The merge is deliberately left in progress: the conflict markers are the most
# useful artifact the review agents get.
git -C "$MERGE_TRIAL" merge --no-commit --no-ff "$UPSTREAM_FULL" > "$OUT_DIR/merge-output.txt" 2>&1 || true
git -C "$MERGE_TRIAL" diff --name-only --diff-filter=U > "$OUT_DIR/conflicts.txt" || true
git -C "$MERGE_TRIAL" status --short > "$OUT_DIR/merge-status.txt" || true

# --- summary -----------------------------------------------------------------

jq -n \
  --arg base "$BASE_FULL" \
  --arg upstream "$UPSTREAM_FULL" \
  --arg ours "$OURS_FULL" \
  --arg oursBranch "$OURS_BRANCH" \
  --arg mergeTrial "$MERGE_TRIAL" \
  --arg upstreamWorktree "$UPSTREAM_WT" \
  --arg diffstat "$(cat "$OUT_DIR/diffstat.txt")" \
  --argjson tags "$(jq -R -s 'split("\n") | map(select(length > 0))' < "$OUT_DIR/tags.txt")" \
  --argjson conflicts "$(jq -R -s 'split("\n") | map(select(length > 0))' < "$OUT_DIR/conflicts.txt")" \
  --argjson overlap "$(jq -R -s 'split("\n") | map(select(length > 0))' < "$OUT_DIR/overlap.txt")" \
  --argjson deletions "$(jq -R -s 'split("\n") | map(select(length > 0))' < "$OUT_DIR/upstream-deletions.txt")" \
  --argjson commits "$(jq -R -s '
      split("\n") | map(select(length > 0)) | map(split("\u001f")) |
      map({sha: .[0], short: .[1], author: .[2], date: .[3], subject: .[4]})
    ' < "$OUT_DIR/commits.tsv")" \
  '{
     upToDate: false,
     base: $base, upstream: $upstream, ours: $ours, oursBranch: $oursBranch,
     mergeTrial: $mergeTrial, upstreamWorktree: $upstreamWorktree,
     diffstat: $diffstat, tags: $tags,
     commits: $commits, overlap: $overlap,
     upstreamDeletions: $deletions, conflicts: $conflicts
   }' > "$OUT_DIR/scan.json"

echo "==> $(wc -l < "$OUT_DIR/commits.tsv" | tr -d ' ') commits, $(wc -l < "$OUT_DIR/overlap.txt" | tr -d ' ') overlapping files, $(wc -l < "$OUT_DIR/conflicts.txt" | tr -d ' ') conflicts"
echo "$OUT_DIR"
