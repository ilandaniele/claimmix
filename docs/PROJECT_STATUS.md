# ClaimMix — Project Status & Recovery Notes

_Last updated: 2026-08-23. This file is the single source of truth for "where things stand."
Update it at the end of a work session so the next one can recover quickly._

> **TL;DR** — The system runs unattended: email + WhatsApp intake work, extraction goes
> through **Vertex AI** (postpay, no prepay wall), and the agent is trained on **206
> approved examples** without needing fine-tuning. **WhatsApp runs on the real Argentine
> number**, verified, WABA approved. Intake mail arrives at **veltra.claimmix@gmail.com**
> and nothing else. 21–23 August went into hardening and then into the commercial layer:
> the app was attacked on purpose, load-tested at a hundred simultaneous claimants,
> onboarding a second client was rehearsed end to end, a closed month's invoice is frozen,
> and billing + portfolio have screens. **Every check is green** (CI, CodeQL, secret scan,
> and the four post-deploy jobs) for the first time since the suite was built.
> What is left is commercial and operational: paid plans, and a first client.

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

`pnpm load` mide cuánto aguanta y `pnpm pentest` pregunta qué se consigue sin
credenciales. Las mitades gratis de las dos corren solas después de cada deploy.

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
- **DB migrations still do NOT run on deploy** — they never have. But they are
  tracked now: `scripts/migrate.mjs` keeps a `schema_migrations` ledger, checksums
  every applied file to catch one edited after it ran, and applies each in its own
  transaction. **0001–0017 are applied** (verified against the live schema, not the
  ledger, on 2026-08-23).
  ⚠️ **A baselined row is a claim, not a fact.** The 2026-08-21 baseline adopted
  fourteen migrations as applied *without executing them*, on the assumption they
  had been run by hand. **0010 had not been.** For two days the ledger showed it
  green while `tenants` still had three columns: every tenant creation failed and
  `/api/admin/billing` answered 500. Found on 2026-08-23 by the first run of
  `pnpm onboard`, and applied for real. Use `migrate.mjs --forget <version>` to
  drop a row that lies, then `--apply`.
  The runner also falls back to Neon's SQL-over-HTTPS when port 5432 is blocked
  (it is, from at least one of the networks this gets worked on).
  ```
  node scripts/migrate.mjs            # estado
  node scripts/migrate.mjs --apply    # aplica lo que falte
  ```
  It refuses to run when the ledger is empty but `cases` already exists, so history
  cannot be re-executed by accident. `pnpm smoke` also asks the deploy which
  migrations it can see, on every deploy: a forgotten one now fails out loud
  instead of at the first request that needs the column.
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
  (`expires_at: 0`) so it no longer dies every 24 h.
- **The real number is live** (since ~2026-08-16, verified again 2026-08-23 against the
  Graph API): `+54 9 291 642-6930`, display name «ClaimMix», `code_verification_status:
  VERIFIED`, quality **GREEN**, on WABA «Veltra» with `account_review_status: APPROVED`.
  Meta's **test number is gone** and with it the allow-list — anyone can write in now.
  Messaging tier is **TIER_250** (250 business-initiated conversations a day; people
  writing to us first are not capped). The number is the business's and is public by
  design — it is in `.github/allowed-contacts.txt` with its reason, which is what stops
  the personal-data check from failing on it.
- Stuck-`procesando` reaper (`reap-stuck.ts`) + daily cron + opportunistic call in simulate/batch-simulate.
- Public demo at `/demo`.
- Admin account for the paid Gemini key: **`veltra.info1@gmail.com`** (via "Continuar con Google").
  `veltra.soporte@gmail.com` was blocked by Google (2026-07) and decommissioned — neutralized in
  the DB (cases reassigned, session/account cleared, demoted; profile kept as tombstone for FK/audit).

### 💰 Commercial plumbing (added 2026-08-13, migration 0010 applied 2026-08-21)
The technical product was sellable; the *database* was not. `tenants` held only
(id, name, created_at), there was **no code anywhere that creates a tenant**, and
while cost per tenant was measured (`ai_usage.cost_usd`) nothing recorded what a
client had agreed to pay. Closed that:

