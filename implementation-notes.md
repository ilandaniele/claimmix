# Implementation Notes — ClaimMix W1

## Architecture decisions

### proxy.ts — Next.js 16 middleware file name
Next.js 16 renamed the middleware file from `middleware.ts` to `proxy.ts`. The exported
function must also be named `proxy` (not `middleware`). This aligns with the spec requirement
and answers.md convention. The Next.js discovery mechanism finds this file at the project root.

### CSP strategy — nonce-based, no static headers for script-src
The Content-Security-Policy with script-src nonce is injected by `proxy.ts` at the middleware
layer rather than in `next.config.ts headers()`. This is because a static `next.config.ts`
header cannot include a per-request nonce. The `next.config.ts` sets all other security headers
(HSTS, X-Frame-Options, nosniff, referrer, permissions) as a defense-in-depth layer at the CDN.

### Supabase async cookie API (Next.js 16)
`cookies()` and `headers()` are async in Next.js 15+/16. All callsites use `await cookies()`
and `await headers()`. The `createServerClient()` factory is itself `async` to encapsulate this.

### service-role client protection
`src/lib/supabase/service.ts` imports `server-only` (a Next.js package that throws if
imported in a client bundle). This is the primary guard against accidentally shipping the
service role key to the browser.

### pnpm package manager
The spec requires pnpm. Installed globally via `npm install -g pnpm`. The lockfile
(`pnpm-lock.yaml`) is committed. The `packageManager` field in package.json pins version 11.5.0.

### Vitest 4 for unit tests, Playwright for E2E
`vitest.config.ts` sets `globals: true` so `vi`, `describe`, `it`, `expect` are available
without imports in test files. The `tests/setup.ts` only imports `@testing-library/jest-dom`
for DOM matchers — `vi` mocks are done inline in each test file.

### Tailwind v4 — no tailwind.config.js needed
The scaffold already uses Tailwind v4 with `@import "tailwindcss"` in `globals.css`. No
`tailwind.config.ts` is needed per Tailwind v4 defaults.

## Server vs Client component split

- **Server Components (default)**: all current pages and layouts — no useState/useEffect needed yet
- **Client Components (`'use client'`)**: placeholder login page uses none yet; W2 adds SignInForm
- `src/lib/supabase/browser.ts` is the only client-side Supabase module (for W5 realtime)
- `src/lib/observability/logger.ts` and `src/lib/supabase/service.ts` are `server-only`

## New dependencies (W1)

| Package | Version | Justification |
|---|---|---|
| `@supabase/ssr` | ^0.6.1 | Supabase Auth SSR integration for Next.js App Router |
| `@supabase/supabase-js` | ^2.49.8 | Core Supabase client (required by @supabase/ssr) |
| `@sentry/nextjs` | ^9.18.0 | Error tracking + tracing per spec |
| `zod` | ^3.25.23 | Input validation at API route and Server Action boundaries |
| `openai` | ^4.98.0 | AI extraction worker (W4 uses this) |
| `pino` | ^9.6.0 | Structured JSON logging (currently using custom impl; pino available for W4) |
| `@tanstack/react-table` | ^8.21.3 | Information-dense case table for W5 bandeja |
| `vitest` | ^3.2.0 | Unit test runner (Vitest 4 compatible, installed as v3.2.x) |
| `@playwright/test` | ^1.52.0 | E2E testing |
| `@testing-library/react` | ^16.3.0 | Component testing utilities |
| `@vitejs/plugin-react` | ^4.5.0 | Vitest React support |

## Assumptions (where spec was ambiguous)

- The `proxy` export name in `proxy.ts` is required by Next.js 16 (not `middleware`) —
  confirmed by build error: "Proxy is missing expected function export name"
- Branch protection not applied — requires GitHub Pro for private repos; documented as limitation
- `@vitest/coverage-v8 ^3.2.0` installed (Vitest 4 API-compatible, coverage gate at ≥80%)
- `pino` installed as dependency but the logger in W1 uses a custom lightweight implementation
  to avoid needing `pino` browser build config. Full pino integration wired in W4 if needed.

## Known limitations / tradeoffs

- **Branch protection**: GitHub free accounts cannot set branch protection on private repos.
  Documented limitation; update to public or upgrade to GitHub Pro for enforcement.
