# ClaimMix

## Que es ClaimMix / What is ClaimMix

**Espanol:** ClaimMix es un sistema de gestion de siniestros FNOL (First Notice of Loss) potenciado por IA, disenado para companias aseguradoras de Latinoamerica. Permite a los analistas recibir, clasificar y resolver avisos de siniestros de forma automatica: el sistema extrae datos estructurados (fecha, lugar, partes involucradas, danos declarados) de emails o WhatsApp usando GPT-4o-mini, detecta documentacion faltante segun el tipo de siniestro (choque, robo, granizo, incendio) y enruta los casos de baja confianza al equipo de escalados para revision humana — todo en menos de 60 segundos desde el primer aviso.

**English:** ClaimMix is an AI-powered First Notice of Loss (FNOL) claims management system for Latin American insurance companies. Analysts receive a fully-classified, structured case — claim type, involved parties, damages, missing-document checklist, confidence scores — in under 60 seconds of a simulated or real inbound claim notice. The system uses GPT-4o-mini for extraction, enforces a finite-state machine for case lifecycle, and provides a real-time analyst dashboard in Argentine Spanish (es-AR).

---

## Quick Start

```bash
# 1. Clone the repository
git clone https://github.com/ilandaniele/claimmix.git
cd claimmix

# 2. Install dependencies
pnpm install

# 3. Set up environment variables
cp .env.example .env.local
# Edit .env.local — at minimum set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY
# Set MOCK_AI=true to skip OpenAI calls (recommended for local development)

# 4. Start the development server
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000) and sign in with the seed credentials (after running migrations + seed).

---

## Running Migrations

```bash
# Prerequisites: Supabase CLI installed (https://supabase.com/docs/guides/cli)
# and a Supabase project created (or local Docker via `supabase start`)

# Apply migrations to a local Supabase instance
supabase db push --local

# Apply migrations to a remote Supabase project
supabase db push
```

Migrations are in `supabase/migrations/`:
| File | Purpose |
|---|---|
| `0001_init.sql` | All tables + indexes |
| `0002_rls.sql` | Row Level Security policies |
| `0003_seed_required_docs.sql` | Required docs config per claim type |

---

## Running Seed Data

```bash
# Local only — resets the local DB and applies seed data
supabase db reset --local
```

Seed creates:
- 1 tenant: Seguros del Sur S.A.
- 2 analysts: Lucia Ramallo (analyst, lucia@dev.local / DevPass1234!) and Carlos Medina (admin, carlos@dev.local / DevPass1234!)
- 20 sample cases across all statuses and claim types

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | YES | Supabase project URL (from Project Settings → API) |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | YES | Supabase anon key (public, safe for browser) |
| `SUPABASE_SERVICE_ROLE_KEY` | YES (prod) | Service role key — server-only, bypasses RLS. Used for admin user creation and AI worker. |
| `OPENAI_API_KEY` | NO | OpenAI API key. Leave empty to use mock AI. |
| `MOCK_AI` | NO | Set to `true` to use the deterministic mock extractor (no OpenAI calls). Default: `false`. |
| `SENTRY_DSN` | NO | Sentry DSN for server-side error tracking. |
| `NEXT_PUBLIC_SENTRY_DSN` | NO | Sentry DSN for client-side error tracking. |
| `UPSTASH_REDIS_REST_URL` | NO | Upstash Redis URL for durable rate limiting. Falls back to in-memory LRU. |
| `UPSTASH_REDIS_REST_TOKEN` | NO | Upstash Redis token. |
| `RATE_LIMIT_PROVIDER` | NO | `memory` (default) or `upstash`. |
| `AI_USER_DAILY_TOKEN_CAP` | NO | Per-user daily token cap. Default: `100000`. |
| `AI_TENANT_DAILY_TOKEN_CAP` | NO | Per-tenant daily token cap. Default: `5000000`. |
| `CONFIDENCE_THRESHOLD` | NO | Min confidence to avoid escalation. Default: `0.70`. |
| `NEXT_PUBLIC_SITE_URL` | NO | Deployed URL for CORS and absolute links. Default: `http://localhost:3000`. |
| `LOG_LEVEL` | NO | Structured log level: `debug` / `info` / `warn` / `error`. Default: `info`. |
| `POSTMARK_WEBHOOK_SECRET` | YES (email intake) | HMAC-SHA256 secret for Postmark inbound webhook signature verification. |
| `RESEND_API_KEY` | YES (email intake) | Resend API key for outbound email sending. Get from resend.com. |
| `RESEND_FROM_ADDRESS` | YES (email intake) | Verified Resend sender address (e.g. `claims@claimmix.example.com`). |
| `CORE_SYNC_MODE` | NO | `mock` (default) or `real`. Controls CoreSyncService. |
| `EMAIL_REPLY_BASE_URL` | NO | Base URL for links in outbound emails (e.g. `https://app.claimmix.com`). |

---

## Email Claims Intake Workflow

ClaimMix can receive inbound insurance claim emails via Postmark and process them automatically.

### Architecture

