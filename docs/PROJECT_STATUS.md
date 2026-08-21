# ClaimMix — Project Status & Recovery Notes

_Last updated: 2026-08-13. This file is the single source of truth for "where things stand."
Update it at the end of a work session so the next one can recover quickly._

> **TL;DR** — The system runs unattended: email + WhatsApp intake work, extraction goes
> through **Vertex AI** (postpay, no prepay wall), 83 extractions in the last 3 days with
> **zero errors**, and the agent is trained on **206 approved examples** without needing
> fine-tuning. Nothing is broken. What's left is commercial, not technical: a real
> WhatsApp number and Meta business verification. Tenant onboarding + per-claim
> billing now exist in code (2026-08-13) but **migration 0010 is still unapplied**.

## What ClaimMix is

Multi-tenant **FNOL (first-notice-of-loss) claim intake SaaS** for the Argentine
insurance market. Inbound claims (email, WhatsApp, or simulated) → AI extraction
(Gemini-first) → validated structured fields → analyst dashboard.

- **Stack:** Next.js 16 (App Router), React 19, TypeScript, Drizzle ORM, Neon
  Postgres, Better Auth, pnpm. Deployed on **Vercel (Hobby plan)**.
- **Prod URL:** https://claimmix.vercel.app
- **AI:** Gemini `gemini-2.5-flash` **via Vertex AI** (`GEMINI_TRANSPORT=vertex`),
  OpenAI optional fallback (currently an invalid key), `MOCK_AI=true` for local.

## Cómo probar que todo anda

`pnpm check` corre todo: tipos, lint, ~1960 tests, doce conversaciones enteras
por WhatsApp y por mail sobre los canales simulados, y un chequeo contra el
deploy que está corriendo. **No le manda un mensaje a nadie.**

`pnpm prove --whatsapp <número>` / `--email <dirección>` es el único que manda
algo de verdad, para comprobar que la salida funciona.

Corrélo después de cada deploy. Detalle completo en
[docs/TESTING.md](TESTING.md).

## Key paths

| Area | Path |
|---|---|
| AI extraction | `src/server/ai/` (`gemini-extractor.ts`, `openai-extractor.ts`, `prompt.ts`, `provider.ts`) |
| Output contract (Zod + JSON schema, keep in sync) | `src/lib/schemas/extracted-claim.ts` |
| Worker / orchestration | `src/server/worker/extract.ts` (`runEmailExtractionWorker`) |
| Simulation throttle + reaper | `src/server/intake/simulation-throttle.ts`, `reap-stuck.ts` |
| Scenarios (108) | `src/server/intake/scenarios.ts` (field is `case_type`) |
| Training / fine-tuning | `src/server/training/` (`vertex-ai-fine-tuning.ts`, `examples.ts`) |
| WhatsApp Cloud API | `src/server/whatsapp/cloud-api.ts`, `src/app/api/webhooks/whatsapp/route.ts` |
| Public demo | `src/app/demo/` + `POST /api/demo/public-analyze` |
| Cases schema | `src/lib/db/schema/core.ts` |

## Infra facts (important)

- **Vercel plan: Hobby.** Crons run at most **once per day**, max **2** cron jobs.
  A sub-daily cron (e.g. `*/15`) requires Pro and **fails the Hobby deploy**.
  Current crons: `gmail-poll` (daily) + `reap-stuck` (daily) = the 2 allowed.
- **Deploys:** `git push` to `main` deploys via Vercel's GitHub integration.
  This silently broke when a `*/15` cron was added; keep all crons daily.
  **Always verify a deploy is live** (curl a new route / `npx vercel ls`) — do not
  assume "push + green CI = deployed". Manual deploy: `npx vercel --prod --yes`.
- **DB migrations are applied BY HAND** (psql / one-off scripts). No tracking
  table, no runner; deploys do NOT apply them. When something DB-shaped breaks
  after a deploy, query the LIVE Neon schema and diff vs `src/lib/db/schema/*` —
  do not trust the migration files. Migrations 0001–0009 are all applied (verified 2026-06-28).
  ✅ **There is a runner now: `scripts/migrate.mjs`** (2026-08-13). It keeps a
  `schema_migrations` ledger, checksums every applied file to catch a migration
  edited after the fact, and runs each one in its own transaction.
  **First run on this database must be the baseline**, because 0001–0009 are
  already applied by hand and must not re-execute:
  ```
  node scripts/migrate.mjs --baseline 0009 --apply   # adopt, do not run
  node scripts/migrate.mjs                            # status
  node scripts/migrate.mjs --apply                    # runs 0010
  ```
  It refuses to run when the ledger is empty but `cases` already exists, so the
  baseline cannot be skipped by accident.
  ⚠️ **`0010_tenant_commercial_terms.sql` is NOT applied yet** (written 2026-08-13).
  Until it runs, `/api/admin/billing` and `scripts/create-tenant.mjs` both fail —
  the script checks for `tenants.plan` up front and tells you so.
