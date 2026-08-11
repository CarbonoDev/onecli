# Scope: project lifecycle (create · list · switch)

> **Living document.** Updated as each slice lands — keep the status table below
> current, and record decisions that change during implementation rather than
> letting this drift from the code.

## Status

| #   | Slice                         | Size | State                                          |
| --- | ----------------------------- | ---- | ---------------------------------------------- |
| 1   | `GET /v1/projects` — list     | S    | PR open (#21)                                  |
| 2   | `POST /v1/projects` — create  | M    | PR open (#22)                                  |
| 3   | Web: switcher + create dialog | M    | PR open (#23 transport / #24 UI)               |
| 4   | Org switching                 | M–L  | PR open (#26), plus fixes #30/#31 from testing |
| 5   | Invite to an existing project | M    | PR open (#32)                                  |
| 6   | Projects view                 | M    | not started                                    |
| 7   | Org settings page (rename)    | S    | not started                                    |

Slices 1–4 were built before anyone ran them. Slices 5–7 come from actually
using the feature, and 5 is a root-cause fix rather than an addition — see
"What testing changed" below.

## The gap in one line

Everything below the UI is already multi-project. What's missing is the ability to **create** a project, **list** the ones you can reach, and **switch** between them.

## What already works — do not rebuild

| Layer                     | State                                                                                                  |
| ------------------------- | ------------------------------------------------------------------------------------------------------ |
| `Project` model           | Multi-project ready: `slug` with `@@unique([organizationId, slug])`, `createdByUserId`, org FK         |
| `ProjectAccess`           | User + group bindings, `owner`/`member` role, cascade deletes                                          |
| Ownership of data         | `Agent`, `Secret`, `AppConnection`, `PolicyRuleV2`, `ApiKey`, `Budget`, `AuditLog` all FK to `Project` |
| Gateway                   | Fully project-aware — `agent.project_id` drives secrets, connections and policy resolution             |
| API keys                  | Already `scope: "project" \| "organization"` with a `projectId` FK                                     |
| **Switching (transport)** | `resolveProjectId` already honours `x-project-id`, gated by `canAccessProjectAsUser`                   |
| **Switching (authz)**     | `canAccessProjectAsUser` + `hasProjectBinding` — built and tested in #13                               |
| Management                | `renameProject`, `deleteProject`, `listProjectAccess`, `setProjectAccess` — all shipped                |

Multi-project is not a new capability. It is already happening: `ensureMemberDefaultProject` creates one project per invited member, which is exactly why `projectNameSchema` is deliberately non-unique per org.

## What's actually missing

**API** — `routes/org/projects.ts` defines only `/:projectId` and `/:projectId/access`.

1. `GET /v1/projects` — list projects the caller can reach
2. `POST /v1/projects` — create, seeding the creator as an `owner` binding

**Service** — `project-service.ts` has no `listProjects` and no `createProject`.

**Web** — one page (`settings/project`), hooks `useProject` / `useRenameProject` / `useDeleteProject`. No list hook, no create dialog, no switcher.

**Transport on flat editions** — see Decision 1.

## Design decisions

### 1. How does switching work on flat editions? (the real one)

`proxy.ts` derives project from a `/p/<id>` path prefix, but **strips that prefix entirely when `!CAPS.orgScopedUI`** — which covers `oss` and `onprem-slim`. On those editions the only ways to set project context today are the `?projectId=` query bridge (scoped to `/app-connect`) and the `findUserDefaultProject` fallback. **A switcher on OSS currently has no transport.**

| Option                                                             | Assessment                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A. Default-project cookie**, read by `proxy.ts` → `x-project-id` | **Recommended.** Keeps flat editions flat (no URL change), works on every edition, and mirrors a precedent upstream is _actively building_: `DEFAULT_ORG_COOKIE = "onecli-default-org"` plus `readDefaultOrgCookie()` land in `navigation.ts` in **v1.45.0** (absent from our v1.44.0 base). Define `onecli-default-project` alongside it in the same file, honouring upstream's own comment there — _"One definition so writer and reader can't drift."_ Server still validates via `canAccessProjectAsUser`, so the cookie is a hint, never authority. **Note the extension**: upstream's cookie is read client-side only (`document.cookie`); ours must also be read server-side in `proxy.ts` to become transport. |
| B. Enable `/p/<id>` namespacing on flat editions                   | Changes every URL on OSS, touches proxy + nav + every link. Large blast radius for a feature that doesn't need it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| C. Extend the `?projectId=` query bridge                           | Ugly to carry across navigations; the bridge exists for a popup with no path, not general use.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

### 2. Does `GET /` match upstream's contract?

Yes, and it should. Upstream's web client already calls `GET /v1/projects` expecting `Project[]`, with an optional `X-Organization-Id` header override. Matching that shape **also fixes the v1.45.0 `GetStartedPicker` 404** flagged in `docs/upstream-sync/reviews/2026-08-05-v1.45.0.md`, so this closes a known upstream-adoption blocker for free.

Filtering must go through the fork's access model — org admins see all, everyone else sees only projects they created or hold a binding on (directly or via a group). **Returning every project in the org would leak project names past `ProjectAccess` bindings.**

### 3. `POST /` is fork-owned surface

Upstream's client has `list`, `rename`, `remove` — **no create**. Nothing upstream calls a project-create endpoint. So `POST /v1/projects` is a surface this fork owns outright, and a future upstream project-create could conflict on shape. Worth noting in `docs/upstream-sync/state.json` as a fork-specific divergence to watch.

### 4. Who can create?

Options: any active org member, or admins only. **Recommend any active member**, with the creator seeded as an `owner` binding — that matches the existing implicit behaviour (`ensureMemberDefaultProject` gives every member a project) and avoids making project creation an admin bottleneck. Needs a per-org project cap to bound abuse.

## Invariants that must not break

1. **`findUserDefaultProject` and `hasResolvableProjectExcluding` MUST stay in sync.** The comment in `organization-service.ts` is emphatic: drift is a lockout — a user whose last project is deleted resolves no project and session auth 401s them everywhere. Adding create/list touches project resolution; both predicates must be re-checked together.
2. **Default-project resolution is stable under creation.** Arm 1 is "oldest project you created" (`orderBy: createdAt asc`), so creating a second project does not silently move your default. Preserve that — and note it means there is currently no way to _change_ your default, which Decision 1's cookie would effectively provide.
3. **Guard G — a project must always keep an owner.** Creation must seed the creator's `owner` binding in the same transaction, or a freshly created project is immediately unmanageable.
4. **Slug uniqueness per org.** `@@unique([organizationId, slug])` — creation needs slug generation with collision handling (`slugify` already exists in `organization-service.ts`). A P2002 race must surface as a 409, matching the group-create precedent.
5. **Audit + gateway invalidation.** Per `CLAUDE.md`, create must use `withAudit`. `withAudit` handles gateway cache invalidation when `organizationId`/`projectId` are present.
6. **Guard stack parity.** `POST /` must sit inside the same `app.use("*", …)` chain as the rest of `ossProjectRoutes` — `auth({ requireProject: false })` plus the `scope === "project"` rejection, so a leaked agent key can't create projects.

## Sizing and sequencing

Three stacked PRs, roughly S / M / M:

**PR 1 — `GET /v1/projects` (S).** `listProjects(organizationId, userId)` in `project-service.ts` filtered through the access model, the route, and tests mirroring `projects.test.ts`'s existing cross-org cases. Ships upstream-contract compatibility and closes the v1.45.0 404 on its own. Independently mergeable and useful.

**PR 2 — `POST /v1/projects` (M).** `createProject` with owner-binding seed in one transaction, slug generation + 409 on collision, per-org cap, `withAudit`, guard-stack parity. Tests: creator gets an owner binding, cross-org rejection, cap enforcement, slug collision, project-scoped key 403.

**PR 3 — web: switcher + create dialog (M).** `useProjectsList` + `useCreateProject` hooks, a project switcher in the dashboard nav, create dialog, and the Decision-1 cookie plumbed through `proxy.ts`. Largest UI surface; benefits from 1 and 2 being settled first.

**PR 4 — org switching (M–L).** See below. Sequenced last, and ideally after the v1.45.0 adoption.

---

# Follow-up: org switching

## The gap

Structurally identical to projects — transport and authz exist, discovery and UI don't — **plus one architectural blocker projects don't have.**

`resolveOrganizationId` already reads `x-organization-id` and validates active membership. But there is **no org list endpoint anywhere** (nothing under `/v1/organizations`; `routes/org/index.ts` mounts only members, invitations, groups, role-mappings, policy, budgets, projects), and no web surface — no `api/organizations.ts`, no `use-organizations` hook.

**Multi-org membership is genuinely reachable today, on every edition.** `bootstrapOrganization` gives every user their own org as `owner`, and accepting an invitation upserts an `OrganizationMember` row in someone else's org. So the moment anyone accepts an invite they belong to two orgs, with no way to see or switch between them.

## The blocker: resolution precedence

In `middleware/auth/session.ts`, **project wins and org is derived from it**:

```
projectId = resolveProjectId(request, userId)
if (projectId) {
  organizationId = resolveOrganizationIdFromProject(projectId)   // x-organization-id IGNORED
  return { projectId, organizationId }
}
organizationId = resolveOrganizationId(request, userId)          // header only reached here
```

And `resolveProjectId` falls back to `findUserDefaultProject` whenever `CAPS.tenancy !== "multi-org"`. On `oss` (`org-per-user`) and `onprem-slim` (`single-org-shared`) a project therefore _always_ resolves — so **`x-organization-id` is dead on flat editions.** Org switching there is not a missing-UI problem; the resolution order defeats it. On `cloud` (`multi-org`) it already works, because no project header means `resolveProjectId` returns null and the org header gets its turn.

This is why org switching is a genuine follow-up rather than a sibling of the project work: it changes the most security-sensitive resolution path in the app.

### How to fix it

| Option                                                                                                                                                   | Assessment                                                                                                                                                                                                                                                                                                                                                                                                   |
| -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **A. Make the default-project fallback org-aware** — `findUserDefaultProject(userId, preferredOrgId?)`, with `preferredOrgId` from the org cookie/header | **Recommended.** Switching org then means "land on my default project _within that org_." Precedence is untouched, `x-organization-id` stops being dead without inverting anything, and org and project can never disagree because org is still derived from the winning project. Falls back to today's unfiltered behaviour when the selected org has no reachable project, so the lockout invariant holds. |
| B. Invert precedence — org header wins, project must belong to it                                                                                        | Touches the lockout invariant and the resolution path every request depends on. Also introduces a genuine mismatch class: `resolveProjectId` validates a project against _any_ org the user belongs to, not the selected one, so a stale project header from org A would need explicit rejection under org B.                                                                                                |
| C. No org switcher — switch org implicitly by picking a project in it                                                                                    | Zero new mechanism, and the project switcher (PR 3) already spans orgs. But it's poor UX for an org where you hold no project binding yet, and it leaves `x-organization-id` dead. Reasonable interim if PR 4 slips.                                                                                                                                                                                         |

**Option A keeps the invariant that org is always derived from the resolved project** — which is what makes the current design coherent. Preserve it.

## Sequencing

**Adopt v1.45.0 first.** It ships `DEFAULT_ORG_COOKIE` and `readDefaultOrgCookie()` — the org half of the cookie mechanism. Building an org switcher before adopting means writing a parallel mechanism that then conflicts on merge. If v1.45.0 adoption stalls on its own blocker (`ee_apps::has_request_guard`), cherry-picking just the `navigation.ts` cookie definitions is a viable shortcut.

## Scope of PR 4

1. `GET /v1/organizations` — list orgs where the caller is an _active_ member (`activeMembershipWhere`), returning id/name/slug/role. New file `routes/org/organizations.ts`, or extend `organization-service.ts` with `listUserOrganizations`.
2. `findUserDefaultProject(userId, preferredOrgId?)` — Decision A. **`hasResolvableProjectExcluding` must be updated in lockstep** (invariant 1); the two predicates are required to agree.
3. `proxy.ts` — read the org cookie into `x-organization-id` on flat editions, mirroring the project cookie from PR 3.
4. Web — `api/organizations.ts`, `use-organizations` hook, org switcher in the dashboard nav (alongside the project switcher), writing the cookie on switch.
5. Switching org must clear or re-resolve the project cookie, or you land on a stale project from the previous org.

## Risks specific to PR 4

- **Suspended membership.** `activeMembershipWhere` must fence the list, or a suspended member sees and can select an org they can no longer use.
- **The two predicates.** Any change to `findUserDefaultProject` risks the lockout described in invariant 1. This is the single highest-risk edit in either scope.
- **`onprem-slim` is `single-org-shared`.** An org switcher is meaningless there — gate the UI on membership count > 1 rather than on an edition flag, so it appears exactly when it's useful.
- **Cloud already works.** Don't regress the existing `multi-org` path while making flat editions work; it's the one configuration with live behaviour to preserve.

## Explicitly out of scope

- Changing URL namespacing on flat editions (Decision 1, option B)
- Project transfer between orgs
- Per-project settings beyond what `settings/project` already has
- ~~Reworking `ensureMemberDefaultProject`~~ — **done in slice 5 (#32)**: it
  became `attachMemberToProject`, binding invitees to an existing project
  instead of minting one each
- Org **creation** from the UI (`bootstrapOrganization` / `joinSharedOrganization` remain the only writers) — switching between orgs you already belong to is the ask; creating orgs is a separate product decision
- Leaving an org, and org deletion

## Verification

- `pnpm --filter @onecli/api test` — new list/create cases plus the existing `projects.test.ts` suite
- Cross-org: a member of org A gets 404/empty for org B's projects; list never includes a project the caller has no binding on
- Lockout: create a second project, delete the first, confirm the user still resolves a project (exercises invariant 1)
- Switcher: create project B, switch, confirm agents/secrets/policy all scope to B and the gateway resolves B's connections
- Upstream: confirm `GetStartedPicker` on an `orgScopedUI: true` build now lists projects instead of 404ing

# What testing changed

Slices 1–4 shipped green — full suites, type checks, a real-Postgres run — and
still had three defects that only a person clicking around could find. Worth
recording, because they share a shape: **a scope that was correct on the server
and wrong on the client, with no error anywhere.**

1. **The proxy never runs on API calls.** `proxy.ts` translates the scope
   cookies into headers, but its matcher excludes `v1`. Page requests carried
   the selected project; every client call to `/v1/*` did not, so
   `resolveProjectId` fell back to the caller's DEFAULT project and writes
   landed in the wrong place while the page around them looked right. Fixed in
   #30 by implementing `getProjectId`/`getOrganizationId` — which existed as
   `undefined` stubs for exactly this purpose — and having `apiFetch` send them.
2. **The lockout fallback was too broad.** Selecting an org with no reachable
   project silently resolved a project in the DEFAULT org, and since `session.ts`
   derives org from project, every page then read from the wrong org. Fixed in
   #31: the fallback is now opt-out via `strict`, passed whenever the org was
   chosen explicitly. Returning null is safe — "this org, no project yet" is a
   state the API already models.
3. **Mount effects don't re-run.** Both switchers read their cookie in a
   `useEffect(…, [])`, which does not fire again when they write a new one;
   `router.refresh()` re-renders server components but leaves client state
   alone. They now hold the pending selection.

The lesson for slices 6 and 7: **exercise the client path, not just the server
one.** Every one of these passed every automated check.

# Slice 6: projects view

## The gap

#31 made "this org, no project yet" a correct, reachable state — and a dead
end, because there is nowhere in the UI to create or pick a project from. The
switcher only lists what you can already reach.

## Scope

A `/projects` page listing the current org's projects with, per row, the access
dialog from #13 and rename/delete from `project-service`. Almost entirely
assembly: `GET` (#21), `POST` (#22), `PATCH`/`DELETE` and `GET/PUT
/:projectId/access` all exist and are tested.

- Nav entry alongside Groups and Team, admin-visible on the same "render it and
  let the API 403" pattern the rest of the dashboard uses.
- Empty state that offers creation — this is what the org-with-no-project case
  lands on.
- Reuse `CreateProjectDialog`; do not write a second one.

## What to watch

- **`GET /v1/projects` returns only what the caller may reach.** An org admin
  sees every project, a member sees their bindings. The page must not imply the
  list is the org's full inventory to a non-admin.
- **Deleting your last project is a lockout.** `deleteProject` already guards it
  (`hasResolvableProjectExcluding`); surface that refusal as a clear message
  rather than a generic error.
- Switching to a project from this page should go through the same cookie write
  the switcher uses, not a second mechanism.

# Slice 7: org settings page (rename)

## The gap

Organizations can only be renamed by DB surgery. `validateOrgName` already
exists in `organization-service.ts` and is unused.

## Scope

- `PATCH /v1/organizations/:organizationId` — only `GET /` exists today
  (`routes/org/organizations.ts`, added in #26). Admin-only, org-fenced,
  `withAudit`, and the same `scope === "project"` fence the file already
  applies: a leaked agent key must not rename the organization.
- A settings page mirroring `settings/project`, which is the closest existing
  shape — reuse its card layout rather than inventing one.

## What to watch

- **Renaming must not touch `slug`.** It is `@@unique([organizationId, slug])`
  and is write-only provenance, exactly as `renameProject` treats a project's
  slug. Changing it would break any URL or record that captured it.
- Name is not unique across orgs and should not become so — the same reasoning
  as `projectNameSchema`.
- The org name appears in the switcher; invalidate `queryKeys.organizations`
  after a rename or it shows the old name until reload.
