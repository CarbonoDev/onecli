# OneCLI

Open-source gateway that sits between AI agents and the services they call — stores credentials once and injects them into outbound requests so agents never see the secrets. This repo holds the web app, the Rust gateway, and the shared API/DB packages.

## IMPORTANT: This Repo Is an Independent Fork

This is an independent OSS fork. The EE/cloud edition **never builds here**:

- `apps/web/src/ee/` does not exist, and nothing sets `NEXT_PUBLIC_EDITION` — it always defaults to `"oss"` (see `apps/web/next.config.js`).
- The `@/ee/*` `resolveAlias` maps in `next.config.js` (cloud, onprem-full, onprem-slim) are therefore **dead code**. Do not treat them as a constraint, and do not duplicate a helper or contort a design to keep a cloud/onprem build working — no such build runs in this repo.
- The same goes for the cloud-only surfaces they reach: Cognito auth (`EDITION_INFO.auth === "cognito"` in `packages/api/src/lib/edition.ts`), the `COGNITO_*` env vars under the "Cloud" banner in `lib/env.ts`, and Stripe billing. All are unreachable here.

## Commands

```bash
pnpm dev          # Start development
pnpm dev:web      # Start only the Next.js app
pnpm build        # Build all
pnpm check        # Lint + types + format
pnpm fix          # Auto-fix lint + format
pnpm test         # Run tests
pnpm db:up        # Start local PostgreSQL (Docker)
pnpm db:generate  # Generate Prisma client
pnpm db:migrate   # Run migrations (dev)
pnpm db:studio    # Open Prisma Studio
```

## Structure

```
apps/web/         # Next.js 16 app (App Router)
apps/gateway/     # Rust proxy gateway (onecli-gateway)
packages/api/     # Shared API: routes, services, validations (@onecli/api)
packages/db/      # Prisma ORM + migrations
packages/ui/      # Shared components (shadcn/ui)
packages/eslint-config/
packages/typescript-config/
```

## Environment Variables

See `.env.example` for the full list.