- **Neon DATABASE_URL** is in `.env.local` (prod). `vercel env pull` returns blank
  values for secrets — use `vercel env ls` to check presence.

## Status by area

### ✅ Done, deployed, and verified live
- Cases INSERT fix — migrations 0006/0008/0009 were never applied to prod; applied them.
- batch-simulate returns `failed_cases` + logs per-case INSERT failures.
- RC-vs-choque classification prompt (decisive "who suffered the claimed damage?" test).
- Vertex fine-tuning JSONL fixed (Gemini **GenerateContent** format, not OpenAI ChatCompletions).
- WhatsApp **Cloud API** — **LIVE and verified end-to-end** (2026-07). A real message
  from a phone created a case and extracted (`choque`, titular, póliza). Webhook +
  `messages` subscription were registered through the **Graph API**, not the dashboard:
  that is the ban-safe route — automating the Facebook UI is what risks the account.
  All 7 `WHATSAPP_*` vars are in Vercel, including a **permanent** system-user token
  (`expires_at: 0`) so it no longer dies every 24 h. Still on Meta's **test number**
  (+1 555-174-3395), which only accepts allow-listed senders.
- Stuck-`procesando` reaper (`reap-stuck.ts`) + daily cron + opportunistic call in simulate/batch-simulate.
- Public demo at `/demo`.
- Admin account for the paid Gemini key: **`veltra.info1@gmail.com`** (via "Continuar con Google").
  `veltra.soporte@gmail.com` was blocked by Google (2026-07) and decommissioned — neutralized in
  the DB (cases reassigned, session/account cleared, demoted; profile kept as tombstone for FK/audit).

### 💰 Commercial plumbing (added 2026-08-13, needs migration 0010)
The technical product was sellable; the *database* was not. `tenants` held only
(id, name, created_at), there was **no code anywhere that creates a tenant**, and
while cost per tenant was measured (`ai_usage.cost_usd`) nothing recorded what a
client had agreed to pay. Closed that:

- `neon/migrations/0010_tenant_commercial_terms.sql` — plan, billing_status,
  monthly_fee_usd, included_claims, overage_price_usd, contact_email,
  trial_ends_at, activated_at, with CHECK constraints and an index on
  `cases (tenant_id, created_at)` for the billing query. **Apply by hand.**
- `src/lib/billing/plans.ts` — the price ladder plus `computeInvoice` /
  `computeMargin` as pure functions (17 unit tests; money rounds to cents once,
  garbage input clamps to 0 rather than emitting a credit).
- `GET /api/admin/billing?month=YYYY-MM` — billable claims, invoice breakdown,
  measured AI cost, and margin for the caller's own tenant.
- `scripts/create-tenant.mjs` — onboard a client with the plan's terms applied.

**Billable unit is a claim the agent recognised as a claim** (`is_claim = true`).
Mail correctly rejected as not-a-claim is deliberately NOT billed — charging for
filtered spam would turn the filter into a revenue source instead of a feature.
Cases with no verdict (failed / still processing) are not billed either. The
endpoint returns all four buckets so an invoice can be defended line by line.

A tenant's own stored terms are authoritative, not the catalog: a signed contract
must not change retroactively because someone edited the price list.

### 🔧 Optional improvements (not broken, worth doing)
1. **Big batches still lose cases.** The reaper makes stuck cases *recoverable*
   (`escalado`) but does not *process* them, so a large `batch-simulate` still
   drops part of the distribution. Real fix: chunk/cap batches to fit
   `maxDuration`, or process per-case via the worker route.
2. ~~**Migration runner + `schema_migrations` tracking**~~ ✅ **DONE 2026-08-13**
   (`scripts/migrate.mjs`, see Infra facts). Still needs its first baseline run
   against prod.
3. **No admin UI for tenants or billing.** Both are API/script only. Fine for the
   first few clients, not for ten.
4. **Billing has no invoice history.** `/api/admin/billing` recomputes from
   `cases` on every call, so a past month's invoice changes if old cases are
   edited or deleted. Snapshot each period once it closes before issuing real
   invoices.

### 🤖 The AI path — RESOLVED, running unattended (verified 2026-08-07)
Extraction runs on **Vertex AI**, not the AI Studio key. That switch is what ended
months of outages: the AI Studio Gemini API is **prepay-only in Argentina** (every key
on every billing account returned `429 "prepayment credits are depleted"`; a postpay
card does not fund it). Vertex bills **postpay** against the project's existing billing
account — no prepay wall — and still serves the pinned `gemini-2.5-*` models that AI
Studio now 404s for newly-created keys.

