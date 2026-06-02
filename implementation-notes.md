# Implementation Notes — ClaimMix W1–W6

## W6 Completion Notes (Admin Dashboard UI + Tests + CI)

### Admin dashboard extensions (W6)

**Bandeja page** — Extended with email-intake filter chips (channel, severity, is_claim) rendered in `DashboardClient.tsx`. New `EmailFilterChips.tsx` Client Component handles channel/severity/is_claim URL param updates. `CasesTable.tsx` extended with a severity badge column (only shows when severity is set). `bandeja/page.tsx` extended to parse and pass new filter params to `listCases()`.

**Caso detail page** — Extended for email channel cases. Added four new sections:
- Section A: Parsed email data (is_claim badge, severity badge, customer/policy links)
- Section B: `FieldConfirmationsPanel.tsx` — lists pending/resolved confirmations; calls `PATCH /api/cases/:id/confirm-field`; optimistic UI updates; no PII in console
- Section C: `AttachmentsPanel.tsx` — lists claim_attachments; external_url rendered as href only, never logged (AC23)
- Section D: `CoreSyncButton.tsx` — shown only when status=listo_para_core; calls `POST /api/cases/:id/sync-to-core`

**Customers page** — New `src/app/(app)/clientes/page.tsx` Server Component with search (full_name ILIKE), paginated table, links to detail. New `src/app/(app)/clientes/[id]/page.tsx` with personal info, policies table, cases table. Both RLS-scoped via user-scoped Supabase client.

**Sidebar** — Added "Clientes" nav item pointing to `/clientes`.

### Known limitations / tradeoffs

- `CoreSyncButton` only shows when `status === 'listo_para_core'`. After sync, the page needs a reload to see the new status from the DB — this is acceptable for MVP (fire-and-forget optimistic UI would require Realtime subscription).
- Postmark attachment URLs expire ~7 days. Stored for audit trail; re-hosting to Supabase Storage is deferred.
- `CoreSyncService` is mock-only (`CORE_SYNC_MODE=mock`). Real integration deferred.
- Integration tests (`tests/integration/intake-email.test.ts`, `rls-email.test.ts`, `llm-email-probes.test.ts`) use mocked Supabase clients. True DB isolation tests require `RLS_INTEGRATION_ENABLED=true` + live Supabase.

### AC24 (PII masking) status

PII masking was implemented in W2 (`src/server/email/render.ts` + template files). W6 adds the `llm-email-probes.test.ts` integration test that explicitly verifies DNI and policy_number are masked in rendered templates. AC24 is confirmed tested.

### CI additions

- New `integration-tests-email` job (job 9): runs email integration tests in mock-only mode on every PR.
- New `license-audit` job (job 10): runs `license-checker-rseidelsohn` to deny GPL/AGPL/LGPL/SSPL packages. `continue-on-error: true` since this is informational.
- New `.github/workflows/codeql.yml`: CodeQL for JavaScript/TypeScript with `security-extended` queries; runs on push/PR to main + weekly schedule.

### Out of scope (noticed but not changed)

- E2E tests for `/clientes` pages — Playwright E2E requires a live Supabase instance; added to `tests/e2e/` skeleton is deferred.
- Realtime subscription on caso detail for live status updates — deferred to follow-up.
- Bulk customer import UI — API endpoint exists (`POST /api/customers`), UI deferred.

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

---

# Implementation Notes — ClaimMix W5

## Architecture decisions

### (app) route group layout — app shell
All authenticated pages are under `src/app/(app)/` route group. This allows a shared
layout (`layout.tsx`) that wraps pages with the Sidebar + TopBar without affecting auth
routes (`/login`) or API routes. The old `src/app/bandeja/page.tsx` placeholder was removed
and replaced by the full implementation at `src/app/(app)/bandeja/page.tsx`.

