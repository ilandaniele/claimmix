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
- Admin account `veltra.soporte@gmail.com` (role admin) for adding the paid Gemini key.

### 🔧 Optional improvements (not broken, worth doing)
1. **Big batches still lose cases.** The reaper makes stuck cases *recoverable*
   (`escalado`) but does not *process* them, so a large `batch-simulate` still
   drops part of the distribution. Real fix: chunk/cap batches to fit
   `maxDuration`, or process per-case via the worker route.
2. **Migration runner + `schema_migrations` tracking** — prevents the hand-applied
   migration drift that caused the 0006–0009 INSERT outage.

### 🙋 Blocked on the user (cannot be automated)
- **Gemini paid plan** (#1 blocker): free tier 1500 RPD runs out fast. Log in as
  `veltra.soporte@gmail.com` (admin), add the paid key in **Configuración**
  (per-user key logic already supports this).
- **WhatsApp go-live:** create a Meta Business app + WhatsApp product, get a
  permanent token + App Secret + phone_number_id, set the `WHATSAPP_*` env vars in
  Vercel, register the callback URL `https://claimmix.vercel.app/api/webhooks/whatsapp`,
  subscribe to `messages`. Use a **dedicated** number, not a personal WhatsApp line.
  Full guide: `docs/whatsapp-setup.md`.
- **Re-trigger fine-tuning** once there's paid quota AND training data for `rc` /
  `robo_contenido` (still ~0 examples). The JSONL bug that failed the first job is fixed.
- Minor: delete the stray `_healthcheck_claude.txt` left in the `claimmix-vertex-training` GCS bucket.

## Training state (as of 2026-06-29)
- ~100 approved examples. Good coverage on choque/robo/granizo/incendio; `rc` and
  `robo_contenido` are ~0 (need re-simulation with quota + the sharpened RC prompt).

## Env vars to know
`DATABASE_URL`, `BETTER_AUTH_SECRET`, `GEMINI_API_KEY`, `VERTEX_AI_GEMINI_BASE_MODEL`
(=gemini-2.5-flash), `GOOGLE_DEFAULT_TENANT_ID`, `CRON_SECRET`, and the WhatsApp set
(`WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_APP_SECRET`, `WHATSAPP_ACCESS_TOKEN`,
`WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_TENANT_ID`). See `.env.example`.

## Verify / build commands
`pnpm type-check` · `pnpm lint` (max 5 warnings) · `pnpm test:unit` · `pnpm build`.
CI (GitHub Actions) runs all of these + CodeQL on every push to `main`.