- **Config** (`GEMINI_TRANSPORT=vertex`, set in Vercel prod + `.env.local`):
  `GOOGLE_CLOUD_PROJECT=claimmix`, `GOOGLE_CLOUD_LOCATION=us-central1`,
  `VERTEX_EXTRACTION_MODEL=gemini-2.5-flash`, and `GOOGLE_SERVICE_ACCOUNT_JSON`
  (the SA JSON **inline** — serverless has no filesystem, so the key-file path in
  `GOOGLE_APPLICATION_CREDENTIALS` cannot work on Vercel).
- **Model is `flash`, deliberately not `flash-lite`.** Lite measured 0/3 on
  responsabilidad-civil scenarios (invalid_json on both attempts → case escalates);
  flash 3/3. RC claims are the high-value ones.
- **Cost ~USD 0.002/extraction** with thinking disabled. Thinking must stay off for
  every model, not just `gemini-2.5*` — a `-latest` default with thinking ON billed
  ~$0.78/call and drained a $10 prepay in 16 extractions.
- **Health, last 3 days:** 83 extractions, `gemini-2.5-flash`, **zero errors**. The
  Gmail poller ingests real inbox mail daily and the agent classified **264/264**
  correctly as `no_relevante`.
- `OPENAI_API_KEY` is **INVALID** (401) — optional fallback only; Gemini primary +
  Vertex fine-tuning is the standing decision. Not a priority.
- **GOTCHA (still applies):** key resolution is **user → tenant → env**
  (`provider.ts`); stale tenant/user keys in the DB override env. Verified clean
  (all `gemini_api_key_encrypted = null`) — until someone re-adds one via Configuración.

### 🧠 Training state (2026-08-07) — **206 approved examples**
| class | n | | class | n |
|---|---|---|---|---|
| negatives (not a claim) | 40 | | cristales | 18 |
| choque | 38 | | granizo | 17 |
| robo | 19 | | incendio | 17 |
| rc / accidente_personal / robo_contenido | 18 each | | other | 3 |

The agent is trained and working **without** fine-tuning: approved examples feed the
few-shot layer on every extraction, plus 20 `agent_prompt_rules`.

Negatives went 3 → 40 and were the biggest gap: the agent had almost no signal for
"reject this", the expensive failure mode (a promo booked as a claim wastes an analyst
and pollutes the set). 15 are synthetic (`scenarios-negative.ts`) and 25 are **real
inbox mail, one per distinct sender domain** — including hard cases that carry claim
vocabulary without being claims: a bank's *"Recibimos tu Reclamo 0055604264"*, spam
titled *"Claim your FREE $20"*, health-insurer marketing.

Guarded against over-correction: after loading the negatives, verified 4/4 — real
choque and RC claims still classify `is_claim=true`, bank-"Reclamo" and "Claim" spam
still `false`.

**Back it up before touching the DB:** `node scripts/export-training.mjs` →
`training-export/`. Approved examples are the only asset here that cannot be
regenerated. Latest dump: `training-examples-2026-08-07.json` (206 + 20 rules).
- 🟡 **Security hygiene (2026-07-02 audit):** repo is clean — `.env.local` and
  `*-sa-key.json` git-ignored, no secrets tracked or in git history; `prompt.txt` added
  to `.gitignore`. BUT the `veltra.soporte@gmail.com` app password was pasted into a
  chat session (lives in transcripts) → **rotate that password**. The dead `AQ.` key was
  also pasted around; it's dead, so no action needed once replaced.
- **WhatsApp — real number.** Everything else is done (see above); only the production
  number is left. Registering `+54 9 11 2318-4512` failed because it still had a
  WhatsApp account attached, and a fresh chip never received the SMS code. Next
  attempt: use **voice-call verification** instead of SMS (more reliable in AR), on a
  chip confirmed to receive normal calls/SMS first. Then **business verification**
  (Meta → Security Center → CUIT/AFIP docs, takes days) so any customer can write in,
  not just allow-listed test senders. Hand the new **Phone Number ID** over and the
  Vercel swap is a one-liner. Full guide: `docs/whatsapp-setup.md`.
- **Multi-tenant onboarding (the business model):** key resolution is user → tenant →
  env, so each insurer pastes **their own** Gemini key in Configuración and pays their
  own consumption — our cost per client is $0. Creating the tenant is now scripted
  (`create-tenant.mjs`), but the flow has **never been rehearsed end-to-end with a
  second tenant** — do that on a throwaway tenant before a real client, not during one.
- ~~**Re-trigger fine-tuning**~~ ✅ **DONE 2026-06-30 — first successful tuned model.**
  Job `2eb72bbc-…` (Vertex `tuningJobs/2998492462349025280`) → `JOB_STATE_SUCCEEDED`,
  model `…/models/562968095363170304@1`, base gemini-2.5-flash, 116 examples. DB row is
  `eval_pending` (activation is a deliberate human step — not auto-activated). Fixed a
  real bug to get here: `uploadToGcs` used `PUT` (→404); GCS simple-upload needs `POST`.
  To improve weak classes, re-run once the Gemini key is truly paid + more `rc`/
  `robo_contenido`/`accidente_personal`/`cristales` data is approved, then fine-tune again.
