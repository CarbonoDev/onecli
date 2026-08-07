# Scope: project lifecycle (create · list · switch)

> **Living document.** Updated as each slice lands — keep the status table below
> current, and record decisions that change during implementation rather than
> letting this drift from the code.

## Status

| #   | Slice                         | Size | State                                    |
| --- | ----------------------------- | ---- | ---------------------------------------- |
| 1   | `GET /v1/projects` — list     | S    | in progress                              |
| 2   | `POST /v1/projects` — create  | M    | not started                              |
| 3   | Web: switcher + create dialog | M    | not started                              |
| 4   | Org switching (follow-up)     | M–L  | not started, blocked on v1.45.0 adoption |

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
- Reworking `ensureMemberDefaultProject` — once users can create projects deliberately, auto-creating one per invited member becomes questionable, but that is a follow-up decision, not part of this scope
- Org **creation** from the UI (`bootstrapOrganization` / `joinSharedOrganization` remain the only writers) — switching between orgs you already belong to is the ask; creating orgs is a separate product decision
- Leaving an org, and org deletion

## Verification

- `pnpm --filter @onecli/api test` — new list/create cases plus the existing `projects.test.ts` suite
- Cross-org: a member of org A gets 404/empty for org B's projects; list never includes a project the caller has no binding on
- Lockout: create a second project, delete the first, confirm the user still resolves a project (exercises invariant 1)
- Switcher: create project B, switch, confirm agents/secrets/policy all scope to B and the gateway resolves B's connections
- Upstream: confirm `GetStartedPicker` on an `orgScopedUI: true` build now lists projects instead of 404ing