- `DATABASE_URL`: PostgreSQL connection string
- `NEXTAUTH_SECRET`: Set it to enable Google OAuth login; unset means single-user local mode
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`: Google OAuth credentials
- `AUTH_MODE`: Gateway auth — `local` skips JWT validation, `oauth` validates NextAuth cookies
- `SECRET_ENCRYPTION_KEY`: Encrypts stored secrets (auto-generated on first container start)
- `APP_URL`: Canonical external URL — required whenever users reach OneCLI at anything other than the default

## Code Style

- **Use strong typing** - leverage types from external packages; avoid `any` and type assertions
- Prefer named exports over default exports (except Next.js pages/layouts where required)
- Use `@onecli/ui/*` for shared UI imports, `@/` for app-local imports, `@dashboard/*` for dashboard shared components
- Use `cn()` for class merging
- Mark client components with `"use client"`
- Prefer Tailwind utilities over custom CSS
- Use const arrow functions, not function declarations (for components and utilities)

## Component Structure

- **One component per file** - never put multiple components in the same file (includes page.tsx)
- **Page-specific components** - create `_components/` subdirectory in the route folder:
  ```
  app/(dashboard)/overview/
  ├── page.tsx
  └── _components/
      ├── overview-header.tsx
      └── recent-activity.tsx
  ```
- **Props typing** - use base types directly, only create named interface when adding custom props:

  ```tsx
  // ✓ No custom props - use base type directly
  export const Card = ({ className, children, ...props }: React.ComponentProps<"div">) => { ... };

  // ✓ Custom props - create interface
  export interface ServiceCardProps extends React.ComponentProps<"div"> {
    connected?: boolean;
  }
  ```

- **Multi-component features**: Create a directory with an `index.ts` barrel export

## IMPORTANT: shadcn/ui Components

Components in `packages/ui/src/components/` are from shadcn/ui.

**Allowed:**

- Adding new variants/sizes to CVA definitions
- Customizing via `className` when using components
- Wrapping in your own component

**NOT Allowed:**

- Changing existing variant styles
- Modifying component structure or logic
- Removing existing functionality

When adding components, use shadcn CLI or copy from ui.shadcn.com.

## Dependencies

- Use Radix UI only through shadcn/ui, never import directly
- Check shadcn for components before adding dependencies
- Keep bundle size small - prefer lightweight alternatives

## Web App Patterns

- Server components by default, add `"use client"` only when needed
- Pages export `default function` (async for data fetching)
- Auth: NextAuth v5 with a single Google provider (`lib/auth/nextauth-config.ts`); React context in `providers/auth-provider.tsx`
- Auth mode: falls back to `authMode: "local"` (single admin user, no login) when `NEXTAUTH_SECRET` is unset — see `lib/runtime-config.ts`
- Server-side auth: `getServerSession()` from `@/lib/auth/server`
- Validation: Zod for API inputs
- **Button loading states** - replace icon with spinner, update text (e.g., "Connecting..."), and disable
- **Verify library APIs are current** - check official docs for deprecated/legacy patterns before implementing

## Audit Logging

All state-changing operations (create, update, delete, regenerate) must be audited. Use the `withAudit` wrapper from `@onecli/api/services/audit-service`.

**Pattern:**

```typescript
import { resolveProjectContext } from "@/lib/actions/resolve-user";
import {
  withAudit,
  AUDIT_ACTIONS,
  AUDIT_SERVICES,
} from "@onecli/api/services/audit-service";

export const createAgent = async (name: string, identifier: string) => {
  const { userId, userEmail, projectId } = await resolveProjectContext();
  return withAudit(
    () => createAgentService(projectId, name, identifier),
    (agent) => ({
      projectId,
      userId,
      userEmail,
      action: AUDIT_ACTIONS.CREATE,
      service: AUDIT_SERVICES.AGENT,
      metadata: { agentId: agent.id, name, identifier },
    }),
  );
};
```

**Available constants** — see `packages/api/src/services/audit-service.ts` for the full set (several entries are EE-only):

- `AUDIT_ACTIONS`: `CREATE`, `UPDATE`, `DELETE`, `REGENERATE`, `DISCONNECT`, `PUBLISH`
- `AUDIT_SERVICES`: `AGENT`, `SECRET`, `POLICY`, `GRANT`, `API_KEY`, `APP_CONNECTION`, `APP_CONFIG`, `PROJECT`, `ORGANIZATION`, `MEMBER`, `INVITATION`, `GROUP`
- `AUDIT_STATUS`: `SUCCESS`, `FAILURE`
- `AUDIT_SOURCE`: `APP`, `API`

Events are scoped by `projectId` / `organizationId`, not `accountId`.

**Metadata guidelines:**

- Include resource IDs (agentId, secretId, policyId)
- Include relevant identifiers (name, type)
- Never include sensitive values (tokens, secrets, passwords)

**When to audit:**

- Actions layer (`lib/actions/`) - always use `withAudit`
- API routes (`packages/api/src/routes/`) - use `withAudit` with `source: AUDIT_SOURCE.API`
- Read operations - do not audit

## Database (Prisma)

- Schema at `packages/db/prisma/schema.prisma`
- Always run `pnpm db:generate` after schema changes
- Migrations run automatically on container startup via `docker/entrypoint.sh` (`prisma migrate deploy`)

## CI & Release

Three workflows in `.github/workflows/`:

- `ci.yml` — runs on PRs to `main`: lint, format, types, and tests (the Rust gateway job only when `apps/gateway/**` changed)
- `release.yml` — release-please on pushes to `main`; opens/merges the release PR and tags
- `publish.yml` — on `v*` tags, builds the multi-arch (amd64/arm64) Docker image from `docker/Dockerfile` and pushes it to `ghcr.io`

Deployment is by container image — there is no cloud infrastructure code in this repo.