```
Postmark inbound webhook → POST /api/intake/email
  ↓ HMAC signature verification
  ↓ Idempotency check (email_message_id)
  ↓ Thread lookup (In-Reply-To / References headers)
  ↓ Create/update cases row (channel='email')
  ↓ Write raw_messages row
  ↓ Dispatch runExtractionWorker (async, fire-and-forget)
      ↓ AI extraction (GPT-4o-mini or MOCK_AI=true)
      ↓ is_claim classifier → severity classifier
      ↓ Customer/policy matching
      ↓ Gap analysis → FSM transition
      ↓ Outbound email via Resend (confirmation_received, missing_information_request, etc.)
```

### Setup Steps (human actions required)

1. **Postmark**: Sign up at [postmark.com](https://postmarkapp.com), create an Inbound Server, configure the HMAC secret, and point the inbound webhook URL to `https://<your-domain>/api/intake/email`.
2. **Resend**: Sign up at [resend.com](https://resend.com), verify your sending domain (or use `onboarding@resend.dev` for sandbox), and create an API key.
3. **Environment variables**: Set in Vercel dashboard (or `.env.local` locally):
   - `POSTMARK_WEBHOOK_SECRET` — from Postmark inbound server settings
   - `RESEND_API_KEY` — from Resend dashboard
   - `RESEND_FROM_ADDRESS` — your verified sender address
   - `CORE_SYNC_MODE=mock` — keep as mock until a real core system is connected
4. **DB Migration**: Run `supabase db push` to apply migrations 0005–0008 (email intake tables + seed patterns).
5. **Preview URL**: For testing inbound webhooks on Vercel preview deployments, re-point the Postmark inbound webhook to the preview URL manually.

### Attachment Expiry Note

Postmark attachment URLs expire after approximately 7 days. The system stores the URL and a content hash + filename for audit purposes. In a follow-up iteration, attachments should be downloaded and re-hosted to Supabase Storage for permanent access.

### FSM Statuses (email intake)

| Status | Description |
|---|---|
| `recibido` | Email received, extraction pending or complete |
| `info_faltante` | Missing required fields — auto-reply sent to claimant |
| `confirmacion_pendiente` | Medium-confidence field awaiting analyst confirmation |
| `requiere_especialista` | High severity — specialist must review |
| `listo_para_core` | All fields confirmed — ready for core system sync |
| `enviado_a_core` | Successfully sent to the core system |
| `error_core` | Core sync failed — may retry |
| `no_relevante` | Email classified as non-claim — no further action |

---

## Gmail Push Notifications Setup

ClaimMix uses Google Cloud Pub/Sub push subscriptions to receive real-time Gmail notifications instead of polling. When a new email arrives in the configured inbox, Gmail publishes a notification to a Pub/Sub topic, which immediately POSTs to `/api/webhooks/gmail`.

### One-time gcloud setup (operator)

Run the following commands once to wire up the Pub/Sub topic and push subscription:

```bash
# 1. Create or reuse a GCP project
gcloud projects create <your-project-id> --name="claimmix-pubsub"
# Or verify an existing project:
gcloud projects describe <your-project-id>

# 2. Enable the Pub/Sub API and create the topic
gcloud pubsub topics create gmail-inbound --project=<your-project-id>

# 3. Grant Gmail API service account publish permission on the topic
#    (required so Gmail can publish notifications to your topic)
gcloud pubsub topics add-iam-policy-binding gmail-inbound \
  --project=<your-project-id> \
  --member=serviceAccount:gmail-api-push@system.gserviceaccount.com \
  --role=roles/pubsub.publisher

# 4. Create a push subscription pointing to your deployed webhook endpoint
#    Replace <prod-url> with your Vercel deployment URL (e.g. claimmix.vercel.app)
#    Replace <svc>@<project>.iam.gserviceaccount.com with your service account
gcloud pubsub subscriptions create gmail-inbound-push \
  --project=<your-project-id> \
  --topic=gmail-inbound \
  --push-endpoint=https://<prod-url>/api/webhooks/gmail \
  --push-auth-service-account=<svc>@<project>.iam.gserviceaccount.com

# 5. Set the Pub/Sub env vars in Vercel dashboard (Settings → Environment Variables):
#    PUBSUB_TOPIC=projects/<your-project-id>/topics/gmail-inbound
#    PUBSUB_AUDIENCE=https://<prod-url>/api/webhooks/gmail

# 6. After deploying, register the Gmail watch (one-time, renews automatically via cron):
curl -X POST \
  -H "Authorization: Bearer $CRON_SECRET" \
  https://<prod-url>/api/admin/setup-gmail-watch
```

### Environment variables

| Variable | Required | Description |
|---|---|---|
| `PUBSUB_TOPIC` | YES (push mode) | Full Pub/Sub topic resource: `projects/<id>/topics/gmail-inbound` |
| `PUBSUB_AUDIENCE` | NO (local dev) | OIDC token audience for push auth verification. Set to your prod webhook URL. Leave unset locally to skip verification. |

### How it works

```
Gmail inbox receives email
  ↓ Gmail API publishes notification to Pub/Sub topic
  ↓ Pub/Sub POSTs to /api/webhooks/gmail (with OIDC Bearer token)
  ↓ Route verifies OIDC token audience (if PUBSUB_AUDIENCE is set)
  ↓ Calls pollGmail() to fetch and process new messages via Gmail History API
  ↓ Standard extraction worker pipeline (same as cron path)
```

The `/api/webhooks/gmail` endpoint is excluded from the session-cookie auth check in `proxy.ts` (it handles its own OIDC verification). The Gmail watch registration expires after 7 days; the `/api/cron/gmail-poll` cron job renews it automatically when expiry is within 24 hours.

---

## Architecture

```
                  Browser (React 19 + Tailwind)
                           |
            Next.js 16 App Router (Node 22)
            ┌──────────────────────────────────┐
            │  proxy.ts    (CSP nonce, HSTS)   │
            │  /app/(app)/ (authenticated UI)   │
            │    /bandeja  /casos/[id]          │
            │    /metricas /analisis            │
            │    /admin/users /configuracion    │
            │  /app/api/   (Route Handlers)    │
            │    /auth/sign-in /sign-out /me    │
            │    /cases /cases/[id]             │
            │    /intake/simulate               │
            │    /admin/users /admin/health     │
            │    /metricas                      │
            │  /server/worker/extract.ts        │
            │    (async AI extraction worker)   │
            └──────────────────────────────────┘
                    |              |
           Supabase (Postgres 17)  OpenAI API
           - Auth (email+pw)       gpt-4o-mini
           - RLS on all tables     (or MOCK_AI=true)
           - Realtime channels
           - Storage (phase 2)

Data flow:
  Analyst → "Simular email" → POST /api/intake/simulate (202)
    → case row (status=procesando) → Supabase Realtime → dashboard
    → worker/extract.ts (async) → OpenAI extraction
    → extracted_fields + missing_docs + audit_log
    → case status: listo | esperando | escalado
    → Supabase Realtime → dashboard update (< 2s)
```

---

## Running Tests

```bash
# Unit tests (no external services needed)
pnpm test:unit

# Unit tests with coverage
pnpm test:unit:coverage

# Integration tests (requires INTEGRATION_ENABLED=true and Supabase credentials)
INTEGRATION_ENABLED=true pnpm test:integration

# E2E tests (requires a running dev server + Supabase)
pnpm test:e2e

# E2E with Playwright UI
pnpm test:e2e:ui
```

---

## Human Setup Steps (project owner — one-time)

1. **Create Supabase project** at [supabase.com](https://supabase.com). Copy `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` into Vercel env vars.
2. **Run migrations**: `supabase db push` against the production project.
3. **Create OpenAI API key** at [platform.openai.com](https://platform.openai.com) → API Keys. Set `OPENAI_API_KEY` in Vercel. Sign the Zero Data Retention addendum if available for production insurer use.
4. **Create Sentry project** at [sentry.io](https://sentry.io). Set `SENTRY_DSN` and `NEXT_PUBLIC_SENTRY_DSN` in Vercel.
5. **Create first admin user**: sign up via the app's `/login` page (or Supabase Auth UI), then run:
   ```sql
   UPDATE public.users SET role = 'admin' WHERE id = '<your-auth-uid>';
   ```
6. **Deploy**: connect the GitHub repo to Vercel. Set all required env vars in the Vercel dashboard. Vercel auto-deploys on push to `main`.

---

## Deploy Checklist

- [ ] Supabase project created and migrations applied
- [ ] All required env vars set in Vercel (NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY)
- [ ] MOCK_AI=false in production (set OPENAI_API_KEY instead)
- [ ] First admin user created and role set to 'admin'
- [ ] Sentry project configured (optional but recommended)
- [ ] UptimeRobot ping configured for GET /api/admin/health (prevents Supabase free-tier pause)
- [ ] CI passing on main branch

---

## Contributing

1. Fork the repository and create a feature branch: `git checkout -b feat/your-feature`
2. Install dependencies: `pnpm install`
3. Make your changes. Run `pnpm lint && pnpm type-check && pnpm test:unit` before pushing.
4. Open a pull request against `main`. CI must pass.
5. All UI strings must be added to `src/lib/i18n/es-AR.ts` (no English strings in user-facing components).
6. Security: every new API route must validate input with Zod and return the unified error format `{ error: { code, message } }`.

---

## ADRs (Architecture Decision Records)

| # | Decision | File |
|---|---|---|
| 0001 | In-process AI worker (not a queue) | `docs/adr/0001-in-process-worker.md` |
| 0002 | Single-tenant deploy, multi-tenant-ready schema | `docs/adr/0002-single-tenant-deploy.md` |
| 0003 | Finite-state machine for case status | `docs/adr/0003-fsm.md` |
| 0004 | Prompt injection containment strategy | `docs/adr/0004-prompt-injection-containment.md` |

---

## License

Private — all rights reserved. Not licensed for commercial use or redistribution.
See deployment notes: Vercel Hobby tier is non-commercial TOS; upgrade to Pro before commercial launch.
