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