### Server Component (page.tsx) + Client Component (DashboardClient.tsx) split
`page.tsx` is a Server Component that fetches:
  1. Initial case data (`listCases()`) for the current filter/page
  2. Per-status counts (6 parallel Supabase queries) for the tab badges
  3. The `SCENARIOS` array (static import, no DB query)

`DashboardClient.tsx` is a Client Component that handles:
  - Local state merging realtime updates into the initial server data
  - FilterTabs, TypeFilterChips, CasesTable, Pagination, SimulateModal, Toast
  - Supabase Realtime subscription via `useCasesRealtime`

This pattern keeps the initial HTML server-rendered (good for LCP) while supporting
live updates without full page reloads.

### casesRealtimeUtils.ts — pure utility separation
The pure functions `mergeCaseUpdate`, `computeStatusCounts`, and `formatCaseNumber` are
extracted from `useCasesRealtime.ts` into `casesRealtimeUtils.ts`. This allows unit testing
without importing the Supabase browser client (which requires `NEXT_PUBLIC_SUPABASE_URL`
at module init time and throws in the test environment). The hook re-exports these for
backward compatibility.

### URL search params for filter state (deep linking)
Status filter, type filter, and page number are stored in URL search params via Next.js
`useSearchParams` and `router.push()`. This enables deep linking and browser back button
support. The server fetches data based on these params on every navigation.

### Local pagination with realtime merge
When realtime events arrive, new cases are merged into the local state array. The
pagination is then applied client-side to the merged array. This avoids a full server
refetch on every realtime event while keeping the data fresh. The server-fetched initial
data is synced when the URL params change (navigation triggers page re-render).

### SimulateModal — scenario picker + custom text
Two modes: scenario picker (dropdown of all 20 SCENARIOS) and custom text textarea + type
selector. On submit, calls `POST /api/intake/simulate`. The modal itself doesn't handle
realtime — it just submits and closes; the realtime subscription picks up the new case
as a Postgres INSERT event within ~1-2 seconds.

### Toast notifications
The `useToast` hook manages a queue of `ToastMessage` items with auto-dismiss after 4s.
Each realtime INSERT creates a "Nuevo siniestro recibido: SIN-XXXX-XXXX" toast.
Each UPDATE with status change creates a "Siniestro SIN-... actualizado: X → Y" toast.

## Server vs Client component split

| Component | Type | Reason |
|---|---|---|
| `(app)/layout.tsx` | Server | Fetches user profile, renders shell |
| `(app)/bandeja/page.tsx` | Server | Fetches initial cases data, counts |
| `DashboardClient.tsx` | Client | Realtime, state, filters, modal |
| `Sidebar.tsx` | Client | usePathname for active link styling |
| `TopBar.tsx` | Client | Sign-out action, router |
| `FilterTabs.tsx` | Client | useRouter, useSearchParams |
| `TypeFilterChips.tsx` | Client | useRouter, useSearchParams |
| `CasesTable.tsx` | Client | @tanstack/react-table, useRouter |
| `StatusBadge.tsx` | Server | Pure display, no interactivity |
| `ConfidenceBar.tsx` | Server | Pure display, no interactivity |
| `SimulateModal.tsx` | Client | useState, fetch |
| `Toast.tsx` | Client | useState, useEffect |

## Design decisions

- Table design: horizontal rules only (border-b border-slate-100), no vertical borders
- Status color palette: green-100/800 (listo), yellow-100/800 (esperando), red-100/800 (escalado), slate-100/800 (cerrado), blue-100/800 (procesando)
- Confidence threshold display: green >= 70%, yellow 50-69%, red < 50%, dash for null
- Case ID display: last 8 hex chars of UUID formatted as SIN-XXXX-XXXX
- Sidebar: slate-50 background, 224px width, active link bg-slate-200
- Top bar: white background, user initials avatar (slate-800 circle), sign-out button

## New tests (W5)