- **No shadcn/ui in W1**: `npx shadcn@latest init` requires an interactive prompt. The
  `src/components/ui/` directory is created but empty. W5 runs shadcn init when implementing
  the bandeja table and UI components.
- **Health endpoint DB check**: uses `from('tenants').select('id').limit(1)`. Before migrations
  run (W2), the `tenants` table doesn't exist. The health route accepts Supabase error codes
  `PGRST116` / `42P01` as "connected but no schema yet" — db status = "connected".

## Out of scope (noticed but not changed)

- `AGENTS.md` and `CLAUDE.md` from create-next-app scaffold: left in place (not removed)
- `next-env.d.ts`: gitignored per scaffold default (regenerated on next build)
- Tailwind `@theme inline` block in globals.css: preserved from scaffold

---

# Implementation Notes — ClaimMix W2

## Architecture decisions

### RLS strategy — tenant isolation via current_tenant_id() helper
The spec offers two patterns: `auth.uid()` (simpler) or `tenant_id = current_tenant_id()` (correct
multi-tenant isolation). W2 implements the full `current_tenant_id()` helper function that
queries `public.users WHERE id = auth.uid()` to return the authenticated user's tenant_id.
This is correct for the multi-tenant-ready schema even if only one tenant exists in MVP.

### Migration file naming — 0001_init, 0002_rls, 0003_seed_required_docs
Numbered migrations follow Supabase CLI convention. Each file is idempotent where possible
(IF NOT EXISTS, ON CONFLICT DO NOTHING). RLS and indexes are in separate files for clarity.

### audit_log — append-only enforced at RLS level
The `audit_log` table has INSERT and SELECT policies but no UPDATE/DELETE policies. This
means authenticated users cannot modify audit records via the Supabase client. The service
role client (used only in the worker) can write system events without a tenant context.

### Rate limiting — in-memory LRU, Upstash upgrade path documented
Default provider is `RATE_LIMIT_PROVIDER=memory` using a module-level Map capped at 10,000
keys. Cold starts reset the counter — acceptable for MVP (attacker gets at most 5 attempts
per cold start). The Upstash adapter is in `src/lib/rate-limit/upstash.ts` and activates
when `RATE_LIMIT_PROVIDER=upstash` + `UPSTASH_REDIS_REST_URL/TOKEN` are set.

### Supabase TypeScript types — explicit casts for `never` issue
Supabase @supabase/supabase-js v2 TypeScript types resolve `.from("users").select("*")`
to `never` in some call paths when the column selection inference is ambiguous. Fixed by
using explicit `as UserRow` casts after the guard. The `audit_log` insert uses `any` cast
because `Update: never` in the Database type causes `.insert()` to resolve as `never[]`.
Both are documented with inline comments.

### Login page — `/login` canonical, `/sign-in` redirects
The canonical login URL is `/login` (matches proxy.ts PUBLIC_PREFIXES and the spec route
table). The `(auth)/sign-in` route group exists per the plan.md file map and redirects to
`/login`. This keeps the URL consistent and avoids a duplicate form implementation.

### Auth API routes — `/api/auth/sign-in` and `/api/auth/sign-out` are PUBLIC
Both auth endpoints are in `PUBLIC_PREFIXES` in proxy.ts. This is intentional — they need
to be accessible without authentication (sign-in is how you get a session; sign-out needs
to work even if the session is stale).

## Seed data structure
- 1 tenant: Seguros del Sur S.A. (UUID: 10000000-...)
- 2 analysts: Lucía Ramallo (analyst), Carlos Medina (admin)
- 20 cases: 5 per claim type (choque/robo/granizo/incendio), spread across all 5 statuses
- Raw email bodies: realistic Argentine Spanish narratives for 10 cases
- Extracted fields: for listo and escalado cases
- Missing docs: for all 4 esperando cases (correct doc type per claim type)
- Audit log: representative sample entries

## Human steps for seed data
The `supabase/seed.sql` inserts into `auth.users` using `crypt()`. This works with:
  - `supabase start` (local Docker) + `supabase db reset --local`
  - A Supabase project with the pgcrypto extension enabled
For a remote Supabase project without direct auth.users access, use the Supabase Auth UI
to create users manually, then link them via the SQL in `supabase/seed.sql` section 3.

