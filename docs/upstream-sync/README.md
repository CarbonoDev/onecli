# Upstream sync

This repo is a fork of [onecli/onecli](https://github.com/onecli/onecli). Upstream ships tagged
releases frequently; this fork carries substantial local work on top of a pinned upstream base.

`state.json` records **the last upstream commit we reviewed**. It is the anchor for the recurring
process: each cycle reviews `lastReviewedCommit..upstream/main`, records the decisions under
`reviews/`, and advances the pointer.

## Running a cycle

```bash
# with Claude Code — drives the whole process
/upstream-sync

# or by hand
git remote add upstream https://github.com/onecli/onecli.git   # first time only
.agents/skills/upstream-sync/scan.sh --out /tmp/upstream-scan
```

The scan fetches upstream, computes the delta, and measures real merge conflicts in a throwaway
worktree under `.claude/worktrees/` (gitignored). It never touches your working tree. Tear the
worktrees down afterwards with `.agents/skills/upstream-sync/cleanup.sh`.

The full process — how the review is structured and what to watch for — lives in
`.agents/skills/upstream-sync/SKILL.md`.

## state.json

| field                | meaning                                                                    |
| -------------------- | -------------------------------------------------------------------------- |
| `lastReviewedCommit` | upstream commit the last review covered — the base for the next delta      |
| `lastReviewedTag`    | upstream release tag at that commit, if any                                |
| `lastReviewedAt`     | date of the review                                                         |
| `forkBase`           | upstream release the working branch is currently re-landed onto            |
| `forkBranch`         | the fork branch carrying local work                                        |
| `pendingAdoption`    | reviewed and decided, but **not yet merged** — carries into the next cycle |
| `reviews`            | log of review documents, newest first                                      |

`lastReviewedCommit` advances when a review is **written**, not when the code is merged. Anything
decided but unlanded lives in `pendingAdoption` so the next cycle does not re-litigate it.