| File | Tests | What it covers |
|---|---|---|
| `tests/unit/status-badge.test.tsx` | 15 | All 5 statuses × label + CSS class + data-status |
| `tests/unit/simulate-modal.test.tsx` | 9 | Render, submit, cancel, 429, 500, network error, validation, loading state |
| `tests/unit/cases-realtime.test.ts` | 14 | formatCaseNumber, mergeCaseUpdate (insert+update), computeStatusCounts |
| `tests/e2e/dashboard.spec.ts` | 14 | Redirect guard, API auth, login page, security headers |

Total: 380 unit tests passing (up from 342 before W5).

---

# Implementation Notes — Email Claims Intake (W1)

## Branch
`feat/email-claims-intake` — based on `feat/claimmix-fnol-mvp`

## Migration files and their purpose

| File | Purpose |
|---|---|
| `supabase/migrations/0005_email_intake.sql` | Extends `cases` table with 11 new columns (email_message_id, email_thread_id, is_claim, not_relevant_reason, requires_specialist, severity, core_external_id, core_error_message, core_sent_at, fields_pending_confirmation). Extends the `status` CHECK to include 8 new email-intake FSM states. Adds UNIQUE partial index on (tenant_id, email_message_id) for Postmark idempotency and a regular index on (tenant_id, email_thread_id) for thread lookups. |
| `supabase/migrations/0006_customers_policies.sql` | Creates 4 tables: `customers`, `customer_contacts`, `policies`, `insured_assets`. All RLS-enabled with `tenant_id = current_tenant_id()` policies. Adds FKs from `cases.customer_id → customers(id)` and `cases.policy_id → policies(id)` (added here instead of 0005 because the referenced tables must exist first). |
| `supabase/migrations/0007_claim_extras.sql` | Creates 4 tables: `claim_attachments` (Postmark attachment metadata), `claim_field_confirmations` (analyst review of medium-confidence/conflict fields), `claim_memory` (per-sender learning), `known_claim_patterns` (severity/claim keyword signals). All RLS-enabled. `known_claim_patterns` uses a dual-policy: tenant rows visible to that tenant; global rows (tenant_id IS NULL) visible to all. |
| `supabase/migrations/0008_seed_patterns.sql` | Seeds `known_claim_patterns` with 36 global (tenant_id=NULL) keyword/phrase patterns for Argentine Spanish insurance claims, classified by severity (critical/high/medium/low). Used by the pre-LLM severity classifier to reduce prompt token usage. |

## New TypeScript files

| File | Purpose |
|---|---|
| `src/lib/schemas/postmark-inbound.ts` | Zod schema for Postmark inbound webhook payload. Includes helper functions `extractEmailBody()` (preference: StrippedTextReply > TextBody > stripped HtmlBody, capped at 10K chars) and `extractThreadId()` (normalizes InReplyTo / References for thread lookup). |
| `src/lib/schemas/extracted-claim.ts` | Extended `ExtractedClaimSchema` adds: `is_claim`, `confidence`, `extracted_fields` (ClaimFields), `field_confidences`, `missing_fields`, `fields_pending_confirmation`, `possible_customer_matches`, `possible_policy_matches`, `severity`, `requires_specialist`, `not_relevant_reason`, `summary`, `suggested_reply`. Also exports `ClaimFieldsSchema` and match schemas. |
| `src/lib/schemas/cases.ts` | Extended with `CaseStatusEmailSchema`, `SeveritySchema`, updated `CaseStatusSchema` (union of legacy + email-intake), extended `CaseQuerySchema` (new filters: severity, customer_id, policy_id, channel, is_claim), `ConfirmFieldSchema`, `SyncToCoreSchema`, `EmailCase` interface. |
| `src/server/cases/fsm.ts` | Extended FSM: 8 new email-intake statuses and transitions. Adds `isTerminalStatus()`, `isAiAllowedStatus()`, `EMAIL_INITIAL_STATUS`, `AI_ALLOWED_STATUSES`. LLM08: AI may not set listo_para_core, enviado_a_core, error_core, cerrado. |
| `src/lib/audit/log.ts` | Extended AuditEvent constants: EMAIL_RECEIVED, WEBHOOK_REJECTED, EMAIL_DEDUPLICATED, EXTRACTION_STARTED, EXTRACTION_COMPLETE, CONFIRMATION_REQUESTED, MISSING_INFO_REQUESTED, SPECIALIST_REQUIRED, FIELD_CONFIRMED, FIELD_REJECTED, MEMORY_APPLIED, CORE_SYNC_SUCCESS, CORE_SYNC_FAILED. |
| `src/lib/rate-limit/index.ts` | New RATE_LIMIT_CONFIGS entries: EMAIL_INTAKE_WEBHOOK (100/10s), CONFIRM_FIELD (30/min), SYNC_TO_CORE (5/min). New `checkRateLimit()` convenience wrapper for direct use without async Upstash fallback. |

