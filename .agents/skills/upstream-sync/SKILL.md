---
name: upstream-sync
description: Review what has landed in the upstream onecli/onecli repo since the last sync and decide what to bring into this fork. Use when the user asks to check upstream, sync the fork, review upstream changes, catch up with upstream, or asks what is new in onecli upstream. Also use before starting work that rebases onto a new upstream release.
---

# Upstream Sync

This repo is a fork of [onecli/onecli](https://github.com/onecli/onecli). Upstream ships releases
frequently (`chore(main): release X.Y.Z` commits, tagged `vX.Y.Z`), and this fork carries substantial
local work on top. This skill runs the recurring review: **what landed upstream, what we should take,
and what it will cost us.**

The state that makes it recurring lives in `docs/upstream-sync/state.json` — the last upstream commit
we reviewed. Every run reads it, reviews the delta from there to upstream HEAD, and advances it.

## The shape of the problem

This is not "merge upstream." The fork re-lands large features (org RBAC, user groups, granular
resource scoping, gateway condition matching, spend budgets) onto each upstream base. So the real
questions are:

1. What did upstream actually build, and do we want it?
2. Where does upstream's work **collide** with ours — same files, same feature, different design?
3. What breaks that a merge won't show — deleted exports, renamed types, callers we still have?

Question 2 is the one that matters most and the one a diff won't answer. Upstream sometimes builds
its own version of something the fork already built; adopting it blindly means carrying two designs.

## Process

### 1. Scan

```bash
.agents/skills/upstream-sync/scan.sh --out /tmp/upstream-scan
```

Fetches upstream, reads the last-reviewed commit from `state.json`, and writes `scan.json` with:
the delta commits, release tags crossed, files both sides touched (`overlap`), files upstream
**deleted** (`upstreamDeletions` — highest risk for a fork), and the **measured** conflict list.

The conflict list is measured, not guessed: the script creates a `merge-trial` worktree, runs
`git merge --no-commit`, and leaves it in progress so the conflict markers are readable. It also
creates an `upstream-ref` worktree at upstream HEAD. Both live in `.claude/worktrees/` (gitignored);
the primary working tree is never touched.

If `scan.json` has `upToDate: true`, report that and stop.

### 2. Decide the review areas

Read `scan.json` and group the changed files into 3–5 coherent **areas** — by subsystem, not by
commit. Past runs have used: `apps/gateway` (Rust), `packages/api`, new web features, web
policy/grants UI + build config. Group by what a reviewer would need to hold in their head at once.

For each area write `{ key, label, scope, focus }` where `focus` names the specific files and the
specific suspicion to chase (e.g. "upstream added `org-resource-boundary.ts` — check whether it
duplicates our org-scope enforcement").

### 3. Run the review workflow

```
Workflow({
  scriptPath: ".agents/skills/upstream-sync/review-workflow.js",
  args: {
    repo, upstreamWorktree, mergeTrial,        // from scan.json
    base, upstream, ours, oursBranch,          // from scan.json
    forkContext: "<the local work this branch carries — read it off git log>",
    areas: [ ... ],                            // from step 2
    conflicts: [ ... ],                        // scan.json .conflicts, verbatim
  },
})
```

It runs one `sonnet` agent per area (survey work — mechanical diff reading over a wide scope), one
agent at the session model per conflicted file (resolution needs judgement), then a single synthesis
agent that merges everything and resolves reporter disagreements. Surveys and conflict analyses run
concurrently; the only barrier is before synthesis, which genuinely needs all of it.

Agent count is `areas + conflicts + 1`. If a delta is huge, split it into two runs by area rather
than raising the fan-out past ~15.

### 4. Write the review, advance the state

Write `docs/upstream-sync/reviews/<YYYY-MM-DD>-<version>.md` from the workflow's plan. Keep the
decision table (`take` / `take-with-adaptation` / `skip` / `needs-decision`) — the point of the log
is that the _next_ run can see what we already decided and why, especially the skips.

Then update `docs/upstream-sync/state.json`. Set `lastReviewedCommit` to upstream HEAD **once the
review is written**, not once the code is merged — the file tracks reviews, and `pendingAdoption`
carries anything decided-but-not-yet-landed into the next cycle.

Surface the `openDecisions` to the user directly. Those are judgement calls about the fork's
direction; do not resolve them silently.

### 5. Clean up

```bash
.agents/skills/upstream-sync/cleanup.sh
```

Aborts the merge trial and removes both worktrees. Run this even if the review failed partway.
Never leave `merge-trial` sitting in a conflicted state — a later run will refuse to reuse it.

## Notes and gotchas

- **A clean auto-merge is not a safe merge — this is the main lesson so far.** Both of the v1.45.0 blockers
  were files git merged without a single conflict marker: `api/keys.ts` ended up with two `projects:` keys in
  one object literal, and a new fail-closed guard in `connect.rs` silently disabled the fork's entire granular
  scoping feature with `cargo test` still green. The conflict list tells you where to _look_; it does not tell
  you where the damage is. Always ask the reviewers to check **new callers upstream added to code the fork
  rewrote**, and **new guards upstream added around seams the fork stubs out** (`ee_apps.rs` is the big one —
  its functions are hardcoded `false`/identity stubs, so any upstream check gated on them fails closed here).
- **Verify the headline findings yourself.** Reporters occasionally disagree, and at least one confidently
  wrong "high risk" call has already appeared (claiming an upstream-only file was fork work). Spot-check the
  claims that drive a decision — they are usually one grep.
- **`main` drifts.** The fork's `main` tracks upstream but is often behind the release the working
  branch was re-landed onto. Check `git log --oneline -1 origin/main` against `state.json`; if they
  disagree, say so — it's usually just stale, but it means `main` is not a reliable base.
- **Don't adopt the merge trial.** It exists to measure conflicts. Real adoption should be a
  deliberate rebase or a cherry-pick series onto the working branch, guided by the review.
- **Release commits are noise.** `chore(main): release X.Y.Z` only bumps versions and the CHANGELOG.
  The feature PR right before it is the real content.
- **Upstream tests are a signal.** When upstream adds tests, check whether they encode behaviour the
  fork deliberately changed — that's the cheapest way to find a silent semantic conflict.

## Improving this skill

This is meant to get better each cycle. After a run, if something was missed or a step was awkward,
fix it here: add the gotcha to the list above, sharpen a `focus` prompt in step 2, or adjust the
schemas in `review-workflow.js`. The workflow script is a plain file — edit it and re-invoke with
`scriptPath` to iterate without rewriting the skill.
