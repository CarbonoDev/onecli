export const meta = {
  name: "upstream-sync-review",
  description:
    "Review an upstream delta area-by-area, analyse every real merge conflict, and synthesize an adoption plan",
  whenToUse:
    "Invoked by the upstream-sync skill after scan.sh has produced scan.json and the merge-trial worktree.",
  phases: [
    {
      title: "Survey",
      detail: "one agent per subsystem area of the upstream delta",
    },
    {
      title: "Conflicts",
      detail: "one agent per conflicted file from the merge trial",
    },
    {
      title: "Synthesize",
      detail: "merge findings into a single adoption plan",
    },
  ],
};

// args: {
//   repo, upstreamWorktree, mergeTrial, base, upstream, ours, oursBranch,
//   forkContext: string,            // what local work the fork carries
//   areas: [{ key, label, scope, focus }],
//   conflicts: [path, ...],
// }
// `args` can arrive as a JSON string rather than an object depending on how the
// caller passes it. Destructuring a string yields `undefined` for every field,
// which silently interpolates "undefined" into every agent prompt — the agents
// recover by exploring, but they lose the refs. Normalize first.
const input = typeof args === "string" ? JSON.parse(args) : args;

const {
  repo,
  upstreamWorktree,
  mergeTrial,
  base,
  upstream,
  ours,
  oursBranch,
  forkContext,
  areas,
  conflicts: conflictFiles,
} = input;

for (const [k, v] of Object.entries({
  repo,
  mergeTrial,
  base,
  upstream,
  ours,
  areas,
  conflictFiles,
})) {
  if (v === undefined)
    throw new Error(`upstream-sync review: missing required arg '${k}'`);
}

const CONTEXT = `
You are reviewing an UPSTREAM SYNC for a fork.

- Upstream: github.com/onecli/onecli (OSS). Fork: github.com/CarbonoDev/onecli.
- Fork working branch: \`${oursBranch}\` (${ours}).
- Last reviewed upstream commit (the base): ${base}. Upstream now at ${upstream}.
- The delta under review is \`${base}..${upstream}\`.

Local work the fork carries on top of the base:
${forkContext}

READ-ONLY RULES: run git/read/grep freely, but do NOT edit, write, commit, stage, or reset anything, and never run
'git merge', 'git checkout', 'git restore', 'git reset' or anything else that mutates a working tree.

Locations:
- Fork HEAD (main repo):        ${repo}
- Upstream checked out:         ${upstreamWorktree}
- Merge trial, merge LEFT IN PROGRESS with conflict markers present: ${mergeTrial}

Useful commands (run from ${repo}):
- git diff ${base}..${upstream} -- <path>   # what upstream changed
- git diff ${base}..${ours} -- <path>       # what the fork changed
- git log --oneline ${base}..${upstream}
- git show ${upstream}:<path>
`;

const SURVEY_SCHEMA = {
  type: "object",
  required: ["area", "summary", "changes", "forkImpact", "recommendation"],
  properties: {
    area: { type: "string" },
    summary: {
      type: "string",
      description: "2-4 sentences: what upstream actually did here and why",
    },
    changes: {
      type: "array",
      items: {
        type: "object",
        required: [
          "title",
          "files",
          "whatItDoes",
          "valueToFork",
          "risk",
          "verdict",
        ],
        properties: {
          title: { type: "string" },
          files: { type: "array", items: { type: "string" } },
          whatItDoes: { type: "string" },
          valueToFork: { type: "string" },
          risk: { type: "string", enum: ["low", "medium", "high"] },
          verdict: {
            type: "string",
            enum: ["take", "take-with-adaptation", "skip", "needs-decision"],
          },
        },
      },
    },
    forkImpact: {
      type: "string",
      description:
        "How this area interacts with fork-local work; name specific fork files",
    },
    duplicatesForkWork: {
      type: "array",
      description:
        "Where upstream independently built something the fork already built",
      items: {
        type: "object",
        required: ["upstreamThing", "forkThing", "note"],
        properties: {
          upstreamThing: { type: "string" },
          forkThing: { type: "string" },
          note: { type: "string" },
        },
      },
    },
    recommendation: { type: "string" },
  },
};

const CONFLICT_SCHEMA = {
  type: "object",
  required: [
    "file",
    "conflictKind",
    "oursIntent",
    "theirsIntent",
    "resolution",
    "difficulty",
  ],
  properties: {
    file: { type: "string" },
    conflictKind: { type: "string" },
    oursIntent: { type: "string" },
    theirsIntent: { type: "string" },
    resolution: {
      type: "string",
      description:
        "Concrete, actionable resolution. Name functions and symbols.",
    },
    difficulty: { type: "string", enum: ["trivial", "moderate", "hard"] },
    hiddenBreakage: {
      type: "string",
      description:
        "What breaks beyond the markers (removed exports, renamed types, other callers). Empty if none.",
    },
  },
};