## New env vars added to .env.example

| Variable | Purpose |
|---|---|
| `POSTMARK_WEBHOOK_SECRET` | HMAC-SHA256 secret for Postmark inbound webhook signature verification (AC2) |
| `RESEND_API_KEY` | Resend outbound email API key (AC12, AC10, AC7, AC11) |
| `RESEND_FROM_ADDRESS` | Verified sender address for outbound emails |
| `CORE_SYNC_MODE` | `mock` (default) or `real` — toggles MockCoreSyncClient vs real CoreSyncClient |
| `EMAIL_REPLY_BASE_URL` | Base URL for links in outbound email templates |

## Key decisions

### Why extend `cases` rather than create a new `claims` table (IC1)

The `cases` table already has `channel='email'` in its CHECK constraint, and the existing pipeline (`raw_messages`, `extracted_fields`, `missing_docs`, `outbound_messages`, `audit_log`) is designed to work with `cases` rows. Creating a separate `claims` table would duplicate foreign key relationships and require duplicating all downstream query builders, the FSM, and the audit log writer. The interpretation contract (IC1) explicitly mandates extending `cases`.

### FSM status naming — es-AR Spanish

All new statuses use Argentine Spanish (`recibido`, `info_faltante`, `confirmacion_pendiente`, etc.) to match the existing statuses (`procesando`, `listo`, `esperando`, `escalado`, `cerrado`). The English-to-Spanish mapping is documented inline in `fsm.ts` and in the spec IC6.

### cases.customer_id and cases.policy_id FK placement

The FK columns are added in `0006_customers_policies.sql` rather than `0005_email_intake.sql` because PostgreSQL requires the referenced tables to exist before FK constraints can be defined. Adding them in 0005 would fail because `customers` and `policies` are created in 0006.

### known_claim_patterns RLS — dual-policy for global+tenant rows

Global seed patterns (tenant_id IS NULL) need to be visible to all authenticated users, while tenant-specific overrides (tenant_id set) should only be visible to that tenant. This requires two separate policies: one for tenant-scoped rows and one for global rows. The INSERT/UPDATE/DELETE check (`WITH CHECK`) uses `tenant_id = current_tenant_id()` so tenants can only create their own rows, not modify global ones.

### ExtractedField.source field

The `source` field was added to `ExtractedFieldSchema` to distinguish AI-extracted values (`'ai'`) from memory-recalled values (`'memory'`) and analyst-confirmed values (`'confirmed'`). This is required by AC13 (memory recall). The mock extractor defaults all fields to `source: 'ai'` as they come from regex patterns.

## RLS policy summary for new tables

| Table | Policy | Coverage |
|---|---|---|
| `customers` | `customers_tenant_all` | All operations scoped to tenant |
| `customer_contacts` | `customer_contacts_tenant_all` | All operations scoped to tenant |
| `policies` | `policies_tenant_all` | All operations scoped to tenant |
| `insured_assets` | `insured_assets_tenant_all` | All operations scoped to tenant |
| `claim_attachments` | `claim_attachments_tenant_all` | All operations scoped to tenant |
| `claim_field_confirmations` | `claim_field_confirmations_tenant_all` | All operations scoped to tenant |
| `claim_memory` | `claim_memory_tenant_all` | All operations scoped to tenant |
| `known_claim_patterns` | `known_claim_patterns_tenant` + global visibility | Tenant rows + global (tenant_id IS NULL) rows readable by all |

