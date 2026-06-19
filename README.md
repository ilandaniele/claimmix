# ClaimMix

ClaimMix is an AI-powered FNOL claims management system for insurance teams. It receives inbound Gmail claim emails, creates cases, runs a tenant-configurable claim agent, persists extracted fields and missing documentation, and keeps analysts in a focused operational dashboard.

## Stack

- Next.js App Router
- Better Auth
- Neon Postgres with Drizzle
- Gmail API and Google Pub/Sub
- OpenAI and Google Gemini agent providers
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

## Database

Migrations live in `neon/migrations/`.

Apply them with your Postgres tool of choice:

```bash
psql "$DATABASE_URL" -1 -f neon/migrations/0001_init.sql
psql "$DATABASE_URL" -1 -f neon/migrations/0002_gemini_key.sql
psql "$DATABASE_URL" -1 -f neon/migrations/0003_user_ai_settings.sql
psql "$DATABASE_URL" -1 -f neon/migrations/0004_agent_console_security.sql
psql "$DATABASE_URL" -1 -f neon/migrations/0005_gemini_default.sql
```

Optional seed data lives in `neon/seed.sql`.

## Environment Variables

| Variable | Required | Description |
|---|---:|---|
| `DATABASE_URL` | yes | Neon Postgres connection string |
| `BETTER_AUTH_SECRET` | yes | Better Auth secret |
| `BETTER_AUTH_URL` | yes | Public app URL for Better Auth |
| `AI_PROVIDER` | no | `gemini` or `openai`; defaults to `gemini` |
| `OPENAI_API_KEY` | no | Optional OpenAI provider key |
| `OPENAI_MODEL` | no | Default OpenAI model, defaults to `gpt-4o-mini` |
| `GEMINI_API_KEY` | no | Global Gemini provider key used by the default provider |
| `GEMINI_MODEL` | no | Default Gemini model, defaults to `gemini-2.5-flash` |
| `MOCK_AI` | no | Set `true` to use deterministic mock agent output |
| `GMAIL_CLIENT_ID` | email | Google OAuth client ID |
| `GMAIL_CLIENT_SECRET` | email | Google OAuth client secret |
| `GMAIL_TOKEN_ENCRYPTION_KEY` | email | Encryption secret for Gmail and AI provider keys |
| `GMAIL_TENANT_ID` | email | Fallback tenant for fixed-inbox mode |
| `GMAIL_USER_EMAIL` | email | Fallback fixed inbox address |
| `GMAIL_FROM_ADDRESS` | email | Outbound Gmail sender |
| `CRON_SECRET` | prod | Cron/internal route secret |
| `PUBSUB_TOPIC` | push | Gmail push topic |
| `PUBSUB_AUDIENCE` | push | Expected Pub/Sub OIDC audience |
| `S3_ENDPOINT` / `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` / `S3_BUCKET` | attachments | S3-compatible storage |
| `SENTRY_DSN` / `NEXT_PUBLIC_SENTRY_DSN` | no | Observability |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | no | Durable rate limiting |

## Agent Console

Admins use `/agente` to manage:

- Provider and model settings for OpenAI and Gemini
- Tenant custom fields
- Prompt rules
- Approved training examples
- Optional OpenAI fine-tuning jobs and manual model activation

Gemini and OpenAI are treated as agent providers behind the same validated claim-output contract. The workflow still validates all model output before any database write.

## Security

- Every tenant-owned query must filter by `tenant_id`.
- Neon/Postgres RLS scaffolding is in `0004_agent_console_security.sql` for non-owner roles that set `claimmix.tenant_id`.
- Route handlers validate input with Zod.
- Mutations re-check role authorization server-side.
- Audit events are written for training, provider, field, and model deployment changes.
- Raw email content is never logged to stdout.

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
- [ ] `MOCK_AI=false` in production
- [ ] First admin user created and role set to `admin` or `owner`
- [ ] Gmail watch configured or cron poll enabled
- [ ] CI passing