- `neon/migrations/0010_tenant_commercial_terms.sql` — plan, billing_status,
  monthly_fee_usd, included_claims, overage_price_usd, contact_email,
  trial_ends_at, activated_at, with CHECK constraints and an index on
  `cases (tenant_id, created_at)` for the billing query. **Applied 2026-08-21.**
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

### 🔐 Hardening pass (2026-08-21 → 23)

Everything else here asks whether the system does what it promises. This asked the
opposite question — what do you get without asking anyone — and it found things.

Two suites, both wired into post-deploy where they are free:

- **`pnpm load`** — the read half measures the analyst's dashboard against the
  production database with 1, 5 and 20 concurrent analysts and shows the plan
  Postgres picks; it fails if the case list stops using its index. The write half
  (`--write --claimants N`, spends tokens, by hand) throws N claimants at the real
  webhook at once. **100 simultaneous, none lost**, the last answered inside a
  minute; the dashboard during the storm: 162 ms median. The ceiling is not the
  code — it is the Vercel/Neon plan, and that is a step, not a curve.
- **`pnpm pentest`** — every API route with no credentials, the route list walked
  from `src/app/api` rather than hand-written, so a new unprotected route fails the
  day it ships. Plus role locks read out of the handlers, forged webhook signatures,
  the six headers, CORS, and the tenant wall against a **real database with two
  tenants**. `--agent` (prompt injection) is by hand: it spends the same quota that
  serves claimants.

What it found, all fixed and deployed:

| Hole | What it was worth |
|---|---|
| `X-Internal-Worker: true` | A header is not a secret — anyone could run the extraction worker, the reprocess sweep (**all** tenants, up to 50 real extractions per call, i.e. a lever against the credit card) and the Gmail watch setup. Now `CRON_SECRET` compared in constant time, via `src/lib/security/internal-auth.ts` |
| `/api/admin/health` | Told anyone the transport, whether an OpenAI key existed, the region and whether Sentry was on. Not secrets one by one; together, free reconnaissance. Now status + db, and a probe keeps it that way |
| `viewer` role | The read-only role could connect, disable and delete the insurer's inbox — four `/api/admin` routes accepted any role |
| Monthly USD cap | Never fired: extraction recorded `cost_usd = 0` ("free tier" — true on AI Studio, false since Vertex). A cap in dollars against a sum that is always zero. Now estimated with list prices |
| Public demo | Spent the production tenant's budget, so an anonymous visitor could stop real intake. Now its own tenant (`DEMO_TENANT_ID`, migration 0016) and `checkDemoBudget`, fail-closed |

The **rate limiter** was in-memory, which in serverless means per instance — one
counter per attacker. It runs on Postgres now (`rate_limit_counters`, migration
0015, fail-open); `RATE_LIMIT_PROVIDER` forces upstash/memory.

The **tenant wall** had tests that did not cover it: they mocked `@/lib/db` to
return zero rows and then asserted a 404 — verifying the mock. A query written
without `where tenant_id` left them green. It is now exercised for real, in both
directions (owner sees it first, then the other must not), across id, list,
search, CSV export and the agent's three tools.

The **browser tests** had been red for days without anyone noticing: the job
carried `continue-on-error: true`, so CI reported success on every push. Removed —
a suite that cannot fail the build is decoration.

Prod config changed with it: `ADMIN_EMAILS` is only `veltra.claimmix@gmail.com`,
and `AI_TENANT_DAILY_TOKEN_CAP` went to 20M (a full suite run costs ~1.5M).

### 🚦 Post-deploy, and the trap it fell into (2026-08-23)

`.github/workflows/post-deploy.yml` fires when Vercel reports a successful
production deploy: smoke first, and only if it passed, the rehearsal + the free
halves of load and pentest.