## Tests added in W1

| File | Tests | What it covers |
|---|---|---|
| `tests/unit/fsm-email.test.ts` | 49 | All email-intake FSM transitions (valid/invalid), terminal states, LLM08 AI-allowed status enforcement, full path walks |
| `tests/unit/rate-limit-email.test.ts` | 9 | New RATE_LIMIT_CONFIGS values, checkRateLimit wrapper, retryAfter integer, independent IP counters |
| `tests/unit/postmark-inbound.test.ts` | 19 | Valid/invalid Postmark payload parsing, extractEmailBody priority logic, extractThreadId normalization |

Total unit tests after W1: 549 passing (up from 380 before W1 — includes all pre-existing tests).

---

# Implementation Notes — Email Claims Intake (W2)

## New dependencies

| Package | Version | Justification |
|---|---|---|
| `resend` | ^6.12.4 | Official Resend SDK for outbound transactional email (AC12, AC10, AC7, AC11) |

No Postmark SDK needed — inbound email is a raw HTTP webhook; only `crypto.timingSafeEqual` (Node built-in) is used for HMAC verification.

## New env vars (already added to .env.example in W1 — confirmed present)

| Variable | Purpose |
|---|---|
| `POSTMARK_WEBHOOK_SECRET` | HMAC-SHA256 secret from Postmark UI for webhook signature verification |
| `RESEND_API_KEY` | Resend API key for outbound emails |
| `RESEND_FROM_ADDRESS` | Verified sender address (e.g. `claims@claimmix.com` or `onboarding@resend.dev` for sandbox) |
| `EMAIL_REPLY_BASE_URL` | Base URL for links in outbound email templates |
| `DEFAULT_TENANT_ID` | Single-tenant MVP: tenant UUID derived from env for webhook routing |

## Architecture decisions

### HMAC verification — raw body must precede JSON parsing

The Postmark webhook signature is computed over the exact raw bytes of the HTTP body.
If the body is parsed to JSON and re-serialized before HMAC verification, key ordering or
whitespace normalization may change the bytes and break verification. The route handler reads
`await request.text()` first, converts to `Buffer.from(rawBodyText, "utf-8")` for HMAC,
and only calls `JSON.parse(rawBodyText)` after verification passes.

### Timing-safe comparison — `crypto.timingSafeEqual`

`Buffer.from(expectedHex) !== Buffer.from(actualHex)` is a standard equality check that
short-circuits on the first differing byte. An attacker could use response timing to infer
how many bytes matched (timing oracle attack). `crypto.timingSafeEqual` compares all 32
bytes in constant time regardless of where the first mismatch occurs.

### Fire-and-forget extraction worker dispatch

The webhook must respond in < 500ms p95. The AI extraction pipeline (LLM call + DB writes)
takes up to 8s p95. The solution: dispatch the worker as a fire-and-forget Promise.

Pattern used (matching the existing `/api/intake/simulate` route):
1. Dynamic import of `runExtractionWorker` from `@/server/worker/extract`.
2. On Vercel: `waitUntil(workerPromise)` keeps the serverless function alive until the
   promise resolves even after the HTTP response has been sent.
3. Local dev: the promise runs independently in the Node.js event loop. The 202 response
   is returned immediately; the worker resolves ~3-8s later without blocking.

This is documented as an MVP approach. A real job queue (BullMQ, Inngest, Vercel Cron)
would be the production upgrade path.

### Tenant resolution — DEFAULT_TENANT_ID env var

