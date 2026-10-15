# ClaimMix

ClaimMix is an AI-powered FNOL claims management system for insurance teams. It receives inbound claim messages (Gmail **and WhatsApp**), creates cases, runs a tenant-configurable claim agent, persists extracted fields and missing documentation, and keeps analysts in a focused operational dashboard.

> **📋 Current status, deployment facts, and open blockers live in
> [`docs/PROJECT_STATUS.md`](docs/PROJECT_STATUS.md).** Read it first when picking up the project.

## Stack

- Next.js App Router (deployed on Vercel — Hobby plan)
- Better Auth
- Neon Postgres with Drizzle
- Gmail API and Google Pub/Sub
- WhatsApp Business Cloud API (official Meta — see [`docs/whatsapp-setup.md`](docs/whatsapp-setup.md))
- Google Gemini agent provider (+ Vertex AI fine-tuning)
- S3-compatible attachment storage
- Vitest and Playwright

## Quick Start

```bash
pnpm install
cp .env.example .env.local
pnpm dev
```

Open `http://localhost:3000`.

For local work without external AI calls, set:

```bash
MOCK_AI=true
```

MOCK_AI: el caso queda en Requiere especialista, sin datos inventados; nada se
escribe como si viniera de la persona.

## Database

Migrations live in `neon/migrations/`.

> ⚠️ **Deploys do not apply migrations.** After adding a migration you must run
> `node scripts/migrate.mjs --apply` yourself; it tracks applied migrations in a
> checksummed `schema_migrations` ledger, so re-running is a safe no-op. When
> something DB-shaped breaks after a deploy, **diff the live Neon schema against
> `src/lib/db/schema/*`** rather than trusting these files. (Migrations 0006/0008/0009
> were once shipped in code but never applied, which broke all `cases` INSERTs —
> exactly what the ledger now prevents.)

Apply them with:

```bash
node scripts/migrate.mjs --apply
```

Optional seed data lives in `neon/seed.sql`.

## Environment Variables

| Variable | Required | Description |
|---|---:|---|
| `DATABASE_URL` | yes | Neon Postgres connection string |
| `BETTER_AUTH_SECRET` | yes | Better Auth secret |
| `BETTER_AUTH_URL` | yes | Public app URL for Better Auth |
| `AI_PROVIDER` | no | Defaults to `gemini` (only supported provider — OpenAI was removed) |
| `GEMINI_API_KEY` | no | Global Gemini provider key used by the default provider |
| `GEMINI_MODEL` | no | Default Gemini model, defaults to `gemini-2.5-flash` |
| `MOCK_AI` | no | Set `true` to use a deterministic mock agent: the case is left in Requiere especialista, with no data invented |
| `GMAIL_CLIENT_ID` | email | Google OAuth client ID |
| `GMAIL_CLIENT_SECRET` | email | Google OAuth client secret |
| `GMAIL_TOKEN_ENCRYPTION_KEY` | email | Encryption secret for Gmail and AI provider keys — 32+ random bytes, e.g. `openssl rand -hex 32` |
| `GMAIL_TENANT_ID` | email | Fallback tenant for fixed-inbox mode |
| `GMAIL_USER_EMAIL` | email | Fallback fixed inbox address |
| `GMAIL_FROM_ADDRESS` | email | Outbound Gmail sender |
| `CRON_SECRET` | prod | Cron/internal route secret; the Preview scope uses its own value (repo secret `PREVIEW_CRON_SECRET`) |
| `PUBSUB_TOPIC` | push | Gmail push topic |
| `PUBSUB_AUDIENCE` | push | Expected Pub/Sub OIDC audience |
| `PUBSUB_SERVICE_ACCOUNT` | push | Service account of our push subscription; the token's `email` must match it. Required wherever `PUBSUB_AUDIENCE` is set |
| `S3_ENDPOINT` / `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` / `S3_BUCKET` | attachments | S3-compatible storage |
| `SENTRY_DSN` / `NEXT_PUBLIC_SENTRY_DSN` | no | Observability |
| `RETENCION_MODO` / `RETENCION_ANIOS` | no | Retention of closed cases. Off by default (`apagado`); `simular` only counts, `borrar` deletes cases closed more than `RETENCION_ANIOS` years ago (1 to 30, default 5). Runs in the `reap-stuck` cron, 04 UTC window only |
| `PURGA_ADJUNTOS_MODO` / `PURGA_GRACIA_DIAS` | no | Deferred deletion of R2 attachments of deleted cases. Off by default; `PURGA_GRACIA_DIAS` is the grace period (7 to 365, default 30) |

## Agent Console

Admins use `/agente` to manage:

- Provider and model settings for Gemini
- Tenant custom fields
- Prompt rules
- Approved training examples
- Optional Vertex AI fine-tuning jobs and manual model activation

Gemini is the agent provider, behind a validated claim-output contract. The workflow still validates all model output before any database write.

## Security

- Every tenant-owned query must filter by `tenant_id`, via `enTenant`/`enTenantVarias` (`src/data/scope.ts`).
- Neon/Postgres enforces `FORCE ROW LEVEL SECURITY` as of `0018_tenant_isolation_force_rls.sql`, as a DB-level backstop to the app-level filter.
- Route handlers validate input with Zod.
- Mutations re-check role authorization server-side.
- Audit events are written for training, provider, field, and model deployment changes.
- Raw email content is never logged to stdout.
- Per-tenant OIDC SSO, deferred purge of deleted cases' R2 attachments and an opt-in 5-year retention sweep (both off by default). What is and is not covered, including the open debts, is in [docs/SEGURIDAD.md](docs/SEGURIDAD.md).

## Tests

```bash
pnpm test:unit
pnpm test:integration
pnpm test:e2e
pnpm lint
pnpm type-check
```

Some integration and E2E scenarios require a seeded Neon database and authenticated test users.

## Deploy Checklist

- [ ] Neon database created and migrations applied
- [ ] `DATABASE_URL`, Better Auth, Gmail, and provider env vars set in Vercel
- [ ] `MOCK_AI=false` in production (the mock always leaves the case in Requiere especialista, with no data)
- [ ] First admin user created and role set to `admin` or `owner`
- [ ] Gmail watch configured or cron poll enabled
- [ ] CI passing