const PLAN_SCHEMA = {
  type: "object",
  required: ["headline", "adopt", "order", "openDecisions", "verification"],
  properties: {
    headline: { type: "string" },
    adopt: {
      type: "array",
      items: {
        type: "object",
        required: ["item", "verdict", "why", "files", "effort"],
        properties: {
          item: { type: "string" },
          verdict: {
            type: "string",
            enum: ["take", "take-with-adaptation", "skip", "needs-decision"],
          },
          why: { type: "string" },
          files: { type: "array", items: { type: "string" } },
          effort: { type: "string", enum: ["S", "M", "L"] },
          conflictNotes: { type: "string" },
        },
      },
    },
    order: { type: "array", items: { type: "string" } },
    openDecisions: {
      type: "array",
      items: {
        type: "object",
        required: ["question", "options", "recommendation"],
        properties: {
          question: { type: "string" },
          options: { type: "array", items: { type: "string" } },
          recommendation: { type: "string" },
        },
      },
    },
    verification: { type: "array", items: { type: "string" } },
  },
};

phase("Survey");

// Surveys and conflict analyses are independent axes over the same delta — run
// them concurrently and take the single barrier before synthesis, which
// genuinely needs every reporter's findings at once.
const [surveys, conflicts] = await Promise.all([
  parallel(
    areas.map(
      (a) => () =>
        agent(
          `${CONTEXT}

Your area: **${a.label}**
Paths in scope: ${a.scope}

${a.focus}

Review the upstream delta in your area: what it does, whether the fork should adopt it, and how it interacts with
fork-local work. Read the actual diffs and surrounding code — do not paraphrase commit messages. Where upstream added
tests, note whether they encode behaviour the fork currently violates.

Be concrete; name files and symbols. Return the structured object.`,
          {
            label: `survey:${a.key}`,
            phase: "Survey",
            schema: SURVEY_SCHEMA,
            model: "sonnet",
          },
        ),
    ),
  ),
  parallel(
    conflictFiles.map(
      (f) => () =>
        agent(
          `${CONTEXT}

Analyse exactly ONE merge conflict from the in-progress merge trial.

File: **${f}**

1. Read the conflicted file with its markers at ${mergeTrial}/${f}. For a delete/modify conflict the file may be
   absent on one side — use git to inspect both sides.
2. Run \`git diff ${base}..${ours} -- '${f}'\` and \`git diff ${base}..${upstream} -- '${f}'\` from ${repo} to see
   each side's intent.
3. Check CALLERS and related files — a conflict is usually the visible tip of a wider API change. Grep for symbols
   upstream renamed or deleted.
4. Give a concrete resolution: what to keep from each side, what to re-apply by hand, what to verify afterwards.

Return the structured object.`,
          {
            label: `conflict:${f.split("/").pop()}`,
            phase: "Conflicts",
            schema: CONFLICT_SCHEMA,
          },
        ),
    ),
  ),
]);

const goodSurveys = surveys.filter(Boolean);
const goodConflicts = conflicts.filter(Boolean);
log(
  `surveyed ${goodSurveys.length}/${areas.length} areas, analysed ${goodConflicts.length}/${conflictFiles.length} conflicts`,
);
if (
  goodSurveys.length < areas.length ||
  goodConflicts.length < conflictFiles.length
) {
  log(
    "WARNING: some reporters failed — the plan below is incomplete, re-run or fill the gaps by hand",
  );
}

phase("Synthesize");

const plan = await agent(
  `${CONTEXT}

You are the synthesis step. ${goodSurveys.length} area reviewers and ${goodConflicts.length} conflict analysts have
reported. Combine their findings into one adoption plan for the maintainer.

AREA SURVEYS:
${JSON.stringify(goodSurveys, null, 2)}

CONFLICT ANALYSES:
${JSON.stringify(goodConflicts, null, 2)}

Rules:
- Do not concatenate. Merge, dedupe, and resolve disagreements; if two reporters contradict each other, spot-check the
  code yourself and say which is right.
- The highest-value output is "upstream independently built something we already built" — surface those as
  openDecisions with a real recommendation, not a shrug.
- Be honest about effort. A "take" that quietly requires reworking fork internals is "take-with-adaptation".
- Order matters: low-risk mechanical merges before anything needing a design decision.

Return the structured object.`,
  {
    label: "synthesize:adoption-plan",
    phase: "Synthesize",
    schema: PLAN_SCHEMA,
  },
);

return { plan, surveys: goodSurveys, conflicts: goodConflicts };