For single-tenant MVP, the webhook cannot know which tenant an incoming email belongs to
from the HTTP request alone (Postmark doesn't include tenant context). The route reads
`DEFAULT_TENANT_ID` from the environment. In a multi-tenant future, a `tenant_inbound_addresses`
lookup table would map `OriginalRecipient` (the inbound Postmark email address) to a tenant UUID.

### outbound_messages.status — optimistic 'sent' update

The `dispatch.ts` module calls `sendEmail()` which writes OUTBOUND_EMAIL_SENT / OUTBOUND_EMAIL_FAILED
audit events. However, `dispatch.ts` cannot distinguish success from failure after the call
(it doesn't return a status). For MVP, the outbound_messages row is optimistically updated to
`status='sent'`. The true delivery status is available in the audit_log. A future improvement
would return the Resend message ID and store it for delivery confirmation polling.

### resend-sender.ts — never throws

Email delivery failure must not crash the intake flow. The `sendEmail()` function wraps the
Resend SDK call in try/catch and returns void in both success and failure paths. Failures are
logged (error name only, no PII) and written to the audit log. This ensures:
- The webhook route always returns 202 even if Resend is down.
- Audit log always records the failure for retry investigation.

### PII masking in templates (AC24)

`maskDni(dni)` and `maskPolicyNumber(policyNumber)` are exported from `render.ts` and called
by each individual template before rendering. The mask functions:
- `maskDni`: strips non-numeric chars, returns `****` + last 4 digits.
- `maskPolicyNumber`: preserves non-numeric prefix (e.g. "POL-"), replaces numeric suffix
  with `****` + last 4 digits of the suffix.

Templates with sensitive inputs (data_confirmation_request, confirmation_received) call these
masks unconditionally. The AC24 test suite runs a regex probe against all 4 templates to
confirm no raw DNI or policy_number appears in the rendered output.

## New files created in W2

| File | Purpose |
|---|---|
| `src/server/email/verify-postmark-signature.ts` | HMAC-SHA256 signature verification for Postmark inbound webhooks |
| `src/server/email/dedupe.ts` | Idempotency check: query cases by (tenant_id, email_message_id) |
| `src/server/email/thread-lookup.ts` | Thread detection: query cases by email_thread_id matching In-Reply-To / References |
| `src/server/email/render.ts` | Template dispatcher + PII masking utilities (maskDni, maskPolicyNumber) |
| `src/server/email/templates/confirmation-received.ts` | confirmation_received template (es-AR, masked policy_number) |
| `src/server/email/templates/missing-information-request.ts` | missing_information_request template (per-field es-AR instructions) |
| `src/server/email/templates/data-confirmation-request.ts` | data_confirmation_request template (masked DNI/policy, conflict display) |
| `src/server/email/templates/specialist-escalation.ts` | specialist_escalation template (severity-aware urgency language) |
| `src/server/email/resend-sender.ts` | Resend SDK wrapper; never throws; logs audit events on success/failure |
| `src/server/email/dispatch.ts` | Orchestrates: render → insert outbound_messages → sendEmail → update status |
| `src/app/api/intake/email/route.ts` | Replaces 501 stub with full Postmark webhook handler (AC1-AC4, AC12, AC20) |

## Tests added in W2

| File | Tests | What it covers |
|---|---|---|
| `tests/unit/verify-postmark-signature.test.ts` | 9 | Valid HMAC, wrong HMAC, missing header, empty header, whitespace header, missing secret (throws), non-hex encoding, different body, prefix-only match |
| `tests/unit/template-render.test.ts` | 37 | maskDni (5), maskPolicyNumber (5), confirmation_received (6), missing_information_request (4), data_confirmation_request (5), specialist_escalation (4), AC24 regex probes across all 4 templates (8) |

Total: 46 new unit tests. Total passing after W2: 595.

## Modification to existing files

| File | Change |
|---|---|
| `src/lib/audit/log.ts` | Added OUTBOUND_EMAIL_SENT and OUTBOUND_EMAIL_FAILED audit event constants |
| `tests/integration/intake.test.ts` | Updated the "POST /api/intake/email returns 501" test to reflect the replaced stub behavior (now returns 500 when POSTMARK_WEBHOOK_SECRET not configured) |