- Minor: stray objects in the `claimmix-vertex-training` GCS bucket (`_healthcheck_claude.txt`,
  `_probe_*`, plus this run's tuning JSONL) — SA lacks `objects.delete`; clean via Console.

## Training state (as of 2026-06-30, after this session)
- **116 approved examples** (live DB count). By type: choque 38, robo 19, incendio 17,
  granizo 17, **rc 10** (was 0 — filled this session), cristales 5, robo_contenido 4,
  accidente_personal 3, other 3. `rc` (the worst gap) is now covered; robo_contenido /
  accidente_personal / cristales are still thin because the free-tier Gemini quota ran
  out mid-run. Generation method: ran each distinct weak-class scenario through the real
  worker locally (paid-ish key) and auto-approved ONLY runs where extraction succeeded
  AND predicted claim_type matched the seed. A naive first pass approved 24 failed
  (`escalado`/429) runs — those were detected and deleted.
- **Old failed Vertex job synced (2026-06-30):** job `9110414817876770816` was confirmed
  `JOB_STATE_FAILED` (the ChatCompletions→GenerateContent JSONL bug, now fixed). Its DB
  row (`8029ee95-…`) was stuck in `queued` and was BLOCKING new drafts via the open-job
  guard (`createVertexAiTuningDraft`, statuses draft/queued/running/eval_pending/approved).
  Marked it `failed` → new drafts unblocked.
- **Fine-tuning can only be triggered where the SA key lives.** `GOOGLE_APPLICATION_CREDENTIALS`
  (claimmix-vertex-sa-key.json) + `VERTEX_AI_TUNING_ENABLED=true` + project/location/bucket
  are in `.env.local` (LOCAL), NOT on Vercel — so run the draft→start from local, or add the
  SA creds to Vercel. Trigger path: admin UI / `POST /api/admin/fine-tuning/vertex`
  (`action:"draft"` then `action:"start"`).

## Env vars to know
`DATABASE_URL`, `BETTER_AUTH_SECRET`, `GEMINI_API_KEY`, `VERTEX_AI_GEMINI_BASE_MODEL`
(=gemini-2.5-flash), `GOOGLE_DEFAULT_TENANT_ID`, `CRON_SECRET`, and the WhatsApp set
(`WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_APP_SECRET`, `WHATSAPP_ACCESS_TOKEN`,
`WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_TENANT_ID`). See `.env.example`.

## Verify / build commands
`pnpm type-check` · `pnpm lint` (max 5 warnings) · `pnpm test:unit` · `pnpm build`.
CI (GitHub Actions) runs all of these + CodeQL on every push to `main`.

**CI audit note:** the blocking dependency gate runs `pnpm audit --prod`. One dev-only
advisory is unfixable — eslint → minimatch@3 → brace-expansion@1, patched only in
`>=5.0.8`, an API minimatch@3 cannot consume ("expand is not a function"). It never
ships, so a second non-blocking step keeps dev advisories visible.

## Operational scripts (`scripts/`)
| Script | What it does |
|---|---|
| `export-training.mjs` | Dumps approved examples + prompt rules to `training-export/*.json`. **Run before any DB cleanup** — the approved set is the only thing here that cannot be regenerated. |
| `reset-cases-keep-training.mjs` | Wipes every case but keeps the trained agent. Dry-run by default; `--apply` to execute. |
| `cleanup-junk-cases.mjs` | Deletes only dead-end cases (`no_relevante` / unrecovered `escalado`) that back no approved example. Dry-run by default. |
| `activate-gemini.mjs` | Legacy: verifies the AI Studio key and re-drives the escalado backlog. Superseded by the Vertex transport; kept for the prepay path. |
| `create-tenant.mjs` | Onboards a client: creates the tenant with its plan's commercial terms. Dry-run by default; `--apply` to execute. Needs migration 0010. Prints the remaining manual steps (SIGNUP_ALLOWED_EMAILS, the client's own Gemini key). |
| `migrate.mjs` | Applies pending SQL migrations and records them in `schema_migrations`. Status by default; `--apply` to run; `--baseline NNNN` to adopt already-hand-applied ones without executing. Detects a migration edited after it ran. |

⚠️ **Never `DELETE FROM cases` directly.** `training_examples` hangs off cases by *two*
cascading paths — `case_id`, and `agent_run_id` → `agent_runs.case_id` — so a plain
delete silently destroys the whole training set. `reset-cases-keep-training.mjs` detaches
both (`case_id` is nullable on each) before deleting, and rolls back if the approved
count moves.