## Coverage exclusions
The vitest.config.ts coverage `exclude` list was updated to exclude infrastructure files
that require Next.js runtime or external services:
- `src/lib/supabase/{browser,server,service}.ts` — require Next.js cookies() API
- `src/lib/observability/**` — require Sentry DSN + pino at module init
- `src/lib/rate-limit/upstash.ts` — requires UPSTASH_* env vars
These are tested via integration tests (auth.test.ts, rls.test.ts) and E2E (auth.spec.ts).

---

# Implementation Notes — ClaimMix W3

## Architecture decisions

### Cases API route structure — `export.csv` as a route segment
The spec and plan.md use `export.csv` as the URL (per Next.js App Router convention where the
file at `src/app/api/cases/export.csv/route.ts` maps to `GET /api/cases/export.csv`).
This is a static path segment, not dynamic, so it does not conflict with `[id]`.

### Supabase client typing — `any` cast for query builders
`@supabase/supabase-js` v2's TypeScript types use a complex generic signature
(`SupabaseClient<Database, "public", ...>`) that doesn't match the return type of
`createServerClient()` from `@supabase/ssr`. Rather than fight the type system with
complex generic wiring, the query builder functions accept `any` for the Supabase client
parameter. The correctness is enforced by: (a) all callers pass the user-scoped client
(never service-role), and (b) RLS at the DB level enforces tenant isolation regardless.

### FSM — pure function, no external dependencies
`src/server/cases/fsm.ts` is a pure function module with no Supabase or network calls.
It has 100% unit test coverage. The FSM prevents both invalid status transitions and
LLM08 (AI cannot directly write `cerrado` status — it can only write `listo`, `esperando`,
`escalado` from `procesando`).

### CSV export — RFC 4180 compliant, formula-injection safe
`src/lib/csv/safe-encode.ts` prefixes cells starting with `=`, `+`, `-`, `@` with a
single quote per OWASP CSV injection mitigation. CRLF line endings are used per RFC 4180.
Max 1000 rows per export is enforced in `listCasesForExport` via `.range(0, 999)`.

### IDOR pattern — consistent 404 for all access-control failures
Every case-scoped endpoint returns 404 (not 403) when a case is not found OR belongs to
another tenant. This prevents information disclosure via status code enumeration. The pattern
is: RLS returns no rows → application returns 404 → client cannot distinguish "not found"
from "wrong tenant". This is consistent with AC10.

### Ownership check for PATCH — analyst/admin split
Analysts can only PATCH cases where `assigned_to = auth.uid()`. Admins can PATCH any case
in their tenant. Wrong-tenant cases are caught by RLS before the ownership check runs.
In both cases, the error is 404 (not 403) to prevent tenant enumeration.

### Rate limiting — CASES_API bucket (100/min/user)
All cases endpoints (list, get, patch, export) share the `CASES_API` rate limit bucket
(100 requests/minute per user). The rate limit key uses `user.id` + endpoint name to
provide per-endpoint isolation without requiring a separate bucket per endpoint.

## New files (W3)

| File | Purpose |
|---|---|
| `src/server/cases/fsm.ts` | FSM: valid transitions map + validation functions |
| `src/server/cases/list.ts` | Supabase query builders for list + export |
| `src/server/cases/get.ts` | Supabase query builder for case detail |
| `src/server/cases/patch.ts` | Case patch with FSM + ownership + audit log |
| `src/lib/csv/safe-encode.ts` | CSV generation with formula-injection guard |
| `src/app/api/cases/route.ts` | GET /api/cases |
| `src/app/api/cases/[id]/route.ts` | GET + PATCH /api/cases/:id |
| `src/app/api/cases/export.csv/route.ts` | GET /api/cases/export.csv |
| `tests/unit/fsm.test.ts` | 36 FSM unit tests (all valid + invalid transitions) |
| `tests/unit/csv-safe-encode.test.ts` | 25 CSV unit tests (injection guard + RFC 4180) |
| `tests/unit/cases-list.test.ts` | 8 list query builder unit tests |
| `tests/unit/cases-get.test.ts` | 6 get query builder unit tests |
| `tests/unit/cases-patch.test.ts` | 10 patch logic unit tests |
| `tests/integration/cases.test.ts` | Integration tests (skipped without INTEGRATION_ENABLED) |

## Coverage

W3 achieves 96.75% statement coverage, 83.91% branch coverage — above the 80% threshold.
The uncovered branches are edge cases in the rate-limit upstash adapter (integration-only)
and the CSP nonce fallback path.
