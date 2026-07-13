# ClaimMix — Project Status & Recovery Notes

_Last updated: 2026-06-29. This file is the single source of truth for "where things stand."
Update it at the end of a work session so the next one can recover quickly._

## What ClaimMix is

Multi-tenant **FNOL (first-notice-of-loss) claim intake SaaS** for the Argentine
insurance market. Inbound claims (email, WhatsApp, or simulated) → AI extraction
(Gemini-first) → validated structured fields → analyst dashboard.

- **Stack:** Next.js 16 (App Router), React 19, TypeScript, Drizzle ORM, Neon
  Postgres, Better Auth, pnpm. Deployed on **Vercel (Hobby plan)**.
- **Prod URL:** https://claimmix.vercel.app
- **AI:** Gemini default (`gemini-2.5-flash`), OpenAI optional fallback, `MOCK_AI=true` for local.

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
- **Neon DATABASE_URL** is in `.env.local` (prod). `vercel env pull` returns blank
  values for secrets — use `vercel env ls` to check presence.

## Status by area

### ✅ Done, deployed, and verified live
- Cases INSERT fix — migrations 0006/0008/0009 were never applied to prod; applied them.
- batch-simulate returns `failed_cases` + logs per-case INSERT failures.
- RC-vs-choque classification prompt (decisive "who suffered the claimed damage?" test).
- Vertex fine-tuning JSONL fixed (Gemini **GenerateContent** format, not OpenAI ChatCompletions).
- WhatsApp **Cloud API** webhook (official Meta, ban-safe) — code live; needs Meta creds to function.
- Stuck-`procesando` reaper (`reap-stuck.ts`) + daily cron + opportunistic call in simulate/batch-simulate.
- Public demo at `/demo`.
- Admin account for the paid Gemini key: **`veltra.info1@gmail.com`** (via "Continuar con Google").
  `veltra.soporte@gmail.com` was blocked by Google (2026-07) and decommissioned — neutralized in
  the DB (cases reassigned, session/account cleared, demoted; profile kept as tombstone for FK/audit).

### 🔧 Optional improvements (not broken, worth doing)
1. **Big batches still lose cases.** The reaper makes stuck cases *recoverable*
   (`escalado`) but does not *process* them, so a large `batch-simulate` still
   drops part of the distribution. Real fix: chunk/cap batches to fit
   `maxDuration`, or process per-case via the worker route.
2. **Migration runner + `schema_migrations` tracking** — prevents the hand-applied
   migration drift that caused the 0006–0009 INSERT outage.

### 🙋 Blocked on the user (cannot be automated)
- 🔴 **PROD EXTRACTION DOWN — ROOT CAUSE FOUND (2026-07-13): Gemini API in Argentina is
  PREPAY-only.** Every key on every billing account returned `429 "Your prepayment
  credits are depleted"`. A postpay card does NOT fund this API in AR; you must buy
  prepay credits. (Postpay IS available for **Vertex AI** — see the alternative below.)
  - **New clean setup done:** Google Cloud project **ClaimMix** (`claimmix-502016`,
    number `895285071884`), billing linked with an Argentine card, new key
    `AQ.Ab8RN6Ksvlhyy…` created via AI Studio, staged in `.env.local`. DB verified clean
    (0 stale keys, provider=gemini). Backlog ready: **~1,170 escalado** cases waiting
    (534 email + 636 sim), incl. the weak classes we needed (robo_contenido 94,
    accidente_personal 90, cristales 54, rc 39) → fixes fine-tuning balance.
  - **THE ONE REMAINING STEP (user):** load ~USD 10 prepay at https://ai.studio/projects
    → ClaimMix → prepay. No code change needed.
  - **On "cargado": run `node scripts/activate-gemini.mjs`** — verifies the key works,
    checks DB, and reprocesses the escalado backlog. Then set the key in Vercel prod
    (`vercel login` first) + redeploy.
  - **Postpay alternative:** migrate extraction to **Vertex AI** (postpay, already runs
    fine-tuning on project `claimmix`). Code change; offered, not done.
  - **Anti-block:** ONE country/card (Argentine), small prepay, small data batches.
    Card/country mixing + free-tier bursts got veltra.soporte blocked before.
  - `OPENAI_API_KEY` remains **INVALID** (401) — it's an optional fallback only; Gemini
    is primary + Vertex is fine-tuning (standing decision). Not a priority.
  **GOTCHA (still applies):** key resolution is **user → tenant → env** (`provider.ts`);
  stale tenant/user keys in the DB override env. Verified clean 2026-07-02 (all
  `gemini_api_key_encrypted = null`), so env is the single source of truth — until
  someone re-adds a key via Configuración.
- 🟡 **Security hygiene (2026-07-02 audit):** repo is clean — `.env.local` and
  `*-sa-key.json` git-ignored, no secrets tracked or in git history; `prompt.txt` added
  to `.gitignore`. BUT the `veltra.soporte@gmail.com` app password was pasted into a
  chat session (lives in transcripts) → **rotate that password**. The dead `AQ.` key was
  also pasted around; it's dead, so no action needed once replaced.
- **WhatsApp go-live:** create a Meta Business app + WhatsApp product, get a
  permanent token + App Secret + phone_number_id, set the `WHATSAPP_*` env vars in
  Vercel, register the callback URL `https://claimmix.vercel.app/api/webhooks/whatsapp`,
  subscribe to `messages`. Use a **dedicated** number, not a personal WhatsApp line.
  Full guide: `docs/whatsapp-setup.md`.
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