**Only the smoke runs inside the deploy.** The other three run the code *in the
GitHub runner* against the production database, so they read their configuration
from the runner's environment — and what is missing there is not loud. Four
post-deploy runs went red on 2026-08-22 with 33 behavioural differences from the
rehearsal, and not one of them was real: `AI_TENANT_DAILY_TOKEN_CAP` was never
wired into CI, so the runner used the 5M default while production had 20M. That
day's own testing had spent it, the worker never called the model, and twelve
silent conversations failed every assertion at once — a report that reads exactly
like the agent broke.

Closed on three sides:

- The cap is a **repo variable** now (`vars.AI_TENANT_DAILY_TOKEN_CAP`), passed to
  the rehearsal job. A variable and not a secret on purpose: GitHub masks a
  secret's value in the log, which would print `5.088.283 / ***` in the very line
  that explains the failure. **Keep it equal to Vercel's.**
- The rehearsal **refuses to start** with the budget spent, the same way it already
  refused to run against the mock. Silence is not a behavioural finding.
- `readCap` in `budget.ts` stops an empty or malformed value from disabling a cap
  in silence — `parseInt("")` is NaN, and every comparison against NaN is false, so
  the empty variable did not relax the cap, it switched it off.

### 💬 The agent answers when someone writes (2026-08-23)

The no-repeat rule was right that an unchanged request should not go out twice, and
wrong to conclude there was nothing to say. Someone answering *"fue un choque, ayer
a la tarde"* while their name, policy and DNI are still missing got **silence** — the
rehearsal caught it three runs in a row, always the same turn.

Now a short acknowledgement goes out on both channels — *tomamos nota, seguimos
esperando lo de antes* — **without the list** (repeating it is exactly what the rule
prevents) and without claiming the claim is complete (it is not, and saying so would
be worse than asking twice: it would be false).

Two mistakes on the way there, both caught by the rehearsal rather than by a test:

- The first trigger was "new fields appeared in the database". Too loose: extraction
  re-reads the whole conversation each round, so an "ok" produces rows that were not
  stored before — from older messages — and earned an acknowledgement. The same
  nagging with a different template. The agent's own `wait` verdict now overrules it.
- The field list was passed to the composer *"so it knows what not to ask for"*, and
  out came *"tomamos nota… Para seguir, necesitamos que nos digas el número de
  póliza"*. A list of fields in a prompt is a list of things to ask for, whatever the
  instruction beside it says.

**What the rehearsal cannot promise** is that the acknowledgement path itself runs:
it needs the pending set to come out identical to the previous message's, and with a
live model almost any new fact enters the ask as a confirmation, which changes the
set. A scenario written to force it passed or failed by the day — a rehearsal that
fails at random stops being read — so it is covered by 15 tests instead, and listed
in [docs/TESTING.md](TESTING.md) among what is *not* covered.

### 🔧 Optional improvements (not broken, worth doing)
1. ~~**Big batches lose cases**~~ ✅ **DONE 2026-08-23.** Not for the reason the note
   gave: simulated extractions are serialised on purpose (they take turns so fifty
   calls do not hit the model at once), so parallelising was never the fix — and
   handing each case to the worker route would have been worse, since each would get
   60s to wait for a turn that can take 170. What had to break was all fifty
   depending on one invocation. Measured against production first: twenty cases took
   between 175s and 822s — 8.75 to 41 seconds each — so fifty never fit in the 300s
   ceiling. Now the run asks whether there is time for one more, **measuring the
   cases it already did**, and hands the rest to another invocation over HTTP with
   the internal secret. Six links max: a function that calls itself with no ceiling
   is spending with no floor.
2. ~~**Migration runner + `schema_migrations` tracking**~~ ✅ **DONE** — runner
   2026-08-13, baseline adopted against prod 2026-08-21 (see Infra facts).
3. ~~**No admin UI for tenants or billing**~~ ✅ **DONE 2026-08-23.**
   `/admin/facturacion` shows the tenant's month — fee, included, overage, total,
   AI cost, margin, the four volume buckets, and whether the period is closed.
   `/admin/cartera` shows every client with plan, status, claims and margin;
   it crosses tenants, so it sits behind `requireOperator` (admin session **and**
   an address in `ADMIN_EMAILS`, fail-closed). Creating a client stays in
   `create-tenant.mjs` on purpose — one form duplicating the commercial rules for
   an operation that happens once per client is not worth it.
4. ~~**Billing has no invoice history**~~ ✅ **DONE 2026-08-23** (migration 0017).
   A month that has ENDED is frozen the first time anyone asks for it, and served
   from that copy afterwards; the current month is still a live count. The stored
   row keeps the terms that were used, not just the total, so an invoice survives
   the client changing plan. Frozen on read rather than by cron because Hobby
   allows two crons a day and both are taken.

### 🙋 Waiting on you (not code)

- **The one test nobody but you can run: write to it.** Everything below the surface
  is proven — production sent a real mail *from* the veltra mailbox, the Gmail watch
  is registered and real inbound mail (Google's own notifications) became cases and
  was correctly filed as `no_relevante`, and twelve whole conversations run against
  the real agent on both channels every deploy. What has NOT been done since the
  mailbox changed is the last metre: **a claim-shaped message from a real person to
  `veltra.claimmix@gmail.com`, and a real WhatsApp to the business number**. The
  rehearsal cannot do it — it runs on the simulated channels on purpose, so it never
  messages anyone — and neither can anyone but the owner of a phone and a mailbox.
  Send both, watch them land in Bandeja, and read what comes back.
- **Rotate the WhatsApp system-user token.** Meta echoed it inside an error response
  on 2026-08-23 and it is now in a chat transcript. Same standing as the
  `veltra.soporte` password below: it is not known to be leaked, and it is no longer
  only where it should be.
- **Vercel and Neon are still on the free plans.** The load test says the ceiling
  is the plan, not the code — that becomes a step-shaped outage the month it hits.
- **New GCP project `claimmix-veltra`** + `pnpm switch-gcp` to move extraction to it.
- ~~**Connect the veltra mailbox**~~ ✅ **DONE 2026-08-23.** Intake now reads from
  `veltra.claimmix@gmail.com` and nothing else. The two personal mailboxes it replaced
  are **disabled, not deleted** — reversible from Configuración; run
  `pnpm mailbox --keep veltra.claimmix@gmail.com --delete` to remove them for good.
  Production proved the new mailbox can send before the old ones were switched off, and
  the Gmail watch was registered on the spot, so inbound is push and not once-a-day.
  `GMAIL_USER_EMAIL` / `GMAIL_FROM_ADDRESS` still name the old address and that is
  harmless: the From comes from the connected account (`dispatch.ts`), and the env var
  is only a fallback for when no mailbox is connected at all.
- **Demote the two extra admins** in the database if the `[Urgente]` alerts should
  reach veltra only.
- **Rotate the `veltra.soporte@gmail.com` app password** — see Security hygiene below.
- **Meta business verification** (Business Manager → CUIT/AFIP docs) if the 250/day
  tier starts to bind. The number and the WABA are already approved; this only raises
  the ceiling on business-initiated conversations. Not urgent before a pilot.

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
- ~~**WhatsApp — real number**~~ ✅ **DONE.** It took two attempts: `+54 9 11 2318-4512`
  failed because it still had a WhatsApp account attached and a fresh chip never got the
  SMS code. The number that worked is the one in production now. If it ever has to be
  swapped again, the Vercel change is a one-liner once you have the new **Phone Number
  ID** — full guide in `docs/whatsapp-setup.md`, and prefer **voice-call verification**
  over SMS in Argentina.
- **Multi-tenant onboarding (the business model):** key resolution is user → tenant →
  env, so each insurer pastes **their own** Gemini key in Configuración and pays their
  own consumption — our cost per client is $0. ✅ **Rehearsed end-to-end since
  2026-08-23**: `pnpm onboard` creates a throwaway tenant with the real script,
  checks the plan's terms landed, that its claims are invisible from the other tenant
  through all five read paths, that billing counts and prices only its own, that a
  closed month's invoice survives its cases being deleted, that its AI budget and key
  resolution are its own, and then deletes it and verifies nothing is left. Free — it
  never calls the model — so run it before each real client. It says out loud what it
  could not test: the client's own key needs `GMAIL_TOKEN_ENCRYPTION_KEY`, which is
  write-only in Vercel.
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

Added by the hardening pass: `ADMIN_EMAILS` (who is admin), `DEMO_TENANT_ID` (the
public demo's own tenant — no fallback to production on purpose),
`AI_TENANT_DAILY_TOKEN_CAP` / `AI_USER_DAILY_TOKEN_CAP` / `AI_DEMO_DAILY_TOKEN_CAP`
/ `MONTHLY_BUDGET_USD` (the caps that now actually fire), `RATE_LIMIT_PROVIDER`
(postgres by default) and the `R2_*` set for attachments.

⚠️ `AI_TENANT_DAILY_TOKEN_CAP` lives in **two** places and they must agree: Vercel
(production) and the GitHub **repo variable** (the post-deploy rehearsal, which runs
in the runner). See the post-deploy section above for what happens when they don't.

## Verify / build commands
`pnpm type-check` · `pnpm lint` (max 5 warnings) · `pnpm test:unit` · `pnpm build`.
CI (GitHub Actions) runs all of these + CodeQL on every push to `main`.

After every **production** deploy, `post-deploy.yml` runs `pnpm smoke --deep` and, if
it passed, the rehearsal + the free halves of load and pentest. `pnpm check` is the
same thing from your machine. Everything about the suites: [docs/TESTING.md](TESTING.md).

**Secret scanning (fixed 2026-08-23):** the *Secretos* workflow had been red on every
push since it was added on 21 August, and it was not a false positive — it was
scanning **nothing**. gitleaks builds the push range (`<before>^..<after>`) and hands
it to git; the checkout used `fetch-depth: 1` to save minutes, so those commits were
not in the clone, git answered "unknown revision", and the scan ended with «0 commits
scanned» and exit 1. The worst pair: red, which is noise, and unscanned, which is what
the red made it look like was happening. Sunday's scheduled run clones in full and
passed, so from outside it looked intermittent rather than never-worked. Full clone
now, and the log says how many commits it read.

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
| `create-tenant.mjs` | Onboards a client: creates the tenant with its plan's commercial terms. Dry-run by default; `--apply` to execute. Prints the remaining manual steps (SIGNUP_ALLOWED_EMAILS, the client's own Gemini key). |
| `migrate.mjs` | Applies pending SQL migrations and records them in `schema_migrations`. Status by default; `--apply` to run; `--baseline NNNN` to adopt already-hand-applied ones without executing; `--forget NNNN` to drop a ledger row that turned out to be a lie (the schema is not touched). Detects a migration edited after it ran. Falls back to Neon over HTTPS when port 5432 is blocked. |
| `rehearse-onboarding.mts` | `pnpm onboard` — gives a throwaway client the full onboarding, checks isolation, billing, the invoice freeze and the AI budget, then deletes it. Free. Run it before each real client. |
| `switch-gcp-project.mts` | `pnpm switch-gcp` — moves extraction to another GCP project in one command (service account, APIs, Vercel vars). |
| `switch-mailbox.mts` | `pnpm mailbox` — swaps the intake mailbox without a moment of silence. |

The testing scripts — `check-everything`, `rehearse-conversations`, `smoke-production`,
`prove-delivery`, `load-test`, `pen-test` — are run through their `pnpm` aliases and
documented in [docs/TESTING.md](TESTING.md), not here.

⚠️ **Never `DELETE FROM cases` directly.** `training_examples` hangs off cases by *two*
cascading paths — `case_id`, and `agent_run_id` → `agent_runs.case_id` — so a plain
delete silently destroys the whole training set. `reset-cases-keep-training.mjs` detaches
both (`case_id` is nullable on each) before deleting, and rolls back if the approved
count moves.
