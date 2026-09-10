# ClaimMix — Project Status & Recovery Notes

_Last updated: 2026-09-09. This file is the single source of truth for "where things stand."
Update it at the end of a work session so the next one can recover quickly._

> **TL;DR** — The system runs unattended: email + WhatsApp intake work, extraction goes
> through **Vertex AI** (postpay, no prepay wall), and the agent is trained on **206
> approved examples** without needing fine-tuning. **WhatsApp runs on the real Argentine
> number**, verified, WABA approved. Intake mail arrives at **veltra.claimmix@gmail.com**
> and nothing else. 21–24 August went into hardening, then the commercial layer, then
> the last metre of the wire: the app was attacked on purpose, load-tested at a hundred
> simultaneous claimants, onboarding a second client was rehearsed end to end, a closed
> month's invoice is frozen, billing + portfolio have screens, and **both channels were
> driven end to end with real messages from a real person** — a mail, two WhatsApps and a
> photograph, all answered. **Every check is green** (CI, CodeQL, secret scan, and the
> five post-deploy jobs), and the extraction now bills to **Veltra's own Google Cloud
> project**. What is left is commercial: paid plans, and a first client.

## What ClaimMix is

Multi-tenant **FNOL (first-notice-of-loss) claim intake SaaS** for the Argentine
insurance market. Inbound claims (email, WhatsApp, or simulated) → AI extraction
(Gemini-first) → validated structured fields → analyst dashboard.

- **Stack:** Next.js 16 (App Router), React 19, TypeScript, Drizzle ORM, Neon
  Postgres, Better Auth, pnpm. Deployed on **Vercel (Hobby plan)**.
- **Prod URL:** https://claimmix.vercel.app
- **AI:** Gemini `gemini-2.5-flash` **via Vertex AI** (`GEMINI_TRANSPORT=vertex`),
  `MOCK_AI=true` para local. **No hay fallback de OpenAI**: el extractor se borró
  y `OPENAI_API_KEY` no se lee en ningún archivo. El selector real es
  `resolverAiMode` (`MOCK_AI`, `AI_MOCK`, o Gemini sin configurar).

## Cómo probar que todo anda

`pnpm check` corre todo: tipos, lint, ~1960 tests, doce conversaciones enteras
por WhatsApp y por mail sobre los canales simulados, y un chequeo contra el
deploy que está corriendo. **No le manda un mensaje a nadie.**

`pnpm prove --whatsapp <número>` / `--email <dirección>` es el único que manda
algo de verdad, para comprobar que la salida funciona.

`pnpm arquitectura` comprueba que ninguna consulta se salga de la capa de datos
y `pnpm permisos` que el rol restringido pueda hacer lo que ella le pide.

`pnpm load` mide cuánto aguanta y `pnpm pentest` pregunta qué se consigue sin
credenciales. Las mitades gratis de las dos corren solas después de cada deploy.

Corrélo después de cada deploy. Detalle completo en
[docs/TESTING.md](TESTING.md).

## Key paths

| Area | Path |
|---|---|
| AI extraction | `src/server/ai/` (`gemini-extractor.ts`, `mock-extractor.ts`, `prompt.ts`, `provider.ts`, `ai-mode.ts`) |
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
- Public demo at `/demo` — genuinely reachable without an account since 2026-08-24;
  see "Three pages nobody outside could open" below for why it was not before.
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

### 📨 The last metre of the wire (2026-08-24)

Every layer above the transport had a test; the transport itself was covered by "a
person sends a message and looks". That is now two things instead of one.

**`pnpm knock`, on every deploy.** The deploy *deposits* a claim-shaped mail into the
real mailbox with `users.messages.insert` — not sent, no SMTP, no recipient — and a
Meta-signed payload is posted to the real webhook. Both become cases, the agent's reply
is composed and recorded, and nothing leaves the building: the mail sender is
`@example.com` and the number is from the reserved block. It also checks that a forged
signature is rejected, which is the half of a signature that matters. What it does not
prove is Google and Meta *delivering* to us — there the message is already in the box
and we call our own webhook.

Its first run found a real bug: **the reply to the test mail was actually sent.** The
guard compared the raw `to` header against `@example.com`, and a real mail carries
`Nombre <dirección>` — the string ends in `>`, so it never matched. It only ever worked
for bare addresses, which is how the rehearsal sends them and not how any mail client
does. Building the WhatsApp half surfaced a second one: the "never message an invented
number" rule lived only in the *simulated* messenger, so anything arriving through the
signed webhook would have tried Meta — which is exactly what gets a WhatsApp Business
account restricted. Both guards now live on the recipient, where they hold for every
path (`lib/email/reserved.ts`, `lib/phone/reserved.ts`).

**And the real messages, sent by hand.** A mail (`choque`, answered in 18 seconds), two
WhatsApps (`granizo`, policy extracted, both replies delivered) and a **photograph** —
which travelled Meta → R2 → recognition → closed the `fotos_danos` request → reply, four
steps nothing had ever exercised.

Those messages found the rest of a day's worth of small lies in the data:

- **`email` held whatever the channel called the sender**: the whole header on mail,
  the phone number on WhatsApp. Neither broke a reply — sending uses the connected
  mailbox, not this field — and both poison the thing that is actually compared:
  matching a customer by mail against `Nombre <dir>` finds nobody, and against a phone
  number finds anything. A value that looks present and is wrong is worse than an empty
  one: an empty one gets asked for.
- **The phone was asked for on WhatsApp**, where the sender *is* the contact number and
  we know it better than if they typed it. It went unnoticed because the number sat in
  the `email` field and satisfied the contact pair with a falsehood; removing it made
  the question appear. Now `phone` is filled from the sender and the pending contact
  request is closed — only the contact pair, because the sender is the identity of the
  transport (a fact), while the time of the accident is a reading of the text (an
  interpretation), and closing a request on an interpretation marks as received
  something nobody confirmed.
- **The rehearsal was walking a path production never walks.** It invented 17-digit
  phone numbers; E.164 stops at 15, so the new guard rejected them, the case ended with
  no contact at all, and the agent asked for *"dejanos un correo donde podamos
  escribirte"* — something a real claimant is never asked, because a real number goes
  through. Green for the wrong reason is worse than red. Invented claimants are now
  invented in who they are, not in what shape they have.

### ☁️ Moving the extraction to Veltra's own project (2026-08-24)

The point was not the name: it was that the model's spend should be the business's,
not a person's. So the project had to be created **signed in as veltra.claimmix**, in
Veltra's organisation, with its own billing account — nothing I could do from a
session authenticated as someone else, and the reason the console steps were handed
over rather than scripted.

`pnpm switch-gcp` verifies before it writes: it makes a real Vertex call with the new
key and, if the model does not answer, nothing is touched. It answered, and the deep
smoke confirmed production is extracting on the new project.

Three things worth remembering:

- **The script wrote GitHub and not Vercel, and exited successfully.** On Windows
  `npx` is a `.cmd` and `execFileSync` cannot run it: ENOENT, caught, printed as
  "cargalo a mano" on one line, and on it went. That left local and CI pointing at the
  new project while production stayed on the old one — the worst way to be half-done,
  because each half looks healthy on its own. (`gh` is an `.exe`, which is why that
  half worked and made it look like a Vercel problem.) Fixed, and a partial write now
  exits non-zero.
- **The key landed inside the repository, which is public.** `.gitignore` covers
  `*-sa-key.json` and Google names the download `<project>-<hex>.json`, which does not
  match — one `git add -A` away from a service-account key in a public repo. Keep the
  local copy named `*-sa-key.json`.
- **New organisations block service-account keys by default**
  (`iam.disableServiceAccountKeyCreation`). Overriding it at *project* level is the
  narrow fix; the wide one is Workload Identity Federation, where Vercel proves who it
  is with a short-lived OIDC token and there is no JSON to leak at all. That is the
  real answer to a key living in three places, and it is not written yet.

  Nota posterior (2026-08-31): la anulación **no quedó puesta**. Hoy la restricción
  está activa y heredada de la organización — ver «Waiting on you» más abajo. Lo
  que sigue abierto es lo de Workload Identity Federation, que es el arreglo de
  verdad; esto sólo impide que aparezca una clave más.

  Nota posterior (2026-09-05): hecho, para Vercel y para el post-deploy de
  GitHub — ver «Vercel le prueba a Google quién es, sin clave». La clave sólo
  queda en esta máquina, para entrenar.

### 🔕 The week the mailbox would have gone quiet (2026-08-24)

Publishing the OAuth app was the last step of the migration, and the reason is narrow:
while an app that asks for Gmail scopes sits in **Testing**, Google expires the
mailbox's permission **every seven days**. The intake would have stopped by itself the
following Sunday, with nothing in the logs to explain it. It is **In production** now,
unverified — which is fine up to 100 users and only costs the "Google hasn't verified
this app" screen when *we* connect *our own* mailbox.

Publishing needs a public Terms URL and a public Privacy URL. That requirement is what
uncovered the `/demo` problem below.

**The expiry is stamped on the token, not read from the app.** The permission issued an
hour before publishing still carried its seven-day clock, so the mailbox had to be
reconnected once more afterwards. Reconnecting is what broke it:

- Google answered the consent with a **500**, after the app had already dropped the
  existing row. One transient error from Google and there was **no mailbox at all** —
  `/api/health` went to `degraded`, the poller returned `INTERNAL`. The retry worked.
- Worse, and quieter: **reconnecting kills the push subscription and nothing notices.**
  `gmail.users.watch` hangs off the OAuth grant, so revoking the grant drops it on
  Google's side — but `gmail_poll_state` keeps the old expiry, seven days out. The cron
  only renews what it sees expiring, so it did not renew. `/api/health` still said
  "casilla conectada, token legible", because the token *was* readable. Mail still
  arrived, just via the twice-daily cron instead of in seconds.

  Nothing failed. The system looked healthy and was slow, and would have stayed that
  way for a week.

Three fixes, in the order that matters:

1. **The callback re-registers the watch**, because that is the only moment we know for
   certain there is a fresh grant. If it fails the mailbox stays connected — push is
   latency, not the way in, and the cron keeps working.
2. **`/api/admin/setup-gmail-watch` reads the mailbox from the database.** It was still
   looking in `GMAIL_USER_EMAIL`, unset since mailboxes moved to the Configuración
   screen, so the one manual way to revive push returned a 500.
3. **Health checks the push, not just the token.** There is no column holding when the
   watch was registered, but it can be derived: Gmail grants exactly seven days, so
   registration was `watch_expiration - 7d`. If the mailbox connected *after* that, the
   watch belongs to a permission that no longer exists → `degraded`, with the command
   to fix it in the message.

The callback had **no tests at all** — which is how a route that connects mailboxes
came to silently disable push. It has seven now; two go red if the watch registration
is removed. Proven in production by depositing a mail and waiting **without calling the
poller**: the case appeared on its own.

### 🚧 Three pages nobody outside could open (2026-08-24)

`/privacy` and `/terms` exist because Google will not publish an app without them. Both
were behind the session gate, so Google could not read them — and neither could
`/demo`, which meant **the public demo had never been public**. This document listed it
under "done, deployed and verified" for weeks. The back half worked the whole time
(`/api/demo/public-analyze` was never gated), so nothing looked broken; the front door
was simply locked.

**And the way it was found is the part worth keeping.** There were two `proxy.ts` files,
one at the root and one in `src/`. I reasoned about which one Next.js loads, concluded
it was the root, and deleted the other. Wrong: this project keeps `app/` inside `src/`,
so the proxy must sit beside it. **Production served `/bandeja`, `/clientes` and
`/metricas` with no session at all** until it was restored.

The evidence was one command away and free: the build log prints `ƒ Proxy (Middleware)`
when a proxy ships. It was there in the previous build and gone from mine. **Deducing
which file runs, when the build will tell you, is not a shortcut.** Restoring it then
exposed a second fault the same reasoning had hidden — the matcher was gating `/api`,
so `/api/health` returned 401 before reaching its own Bearer check, which would have
broken both crons, the smoke test and the doorbell. API routes authenticate themselves
and the pen test walks every one of them unauthenticated on each deploy.

Every deploy since checks `ƒ Proxy (Middleware)` is in the build output.

### 🧱 La base separa a las aseguradoras, no el código (2026-08-25)

Antes, que una aseguradora no viera los datos de otra dependía de que cada
consulta llevara escrito `eq(tabla.tenant_id, tenantId)`. Había 198. Una que se
olvidara no daba error ni salía en los tests: devolvía filas de todos.

Ahora lo hace Postgres. Las 29 tablas con columna de inquilino tienen RLS
**forzado** y política propia, y la aplicación entra con `claimmix_app`, un rol
sin `BYPASSRLS`. La capa (`src/data/scope.ts`) abre la transacción, fija el
inquilino y corre la consulta adentro:

```ts
const filas = await enTenant({ tenantId }, (db) =>
  db.select().from(cases).where(eq(cases.status, "escalado"))
);
```

Sin `WHERE` por inquilino. Y si alguien intenta insertar en otro, la base lo
**rechaza** — una defensa que antes no existía en ninguna forma.

**Lo que se comprueba solo, en cada `pnpm check`:**

| Chequeo | Qué mira |
|---|---|
| `pnpm arquitectura` | que ninguna consulta quede fuera de la capa sin decir por qué |
| `pnpm permisos` | que `claimmix_app` pueda hacer lo que la capa le pide, en las 29 tablas |
| `pnpm tenancy` | que la base esconda de verdad lo ajeno |
| `pnpm capa-datos` | lo mismo, pero a través del código TypeScript |

**Las 46 consultas que quedaron afuera no son deuda.** El limitador de tráfico
cuenta por IP antes de saber quién llama; `gmail_poll_state` no tiene columna de
inquilino; los barridos nocturnos recorren a todos a propósito; el reporte de
facturación los agrega de una; y las de login son las que *averiguan* de qué
inquilino es la sesión. Cada una lleva `// sin-inquilino: <por qué>` encima, y
`pnpm arquitectura` falla con cualquiera que no lo lleve.

**Dos trampas que costaron caro y conviene no volver a pisar:**

- **`FORCE` no alcanza.** Un rol con `BYPASSRLS` ignora las políticas aunque la
  tabla las fuerce. El rol nuevo era obligatorio, no una prolijidad.
- **En Neon los roles viven en el proyecto, no en la rama.** El ensayo creaba
  una rama temporal y ahí adentro le cambiaba la contraseña a `claimmix_app`
  — y el cambio llegaba al rol de producción. Ya está arreglado: el ensayo usa
  `claimmix_app_ensayo`, propio.

### ⏱️ El trabajo deja de morir con la invocación que lo arrancó (2026-08-26)

La carga simulada corría en un `after()` de Vercel: la respuesta salía y el
trabajo seguía en la misma invocación. Funciona hasta que no. Cuando se encolan
muchos casos, el presupuesto de tiempo de la función se agota y Vercel
**descarta** los `after()` que no alcanzaron a arrancar. El caso queda en
`procesando` para siempre — el INSERT ocurrió y el agente nunca corrió.
`reap-stuck.ts` es un barrido nocturno escrito sólo para tapar eso.

Ahora ese flujo es durable (SDK `workflow` de Vercel, 4.8.5). Se encola y cada
paso corre en su propia petición; si el proceso muere, retoma en el paso que
seguía. El barrido queda como red por debajo, no como el mecanismo.

Y está **probado**, no supuesto. `pnpm flujos` corre un flujo de tres pasos
donde el del medio falla dos veces a propósito y verifica que el del medio
corrió tres veces mientras el primero corrió **una**. Sin esa prueba no habría
manera de saberlo: sin el compilador, `"use workflow"` y `"use step"` son
literales de cadena, la función corre igual, y cualquier test que sólo mire el
valor devuelto pasaría con la durabilidad apagada.

**Cuatro cosas que costaron encontrar y conviene no volver a pisar:**

- El primer test contaba en una variable de módulo y daba **cero siempre**. Los
  pasos se compilan a un paquete aparte: la variable que el test miraba y la que
  los pasos tocaban eran dos distintas con el mismo nombre. Un cero que parece
  "no se ejecutó" cuando es "no lo estás mirando".
- Un `import "node:fs"` en el grafo del flujo **no compila**, aunque el uso esté
  adentro de un `"use step"`. El chequeo mira el módulo, no dónde cae la llamada.
- El SDK empaqueta `builtin-modules` y emite su import de JSON sin
  `with {type:"json"}`. Node 24 lo rechaza y **todo flujo se cuelga** hasta que
  el test expira, con un error que no menciona ni a Node ni al JSON. Va parchado
  (`patches/builtin-modules@5.0.0.patch`), con la lista escrita: leerla de
  `node:module` tampoco sirve, porque el flujo corre en una VM donde eso no está.
- `.well-known/workflow/` tiene que quedar afuera del matcher de `src/proxy.ts`.
  Si lo intercepta, el síntoma es `detached ArrayBuffer`.

Si encolar falla, se cae al `after()` de antes: un flujo que no arranca es peor
que un `after()` que quizás sí.

### 🧩 El núcleo, con las decisiones adentro (2026-08-26)

`src/core/` pasó de un archivo a seis, y son los que más criterio concentran: la
máquina de estados de un caso, qué documentos pide cada tipo de siniestro, qué
falta todavía, cómo se arma la conversación que lee el extractor, qué números
son de prueba, y cuándo contestar.

Ninguno hablaba con la base ni con la red; estaban donde estaban por costumbre.
Lo que cambia en la práctica: `tests/unit/conversation-body.test.ts` probaba que
una respuesta citada se recorta bien, y para eso simulaba `@/lib/db` y
`@/data/scope` — porque el import arrastraba mil seiscientas líneas de worker.
Ahora importa del núcleo y no simula nada.

### 🧪 Lo que ahora se prueba solo (2026-08-26)

Tres zonas del producto no tenían un solo test, y las tres deciden algo que
importa. Escribírselos destapó **dos defectos reales**:

**Un nombre salía a medias enmascarar.** `maskByKey` preguntaba
`includes("policy")` antes que `includes("name")`, y `policyholder_name`
*contiene* "policy". El nombre del asegurado se enmascaraba con la regla de los
números de póliza y "Roberto Paz" salía del sistema como `Roberto***Paz`. En una
ciudad chica, eso es la persona.

**Quince consultas reventaban en producción.** El codemod que migró todo a la
capa envolvió también el `.catch(() => [])` del final de las cadenas, y ese
`.catch` las resuelve en una promesa — `batch` necesita el constructor. La
página de un caso, la corrida del agente y el export estaban rotos. Los 2168
tests pasaban en verde: el puente que usan los tests hace
`Promise.resolve(armar(db))`, que con una promesa funciona igual, y por eso
escondía justo esta clase de error.

**Lo que se agregó:**

| | Qué cuida |
|---|---|
| 13 e2e de seguridad | rutas del motor de flujos, nonce de la CSP por pedido, iframe, límite de tráfico |
| 24 tests de PII | que ningún secreto salga, en ningún modo, ni siendo dueño |
| 14 de las guardas | quién entra y quién no — estaban EXCLUIDAS de la cobertura |
| 13 de la capa | que el `set_config` viaje primero en el lote, con el inquilino correcto |
| 7 del flujo durable | que esperar el turno y correr el agente sigan en pasos separados |

**Y dos chequeos que mentían.** Los jobs de e2e e integración se salteaban sin
secretos, imprimían `[skip]` y quedaban **en verde**: se leen como cobertura y
no existen. Ahora es aviso en un pull request —puede venir de un fork— y error
en `main`. El piso de cobertura estaba en 80 con una cobertura real de 70, así
que fallaba siempre y nadie lo corría; queda en el número de hoy, como
trinquete.

`pnpm audit`: 7 vulnerabilidades → 0. Entraban con el SDK de flujos (`undici`,
con un aviso de *cross-user information disclosure*). El arreglo obvio rompió el
lint, y vale la pena el porqué: `">=1.1.18"` no tiene techo, así que 5.0.9
también lo satisface, y pnpm se la dio a `minimatch@3`, que hace `require()` —
`TypeError: expand is not a function` desde adentro de eslint. Un override sin
`<mayor+1` no fija una versión: autoriza cualquier futuro.

### ⚙️ La CI, y qué prueba de verdad (2026-08-26)

Dos jobs pasaban en verde **sin correr nada**: se salteaban cuando faltaba un
secreto, imprimían `[skip]`, y el check quedaba verde. Un verde que no probó
nada se lee como cobertura y no existe.

Al arreglarlo aparecieron tres cosas distintas:

**El post-deploy estaba roto por una omisión propia.** El commit que enseñó a la
CI el rol nuevo agregó `DATABASE_URL_APP` a los jobs de `ci.yml` y no a los de
`post-deploy.yml`. Cuatro jobs corrían media tarea antes de romper: lo que va por
el rol dueño andaba, y lo que pasa por `enTenant` tiraba "falta
DATABASE_URL_APP". En el pen test el síntoma se leía como **"la pared entre
inquilinos falló"**, porque esa prueba pasa por `listCases`. Un rojo que señala
mal cuesta más que uno que no aparece. Hay una invariante que ahora lo comprueba.

**Los 204 tests de integración corren, por primera vez.** Los di por imposibles
y me apuré: el alta exige dirección verificada, sí, pero eso gobierna la
PROVISIÓN —el perfil que ata a alguien a una aseguradora— no la creación de la
cuenta. `pnpm sembrar` hace lo mismo que hace un admin: crea la cuenta y después
escribe el perfil. Corren contra el ensayo y con su rol restringido, nunca
contra producción — el script se planta solo si le pasan esa cadena.

Al ponerlos a correr salieron cuatro cosas que llevaban meses tapadas: apuntaban
a un endpoint que ya no existe, no mandaban `Origin` (que Better Auth exige
contra CSRF), **no había techo de intentos en la ruta HTTP de login** —el límite
existía pero sólo lo aplicaba la Server Action del formulario, o sea el camino
de una persona y no el de quien adivina contraseñas— y **la capa de datos no
comprobaba su propia suposición**: con `DATABASE_URL_APP` apuntando al rol
dueño, `/api/cases` sirvió casos de tres aseguradoras con un 200 impecable.

**Los e2e están prendidos desde el 27 de agosto de 2026, y ninguno se saltea.**
68 tests: login y cierre de sesión de verdad, la conversación de un caso,
simular un mail y verlo aparecer en la tabla, más las cabeceras y límites que
no necesitan datos.

Corren contra el ENSAYO con secretos PROPIOS —`E2E_DATABASE_URL` y
`E2E_DATABASE_URL_APP`— y ese es todo el punto. Antes usaban `DATABASE_URL`, o
sea la base de los clientes, y los e2e escriben. El aviso del propio job decía
desde siempre «apuntando al ENSAYO, nunca a producción» y estaba mal igual:
con la misma variable, apuntarla mal es un descuido de un segundo que después
no se ve. Con un nombre distinto, para que toquen producción hay que ir a crear
un secreto con ese nombre y pegarle adentro esa cadena — ya no es un descuido
sino una decisión.

Cómo correrlos en local está en `docs/TESTING.md`, sección 8: `pnpm sembrar` y
`pnpm test:e2e`.

**Encenderlos destapó tres fallas reales, todas en producción:**

- `countRows` estaba caído en cada carga de la bandeja, y también en el listado
  de clientes, el de pólizas y la pantalla de métricas. Envolvía `db.$count`,
  que no devuelve una consulta sino un objeto que se puede esperar: la capa
  manda todo por `batch()` y necesita ARMARLA. La bandeja mostraba «This page
  couldn't load». Hay una invariante nueva que lo prohíbe.
- `/api/admin/gmail-status` dejaba entrar a cualquier usuario con sesión,
  mientras el encabezado del propio archivo decía «AC6: Non-admin users get
  403». Había dos tests contradiciéndose y sólo corría el que acompañaba al
  código. Esa ruta y su pantalla huérfana ya no existen.
- El bloque que saca a un usuario con sesión de `/login` era código muerto: el
  proxy devuelve temprano para las rutas públicas y `/login` es pública.

Catorce de esos tests se salteaban con un mensaje claro, así que no era un
verde mentiroso. Pero eran catorce comprobaciones que no existían y se contaban
como cobertura. Un test que no corre cuesta más que no tenerlo.

**Estado de los pipelines:** CI en verde. Post-deploy con smoke, pen test,
permisos, carga y timbre en verde.

### 🔑 Credenciales rotadas (2026-08-26)

Cuatro credenciales reales quedaron en el transcripto de una sesión de trabajo,
y la razón principal era que `pnpm rol-app --rotar` **imprimía** la contraseña
que acababa de generar. Ahora va del generador al archivo sin pasar por pantalla:
una credencial que aparece en una terminal termina en un registro, una captura o
el historial, y no hay forma de saber en cuál de los tres.

| Rotada | Alcance |
|---|---|
| `claimmix_app` producción | la que usa la aplicación para todo |
| `claimmix_app` ensayo | idem, en la base de pruebas |
| `neondb_owner` ensayo | dueño de las tablas del ensayo |
| Clave de API de Neon | **la de mayor alcance**: crea ramas, lee las cadenas de todas, fabrica más claves |

La clave de Neon vieja responde 401 — comprobado.

**Rotar dejó producción caída unos minutos.** El deploy que corre tiene las
variables horneadas y no las relee, así que la capa de datos empezó a fallar la
autenticación. Un redeploy lo resolvió. No hay forma de evitar esa ventana
—Postgres no admite dos contraseñas a la vez para el mismo rol— pero sí de
hacerla corta, y el script ahora lo dice antes de que pase:

1. rotar
2. subir la variable a Vercel
3. **redesplegar** — el deploy que corre no relee las variables
4. mirar `/api/health`

**Sin rotar, a propósito:** el token de WhatsApp y el secreto de Google (que
respalda la casilla y el login). Rotarlos corta la casilla y obliga a
reconectar; quedó dicho que esos se mantienen. Siguen anotados como expuestos.

### 🛡️ Auditoría de seguridad (2026-08-26)

Punto por punto, con el número medido al lado. Lo que dice "sí" está comprobado
contra producción o con un test que falla si deja de ser cierto.

| Punto | Estado |
|---|---|
| Aislamiento entre inquilinos (RLS) | 29 tablas con FORCE y política, rol sin BYPASSRLS, y la capa se planta si le dan uno que saltea |
| CORS | ningún `Access-Control-Allow-Origin` para un origen ajeno |
| Credenciales fuera del código | gitleaks en cada push, en verde |
| Límite de tráfico | por (IP, cuenta) **y** por IP sola — el segundo se agregó hoy |
| Inyección SQL | drizzle parametriza; 3 `sql.raw` y los tres con enteros acotados |
| Autenticación y validación | 37 de 54 rutas con zod; las 17 restantes no leen cuerpo o validan a mano |
| Cabeceras de seguridad | las 6, verificadas en producción |
| GET no filtran secretos | 19 comprobaciones sobre 15 rutas, con sesión y sin ella |
| Listados acotados | `per_page=100000` devuelve 100 |
| Columnas de más | el listado pasó de 24 campos a 18 |
| Peso en el navegador | 273 kB comprimidos, tope 300 |
| Índices | medidos; RLS **no** los anula (comprobado con 300.000 filas) |
| Tests | 2190 unitarios, 223 de integración, 55 e2e, 30 intentos de pen test |
| Pruebas de carga | `pnpm load`, p95 de 299 ms con 20 analistas |

**Lo que NO está, y es una decisión pendiente:**

- ~~**Recuperación de contraseña**~~: hecha el 28 de agosto de 2026. Enlace por
  correo que vence en una hora y sirve una sola vez, desde la casilla de la
  aseguradora de esa persona. La respuesta del formulario es siempre la misma
  exista o no la cuenta, y el enlace no se registra en ningún lado — es la
  credencial mientras dura. Techo de tres pedidos por hora y por dirección,
  aplicado en la Server Action Y en la ruta HTTP, que son dos puertas al mismo
  cuarto.
- **Dominio propio**: corre en `claimmix.vercel.app`. Hace falta comprar y
  configurar uno.
- **VPS**: no aplica. Esto es serverless; no hay puertos ni SSH que cerrar.
- **No hay ningún `owner`.** Ya no bloquea nada: desde el 28 de agosto de 2026
  `veltra.soporte@gmail.com` tiene rol `specialist`, y el aviso de derivación
  busca especialistas ANTES de caer al respaldo por `owner`. `owner` sólo se
  necesita para que un admin pueda ascender a otro a ese rol.

  Cómo quedó el aviso: `SPECIALIST_ALERT_EMAILS` se borró de producción a
  propósito. Mientras esa lista tenía direcciones ganaba sobre los roles, así
  que sumar un especialista no cambiaba nada. Ahora el destinatario se decide
  por el rol —lo que se ve en la pantalla de usuarios— y no por una variable
  del despliegue. La variable sigue existiendo como escotilla para el caso en
  que no haya ningún especialista.

**Dos cosas que encontró la revisión, en código escrito el mismo día:**

El techo del login frenaba a quien ataca UNA cuenta y no a quien recorre una
lista de diez mil direcciones — cinco intentos en cada una y ninguno en total.
Ahora hay un segundo cupo por IP.

Y el guardia que comprueba el rol cacheaba su promesa pasara lo que pasara: un
error de red de un segundo dejaba la capa de datos rota hasta reciclar la
instancia. Ahora sólo se cachea el resultado bueno.

**Y una que casi reporto mal:** `getClientIp` toma el valor de más a la
izquierda de `X-Forwarded-For`, que en general lo escribe quien llama. Probado
contra producción —doce pedidos con una IP falsa fija y doce rotándola
compartieron cupo— Vercel la sobrescribe en el borde. No es una vulnerabilidad;
es una garantía de la plataforma de la que dependen todos los topes, y ahora
está escrita en el código.

### 🔍 Auditoría del código contra las buenas prácticas (2026-08-28/29)

Barrido del código entero contra el documento de estándares: DRY, KISS, una
responsabilidad por archivo, capas claras, nada de N+1. De los hallazgos que se
sostuvieron contra el código real, se implementaron todos. Cada plan pasó antes
por un pase adversarial que lo refutó; los siete volvieron con correcciones, y
en varios casos la corrección cambió qué había que hacer.

**Bugs vivos que aparecieron en el camino** (no eran el objetivo del barrido):

- **Confirmar un campo sin valor escribía y después contestaba 400.** La fila de
  `claim_field_confirmations` quedaba marcada como confirmada y el analista veía
  «Error al procesar la confirmación». Reintentaba y fallaba de nuevo, porque la
  fila ya no estaba pendiente. Sin salida. Arreglado en los dos extremos: el
  servidor corta antes de escribir, y la pantalla no ofrece confirmar lo que no
  tiene valor.
- **Tres datos en conflicto mandaban tres mails al asegurado.** Es lo que pasa
  cuando escribe un familiar del titular —nombre, mail y documento distintos—.
  Ahora es un mensaje que los lista.
- **Un typo en el canal del chequeo de entrega mandaba un mail.** El canal se
  resolvía con `channel === "whatsapp" ? … : "email"`, así que «whatsap» mandaba
  un correo. Ahora se valida contra la lista.
- **El mensaje de presupuesto agotado decía «para este mes» siempre**, pero dos
  de los tres topes son diarios.

**Lo que dependía de la suerte:**

- Que un ensayo no le escriba a una persona real NO lo garantizaba el canal
  `email_sim` —`dispatch.ts` no mira el canal—: lo garantizaba que el `from_addr`
  fuera `@example.com`. En modo texto libre quedaba `null`, y lo único que
  frenaba el envío era que Gmail no puede mandar a una dirección vacía. Ahora es
  siempre una dirección reservada y válida.
- `POST /api/health/delivery` —que manda mensajes de verdad— no tenía ni un
  test, y su registro de auditoría no anotaba a quién. Ahora tiene 26 y anota el
  destinatario enmascarado.

**Tests que estaban en verde sin probar nada:**

- Cuatro criterios de aceptación probaban una función vacía: el archivo mockeaba
  el módulo bajo prueba y después lo llamaba. Uno de ellos afirmaba que el mock
  había sido llamado con los argumentos que el propio test le pasó.
- Las cuatro ramas que eligen el estado de un caso no las cubría nadie: invertir
  dos `if` dejaba los 2300 tests en verde.
- Ninguna de las cuatro pruebas de conflicto contaba envíos, así que ni el N+1
  ni los N mails estaban cubiertos.

**Duplicación real que se fue:**

- La lista de los nueve datos del siniestro estaba escrita tres veces (esquema,
  hidratación, y una escalera de `if` en el worker). Ahora sale del esquema.
- Clientes y pólizas eran el mismo controlador escrito dos veces.
- Los dos módulos de fine-tuning elegían el conjunto de entrenamiento por
  separado.
- La misma consulta de mensajes estaba escrita dos veces en la misma pantalla.
- Once paneles del detalle de caso escribían a mano su `aria-labelledby`.

**Lo que quedó anotado y NO se hizo, a propósito:**

- ~~**Las once consultas por render del detalle de caso.**~~ ✅ **HECHO
  2026-08-29**, pero NO como pedía el hallazgo. Lo que se paga no es la cantidad
  de consultas sino la de esperas encadenadas, y eran cinco: la fila del caso,
  tres relacionadas, dos de correo, el respaldo del parser, y el acordeón —que
  era otro componente de servidor que consultaba solo—. Ahora son DOS: la fila
  del caso, y después todo junto. Sigue siendo una consulta por cosa, cada una
  con su `.catch`, así que los cinco dominios de falla se mantienen: juntarlas
  en un `enTenantVarias` habría hecho que un hipo leyendo la auditoría vaciara
  la pantalla entera. Hay tests que fijan las dos cosas —las dos tandas y la
  independencia ante fallas— y el de las tandas no cuenta consultas: cuenta
  cuándo arranca y termina cada una.
- ~~**El andamiaje de los tests del worker está copiado en cuatro archivos.**~~
  ✅ **HECHO 2026-08-29.** Quedó sobre DOS módulos y no uno, a propósito:
  `worker-harness.ts` para el estilo `vi.doMock` por test, y `db-simulado.ts`
  para el de `vi.mock` a nivel de archivo. No se pueden unificar porque
  `vi.mock` se iza por encima de los imports — eso, y las veinte y pico
  llamadas a `vi.mock` de cada archivo, queda repetido y está bien que quede.
  Migré de a uno comparando cobertura, que salió idéntica hasta la centésima.
  Verificar la migración destapó dos cosas: el camino de error de Gemini era una
  SEGUNDA copia a mano de `escalateCase` (anularla no rompía nada), y el doble
  de `GeminiExtractionError` de ese archivo no llevaba `cause`, así que el
  estado HTTP del proveedor nunca llegaba al registro. Las dos arregladas.
- ~~**`ip` y `user-agent` en la auditoría de confirmaciones.**~~ ✅ **HECHO
  2026-08-29.** Ahora se guardan, igual que en el PATCH del caso: un historial
  donde la mitad de las acciones tiene origen y la otra mitad no sirve poco para
  reconstruir quién tocó qué. Al hacerlo apareció que la política de privacidad
  declaraba «acciones, marca de tiempo, ID de usuario» y NO la IP ni el
  navegador — y `patchCase` ya los guardaba, o sea que el texto venía corto
  desde antes. Ahora los declara, y aclara que esos registros son sobre el
  personal de la aseguradora, no sobre quien reporta un siniestro.

Cobertura al cierre: 72.9 sentencias / 63.2 ramas / 74.5 funciones / 73.9
líneas, arriba de los pisos y arriba de donde arrancó. 2362 unitarios en verde.

### 🔐 VibeSec sobre todo el repo (2026-08-29/30)

Se pasó [VibeSec-Skill](https://github.com/BehiSecc/VibeSec-Skill) entera sobre
el código, sección por sección, con un pase adversarial que refutó cada hallazgo
antes de darlo por bueno. La guía queda versionada en `.claude/skills/vibesec/`
con una nota de qué asume y qué hace distinto este repo — que es la fuente
número uno de falsos positivos al leerla acá.

**Lo más grave, y no lo encontró el pentest propio:**

- **Quince endpoints que cruzaban aseguradoras.** El plugin `admin` de Better
  Auth publicaba `/api/auth/admin/*`: `list-users` devolvía el padrón de TODAS,
  e `impersonate-user` emitía una sesión a nombre de cualquier usuario de
  cualquiera, salteándose entera la capa RLS. Decidía el permiso contra
  `authUsers.role`, una columna paralela a la que usa el producto y que nadie
  sincronizaba: el día que alguien las «alineara», cada admin de aseguradora
  pasaba a ser admin global. La aplicación no llamaba a ninguno. Se sacó.
- **Un asegurado podía hacer que la aseguradora le mandara phishing a quien él
  eligiera.** Las cinco plantillas de correo interpolaban sin escapar todo lo
  que viene de afuera. Y el destinatario lo elegía el atacante: el mail sale a
  la dirección del `From` entrante, que nadie verifica. Ahora se escapa el HTML
  (el texto plano NO, y hay un test que lo fija en los dos sentidos).
- **Un admin podía enganchar SU casilla de Gmail a la aseguradora de un
  colega.** Al `state` de OAuth le faltaba un nonce; un admin conoce el `userId`
  de sus colegas porque ve el padrón. Ahora el nonce viaja por dos caminos y la
  cookie se quema al usarse.
- **`/api/intake/simulate` no tenía guarda de rol**, y el encabezado del archivo
  decía que sí. Un `viewer` creaba casos reales y gastaba IA.

**Fallos abiertos, que es el patrón que más se repitió:**

- El limitador de tráfico se degradaba a memoria en silencio si faltaba
  `DATABASE_URL`. En serverless eso es no tener tope.
- El webhook de Gmail no verificaba NADA si faltaba `PUBSUB_AUDIENCE`.
- La deduplicación de adjuntos corría antes de validar el tipo, así que
  reenviar los mismos bytes con otro `Content-Type` salteaba la lista blanca.
  Y `image/*` dejaba pasar SVG, que es XML con script adentro.

**Sesiones que no se cerraban cuando alguien las cerraba:**

- Restablecer la contraseña no cerraba las sesiones abiertas — que es el motivo
  por el que alguien la restablece.
- Cambiarla pedía explícitamente `revokeOtherSessions: false`.
- Y el caché de sesión en cookie duraba 5 minutos, o sea el techo de cuánto
  sobrevive una sesión ya revocada. Bajó a 60 segundos, y la pantalla lo dice.

**De más al navegador:** el historial del caso viajaba entero, con la IP y el
navegador de cada analista; el error crudo de Gemini volvía al cliente; y la
versión de Node y la región se le mostraban a cualquiera.

**Los cuatro que primero dejé con motivo, y después se hicieron igual.** Tres de
esos motivos resultaron menos ciertos de lo que pensé, y vale más eso que la
lista:

- ~~`style-src 'unsafe-inline'`~~ ✅ **fuera.** El encabezado del propio archivo
  decía que Tailwind v4 genera estilos en línea en tiempo de ejecución y que por
  eso hacía falta. Probado en un navegador contra un build de producción: es
  falso. Lo que producía atributos `style` eran siete `style={{ width }}`
  NUESTROS, en las barras de progreso; Tailwind emite una hoja, que `'self'` ya
  cubre. Las barras pasaron a una clase redondeada al 5% (`ancho-de-barra.ts`,
  21 clases literales porque Tailwind sólo compila las que ve escritas). Cero
  violaciones en producción; las 17 que salen en desarrollo son del overlay de
  Next. El nonce NO cubre atributos `style`, sólo bloques `<style>` — medido.
- ~~La CSP no llega a `/api`~~ ✅ **ahora tiene la suya, más cerrada:**
  `default-src 'none'`. Sin `sandbox`, que habría roto la descarga del CSV.
- ~~El token de recuperación en la query string~~ ✅ **sale de la URL apenas la
  página lo lee.** Llega ahí porque así funciona un enlace por correo; eso no
  obliga a que se quede. Costo aceptado: recargar pierde el enlace.
- ~~El alta distingue si una dirección ya tiene cuenta~~ ✅ **los dos caminos
  terminan igual.** Lo que NO arregla, escrito en el código: un alta nueva sí
  deja sesión y cae en /bandeja, pero eso ya no es una sonda pasiva.

`pnpm pentest` quedó en 40 intentos. Tres sondas nuevas cuidan esto: `script-src`
y `style-src` sin `unsafe-inline`, sin `unsafe-eval`, y que la API traiga su CSP.
La primera importa porque la que ya había sólo miraba que `script-src` tuviera
un nonce — y un `'nonce-…' 'unsafe-inline'` la pasaba.

`pnpm pentest` pasó de 30 a 36 intentos, y la sonda nueva —la del subárbol admin
de Better Auth— se escribió dos veces: la primera aceptaba «cualquier error» y
pasaba CON el agujero puesto, porque un endpoint montado da 401 y uno inexistente
da 404, y los dos son >= 400. Ahora exige 404 y trae su propia prueba de control.

**Y un e2e que se saltaba solo.** Al cerrar la CSP, CI se puso en rojo con un
test que decía comprobar que `/api` traía la cabecera del proxy:

```ts
if (csp) { expect(csp).toContain("script-src"); }
```

La API no traía ninguna CSP, así que la condición era falsa y el test pasaba en
verde sin afirmar nada — se leía como cobertura de una cabecera de seguridad y no
comprobaba que existiera. Falló recién cuando la cabecera empezó a existir. La
premisa además era falsa: el proxy no corre para `/api`, su matcher la excluye a
propósito. Reescrito sin `if`, y con uno nuevo que afirma lo que se acaba de
ganar: la CSP de una página lleva nonce y no tiene `unsafe-inline` ni
`unsafe-eval`.

Después CI se cayó una vez más con `Timed out waiting 120000ms from
config.webServer` y ninguna línea más: Playwright ignora el stdout del servidor,
así que no se distinguía una compilación en frío de un proceso muerto. Re-correr
pasó en verde —era lo primero—, pero eso se supo re-corriendo y no leyendo. Ahora
`stdout`/`stderr` van a `pipe` y el tope en CI es 240 s, donde no hay caché de
Turbopack. Un servidor roto de verdad sigue fallando, sólo que más tarde y
diciendo por qué.

**Y un tercero, el más interesante: un test que medía el reloj.** `AC3` del login
—«el sexto intento en diez segundos da 429»— se puso en rojo después de once
corridas verdes con el mismo código. La ventana del limitador es fija y alineada
al reloj (`floor(now / 10s) * 10s`), que es lo que hace que todas las instancias
cuenten juntas, y el costo está escrito en `postgres.ts`: en el borde entre dos
ventanas pasan hasta el doble de intentos. El test caía justo ahí.

Reproducido contra el ensayo con la misma función que usa el login:

| ráfaga de 5 + 1 | sexto permitido |
|---|---|
| arrancando 250 ms antes del borde | **true** ← la falla |
| arrancando alineada | false |

Una de cada cuatro corridas, que es del orden de lo que se vio en CI. El
limitador hace lo que dice; el test afirmaba una garantía que nunca prometió, así
que se arregló el test. De paso se fue un `beforeEach` con `clearAllRateLimits()`
que no reiniciaba nada: limpiaba el mapa en memoria del proceso de los tests, no
el del servidor, y el servidor ni cuenta en memoria — cuenta en Postgres.

### 📄 Le encontrábamos la póliza y se la pedíamos igual (2026-08-31)

El ensayo posterior al deploy encontró algo que ninguna de las 2.482
verificaciones veía, que es exactamente para lo que está:

```
busca-la-poliza turno 1: no debería decir "número de póliza"
```

Cecilia da su DNI y no el número de póliza. El buscador la encuentra, el agente
llama a `polizas_por_dni`, recibe **POL-8812-R**… y la respuesta siguiente
arranca con «El número de póliza (por ejemplo POL-12345)».

El agente no se equivocaba. Los faltantes se anotan en el paso (h) del worker y
recién en (i) y (j) se busca en la base, así que `numero_poliza` le llegaba
marcado como faltante aunque la póliza ya estuviera enlazada por `policy_id`.
**Pedirle a alguien un dato que está en nuestra propia base es lo que hace un
formulario**, que es lo que esto vino a reemplazar.

No era una regresión: el post-deploy anterior pasó con el mismo código. El
escenario lo destapaba a veces, y ese día lo destapó seis de seis.

Ahora, cuando encontramos la póliza y la persona no dijo el número, se anota —el
valor va a `extracted_fields` con la confianza del match, no inventada, y la fila
de faltantes se marca satisfecha, igual que hace el reconciliador de documentos.
La clave se canoniza antes de comparar: el extractor emite `numero_poliza` o
`policy_number` según el día, y marcar sólo una dejaba viva la otra.

Tres decisiones, las tres afirmadas:

| la persona | encontramos | qué hace |
|---|---|---|
| no dijo número | una póliza | la completa sola |
| dijo un número | cualquier cosa | **no lo pisa**, ni aunque no coincida |
| no dijo número | dos pólizas | pregunta |

La segunda importa tanto como la primera: un número equivocado es una
conversación con la persona, no algo para corregirle por atrás. La tercera,
porque con el auto y la casa a nombre de la misma persona no sabemos bajo cuál
viene el siniestro, y elegir la primera sería adivinar y escribirlo como si lo
supiéramos.

La regla vive en `@/core/case/poliza-encontrada` y no adentro del worker, por lo
mismo que `status-after-extraction`: trece líneas puras entre consultas a la base
no las prueba nadie.

### 🧹 Barrido de tests que se salteaban solos (2026-08-31)

Después del `if (csp)` —un e2e que pasaba en verde sin afirmar nada— fui a buscar
a sus hermanos por todo el árbol. De **2.241 casos**:

| lo que se buscó | resultado |
|---|---|
| afirmaciones adentro de un `if` | 28, de las cuales **25 son estrechamiento de tipo** (`if (result.success)` con un `expect(...).toBe(true)` arriba — el patrón idiomático de Zod). **3 vacías.** |
| tests sin ninguna afirmación | **0.** Los 5 que marcó el detector delegan en un ayudante que sí afirma |
| tests salteados | 52, **todos** con `skipIf` por credenciales o servidor, y todos visibles en el reporte |
| expectativas construidas desde una constante de la implementación | **0** |

Los tres vacíos:

- **`policy-matcher`, «ordena activas antes que vencidas».** El cuerpo entero
  adentro de dos `if` anidados: con una función que devolviera `[]` pasaba igual.
- **`customer-matcher`, «el match por DNI (0.85) va primero».** Devolvía la
  misma persona por los dos caminos, la deduplicación las juntaba en una, y el
  `if (matches.length >= 2)` nunca se cumplía. Lo único en pie era
  `expect(first).toBeDefined()`.
- **`worker`, «procesando sólo transiciona a listo/esperando/escalado».** Si el
  worker no escribía NINGÚN estado —un caso colgado, peor que transicionar mal—
  el bucle no daba una vuelta.

**Verificados con mutantes, no de palabra.** Orden invertido → cae. Confianza del
DNI de 0.85 a 0.55 → caen tres. Estado prohibido → cae el del FSM. Y uno que NO
cae: sacar `caseUpdate.status` no rompe nada porque hay otro escritor que igual
deja «listo» — queda anotado en el test para no exagerar lo que cuida.

Dos de propina: `Retry-After` se afirmaba `>= 0`, así que un `Retry-After: 0`
pasaba (le dice al cliente que reintente ya mismo, justo lo que el tope existe
para impedir); y nada afirmaba cuántos escenarios tiene el catálogo del extractor
—los bucles GENERAN un test por escenario, así que borrar 140 bajaba el total y
seguía todo verde. Piso en 160; hay 163.

El detector tenía el defecto que buscaba: leía `async ({ page }) => {` y tomaba
la llave de la desestructuración como cuerpo, así que reportaba como vacíos los
cincuenta e2e de Playwright.

### 🔌 El servidor de desarrollo dice a qué base le habla (2026-08-31)

`next dev` lee `.env.local`, donde vive la cadena de **producción**, y eso está
bien: hay un solo ambiente desplegado. Lo que no estaba bien es que no se notara
— un `pnpm dev` olvidado contra la base de los clientes se ve igual que uno
contra el ensayo.

```
[db] conectando a ep-damp-meadow-ac1xqhzs.sa-east-1.aws.neon.tech
```

Sólo el host: la contraseña viaja en la misma cadena y no tiene por qué aparecer
en una terminal, un log de CI ni una captura. Callado en producción y bajo
vitest. Dice «conectando a» y no «desarrollo» porque también sale en el ensayo
que corre en CI contra una base real, y ahí «desarrollo» era falso justo donde
más importa saber a qué base se le escribe. Cierra la mitad que faltaba del incidente de los e2e escribiendo en la
base real.

### 🔎 Una persona escribía su DNI con puntos y no aparecía en el padrón (2026-08-31)

El post-deploy volvió a fallar en `busca-la-poliza`. El aviso que se había
agregado un rato antes —qué claves había para buscar, los nombres y nunca los
valores— contestó de una:

```
"customer_matcher.matches_found","match_count":0,"claves_disponibles":["dni","phone"]
```

El DNI **estaba** y aun así no encontró a nadie. La primera hipótesis (que el
modelo había mandado el alias `dni_asegurado`) era falsa, y ese log es lo único
que lo demostró.

La causa era una línea: `.where(eq(c.dni, dni))` — igualdad exacta contra una
columna que guarda los dígitos pelados. Medido contra el ensayo, sembrando un
cliente y buscándolo de las cuatro formas:

| lo que escribe la persona | antes | después |
|---|---|---|
| `27.654.321` | **0** | 1 |
| `27654321` | 1 | 1 |
| `DNI 27 654 321` | **0** | 1 |
| `s/d` | 0 | 0 |

**No era una línea suelta: los cuatro caminos comparaban en crudo.** DNI e
igualdad exacta; póliza igual, en los dos buscadores; correo con la entrada en
minúsculas y la columna no; y el teléfono, el más elocuente — calculaba el
normalizado y lo **tiraba**, con un `void normalized; // not in SQL` al lado.

Y el sistema ya lo sabía: `verificar_poliza` y `polizas_por_dni` normalizan desde
el día uno, con un comentario que enumera las tres formas de escribir un DNI. Dos
caminos a la misma tabla, uno tolerante y el otro no, y el estricto era el que
decide si el caso queda asociado a un cliente. Por eso el agente encontraba la
póliza por DNI y el caso quedaba igual sin cliente.

Ahora hay una sola normalización en `@/core/matching/normalizar`, y las copias de
`agent-tools` la usan. La de `claim-parser` queda: normaliza distinto a propósito
y es sobre el valor que se guarda y se muestra, no sobre el que se busca.

**La mitad peligrosa, también afirmada.** Un `"s/d"` se normaliza a la cadena
vacía, y buscar por vacío contra una columna normalizada devuelve a TODA persona
con el documento vacío, con la confianza alta de una coincidencia por documento.
Encontrar a cualquiera es peor que no encontrar a nadie: hay un mínimo por tipo
de dato y por debajo ni se consulta.

Verificado en vez de supuesto: interpolar el dato en un `sql` de Drizzle **no**
es inyección — compila a `= $1` con el valor aparte, y hay un test con
`X' OR '1'='1` que lo afirma.

Efecto de punta a punta: `busca-la-poliza` registra `match_count: 1`, y
`choque-completo` pasó de `confirmacion_pendiente` a `listo_para_core`, que es a
lo que llega un caso cuando sí se asocia al cliente.

**Cuánta gente quedó afectada: ninguna, todavía.** Medido en la base de
producción después de arreglarlo, que es la parte que ningún análisis del código
podía contestar:

| | |
|---|---|
| clientes cargados | **0** |
| pólizas cargadas | **0** |
| casos | 481 |
| casos con DNI extraído | 154 |
| …de los cuales escritos **con puntos** | **59 (38,3 %)** |

O sea: ninguna aseguradora cargó todavía su padrón, así que no había con qué
coincidir y nadie sufrió el defecto. Pero de las 154 personas que dieron su DNI,
59 lo escribieron `NN.NNN.NNN` — **dos de cada cinco**. El día que se cargue el
primer padrón, el defecto habría fallado en silencio con esas dos de cada cinco,
sin una sola excepción ni una línea de log.

El número de póliza, en cambio, vino normalizado en el 100 % de los 94 casos que
lo traen: ese camino estaba igual de mal escrito y mucho menos expuesto.

Vale la aclaración porque el mensaje del commit se lee como si hubiera pasado. No
pasó: el arreglo es preventivo, y lo que lo hace urgente no es el daño hecho sino
que el daño empezaría el día que el producto empiece a servir para algo, y sería
invisible.

### 🕳️ Barrido de defectos silenciosos (2026-08-31)

Sesenta y un agentes sobre `src/` y `scripts/`, con ocho lentes distintos y dos
escépticos por hallazgo (uno que intenta refutar leyendo el código, otro que
pregunta si le pasa algo malo a alguien). **31 crudos → 26 únicos → 18
confirmados**, más 2 de un crítico de cobertura.

Buscaba una familia concreta: código que parece funcionar, no funciona, y **no
falla cuando no funciona**.

#### Arreglados

| qué pasaba | dónde |
|---|---|
| **El agente podía dar por recibido un parte policial que nadie mandó.** Encontrado en los DATOS, no leyendo código. | `orchestrate.ts` |
| **«Hay un herido» iba a un especialista; «hay tres heridos», a nadie.** La capa de patrones no veía el plural. | `severity-classifier.ts` |
| **Un aviso al especialista que falló contaba como aviso**, y la guarda de idempotencia impedía reintentar para siempre. | `specialist-alert.ts` |
| **La pantalla decía «completitud automática: 0%»** con 28 casos completados: contaba estados que el canal real no escribe. | `kpis.ts` |
| **Con más de 50 mensajes acumulados el resto se perdía**, con `errors: 0`: la marca de agua saltaba al presente sin leer la cola. | `gmail-poller.ts` |

#### Los 13, hechos

Ninguno tenía daño medido en producción, y eso vale decirlo junto: casi todos son
preventivos. Lo que los hacía urgentes no es lo que rompieron sino que rompen en
silencio, el día que llegue volumen.

| qué pasaba | dónde |
|---|---|
| El tope mensual de IA decía ser del proyecto y era **por aseguradora**: cuatro inquilinos a 199 son 796 contra un techo de 200 | `budget.ts` |
| El mail de conflicto decía «Obtuvimos el siguiente dato:» **y nada después** | `orchestrate.ts` |
| El remitente que indexa la memoria del cliente venía **siempre vacío** en el canal real | `confirm-field.ts` |
| Por mail, la pregunta de la persona se caía en el borde y salía el pedido anterior **palabra por palabra** | `render.ts` |
| El DNI entraba **crudo** al `audit_log` y a stdout | `redact.ts` |
| El redactor **invertía frases**: «sin la póliza no se puede» → «sin la [POLIZA] se puede» | `redact.ts` |
| Entre las 21 y las 24, una póliza que vence hoy figuraba **vencida** | tres lugares |
| La caja de `/clientes` decía «nombre, DNI o email» y buscaba **sólo por nombre** | `clientes/page.tsx` |
| El cupo por usuario **no podía alcanzarse**: 7.554 filas de uso, cero con usuario | `gemini-extractor.ts` |
| El barrido nocturno cerraba 250 casos y auditaba **200** | `close-abandoned.ts` |
| El re-despacho no miraba si el POST llegó, y la bandera ya estaba limpia | `extract.ts` |
| El conflicto se detectaba con la clave canónica y se leía con la cruda: quedaba **vacío** | `orchestrate.ts` |
| La cartera **contradecía la factura** ya emitida de un mes cerrado | `tenant-summary.ts` |

Y las dos decisiones de arquitectura:

- **`no_relevante` tiene una salida.** Alguien escribe «hola», queda clasificado
  como no-denuncia, y la denuncia de verdad no la leía nadie. LLM08 sigue en pie:
  la arista la toma el ingreso de correo cuando llega un mensaje, no el modelo.
  Abrirla evaporó una guarda de PERMISOS en `/re-analyze` que preguntaba «¿es
  terminal?» — lo cazó un test que ya estaba, y ahora son dos nombres distintos
  para dos preguntas distintas.
- **`claim_attachments.matched_doc_key`** (migración 0022, aplicada a las dos
  bases): un adjunto que ya cerró un documento deja de ofrecerse.

#### Lo que aprendí arreglándolos, que vale más que los arreglos

- **Un test defendía un defecto.** El sello «recibido el …» usaba el día UTC, y
  el test que lo fijaba existe justamente para que el modelo resuelva la palabra
  «ayer». Con el sello corrido, calculaba la fecha del siniestro un día tarde.
- **Casi rompo permisos dos veces.** Abrir la máquina de estados evaporó una
  guarda; los dos tests que la cazaron ya estaban escritos.
- **Un comentario mío mentía.** El encabezado de `normalizarNumeroPoliza` decía
  que `POL8812R` y `POL-8812-R` son el mismo contrato. No lo cambié —el índice
  único es sobre el texto crudo, así que podrían ser dos contratos— pero es la
  clase de comentario que hace que alguien «arregle» la función y rompa el 100 %
  de las búsquedas en silencio. Hay un test que ata las dos mitades.
- **Me equivoqué de base.** `migrate.mjs` lee `.env.local` directo e ignora el
  entorno: creyendo que aplicaba al ensayo, apliqué a producción. Aditiva y sin
  daño, pero no era lo que quise hacer. Para ensayar va `--env
  STAGING_DATABASE_URL`.

### 🎨 El tablero, con el lenguaje visual de la referencia (2026-09-01)

Se copió el lenguaje visual de un producto de referencia sobre las dos
pantallas que se usan todo el día. **Sólo el diseño**: no cambió ningún
control, ningún botón, ninguna consulta de negocio.

**La bandeja** se veía como tres tarjetas mal apiladas, y por razones
concretas:

| qué pasaba | por qué se veía mal |
|---|---|
| El título estaba escrito **dos veces** — «Bandeja de siniestros» en la pantalla y otra vez adentro de la tarjeta | dos encabezados a diez centímetros, los dos con cara de ser el de la pantalla |
| **Tres franjas de filtros**, cada una con su `border-b` y su `bg-white`, adentro de una tarjeta que ya tenía fondo y borde | tres líneas duras cruzando algo redondeado |
| Veinte chips, **todos rellenos de gris** salvo el activo | el elegido tenía que pelear por destacarse contra diecinueve iguales |
| «Martín Ezequiel Rodríguez» se partía en **tres líneas** | la fila pasaba de 44 a 97 píxeles; con veinte filas, media pantalla de aire |
| La hora en formato de 12 (`09:55 p. m.`) | cinco caracteres de más por fila, y con doce columnas eso empujaba «Asignación» fuera de la pantalla |

Ahora: un encabezado que en vez de repetir el título dice **cuántos siniestros
hay bajo los filtros puestos**, una sola franja de filtros, chips sin relleno
salvo el elegido, nombre truncado con el completo en el `title`, y reloj de 24
—que además es como se escribe la hora en Argentina—.

**El detalle del caso** pasó a la grilla de rótulo-sobre-valor. La fila de
metadatos era prosa con dos puntos —«Asignado a: Sin asignar   Creado: hace 3
días»— o sea etiquetas y valores del mismo tamaño en la misma línea: para leer
un dato había que leer los tres. `Field` sale como `<dt>`/`<dd>` adentro de un
`<dl>`, así que un lector de pantalla dice «Póliza, ABC-123» en vez de dos
textos sueltos.

**La insignia de estado tenía trece colores, uno por estado.** Trece colores no
informan: hay que leer la palabra igual, y mientras tanto la columna parece un
semáforo roto. Ahora son **cinco tonos que contestan la única pregunta** que se
hace alguien mirando la bandeja —¿esto me está esperando a mí?—: rojo pide una
persona, ámbar espera al denunciante, violeta está en vuelo, verde salió bien,
gris terminó. La palabra sigue distinguiendo los trece.

#### El bug que sólo se ve en una máquina con el sistema en claro

**El variante `dark:` de Tailwind seguía al tema del SISTEMA OPERATIVO, no a la
clase `.dark` que pone el botón del producto.** En Tailwind v4 viene atado a
`prefers-color-scheme` y hay que registrar `@custom-variant dark` para
cambiarlo. Faltaba. Eran **255 clases `dark:` en 18 archivos** enganchadas al
interruptor equivocado:

- Con el sistema en claro, alguien toca la luna: la aplicación se pone oscura
  —eso lo hacen los `!important` de `globals.css`— pero **ninguna clase `dark:`
  se aplica**. Así se veía el ítem deshabilitado «Agente» del menú **más
  brillante que los habilitados**: su `dark:text-slate-600` no llegaba nunca.
- Y al revés: con el sistema en oscuro, alguien elige el tema claro y las
  clases `dark:` se aplican igual, encima de una interfaz clara.

Medido en las dos configuraciones antes de tocar nada: con el sistema en claro
el ítem deshabilitado daba luminosidad **84,8** contra **49** de los
habilitados; después del arreglo, **35,6**. En una máquina con el sistema en
oscuro estaba todo bien, que es por lo que sobrevivió tanto tiempo.

Faltaba además el override oscuro de `text-slate-300`: el guión de una celda
vacía salía casi blanco sobre la tarjeta oscura, o sea que **la ausencia era lo
más brillante de la tabla**.

> Para el próximo: si una clase `dark:` no hace nada, mirá primero
> `@custom-variant dark` en `globals.css`, no el componente.

#### El buscador del padrón seguía roto un piso más abajo

El hallazgo del 31-ago —la caja decía «nombre, DNI o email» y se buscaba sólo
por nombre— se arregló **dentro del componente**, escribiendo una segunda
consulta a mano. Abajo seguía `listCustomers` —el módulo extraído justamente
para poder probar el filtro sin fabricar una petición HTTP— con el
`ilike(full_name)` de siempre. Y es el que sirve `/api/customers`.

O sea que `GET /api/customers?search=27654321` contestaba «no hay clientes»:
**el mismo defecto, en el camino que no se miró**.

Las dos copias además ya habían divergido en otra cosa: la de la pantalla
armaba el patrón LIKE **sin escapar**. `%` y `_` son comodines, así que buscar
«_» devolvía el padrón entero. Medido contra la base de ensayo: pasa de traer 3
de 3 a traer 0, y «100%» encuentra al cliente que de verdad se llama así.

Ahora las dos entran por `armarFiltroDeBusqueda`, y la pantalla deja de hacer
dos viajes a la base.

#### Tres tests que pasaban en verde sin proteger nada

- **`status-badge`** fijaba un matiz por estado para **cinco de los trece**. Eso
  era una foto de la hoja de estilos, no una invariante: cualquier cambio de
  paleta lo rompía sin que nada estuviera mal, y los otros ocho no los miraba
  nadie. Ahora cubre los trece y prueba que el color **agrupe por urgencia**.
  Suma un guardián que rechaza cualquier familia de color que `globals.css` no
  pise en modo oscuro —comprobado con un mutante: se pone rojo nombrando el
  archivo que hay que tocar—.
- **`source-badge`** enumeraba a mano los colores que **creía** que usaban las
  otras dos insignias. Cuando la paleta cambió, la lista quedó describiendo
  colores que ya nadie usa, y **seguía pasando en verde**: comprobaba que no
  hubiera choque con la paleta de anteayer. Ahora renderiza las tres familias y
  exige que ninguna pinte igual que otra. **Encontró un choque de verdad al
  primer intento**: la severidad crítica y el estado escalado quedaban
  idénticos, en columnas contiguas.
- **`busqueda-libre`** leía `clientes/page.tsx` **como texto** y buscaba tres
  palabras adentro. Con la búsqueda mudada a una función común, ese grep habría
  seguido en verde apuntando al archivo equivocado. Ahora arma la consulta con
  `QueryBuilder` —sin conexión— y mira el SQL que sale. Tres mutantes probados,
  cada uno cae en un test distinto.

#### `browserslist`: dos avisos altos que llegan por Sentry

CI se puso rojo, y no por lo pusheado: el único paso que falló fue
`pnpm audit --audit-level=high --prod`, con dos avisos contra `browserslist`
<=4.28.6 (GHSA-c83g-rgw3-j3cx, GHSA-73wf-gq98-2v4g) que entran por siete
caminos abajo de `@sentry/nextjs`. No son alcanzables acá —`browserslist` corre
en el build, no en el servidor— pero el portón existe para no tener que rehacer
ese razonamiento cada vez. Un `override` más en la lista que ya existe para
esto. Queda `4.28.8`, con una sola versión resuelta en el lock.

#### Verificación

`pnpm check` completo en verde, incluida la variante `--deep` que prueba R2 y
el modelo de verdad (subida, lectura y borrado correctos; el modelo responde).
Las tres capas: 2.657 unitarios, 12 conversaciones sin diferencias, y el smoke
contra `production`. CI entero en verde después del arreglo de dependencias:
los 11 jobs, E2E incluidos.

Lo visual se verificó **mirando**, no leyendo el diff: capturas de las dos
pantallas en claro y en oscuro, más una medición de los colores computados. El
bug del ítem deshabilitado no se ve de ninguna otra forma — de hecho ya había
sido «arreglado» antes en el componente, y el componente estaba bien.

### 🌐 La interfaz habla los dos idiomas, y los tests dejaron de apostar a uno (2026-09-02)

**Diecinueve archivos medidos, dieciséis traducidos, 233 claves.** No era el
olvido de una palabra: no tenían UNA sola llamada al diccionario, así que con la
interfaz en inglés quedaban enteros en castellano. Tres de los diecinueve salen
sin tocar con motivo —`ui.tsx` y `PanelSection.tsx` reciben todo por props,
`escalados/page.tsx` es un `redirect`— y uno, `CasesTable.tsx`, ya estaba entero:
usa `useLocale` y la medición buscaba `useT|getT`.

**Lo que NO se traduce, y es una decisión.** Los valores que viajan a una API o
se guardan en una columna quedan crudos: `config_only` y `masked` en el export,
`text`/`enum`/`phone` en campos personalizados, `draft`/`eval_pending` en
fine-tuning, `success`/`rate_limited` en el uso del proveedor. Son lo que hay que
poder pegar en la consola de Google o en un ticket; traducirlos daría dos nombres
para la misma cosa.

**El peor caso no era un texto sin traducir: era uno que parecía traducido.**
`SimulateModal` importaba `t` de `@/lib/i18n` —la firma sin locale, que devuelve
siempre es-AR— y encima la llamaba en el cuerpo del módulo, una vez al cargar el
archivo, antes de que exista ningún idioma. Era el único del producto así.

**El idioma sigue a quien mira; la zona, nunca.** Tres fechas más se estampaban
con `toLocale*String()` sin argumentos, o sea idioma Y zona del navegador. Qué
mes/hora es se decide en Buenos Aires —`ZONA_ARGENTINA`— y cómo se escribe lo
decide quien mira. La excepción es `core/fecha/mes-calendario.ts`: `"2026-09"` no
es un instante sino una etiqueta de período, se arma y se formatea en UTC, y
formatearla en hora argentina la correría al mes ANTERIOR.

⛔ **Antes de confiar en un e2e que busca texto de la interfaz.** El idioma sale
de `users.locale`, una preferencia por usuario guardada en la base. Los e2e
corren contra staging, que es COMPARTIDA y sobrevive a los runs, y el selector de
idioma hace `PATCH /api/auth/me` —no sólo la cookie—, así que alcanza con que
alguien lo toque una vez para dejar esa cuenta en otro idioma para siempre. Desde
ahí el resultado depende de una carrera: `LocaleProvider` escribe la cookie en un
efecto y `auth.setup.ts` guarda el `storageState` apenas entra. Pasó: 72 tests en
verde a las 21:12 y el mismo test en rojo a las 21:33 sin un cambio en el medio.
Se arregló con `tests/e2e/texto.ts` — se busca por CLAVE y se aceptan los dos
idiomas.

**Y ahí apareció uno peor que el que se rompió.** `un analista no entra a
/clientes` afirmaba que NO se ve la columna `/dni/i`. Es una afirmación NEGATIVA,
así que el idioma equivocado la deja pasar sola — y `clientes.col.dni` es «DNI»
en castellano y «ID number» en inglés. Con la interfaz en inglés ese test daba
verde aunque la tabla de clientes se hubiera pintado entera para alguien que no
tiene que verla. **Una guarda que se aprueba sola es peor que no tenerla**, y una
afirmación negativa sobre texto es la forma más fácil de escribir una.

~~**Pendiente, medido y no hecho.** OpenAI sigue nombrado en 24 archivos — un
extractor entero, el selector lo sigue ofreciendo…~~

**Hecho el 2026-09-09.** Ya no es cierto casi nada de eso: el extractor se borró,
`OPENAI_API_KEY` no se lee en ningún archivo de `src/`, y el selector real
(`resolverAiMode`) mira `MOCK_AI`, `AI_MOCK` y si Gemini está configurado, nada
más. Quedan ocho archivos que lo NOMBRAN, y lo que quedaba de verdad se cerró:

- La política de privacidad pública declaraba «OpenAI / Google Gemini» y omitía
  los dos destinos que sí reciben lo más sensible — **Cloudflare R2**, donde
  viven las fotos de los daños y las licencias, y **Meta**, por donde entran y
  salen los WhatsApp. Corregida.
- `tenant_ai_settings.openai_model` (`NOT NULL DEFAULT 'gpt-4o-mini'`) no la leía
  nadie y parecía configuración viva. Borrada en la migración 0027.
- `model_training_jobs.provider` tenía `DEFAULT 'openai'` mientras el código
  escribe `vertex_ai_gemini` y `vertex-ai-fine-tuning.ts` tira `WRONG_PROVIDER`
  con cualquier otro valor. Alineado en la 0027.
- Tres comentarios de cabecera decían que `OPENAI_API_KEY` elegía el extractor
  mock. No elige nada.

Lo que se queda, con su nota: `openai_fine_tuning_job_id` guarda el nombre del
recurso de Vertex y renombrarla pide una migración sobre datos vivos.

### 🔑 Google entra, salir se ve, y el registro está cerrado (2026-09-03)

**«Continuar con Google» no funcionaba, y no era Google.** El `redirect_uri`
era el correcto. Se cortaba en el vinculado: Better Auth 1.6.25 tiene una
segunda condición, `requireLocalEmailVerified` —por omisión `true`—, que
`trustedProviders` NO cubre. La única cuenta de producción con contraseña tenía
`email_verified = false`, así que caía en `account not linked`. Y encima el
login nunca leía `?error=`, así que la persona volvía a un formulario limpio:
«apreté y no pasó nada».

⛔ **No se apagó `requireLocalEmailVerified`, y es a propósito.** Era una
línea. Pero `/registro` estaba abierto a cualquier dirección, así que apagarla
dejaba que quien se adelantara a registrar el correo de otro se quedara con su
cuenta cuando el dueño real entrara por Google. Se resolvió vinculando desde
adentro (Configuración → Vincular Google), que prueba las dos mitades.
Verificado contra la base: la cuenta tiene `credential` + `google`.

**Un bug del propio arreglo, que conviene recordar.** `errorCallbackURL` era
`/login?error=auth_callback_failed`. Better Auth appendea con `&` si ya hay
`?`, así que llegaba `?error=a&error=b`, Next lo entrega como array, y el
lookup caía al mensaje inútil «Probá de nuevo» — que además aconsejaba mal.
Ahora `errorCallbackURL` es `/login` a secas y `codigoDeError` tolera el array.

**Salir de la sesión «quedaba colgado».** Dos cosas: un icono de 28px sin
ningún estado de espera contra un viaje a Neon que tarda, y navegación desde el
cliente en carrera con la cookie recién borrada. Ahora usa la acción de
servidor con `useFormStatus`. Y la tercera, que nadie había visto: **esa acción
es la única que escribe `AUTH_SIGN_OUT` en la auditoría, y nadie la llamaba.**
Ningún cierre de sesión desde la interfaz quedó registrado nunca. Hay un e2e
que aprieta y espera LLEGAR al login.

**El registro está cerrado.** `SIGNUP_ALLOWED_EMAILS` + `ADMIN_EMAILS`, en
`user.create.before` —el único punto por el que pasan `/registro` Y la primera
entrada por Google— además de la capa que ya existía en `provision.ts`. Un
admin da de alta a quien quiera desde `/admin/users` (`enAltaDeAdmin`). Las
seis direcciones de producción están cargadas en Vercel. **Sondeado en
producción**: una dirección fuera de la lista recibe 400 y no deja fila.

Direcciones exactas y no dominios, porque las seis cuentas de producción son
`@gmail.com`: una lista de dominios que las incluya deja entrar al planeta.

### 🧭 La bandeja: un scroller, cien por página, y tres trampas (2026-09-03)

**«Si selecciono 100 se rompe» era un crash del servidor, y estaba desde
siempre.** `page.tsx` —componente de servidor— importaba `PER_PAGE_OPTIONS`
desde `DashboardClient.tsx`, que es `"use client"`. En React Server Components
un export que no es componente NO cruza esa frontera como valor: cruza como
referencia de cliente, un proxy. En el servidor no era un array y `.includes`
tiraba `TypeError` cada vez que la URL traía `?per_page=`. Con el valor por
omisión el parámetro no viaja, así que la rama nunca corría. Ni `tsc` (ve el
tipo real) ni `next build` (el proxy se resuelve en ejecución) lo agarran. Lo
encontró un e2e que navega a `/bandeja?per_page=100` con sesión real — y la
lectura previa de que «el cableado está bien» estaba equivocada porque nunca
ejecutó esa rama. Ahora vive en `bandeja/per-page.ts`, sin directiva.

⛔ **Regla que sale de eso:** un módulo `"use client"` exporta componentes y
hooks. Un valor —constante, tabla, función pura— que un componente de
servidor necesite va en un archivo sin directiva. Escáner rápido: buscar
`export const` en archivos con `"use client"` e importadores sin ella. Hoy no
queda ninguno.

**Las dos barras de scroll eran tres contenedores anidados.** La tabla tenía
`max-h` + `overflow-auto` propios —puestos para que el encabezado `sticky`
tuviera contra qué pegarse— adentro de una envoltura que ya scrolleaba,
adentro del `<main>` del layout. Con 20 filas nada scrolleaba y no se veía;
con 100, dos barras y el encabezado pegado dos veces. Scrollea sólo la
envoltura de la lista (`data-scroll="lista"`); el `sticky` se pega al
scroller más cercano, que es uno. Barra fina en los dos motores
(`scrollbar-*` y `::-webkit-scrollbar`), clase `.scroll-fino`.

**Trampa de verificación: `| grep | head` miente.** El estado de salida de
un pipeline es el del último comando. `tsc | grep | head` devuelve cero con
`tsc` en rojo; con `pipefail`, `grep -v` sobre salida vacía devuelve 1 y mata
la cadena antes del commit. Un commit con error de sintaxis llegó a `main`
así (`7da1482`). Desde entonces cada verificación corre sola y se lee su exit
code explícito; el push va en la misma orden que el commit.

**Trampa de diagnóstico: el log de `tsx` redirigido a archivo se bufferiza.**
Un `pnpm rehearse > log` matado a mitad muestra una línea aunque haya corrido
diez minutos e insertado cinco casos — el buffer muere con el proceso. Dos
veces se leyó «colgado en la primera llamada» cuando era «avanzando lento».
La base dice la verdad: `created_at` de los casos de ensayo.

**El ensayo escribe en PRODUCCIÓN y se limpia solo al arrancar.** Sus casos se
reconocen por `email_thread_id LIKE '5490000%'` y clientes
`ensayo.*@example.com`; los hijos de `cases` son `ON DELETE CASCADE`. Un
ensayo matado a mitad deja huérfanos — hoy cinco, dos veces, borrados por ese
mismo criterio en una transacción con conteo antes y después.
`cleanup:cases` NO sirve para esto: borra todos los casos del inquilino.

**El e2e que estaba en verde y no contaba filas.** «Pongo 100 y la tabla
sigue en 20» llegó DESPUÉS de que el e2e de cien por página pasara en CI.
Afirmaba que el selector decía «100» y que había un solo scroller — nunca
contó `tbody tr`, porque el tenant contra el que corría tenía un caso. Un
test que no mira lo que el usuario mira no prueba lo que el usuario ve.
Ahora cuenta filas contra el total del pie, en los dos tamaños y por el
desplegable, y CI corre contra el tenant del padrón (131 casos).

⛔ **Cómo se verifica una pantalla, entonces:** no leyendo el código —eso
dio «el cableado está bien» dos veces— sino con Playwright entrando de
verdad contra staging. Localmente:

```
DATABASE_URL=$STAGING_DATABASE_URL DATABASE_URL_APP=$STAGING_DATABASE_URL_APP \nPLAYWRIGHT_ADMIN_EMAIL=mariela@seguros-del-sur.com.ar \nPLAYWRIGHT_ADMIN_PASSWORD=$INTEGRATION_ADMIN_PASSWORD \nnpx playwright test tests/e2e/por-pagina.spec.ts --project=chromium
```

Playwright tipea la contraseña; nadie la imprime. Si hace falta más de
veinte casos para distinguir tamaños, se siembran marcados
(`email_thread_id LIKE 'sembrado-100-%'`) y se borran por ese mismo
criterio en una transacción con conteo — hoy 130 sembrados, 130 borrados.
Una captura con sesión real es la prueba que se le muestra a quien reportó;
«ya cambié el diseño» sin captura fue exactamente lo que no alcanzó.

**El «pooler lento» nunca fue Neon: era la red de esta máquina.** Se midió
0,8–5 s por conexión a Neon y se concluyó «pooler degradado». Nunca se midió
contra OTRO destino. Cuando llegó «la app tarda en cargar», el desglose lo
mostró: `favicon.ico` —estático, servido por el borde de Vercel desde caché,
sin función ni base— tardaba 2,7–4,6 s; el handshake TCP solo, 2,6–4 s;
`nextjs.org`, 5–14 s; y `google.com`, 3,3 s. Una conexión degradada hacia
todo internet, no un proveedor. Producción estaba bien todo el tiempo.

⛔ **Regla:** una latencia se atribuye a un destino sólo después de medir
otro. Antes de culpar a Neon o a Vercel, `curl -w '%{time_connect}'` contra
`google.com`. Si el TCP a Google tarda segundos, el problema está de este
lado del cable y ningún commit lo arregla.

**Y una trampa más, la que costó más tiempo: los topes.** El 3/9 por la
tarde el pooler de Neon respondía a 0,8–5 s por conexión desde esta máquina
(baseline 0,15–0,6 s). El `pnpm check` completo falló tres veces, ~90 min, y
se leyó como «la capa `rehearse` no puede conectar». No era eso: el ensayo
AVANZABA —un caso cada ~2 min en vez de ~30 s— y lo mataban el techo de 10
min de la herramienta de shell y después un `timeout 600` puesto a mano.
Cada muerte dejaba huérfanos y un log de una línea (el buffer de `tsx`), que
reforzaba la lectura equivocada. Lanzado desligado del proceso de la
herramienta y sin tope, cerró en verde: 12 conversaciones sin diferencias,
smoke sobre `5b7e6d0`, **11,8 min** (normal ~7). Con el pooler lento el
ensayo tarda casi el doble, no falla. Un tope corto convierte «lento» en
«roto» y además ensucia producción.

### ⚡ La bandeja responde al click, y dos viajes menos por pantalla (2026-09-04)

**«Aprieto y tarda en cambiar.»** Todo el estado de la bandeja vive en la URL y
cambiarlo era `router.push`: hasta que el servidor contestaba no se movía nada.
Ahora hay UNA transición para toda la bandeja (`navegacion-pendiente.tsx`):
pestañas, chips, página y tamaño se dibujan a partir del destino en vuelo —el
click se refleja al instante— y la lista se atenúa con una barra fina mientras
llega la respuesta. El e2e afirma que el desplegable dice «100» en menos de
300 ms, antes de que cambie la URL.

**«Está lento para pocos casos.»** Con quinientos casos ninguna consulta es
cara; lo que domina es cuántas veces va y vuelve al pooler antes de pintar. Dos
cascadas se fueron: la lista y los contadores por estado salen en un
`Promise.all` (eran serie), y la fila de `users` —que el layout pedía para la
barra y CADA página volvía a pedir para el `tenant_id`— pasa por
`lib/auth/user-row.ts`, un `cache()` de React que la dedupe por pedido. La usan el
layout y las ocho páginas que resolvían el inquilino a mano (`admin/users` no
lo hacía: su `from(users)` es el listado del inquilino). No queda ninguna.

Las dos reglas son `async-parallel` y `server-cache-react` de
`vercel-react-best-practices` (Vercel Engineering, 185K instalaciones),
instalada globalmente a pedido con `find-skills`. Sobre `base_claude.md`: no
existe en el repo, en `~/.claude` ni en el home; lo que rige es `CLAUDE.md` →
`AGENTS.md`.

⛔ **Lo que no se pudo medir en milisegundos** desde esta máquina, porque el
enlace estuvo entre 0,25 y 2,2 s de ping: la ganancia se cuenta en viajes
secuenciales —cuatro donde había seis en `/bandeja`—, no en tiempos.

### 🔐 Vercel le prueba a Google quién es, sin clave (2026-09-05)

Producción hablaba con Vertex con una clave JSON de la service account pegada
en `GOOGLE_SERVICE_ACCOUNT_JSON`: el mismo secreto en Vercel, en GitHub y en
esta máquina, y una restricción de la organización impidiendo crear otra. Hoy
Vercel firma un token OIDC por pedido (`x-vercel-oidc-token`, dos horas de
vida) y Google lo acepta por Workload Identity Federation: pool y proveedor
`vercel` en `claimmix-506321`, emisor
`https://oidc.vercel.com/ilandaniele-3471s-projects`, condición que fija
`owner_id` y `project_id` (inmutables: renombrar el equipo o el proyecto cambia
`sub`, `iss` y `aud`) y sólo `production`/`preview`. El token se canjea en STS
y se impersona a `claimmix-extractor` con `roles/iam.workloadIdentityUser`, así
que la identidad y los permisos son los mismos que con la clave.

`src/server/gcp/credenciales.ts` decide el modo: `oidc` si están las cuatro
`GCP_*`, si no `clave`, si no `adc`. `/api/health` lo informa y con `deep=1`
acuña un token por ese camino antes de llamar al modelo.

Probado antes de tocar producción: un token real de Vercel (entorno
`development`, permitido sólo durante la prueba) recorrió STS, la
impersonación y una llamada a Vertex desde esta máquina. Dos cosas para saber:

- **La primera llamada tras crear el binding dio 403**
  (`iam.serviceAccounts.getAccessToken` denegado); un minuto después pasó.
  Propagación de IAM, no configuración.
- **El supplier llama a `getVercelOidcToken()` sin argumentos** a propósito.
  `google-auth-library` le pasa un contexto con `audience`, y con eso
  `@vercel/oidc` canjearía el token por uno de audiencia custom que el
  proveedor no acepta.

Orden de salida: el código llega con las `GCP_*` ausentes (modo `clave`, nada
cambia), se agregan las variables, `/api/health?deep=1` tiene que decir
`credenciales: oidc`, un ensayo contra producción ejercita el camino real (el
agente corre dentro de `after()`), y recién ahí sale
`GOOGLE_SERVICE_ACCOUNT_JSON` de Vercel.

Salió así el 2026-09-05: `/api/health?deep=1` dijo `credenciales: oidc` con
`32bec99`, el post-deploy completo (ensayo incluido) pasó, se quitó
`GOOGLE_SERVICE_ACCOUNT_JSON` de Vercel, se redeployó y el post-deploy volvió
a pasar. Vercel ya no tiene ninguna clave.

La copia de GitHub se cerró igual: el ensayo del post-deploy entra con el
token OIDC de GitHub Actions (`google-github-actions/auth`, proveedor `github`
en el mismo pool, sólo este repo y sólo `post-deploy.yml`) y el secreto
`GOOGLE_SERVICE_ACCOUNT_JSON` se borró del repo. Una trampa que costó una
corrida roja: **Vercel crea los deployments de GitHub con `ref` = SHA del
commit**, no `main`, así que en un run por `deployment_status` el token dice
`ref=<sha>` y una condición `assertion.ref=='refs/heads/main'` lo rechaza
(«rejected by the attribute condition»). La condición acepta `main` o
`event_name=='deployment_status'`; quién puede disparar eso lo sigue
decidiendo la protección de rama y la puerta `environment == 'Production'`
del job. La corrida que lo prueba es el post-deploy de este mismo commit.

La clave queda en un solo lugar: `claimmix-veltra-sa-key.json` en esta
máquina, para el entrenamiento local. **No borrarla en GCP**: la organización
impide crear otra (`iam.disableServiceAccountKeyCreation`). Volver atrás es
pegar ese archivo en `GOOGLE_SERVICE_ACCOUNT_JSON` de Vercel, sacar las
`GCP_*` y redeployar.

### 📬 El correo lo escribe el agente, y el ensayo lo imprime (2026-09-07)

Un asegurado escribió al buzón de ingreso y el sistema le contestó a los doce
segundos con un mail que abría **«gracias por tu reclamo.»**, en minúscula y
descabezado. La causa inmediata era una línea de la plantilla; lo de fondo era
que **por mail salía la plantilla determinista y por WhatsApp pasaba por
`composeReply`**. Mismo cerebro, dos productos.

Ahora `emailMessenger` compone igual que el de WhatsApp: `writeWhatsAppReply`
pasó a `writeReply(message, fallback, channel)`, porque nada debajo de esa firma
era específico del canal. La plantilla sigue siendo el piso —redactor apagado,
guardas que rechazan o excepción: sale byte por byte lo de antes— y la
composición ocurre en el mensajero y no en `dispatch`, para que la vista previa
del ensayo y el envío real coincidan por construcción.

Alrededor: `src/core/nombres/nombre-de-persona.ts` (los dos canales traían el
nombre en el sobre y lo tiraban; entra como `source: "canal"`, que **no** cruza
contra el padrón ni se copia a `cases.policyholder_name`, y **no** necesita
migración porque `extracted_fields` no tiene columna `source`) y
`src/core/email/html.ts` (todo lo que la plantilla interpola sale de un correo
que escribió un desconocido, y el destinatario lo elige el mismo atacante:
phishing firmado con el DKIM de la aseguradora).

**Lo que encontró la revisión adversarial de ese mismo cambio, antes de
mergearlo.** Cinco dimensiones, dos lentes de refutación por hallazgo, 41
agentes: 18 hallazgos, 4 sobreviven, y son dos regresiones que el propio cambio
introducía.

- `writeReply` mapea `fields` desde `data.missingFields` y la rama de conflictos
  manda `data.fields`. El redactor recibía «Señalar la diferencia entre los dos
  valores» **sin ningún valor**, y la verificación de campos caídos sólo corría
  para `ask`, así que cualquier párrafo vago pasaba a la primera. Al asegurado
  le llegaba un aviso de diferencia sin decir qué dato ni entre qué valores, sin
  el bloque que le pide responder «Confirmo», y el caso quedaba trabado en
  `confirmacion_pendiente` esperando esa respuesta. Es AC7 y AC9. **Es el único
  mensaje del producto cuyo piso ES un dato.**
- AC24 lo sostenía la plantilla al renderizar, o sea DESPUÉS. Con la prosa en el
  medio ese enmascarado ya no está en el camino, y el prompt recibía el correo
  crudo del asegurado —con su DNI entero, porque se lo pedimos nosotros—.

Se arregló enmascarando lo que **entra** al prompt (`conflictosParaElRedactor`,
`sinNumerosEnteros`): un modelo no repite un número que nunca vio, y eso no
depende de que una expresión regular lo reconozca a la salida.

**Y el ensayo no tenía ese escenario**, que es por qué se rompió sin que nadie
lo viera. Los trece pasaron a catorce: escribe un familiar del titular y no
coincide ni el nombre ni el documento. Las unitarias lo agarran ahora, pero un
mensaje que nombra los dos datos y suena a interrogatorio pasa igual todas las
verificaciones — por eso tiene que estar impreso.

### 🛡️ Tres guardas que no veían lo que decían ver (2026-09-07)

El patrón de toda la sesión: una guarda que sólo ve el camino conocido convierte
al desvío en el camino fácil.

- **`check-architecture.mjs` no corría en CI.** Vivía sólo dentro de `pnpm
  verify` y `pnpm listo`; la CI corre los pedazos por separado y ninguno lo
  incluía, así que en un pull request la guarda contra fugas entre inquilinos no
  se ejecutaba nunca. Va como job `arquitectura` en `secrets.yml` (sólo módulos
  nativos de node: corre en segundos sin instalar nada). Y `find-raw-db.mjs`, en
  la que delega, sólo veía `db.select(`: no veía `db.query.casos.findMany(` ni
  `getDb().select(`. Ponerla en CI sin ampliarla habría dado confianza por una
  guarda con dos agujeros.
- **`pnpm peso` medía JavaScript, y el peso no era JavaScript.** `/bandeja` le
  pasaba `SCENARIOS` entero como prop a un componente de cliente: **145,9 KB**
  de texto de denuncias serializados adentro del HTML en cada carga, para
  dibujar un desplegable de 163 renglones. `medir-peso.mjs` lee
  `.next/static/chunks` y comprime, así que el chequeo estuvo en verde todo el
  tiempo. Recortado a **29,1 KB** (−80%) con una prueba de paridad que arma las
  163 etiquetas desde el `raw_text` completo y las compara: el desplegable sale
  byte por byte igual. Y `tests/unit/la-frontera-no-lleva-bultos.test.ts` mide
  de ahí en más lo que cruza la frontera servidor→cliente (tope 48 KB). No ve
  `prop={armarLista()}`, y lo dice.
- **El webhook de WhatsApp.** La base frenaba el mensaje repetido pero el aviso
  se perdía —`return null` en el 23505 es exactamente lo que devuelve un INSERT
  que salió bien— así que cada reentrega de Meta era otra extracción contra
  Vertex y otro mensaje al asegurado diciendo lo mismo. Y el `try/catch` adentro
  del `for` se comía el error de un INSERT fallido y contestaba 200 igual: un
  hipo de Neon en un pico y esa denuncia no existía en ningún lado, marcada como
  entregada y sin reintento posible. Van juntas porque devolver 500 hace que
  Meta reentregue el evento entero, incluidos los que sí entraron.

⚠️ **`idx_ai_usage_tenant_cubridor` se sacó** (migración 0024, aplicada). El
planificador lo ignoraba y hacía bien: 9.616 de 9.621 filas eran del mismo
inquilino. Costaba una escritura por cada llamada de IA a cambio de nada. Los
otros dos índices de la 0023 se quedan.

Comprobado contra la base de producción el 2026-09-07, que es la única
respuesta que vale en este proyecto —acá las migraciones se aplicaron a mano
más de una vez, así que el archivo dice lo que se quiso hacer y el catálogo
dice lo que pasó—. `pg_indexes` sobre `ai_usage` devuelve
`ai_usage_pkey`, `idx_ai_usage_tenant_created` e `idx_ai_usage_user_created`, y **no** el cubridor.
El reparto que motivó sacarlo sigue igual de torcido: 9.896 filas, 2
inquilinos, 9.891 contra 5.

⚠️ **El endpoint público de la demo no registraba su gasto.** `DEMO_USER_ID` era
`"demo-public"`, que no es un uuid, así que el INSERT de `ai_usage` rompía con
`22P02` y el tope no veía nada. (Yo mismo había dicho antes que sí registraba:
había comprobado que `recordUsage` se llama, no que el INSERT entrara.)

**Pendiente, y es una decisión de producto, no un defecto:** `renderConflict` de
WhatsApp muestra los valores del conflicto **sin enmascarar**, y siempre lo
hizo — AC24 nunca existió de ese lado. Cambiarlo cambia lo que lee un asegurado.

**También:** los hallazgos de la auditoría pasaron por verificación adversarial
de dos lentes: 116 veredictos sobre los 62 hallazgos —los 42 que habían quedado sin votar, incluidos—, 36 refutados, 26 en pie, 23 distintos. Lo arreglado esta sesión son
los puntos 1, 2, 3, 9, 10 y 16 del informe. Quedan, en orden: el barredor de 15
minutos, la reentrega que trata el 200 como leído, las llamadas al modelo sin
registrar, la falta de timeouts de proveedor, la marca de agua del poller de
Gmail, que nadie consulta `/api/health`, los KPIs de la bandeja, el mensaje de
cierre duplicado, la pantalla de caso que dice «no existe» ante un error de
base, el adjunto de WhatsApp que se bufferea entero antes de mirar el tamaño, y
siete de accesibilidad.

### 🧯 El día que casi todas las guardas resultaron ser adornos (2026-09-08)

Doce cambios en un día, y once de ellos son la misma forma: **algo que decía
estar vigilando y no vigilaba nada**. Vale la pena leerlos juntos, porque la
lección no está en ninguno por separado.

| lo que prometía | lo que hacía |
|---|---|
| `check-architecture.mjs` — guarda contra fugas entre inquilinos | no corría en CI: vivía sólo en `pnpm verify` y `pnpm listo` |
| `find-raw-db.mjs` — encuentra consultas fuera de la capa | sólo veía `db.select(`; no `db.query.*` ni `getDb().*` |
| `pnpm peso` — «cuánto le llega al navegador» | medía JavaScript, y los 145,9 KB de la bandeja no eran JavaScript |
| `replyFor` del timbre — «el agente contestó» | dejaba de mirar a los 20 s, con tres llamadas al modelo por delante |
| `reap-stuck` — la red del intake real | filtraba `procesando`, un estado que los casos reales no tienen |
| `Carga (lectura)` — presupuesto de p95 | medía a sus hermanos: ensayo y timbre en la misma base |
| el encabezado de `gmail-poller` | decía «fire-and-forget» y esperaba al worker |

Y dos que escribí yo mismo ese día, con el mismo defecto: una prueba que
afirmaba sobre `\n` a mano y no coincidía nunca en Windows —pasaba sin
comprobar nada, y fallaba recién en CI— y un `echo "[tsc $?]"` que leía la
salida de `head` y no la de `tsc`, así que informé «tsc 0» dos veces con
errores en pantalla.

**El costo real de esto no es el defecto, es el rojo que no significa nada.**
Tres post-deploy seguidos en rojo con el sistema sano —el agente había
contestado las tres veces, 1,1 / 4,8 / 6,2 s después de que el guión dejara de
mirar— y en el medio acusé al PR #68 de una regresión que no existía, antes de
mirar el `audit_log`. El `waitForCase` de ese mismo archivo ya tenía escrito el
comentario de la vez anterior que pasó lo mismo, el 1º de septiembre.

#### Lo que cambió de comportamiento, no de vigilancia

- **El correo pasa por el mismo redactor que WhatsApp.** Un asegurado recibió
  un mail que abría «gracias por tu reclamo.», en minúscula: por mail salía la
  plantilla determinista y por WhatsApp `composeReply`. Mismo cerebro, dos
  productos.
- **El mail de conflicto volvió a decir los dos valores.** La revisión
  adversarial del propio PR encontró que `writeReply` mapeaba `fields` desde
  `data.missingFields` y la rama de conflictos manda `data.fields`: el redactor
  recibía «señalá la diferencia entre los dos valores» sin ningún valor, y nada
  lo frenaba porque la verificación de campos caídos sólo corría para `ask`.
  Es AC7 y AC9.
- **Un mensaje por vuelta.** Un familiar del titular recibía el pedido de
  confirmación y, segundos después, «tu reclamo fue asignado a un especialista»
  — uno le pide que conteste y el otro que espere. La derivación por
  deliberación era el único emisor que no consultaba
  `confirmationEmailDispatched`.
- **AC24 se sostiene donde se puede sostener.** El enmascarado lo hacía la
  plantilla al renderizar, o sea DESPUÉS; con la prosa del modelo reemplazando
  el cuerpo eso dejó de estar en el camino. Ahora se enmascara lo que ENTRA al
  prompt: un modelo no repite un número que nunca vio.
- **El poller larga la extracción y sigue.** Esperaba al worker con `await
  fetch`, gastando su techo de 60 s en el trabajo de otra función con su propio
  techo de 60 s. Los dos se morían juntos: 504 y un caso con los campos
  extraídos y sin respuesta.
- **La bandeja manda 29,1 KB y no 145,9 KB.** Pasaba los 163 escenarios
  completos como prop a un componente de cliente, para dibujar un desplegable.

#### Lo que quedó comprobado contra la base, no contra el archivo

- `idx_ai_usage_tenant_cubridor` **no está** en producción (`pg_indexes`), y el
  reparto que motivó sacarlo sigue igual: 9.896 filas, 2 inquilinos, 9.891 / 5.
- Los 62 hallazgos de la auditoría pasaron por verificación adversarial de dos
  lentes: **116 veredictos**, 36 refutados, 26 en pie, 23 distintos.
- Antes de tocar el barredor: 356 casos reales salieron de `recibido` con
  **mediana de 8 s**; 0 en `procesando`; **1 en `recibido` de hacía más de un
  día**. Después del arreglo, disparado a mano:
  `{"ok":true,"reaped":1,"caseIds":["e8520a83…"]}` y `recibido` vacío. Ese caso
  era una persona que escribió y no recibió nunca una respuesta.

#### Lo que NO se hizo, y por qué

- **Tres de las cuatro consultas del tablero recorren `cases` entera** (Seq
  Scan). Con 484 casos no se nota; el reporte de `pnpm load` lo imprime en cada
  corrida para cuando sí. Es otro cambio, con su propia medición.
- **`renderConflict` de WhatsApp muestra los valores sin enmascarar**, y
  siempre lo hizo — AC24 nunca existió de ese lado. Cambiarlo cambia lo que lee
  un asegurado: es una decisión de producto.
- **El barredor no corre cada quince minutos en la práctica.** El `schedule`
  dice `*/15`, y las corridas reales del 8 de septiembre fueron 11:42, 15:22 y
  18:55. GitHub demora las tareas programadas cuando está cargado, cosa que el
  propio encabezado del workflow admite. Un caso trabado se ve en horas, no en
  media hora. Mejor que nunca, que es lo que era hasta ese día.
- **Quedan once puntos del informe de verificación**, en su orden: timeouts de
  proveedor, la mayoría de las llamadas al modelo sin registrar, la marca de
  agua del poller de Gmail, la reentrega que trata el 200 como leído, que nadie
  consulta `/api/health`, los KPIs de la bandeja, el mensaje de cierre
  duplicado, la pantalla de caso que dice «no existe» ante un error de base, el
  adjunto de WhatsApp que se bufferea entero antes de mirar el tamaño, y siete
  de accesibilidad.

### 🧹 La lista de pendientes, cerrada (2026-09-09)

Una auditoría con tres lentes —lo que el documento declara abierto, lo que el
código confiesa, y lo que vive afuera del repo— devolvió 49 hallazgos. Se
comprobó cada uno contra el código antes de tocarlo, y varios no se sostuvieron.
Lo que sigue es qué cambió y qué NO, con el porqué.

#### Lo peor que había, y no estaba anotado en ningún lado

**«Enviar al sistema central» dejaba el comprobante de una entrega que nunca
ocurrió.** `getCoreSyncClient()` devolvía `MockCoreSyncClient` SIEMPRE: la rama
`CORE_SYNC_MODE=real` sólo escribía un `console.warn` y seguía de largo hasta el
mismo `return`. Y `CORE_SYNC_MODE` no estaba puesta en ningún lado —ni
`.env.local`, ni la CI, ni Vercel— así que el default es el que corría en
producción.

El botón aparece en cualquier caso en `listo_para_core`. Al apretarlo, la ruta
guardaba `core_external_id = 'CORE-' + los primeros ocho caracteres del id`,
ponía el caso en `enviado_a_core` y escribía un `CORE_SYNC_SUCCESS` en la
auditoría. Un identificador inventado, un estado que dice «entregado» y un
registro de algo que no pasó. Y los ids terminados en `0` —uno de cada
dieciséis, porque son UUID— devolvían un «Core timeout» igual de inventado, que
es un error que el analista sale a investigar.

Ahora el default es no tener cliente: 501 antes de cualquier escritura, y la
pantalla dice que el caso quedó listo pero que del otro lado no hay nadie.

#### Lo que se perdía en silencio

| | qué pasaba |
|---|---|
| Correo | Un mensaje que fallaba una vez **no se volvía a leer nunca**: la marca de agua avanza siempre (y hace bien: frenarla es el bucle de veneno), y el cron arranca desde ahí. La tercera salida es `mensajes_pendientes` (0026): la marca avanza **y** el mensaje se reintenta, hasta tres veces |
| WhatsApp | Un adjunto de más de 10 MB devolvía `null`, igual que una falla de descarga, y no quedaba fila. El asegurado mandaba la foto de los daños, creía que la había mandado, y el pedido seguía abierto sin explicación |
| WhatsApp | `renderConflict` mandaba el DNI entero. El enmascarado existía pero sólo se aplicaba a lo que entra al prompt del modelo |
| WhatsApp | Un `catch` vacío podía tragarse el cuerpo de un mensaje entrante, con un comentario que describía código que ya no existe |
| Barredor | Dice cada 15 minutos y corre cada 3 horas: el 08/09 disparó 7 veces de 96, con huecos de más de cinco. Ahora barre también en el `after()` del webhook, que es tráfico real |

#### Un duplicado que habría roto el fine-tuning

`maybeQueueFineTuneJob` parecía código muerto para conectar. **No se conectó**:
insertaba `provider: "gemini"`, y todo el camino de Vertex tira `WRONG_PROVIDER`
—en tres lugares— para cualquier trabajo cuyo provider no sea
`vertex_ai_gemini`, que es lo que tienen las dos filas reales. Cablearla habría
fabricado borradores que ningún paso posterior podía tomar.

El que anda es `createVertexAiTuningDraft`. Se borró el duplicado.

#### Lo que vive afuera del repo

- **La guarda de aislamiento entre aseguradoras no era un check requerido.**
  `check-architecture.mjs` comprueba que ninguna consulta se salga de la capa que
  pone el contexto de inquilino. Ahora es requerida, y `strict: true`, así que un
  PR con 486 commits de atraso ya no se mergea con checks de junio.
- **Las alertas de Dependabot estaban apagadas** en un repo público. Activadas,
  junto con las actualizaciones de seguridad automáticas.
- **`sha_pinning_required`** pasó a true: la convención de pinear por SHA ahora
  es una regla y no disciplina.
- **Los diez PR de Dependabot**, resueltos de a uno (ver «Los bumps», abajo).
- **Dos cuentas de más con rol admin** bajaron a `analyst` — privilegio mínimo
  sobre un producto que guarda DNIs y fotos. Quedan `veltra.claimmix` (la cuenta
  de producción) e `ilan.daniele`. Nota: el motivo anotado en el informe era
  incorrecto; los avisos `[Urgente]` se deciden por rol `specialist` con respaldo
  en un `owner`, y los admin no están en ninguna de las dos listas.

#### Los índices de `cases`: la pregunta era al revés

No faltaba ninguno. **Sobraban dos**, y se sacaron en la 0025:

- `idx_cases_tenant_created (tenant_id, created_at DESC)` duplicaba a
  `idx_cases_tenant_created_at`. El planificador ya elegía el ASC **para el orden
  descendente**, escaneándolo hacia atrás. Borrado en una transacción con
  ROLLBACK contra producción: ningún plan cambió. Eran 184 kB y una escritura de
  índice más por fila.
- `idx_cases_extraction_lease` es parcial `WHERE ... IS NOT NULL` y la única
  consulta que toca esa columna pregunta `IS NULL OR < now()-interval`. Ni
  forzando con `enable_seqscan = off` lo elige. Estaba muerto por construcción.

#### Hallazgos que NO se sostuvieron

Vale anotarlos para que no vuelvan a la lista:

- El `TODO` del webhook de flujos vive bajo `.gitignore`: es andamiaje generado
  por el paquete `workflow`, no código del repo.
- Los exports de `rate-limit/index.ts` están todos usados.
- El comentario de `batch-simulate` es correcto: sigue usando `after()` y el tope
  coincide con el código.

#### Lo que NO se hizo, por decisión

- **Dominio propio**, **plan pago de Vercel y Neon** y **verificación de negocio
  de Meta**: quedan como están.
- **Rotar las credenciales** (WhatsApp, Google y cuatro más): más adelante.

#### Lo que NO se hizo, por otras razones

- **`--config=auto` de semgrep** sigue bajándose las reglas de semgrep.dev en cada
  corrida, y de paso le manda la URL del repositorio. Se pineó la HERRAMIENTA,
  que es por donde se ejecuta código; fijar el conjunto de reglas pide
  vendorearlo y cambia qué reglas corren.
- **Los CHECK que aceptan `'openai'`** en `tenant_ai_settings` se dejaron: son
  permisivos, no incorrectos, y apretarlos sobre datos vivos es otra
  conversación.
- **`@types/node` 26** y **`@vitejs/plugin-react` 6**: el primero describiría APIs
  de Node 26 mientras la CI corre 22 —y pasa verde, que lo hace peor—, y el
  segundo pide vite 8 contra el vite 7 que trae vitest.

#### El `DATABASE_URL` con rol dueño: la condición escrita era inalcanzable

El documento planteaba cambiar `DATABASE_URL` al rol restringido «cuando no
queden filtros por inquilino escritos a mano». Quedan 10, y al mirarlos uno por
uno **no se pueden sacar**: viven en código de sistema que es cross-tenant por
diseño. El comentario del barredor lo dice con todas las letras — «recorre los
casos de TODOS los inquilinos, que es para lo que existe; el cron no corre en
nombre de ninguno»— y lo mismo vale para `/api/health`, la facturación, el
export del agente, la memoria y la administración de casillas de Gmail.

O sea que el cliente dueño no es un resto por eliminar: **es el actor de
sistema**. Lo que importa no es hacerlo desaparecer sino que sólo lo usen
caminos declarados, y de eso ya se ocupa `check-architecture.mjs` — que a partir
de hoy es un **check requerido de `main`**, que era lo que faltaba de verdad.

Cambiar `DATABASE_URL` al rol restringido, tal como está escrito el plan,
rompería el barredor, la salud, la facturación y el alta de casillas.

### 🔎 El índice de `cases`: medido, y la respuesta es que no va (2026-09-08)

Quedaba abierto «los tres Seq Scan del tablero, 226 / 187 / 340 ms contra un
presupuesto de 500 — ¿el índice va ahora o cuando haya volumen?». Se midió
contra producción, sólo lectura, con el rol de la aplicación y RLS puesta, que
es la única forma de ver el plan que realmente corre.

**Ya no son tres. Es uno, y cuesta 0,36 ms.**

| consulta | cómo la resuelve | tiempo |
|---|---|---|
| listado (LIMIT 25) | `Index: idx_cases_tenant_created_at` | 19,6 ms en frío |
| conteo del listado | `Index Only Scan: idx_cases_tenant_type`, 0 heap fetches | 0,08 ms |
| **contadores por estado** | **Seq Scan, 483 filas** | **0,36 ms** |
| listado + `status=listo` | `Index: idx_cases_tenant_status` | 0,75 ms |
| conteo + `status=listo` | `Index: idx_cases_tenant_status` | 0,09 ms |

Los 226 / 187 / 340 ms de la medición vieja eran ida y vuelta a Neon, no tiempo
de ejecución. El presupuesto de 500 ms mide viajes; los Seq Scan nunca fueron
el problema.

**De paso queda contestada la pregunta que abrió `medir-rls-indices.mts`: la
política SÍ se inlinea.** El plan muestra el predicado como
`tenant_id = (NULLIF(current_setting('claimmix.tenant_id', true), ''))::uuid`,
o sea una igualdad sobre la columna y no `f(columna)`. Los índices que empiezan
por `tenant_id` siguen sirviendo después del refactor a RLS. Es SQL y STABLE y
no es security definer, que son las tres condiciones.

**Por qué no se agrega un índice.** El único Seq Scan que queda es
`select status, count(*) from cases group by status`, y el índice que lo
serviría —`(tenant_id, status)`— **ya existe**: es `idx_cases_tenant_status`, con
7180 usos. El planificador no lo elige porque a este tamaño estima 36,89 contra
40,61, un 10% de diferencia.

Forzándolo con `enable_seqscan = off` se ve que el índice es mejor de lo que el
planificador cree:

```
ELEGIDO   Seq Scan            0,36 ms   26 buffers
FORZADO   Index Only Scan     0,10 ms    2 buffers, Heap Fetches: 0
```

Tres veces y media más rápido. Pero **crear otro índice no cambiaría nada**: el
que sirve ya está, y agregar uno más caería exactamente en el error de la 0023,
que la 0024 tuvo que revertir un día después. La diferencia con aquel caso es
que acá forzado es más *rápido* (allá era más lento: 2,79 contra 1,98 ms) y hay
cero heap fetches (allá 2871 sobre 9616). O sea: el índice está bien, la
estimación está apenas corrida, y el cruce lo va a hacer el planificador solo
cuando la tabla crezca, porque el costo del Seq Scan crece con la tabla entera y
el del índice no.

Con 483 filas de 484 del mismo inquilino, filtrar por `tenant_id` no descarta
nada — el mismo argumento (1) de la 0024.

**Lo que sí apareció y vale mirar cuando haya ganas:**

- **Dos índices que se pisan.** `idx_cases_tenant_created (tenant_id, created_at
  DESC)` de 184 kB y `idx_cases_tenant_created_at (tenant_id, created_at)` de
  40 kB. Un btree se recorre en los dos sentidos, así que sirven para lo mismo;
  los dos se usan (11461 y 26564). Sobra uno, y cada escritura paga los dos.
- **Cuatro índices con cero usos:** `idx_cases_tenant_severity`,
  `idx_cases_extraction_lease`, `idx_cases_policy_number_trgm` y
  `idx_cases_policyholder_name_trgm`. Los dos de trigramas están a propósito
  (`load-test.mts` explica que el planificador los va a elegir recién con
  volumen). Los otros dos no tienen esa nota: el de severidad es parcial
  (`WHERE severity IS NOT NULL`) y el del lease también
  (`WHERE extraction_lease_at IS NOT NULL`), y ninguno se usó nunca.

### 🧾 Los dieciséis puntos del informe, cerrados (2026-09-08)

Quedaban dieciséis de los veintitrés del informe de verificación. Están todos
hechos y desplegados; `main` en `767efa5` con CI, CodeQL, secretos y los siete
jobs del post-deploy en verde. Lo que sigue es qué cambió para una persona que
denuncia, y qué NO se hizo.

#### Lo que cambia para el asegurado

| # | qué pasaba |
|---|---|
| 5 | `/api/worker/extract` contestaba **200 siempre** — el `ok:true` estaba escrito a mano y el resultado real quedaba anidado en `agent`. El redespacho decide con `res.ok`, y para cuando corre `extraction_pending` ya se limpió: el segundo mensaje de alguien se perdía sin rastro |
| 15 | El adjunto se bajaba **entero** antes de mirar cuánto pesaba. Un PDF de 100 MB eran ~330 MB de pico contando el base64 del intake, adentro del tiempo del webhook, repetible sin credencial |
| 8 | `advancePollState` borraba `last_error` en la MISMA corrida en que `recordPollError` acababa de escribir el id del mail perdido |
| 7 | Ninguna llamada al proveedor tenía timeout: 300 s de undici contra 60 s de función. Vertex se quedaba callado y Vercel mataba la función antes de que corriera el `catch` que escala |
| 6 | `ai_usage` veía entre un cuarto y un tercio del gasto. Los tres topes leen esa tabla, y `/api/admin/billing` calcula el margen con ella |
| 12 | Con 43 casos en `requiere_especialista` la baldosa «Escalados» decía **0** |
| 13 | El cierre se podía mandar dos veces por WhatsApp: la guarda buscaba `confirmation_received` y el libro guarda `wa_confirmation_received` |
| 14 | Siete `catch` mudos. El de `fetchCaseRow` es el peor: `null` es el único camino al 404, así que un rol sin autenticar mostraba «El caso no existe» sin una línea en el log |
| 11 | `/api/health` sólo se consultaba después de un deploy. El token de WhatsApp vence un martes y el canal está caído hasta que alguien se queje |
| 17-23 | Escape no cerraba los diálogos; /demo era ilegible en oscuro (1,05:1) y no anunciaba nada; 2,56:1 en once etiquetas; no había «saltar al contenido»; Ctrl+clic en una fila abría el caso en la misma pestaña |

#### Lo que apareció y no estaba en el informe

- **Dos RCE no autenticadas en Next.js** (Image Optimization y windows-hosted).
  16.2.12 → 16.3.3. `pnpm audit` se puso en rojo sin que nadie tocara una
  dependencia: salieron advisories nuevas.
- **Las dos llamadas al modelo de `documents.ts`.** Reconocer un adjunto manda
  la foto entera adentro del prompt: era la llamada más cara del producto y la
  que menos rastro dejaba.

#### El error que costó tres PR

En `#73` traté un problema de **estado compartido** como si fuera de **orden**.
El techo de intentos de login se llavea por (IP, dirección) y los contadores
viven en la base compartida; puse un grupo de concurrencia con
`cancel-in-progress: false` creyendo que hacía cola.

No la hace: GitHub guarda **una sola** tarea pendiente por grupo y «any
previously pending job will be cancelled». Con tres PR abiertos los del medio
se cancelan solos, quedan bloqueados para mergear, y `gh pr checks` los muestra
como `fail` — así que además parece un test caído. Se ven «fallando» en tres
segundos.

`#89` lo revirtió y `#91` hizo el arreglo de verdad: que cada prueba de login
use su propia IP. La regla ya estaba escrita en el encabezado de ese archivo
—«cada prueba que toca el techo usa una clave propia»— y estaba aplicada de un
solo lado de la llave.

#### Lo que NO se hizo, y por qué

- ~~**Los tres Seq Scan del tablero**~~ — **medido el 2026-09-08: no hacen falta
  índices nuevos, y ya no son tres sino uno.** Ver abajo.
- **`renderConflict` de WhatsApp muestra los valores sin enmascarar**, y siempre
  lo hizo. AC24 nunca existió de ese lado. Cambiarlo cambia lo que lee un
  asegurado: es decisión de producto.
- **Un adjunto rechazado por tamaño ya no deja fila con `rejected_reason`** — el
  camino es `null`, el mismo de las otras fallas de descarga, así que queda en
  el log y no en la pantalla del analista. Devolver ese rastro pide tocar el que
  llama y `rehost-attachments`.
- **El hueco de foco de los dos diálogos de caso**: mientras `loading` es true
  todos los enfocables quedan deshabilitados, la lista sale vacía y el Tab
  escapa por un segundo. Ya pasaba con las dos copias del bloque.
- **La política de la marca del poller.** El arreglo ingenuo (`errors === 0`)
  reintroduce el bucle de veneno que el comentario de esa línea advierte. O un
  contador de fallos consecutivos, o un barrido de no-leídos: hay que decidirlo.
- **Diez PR de Dependabot** abiertos desde junio, cuatro de ellos saltos de
  major (typescript 6, @types/node 26, @vitejs/plugin-react 6, actions/checkout 7).

### 🧵 Las doce MEDIA de la auditoría, cerradas (2026-09-09)

Los trece agentes de `prompts for performance and security` dejaron nueve ALTA
—ya cerradas y anotadas arriba— y doce MEDIA. Estas son las doce, con lo que se
hizo y, en un caso, lo que se decidió NO hacer.

Cada una comprobada contra el código antes de tocarla. Dos cambiaron de forma al
mirarlas de cerca, y una se dio vuelta entera.

#### Lo que costaba latencia, medido

| | qué pasaba | medido |
|---|---|---|
| `/metricas` | nueve `enTenant` en un `Promise.all`. En paralelo pero no juntas: cada una abre su transacción HTTP con su `set_config` adelante | 9 pedidos → 1 |
| El prompt del worker | siete cargas antes de llamar al modelo, con la misma forma | p50 **873 → 288 ms**, quince corridas intercaladas contra producción |
| Toda ruta de la API | sesión, fila de `users` y cupo, en fila. Las dos últimas sólo necesitan el id del usuario | 3 viajes → 2, en catorce archivos |
| Arranque en frío | `instrumentation.ts` importaba `@sentry/nextjs` siempre: 22 paquetes, 43 MB, **260 ms** — y adentro un `if (SENTRY_DSN)` que nunca se cumple | 260 ms → 0 |

Del lote del prompt vale la pena anotar el método: con **cinco** corridas daba
354 contra 383 ms y parecía ruido. Con quince se separan solas. La primera
medición decía «no vale la pena» y era la medición, no el cambio.

Y el lote tiene reserva. Cada cargador tenía su `catch` con un valor por
omisión —sin reglas se extrae igual— y en un lote no hay errores parciales: una
tabla que falta tumbaría la transacción entera. Si el lote se cae, se vuelve por
el camino de a uno. El rápido es el normal; el lento es el raro y deja su línea.

#### Lo que estaba mal, no lento

**Un webhook de WhatsApp es de la APP, no de un número.** La firma prueba que el
evento viene de Meta; no dice a quién le escribieron. Con la app suscripta a más
de una WABA, los mensajes de todas llegaban a la misma ruta y el inquilino salía
de una constante: la denuncia de la otra aseguradora terminaba en esta bandeja,
con sus fotos y su DNI. `metadata.phone_number_id` venía en el payload desde
siempre y el parser lo tiraba.

**Dos mensajes juntos abrían dos casos.** Buscar-y-crear son dos transacciones y
en el medio hay una ventana; Meta entrega dos eventos sin prometer orden. La
conversación quedaba partida y el agente contestaba dos veces por el mismo
choque. El índice de la 0029 lo cierra — sobre `recibido`, que es el estado con
el que un caso nace, y no sobre «abierto», porque el buscador tiene una ventana
de siete días y `now()` no entra en un predicado de índice.

**El barrido cerraba conversaciones culpando a quien nunca recibió la
pregunta.** Salir de `info_faltante` no depende de que el envío funcione: el
orquestador manda y en la línea siguiente escribe el estado, sin mirar el
resultado. Un mail rechazado, una plantilla de WhatsApp fuera de la ventana de
24 h, y catorce días después el caso se cierra con «sin respuesta del
denunciante». Ahora se mira el último saliente. Los que no salieron **no se
cierran**: quedan en el tablero y se cuentan con sus ids, una línea por barrido.

**La corrida no tenía reloj.** Una extracción son 10-20 s y la función tiene 60,
así que sola llega. Pero antes se bajaron los adjuntos (hasta cuatro, 10 s cada
uno) y después puede venir un redespacho, que corre otra corrida ENTERA adentro
de la misma invocación esperando su respuesta. La cadena no tenía tope: cuando
se acababa el tiempo morían todas juntas, la de más adentro a mitad de una
escritura.

#### Dos guardas que no veían lo que decían ver

**La intersección del ensayo se comía las regresiones peores.** Cuando algo
difiere, el post-deploy repite e intersecta: lo que falla dos veces es
regresión, lo que falla una es el modelo. La intersección iba sobre el TEXTO del
motivo, y ese texto lleva adentro lo que el modelo contestó — «estado
info_faltante, esperaba listo». O sea que pedía que el modelo se equivocara dos
veces IGUAL, no dos veces. Una regresión inestable se escondía mejor que una
determinista.

Se arregló el 09/09 y **atrapó su propio caso en la primera salida**: la misma
afirmación rota en las dos corridas, `confirmacion_pendiente` una vez y
`escalado` la otra. Con la clave vieja, verde.

**El escenario «detalle de un caso» de la prueba de carga no podía fallar.**
`getCaseDetail` se traga los errores de base y devuelve `null` — deliberado, un
404 es mejor que un 500 para el analista. En la prueba eso significaba que la
operación nunca tiraba. Y peor: al devolver `null` temprano se saltea las tres
consultas siguientes, así que **una base caída se leía como una mejora de
rendimiento**.

#### Y una que se dio vuelta

El informe pedía prohibir dos casos abiertos por hilo con un índice único. No se
puede, y averiguarlo cambió el arreglo: el buscador mira tres estados DENTRO de
una ventana de siete días, y a propósito deja que un mensaje muy posterior abra
un caso nuevo. Un índice sobre los tres estados prohibiría eso.

Lo que sí se puede es `recibido`, y sólo porque `reap-stuck` saca de ahí
cualquier caso de más de 20 minutos: el único escenario donde el índice
cambiaría una decisión del buscador —un `recibido` más viejo que la ventana— no
existe. Sin ese barredor, este arreglo estaría mal.

#### La guarda de arquitectura aprendió a leer

Partir los cargadores en «armar la consulta» y «ejecutarla» hizo que siete
consultas quedaran fuera de un `enTenant` literal, y `find-raw-db.mjs` las
reportó como sueltas. No lo eran: el `db` que usan se los pasa la capa.

Ahora reconoce un armador por el **tipo** del parámetro —`db: ClienteDatos`, que
sale de `@/data/scope` y no se llega a él de otra forma— y no por el nombre, que
lo escribe cualquiera. Se probaron las dos direcciones: una consulta suelta de
verdad sigue saliendo reportada, y un `db` sin ese tipo también.

#### Lo que NO se hizo

- **Prender Sentry.** Se sacó el andamiaje que nunca estuvo conectado —el config
  del cliente que no carga nadie, dos helpers con cero llamadas— y el import
  quedó detrás del DSN. Pero en producción sigue sin haber quien avise cuando
  algo explota: eso pide una cuenta y un DSN, y es una decisión de quien opera
  el producto. Lo que cambia es que el repo ya no aparenta tenerlo.
- **La carrera del correo.** Tiene la misma forma que la de WhatsApp y otro
  camino de ingreso, que no sabe recuperarse de un choque de clave. Una cosa por
  vez.

#### Una nota sobre cómo se aplicó la 0029

El índice se creó en producción **antes** que el código que lo maneja, por un
error mío: el ensayo iba a ser `BEGIN` / crear / `ROLLBACK`, y el driver HTTP de
Neon manda cada sentencia como su propia transacción, así que el `ROLLBACK` no
envolvía nada. Se había verificado antes que no hubiera duplicados, así que no
rompió nada, y el código entró enseguida — pero el ensayo con rollback contra
Neon por HTTP **no existe**. Para eso hay que mandar el bloque entero en un solo
`sql.query`, o no ensayar.

#### Y una nota sobre la 0030: el ensayo estaba ocho migraciones atrás

El PR de la 0030 agregó `cases.intentos_de_extraccion`. La CI se cayó en dos
jobs con `error_code: 42703` —columna inexistente— desde adentro de un test,
o sea con el dedo apuntando al código del PR.

No era el código. `E2E_DATABASE_URL` y `STAGING_DATABASE_URL` son secretos
APARTE de producción, a propósito: los tests nunca tocan datos de clientes. Pero
**nada aplica las migraciones ahí**, y nadie lo mira: el ensayo estaba en la
0022, ocho atrás. Las ocho eran idempotentes y entraron sin ruido.

El agujero no era la 0030: era que el desfasaje sólo se ve cuando un test se
rompe con un error de Postgres que parece otra cosa. Ahora `migrate.mjs
--exigir-al-dia` sale 1 si falta alguna, y los dos jobs lo corren antes de
sembrar. **No las aplica**: aplicar migraciones desde la rama de un PR es dejar
que cualquier PR escriba en el esquema del ensayo. Avisa, con el nombre del
archivo y el comando.

### 🔬 Los catorce prompts, corridos (2026-09-09)

Doce agentes sobre el código de hoy, más `/configure-load-tests` ejecutado a
mano. `load-testing-reference` es el documento de plantillas, no un agente.

Lo que sigue es **el inventario**, no el trabajo hecho: se arreglaron seis cosas
en el momento y el resto queda anotado con archivo y línea. Cada agente tenía
instrucción de decir también qué NO se sostenía al verificarlo, y esa parte vale
tanto como la otra.

#### Lo que se arregló en la misma corrida

| | qué era |
|---|---|
| **Inyección por centinela** | el asunto y el cuerpo del denunciante se interpolaban entre `<email_body>` y su cierre, y todo eso se manda como `systemInstruction`. Un cuerpo que cierra el centinela le escribe al modelo donde le escribe el operador. Y quien lo manda no está autenticado |
| **`deliberate` sin regla** | el prompt que elige entre pedir, contestar, escalar o esperar no tenía ninguna línea diciendo que el bloque del usuario es un dato |
| **El pen test no lo probaba** | los cuatro ataques eran persuasión; ninguno cerraba el centinela, que es el fuerte. Ahora hay un quinto |
| **Credenciales al host que diga el evento** | `deployment_status.target_url` sin validar, y abajo un POST con el correo y la contraseña de la cuenta de pruebas. Cualquiera que pueda crear un deployment se las lleva |
| **Los tests de carga medían el limitador** | una sesión compartida contra un cupo de 100/min por usuario: 50 VUs son ~510 pedidos/min. La corrida salía roja por el limitador y el p95 salía verde, porque un 429 se contesta rápido |
| **Cuatro verdes sin haber medido** | `checks` sin umbral, umbrales sobre métricas sin muestras, `peak` salteando dos tercios del trabajo en silencio, y el medidor del punto de quiebre leyendo el máximo donde iba el mínimo |

#### ALTA, sin arreglar

- **`BETTER_AUTH_SECRET` falla abierto.** Si falta, better-auth usa un secreto
  público y sólo avisa por consola. Con eso se firman cookies válidas, y el
  inquilino sale de la sesión: RLS no ve un ataque, ve un inquilino. Es el único
  secreto del producto sin aserción — `DATABASE_URL_APP`, `PUBSUB_AUDIENCE` y
  `CRON_SECRET` fallan cerrado.
- **El `where` del barrido de abandonados no tiene la guarda que su encabezado
  promete.** El predicado de estado vive sólo en la subconsulta del `IN`, así que
  bajo READ COMMITTED re-evaluar «el id sigue en el conjunto» no protege nada.
  Alguien contesta a los catorce días, el agente pasa el caso a
  `listo_para_core`, y el cron lo pisa con `cerrado`. `reap-stuck` lo hace bien;
  éste no.
- **`findExistingWhatsAppCase` no distingue «no hay» de «no pude buscar».** Un
  hipo de Neon devuelve `null` y el llamador abre un caso nuevo. El índice de la
  0029 no lo tapa: cubre `recibido`, y el caso vivo puede estar en
  `info_faltante`.
- **`extraction_pending` es una marca sin lector.** Cuatro escrituras, y el único
  que la lee es el proceso que la escribió. Los comentarios de los tres caminos
  nuevos describen un consumidor que no existe. Sumado a que el ingreso no toca
  `updated_at`, una respuesta guardada y sin leer termina cerrada a los catorce
  días como «sin respuesta del denunciante».
- **La reserva de extracción falla abierta y después libera la de otro.** El
  `catch` devuelve `true`, el llamador marca la reserva como tomada, y el
  `finally` borra el lease del que sí lo tenía junto con su marca de mensaje
  pendiente. Reproduce el incidente que el lease existe para evitar, justo cuando
  la base está mal.
- **`.env.example` apaga el limitador.** Trae `RATE_LIMIT_PROVIDER=memory`, y esa
  variable gana sobre la detección de `DATABASE_URL`. Sembrar Vercel desde la
  plantilla deja el tope del login contando en memoria, o sea por instancia, o
  sea nada.
- **El armador abrió una puerta al costado de la pared entre inquilinos.**
  `ClienteDatos` y `Db` son el mismo tipo estructural, la guarda exime por firma
  sin comprobar que el armador llegue a la capa, y los cinco archivos del
  refactor **siguen importando `db` sin usarlo**. Pasarle ese `db` a un armador
  compila, corre con el rol dueño y devuelve las filas de todos los inquilinos,
  en verde.
- **La invariante «enTenant no se anida» no matchea el estilo del repo.** La
  expresión no cruza el paréntesis de `(db) =>`, que es como se escribe en los
  doscientos lugares. Hoy imprime que no hay ninguno anidado sin vigilar nada —
  el mismo defecto que el commit que la agregó vino a arreglar en otro lado.
- **Gmail colapsa todos los errores a una constante.** 115 fallos en producción
  entre el 24 y el 28 de junio, los 115 con el mismo payload. Ciento quince
  personas sin respuesta durante cuatro días, y el motivo es hoy
  irreconstruible.
- **`/api/health` mira las dependencias, no el trabajo.** Los nueve chequeos
  preguntan «¿alcanzo a X?». Con 71 timeouts de modelo hoy y 189 adjuntos que R2
  perdió, estuvo verde todo el tiempo.
- **El timeout del modelo está puesto en el p97.** 20 s contra un p95 medido de
  14,7 s: 71 timeouts el 09/09 y 0 los trece días previos. Y el reintento manda
  «tu respuesta anterior no era JSON válido», que para un timeout es el consejo
  equivocado, y reenvía el mismo prompt de 10,6 k tokens. Un timeout se come los
  40 s del presupuesto entero.
- **`deliberate` gasta hasta cuatro llamadas al modelo para buscar lo que el
  worker ya tiene.** Sus tres herramientas contestan preguntas que el matcheo de
  cliente, el de póliza y la carga de la conversación respondieron doscientas
  líneas antes, en la misma invocación.

#### MEDIA, lo más señalado

- **La frontera de PII existe en dos rutas y se esquiva por cuatro.** Un `viewer`
  llega al mail entero del denunciante por `/api/cases/:id/agent-run`.
- **Un `analyst` puede borrar cualquier caso del inquilino** pero no editar uno
  que no tiene asignado: la operación irreversible es más permisiva que la otra.
  Y **ningún borrado deja auditoría** — la única operación irreversible del
  producto es la única sin registro de quién la hizo.
- **El inquilino entra por el cuerpo del pedido** en el webhook de WhatsApp y en
  `batch-simulate`, contra la regla que la propia capa de datos enuncia.
- **~55-70 viajes secuenciales a Neon por mensaje entrante**, de los cuales ~20
  son escrituras de contabilidad que nadie relee y podrían ir en un `after()`.
  `outbound_messages` se lee seis o siete veces para el mismo caso; el analizador
  de huecos hace cuatro lecturas independientes en fila.
- **`googleapis` son 568 ms de arranque en frío** en las dos rutas calientes, y
  el emisor de Gmail no se instancia nunca en el camino de WhatsApp. Es más
  grande que los 260 ms de Sentry que ya se sacaron.
- **1,2 s de sueño incondicional en cada mail**, incluso sin contención.
- **La concurrencia del worker es 1 y la cola no la drena nadie.** Por encima de
  un mail cada 20 s el freno vence, el caso queda pendiente, y sólo lo levanta un
  cron que en Hobby corre una vez por día.
- **El quinto modal nunca recibió el arreglo de foco** — el que crea usuarios con
  su rol: sin foco inicial, sin trampa de Tab, sin Escape.
- **`lang="es-AR"` fijo en el layout raíz**, con la interfaz también en inglés.
- **Siete pestañas sin ninguna semántica de pestaña** en la consola del agente, y
  un solo encabezado en toda la pantalla.
- **Seis controles de formulario sin etiqueta**, dos de ellos con nombre
  accesible vacío.
- **Las métricas se prueban contra una copia del código**, y esa copia todavía
  tiene el bug que se documentó como arreglado. El módulo real tiene 0 % de
  cobertura.
- **La cartera —la plata— tiene 0 % y su único test es una búsqueda de texto
  sobre el archivo fuente**: pasa si se invierten los ternarios o si una
  aseguradora ve la factura de otra.
- **El trinquete de cobertura quedó siete puntos por debajo de lo medido**, y
  tres de sus exclusiones dicen «sólo se cubre por integración» sobre archivos
  que tienen 69-82 % de cobertura unitaria.
- **`page` sin tope superior** (OFFSET ilimitado) y **`q` sin largo mínimo** (dos
  caracteres recorren el índice trigram entero). Dos líneas.
- **`audit_log` crece 142 filas por caso** y no tiene retención: a 100 k casos son
  14,2 M filas y ~5,9 GB. Y **`claim_messages` pesa 31 kB por fila** porque guarda
  el payload entero del proveedor: ~24 GB a la misma escala.
- **El agregado sin ventana de `/metricas` y el tope mensual del presupuesto** son
  O(historia) y O(llamadas²) respectivamente. Ningún índice los arregla.

#### Lo que se persiguió y NO se sostuvo

Vale anotarlo para que no vuelva a la lista:

- **Ni un IDOR.** Las doce rutas con `[id]` resuelven por la capa y devuelven 404,
  nunca 403.
- **Ni una consulta fuera de la capa sin declarar.** Las 42 declaradas se leyeron
  una por una: arranque de sesión, tablas sin inquilino, o barridos de sistema.
- **Ni inyección SQL.** Los tres `sql.raw()` interpolan constantes de módulo o un
  entero acotado.
- **El nonce de la CSP funciona**, aunque los comentarios describan un mecanismo
  que no es el que opera.
- **El prompt ya está bien formado para el caché de Vertex** — la parte variable
  está al final. Lo que falta es leer el contador de tokens cacheados para saber
  si pega.
- **Los índices trigram con cero escaneos sirven**: el cero es artefacto de 483
  filas, no un índice mal formado. No borrarlos.
- **El barrido de `text-slate-400` respetó sus exenciones**: las diez restantes
  son iconos. Quedaron dos afuera del criterio —una hora relativa y una equis de
  12 px— y los placeholders, que no entraron.
- **El modo oscuro no se rompió** con el cambio a `slate-500`: mejora los dos.
- **Imágenes, `next/font`, los barriles de iconos, `zod` en el cliente y los 26
  `force-dynamic`**: todos callejones sin salida, medidos.

#### La cuenta de la disciplina de logs

223 líneas con formato estructurado contra **173 con texto libre**. El 44 % de
los logs del servidor no se puede filtrar por evento ni agrupar por caso. Y el
logger estructurado ya existe: casi nadie lo usa.

#### Sobre Sentry, otra vez

Nada de lo de arriba lo necesita. Lo que no se recupera sin él es la agrupación
automática, los stack traces y la alerta en el minuto cero. Lo más cerca que se
llega gratis: ampliar `/api/health` con cuatro consultas sobre índices que ya
existen, y persistir los errores en `audit_log` en vez de en stdout. Se pasa de
«me entero el jueves» a «me entero en la próxima corrida del cron».

### 🧾 El inventario de los catorce prompts, cerrado (2026-09-10)

Dieciséis PR sobre la lista de arriba (#132 y #134-#147). Lo que sigue es qué
se cerró, qué se **corrigió** del propio inventario, y qué queda con nombre y
motivo.

#### Lo que se arregló

| | qué era |
|---|---|
| **Un timeout no es una escalada** (#132) | `GeminiExtractionError{TIMEOUT}` escalaba el caso a un estado del que el worker no puede arrancar y que `reap-stuck` no barre. Tres reintentos contados en `cases.intentos_de_extraccion` (migración 0030) y después sí escala |
| **Los límites de las listas** (#135) | `per_page` tenía tope y `page` no: `?page=100000000` es `OFFSET 2.500.000.000`, y Postgres no saltea filas sin leerlas. `q` además pide tres caracteres, que es lo que el índice trigram necesita para servir de algo |
| **El ensayo al día** (#136) | nada aplicaba las migraciones a la base de los tests ni avisaba que faltaban: estaba **ocho** atrás, y el único síntoma era un `42703` a mitad de un test que culpaba al código del PR |
| **Borrar era más permisivo que editar** (#137) | un analista no puede editar un caso que no tiene asignado —404— y podía **borrarlo**, con cascada a nueve tablas |
| **El inquilino por el cuerpo** (#138) | el webhook de WhatsApp aceptaba `tenant_id` en el cuerpo y le ganaba a la configuración. Su credencial es una sola y global; quien la tuviera escribía en la bandeja de cualquier aseguradora |
| **El 500 que no dejaba línea** (#139) | `err(new AppError("INTERNAL_ERROR"))` era la única rama de `err()` que no anotaba nada |
| **Once viajes a Neon en fila** (#140) | el analizador de huecos, el presupuesto y el buscador de clientes esperaban consultas que no dependían unas de otras |
| **La misma fuga de PII, al lado** (#141) | `/api/cases/:id/messages` devolvía `body_text` y `from_addr` crudos a `...ALL_ROLES` |
| **Tres verdes que no probaban nada** (#142) | la cartera se verificaba con un `grep` sobre el archivo fuente, `getTenantKpis` tenía 0 % de cobertura, y cinco exclusiones decían «sólo se cubre por integración» sobre archivos con 82 %, 80 % y 68 % |
| **Siete botones que decían ser pestañas** (#143) | la consola del agente no tenía `role="tablist"`, ni flechas, ni `tabpanel`. Y ocho controles sin nombre accesible |
| **El correo guardado dos veces** (#144) | `raw_payload` guardaba el cuerpo en base64 que ya estaba decodificado al lado: 80 % de 12,8 MB |
| **El registro en un solo formato** (#145) | 191 líneas de texto libre y 124 con el JSON armado a mano, y el logger estructurado sin **un solo importador**. 315 llamadas convertidas en 62 archivos, cero `console.*` en `src/`, y una invariante para que no vuelvan |
| **Siete alertas de CodeQL** (#146, #147) | el cierre de `<script>` que no cerraba, el borrado de una pasada que reconstruye la etiqueta, el decode de entidades corriendo DESPUÉS del borrado, dos carreras de sistema de archivos, y dos expresiones armadas con un argumento de la línea de comandos |
| **La inyección de líneas de log** (#145) | el webhook de Gmail interpolaba el `messageId` del sobre de Pub/Sub en un literal de plantilla: un id con un salto de línea forjaba una segunda línea del registro. Con el logger el valor es un campo y `JSON.stringify` lo escapa |

#### Lo que se midió y NO se sostuvo

Vale tanto como lo otro.

- **`audit_log` no crece 142 filas por caso.** Son **4,3 por caso vivo**. De las
  70.576 filas, **65.179 (92 %) apuntan a casos que ya no existen** —la
  telemetría de unos 9.000 casos de simulación que después se borraron, porque
  `target_id` no es clave foránea a propósito—. La extrapolación a 14,2 M filas
  usaba el denominador equivocado. No hay retención que resolver.

- **El índice sobre `ai_usage` sigue sin ir.** El tope mensual del presupuesto
  hace un Seq Scan, sí: **17 ms sobre 13.881 filas**. La 0024 ya midió por qué
  un índice ahí no lo usa el planificador, y los dos motivos que dio —la columna
  líder ya está indexada, y una tabla que sólo crece desarma el Index Only Scan
  por el mapa de visibilidad— siguen valiendo. Crear uno hoy sería repetir
  exactamente lo que la 0023 hizo y la 0024 deshizo.

- **Gmail ya no colapsa los errores.** El sender propaga el status HTTP
  (`GMAIL_401`, `GMAIL_429`). Los 115 payloads idénticos de junio son históricos.

- **Los 1,2 s de sueño del correo ya estaban arreglados**, y `googleapis` ya
  entraba en diferido. Lo que faltaba era el mismo sueño en el camino de
  simulación: 1,5 s por caso contra una cola vacía, ~162 s sobre los 108
  escenarios, en una ruta que dura 60 (#143).

#### La única alerta que se descartó en vez de arreglarse

`js/incomplete-multi-character-sanitization` sobre `unaPasada()` de
`rehearse-conversations.mts`. CodeQL marca esa función sola —es un saneador de
una pasada— y no sigue al llamador, que la repite hasta el punto fijo.

Los cuatro defectos que la regla señaló están arreglados. Lo que queda es la
regla mirando la forma: `readable()` se usa en **dos** lugares —un `console.log`
a la terminal y un `.toLowerCase()` para buscar una frase— y ninguno renderiza
HTML. No hay sink.

Descartada como falso positivo, con el motivo escrito **en el código** y no sólo
en el botón de GitHub. Se reabre desde la pestaña Security si no convence.

#### Lo que queda, y por qué

Dos, las dos en el camino del agente:

- **`deliberate` gasta hasta cuatro llamadas al modelo** buscando lo que el
  matcheo de cliente, el de póliza y la carga de la conversación ya
  respondieron doscientas líneas antes.
- **`outbound_messages` se lee cinco veces por orquestación** para el mismo
  caso, más dos «desde que hablamos» que comparten la misma fila.

Las dos cambian el comportamiento del agente, y `AGENTS.md` es explícito: eso se
lee en el transcripto del ensayo, no en un diff. El ensayo necesita un deploy, y
el 10/09 Vercel llegó al tope de builds del día del plan Hobby. **No se tocaron
a ciegas.**


### 🕳️ Una guarda que no guardaba nada, y era del mismo día (2026-09-10)

Buscando qué tests faltaban apareció esto: la invariante **«el inquilino no entra
por el cuerpo»**, agregada horas antes en #138, tenía un **retroceso literal
(0x08)** donde va `\b`. Su expresión pedía un carácter que no existe en ningún
archivo del repo, así que no matcheaba nunca: pasaba en verde sobre una ruta que
la violaba, comprobado plantando una.

En el diff, en el editor y en GitHub se ve `\b`. Se había verificado, pero con
una expresión escrita a mano en la terminal y no con la que quedó en el archivo.
**Verificar el concepto no es verificar el código.**

Y no era la única. Dos más, del 26/08:

| archivo | qué hacía |
|---|---|
| `scripts/pen-test.mts` | la sonda del motor de flujos, con un `||` que la salvaba a medias |
| `tests/e2e/seguridad.spec.ts` | una aserción **negativa** —`.not.toMatch()`— o sea un test que no podía fallar |

```
con el retroceso  : false   ← nunca detecta
con la frontera   : true
```

El origen es siempre el mismo: una herramienta que se come la barra al escribir
el archivo, y el resultado no se distingue al releer.

#### La invariante que lo cierra

`▸ Ningún carácter de control invisible` recorre `src/`, `scripts/` y `tests/`
buscando 0x07, 0x08, 0x0B, 0x0C y 0x1B. Tabulación y saltos de línea no están en
la lista, porque una guarda que marca cada archivo del repo la saca alguien.

Agarró un retroceso adentro de **su propio comentario** apenas se escribió, que
es la demostración más corta de que hacía falta.

#### Y los dos módulos que sólo se habían verificado a mano

Misma raíz, distinto síntoma: comprobados en archivos del directorio temporal de
la sesión, que se borran al cerrar.

- **`scripts/lib/env-local.mjs`** — lo usan `migrate.mjs` (decide contra qué base
  aplicar migraciones) y `create-app-role.mts` (escribe ahí la contraseña rotada,
  y NO la imprime, así que ponerla en la línea equivocada no se nota). 14 tests;
  el que más importa es el de la colisión de prefijos.
- **`readable()` del ensayo** → `scripts/lib/texto-legible.mjs`. Se cambió cuatro
  veces en un día y no se podía probar porque vivía en un script de top-level
  await: importarlo lo corre. 13 tests, incluido el que fija la propiedad de la
  que depende que su bucle sin tope termine —ninguna pasada alarga el texto— y el
  que distingue un `<` bien escapado de uno crudo.

Las tres guardas del 10/09 tienen ahora sus propios tests, cada una contra lo que
tiene que ver y contra lo que no. Reintroducir el bug exacto que se mergeó rompe
uno.

### 🧮 La bandeja contaba dos veces, y una estaba mal (2026-09-10)

El pedido era de layout: sacar las cuatro baldosas, meter el estado en los
filtros y subir el botón. Al hacerlo apareció que **los dos controles contaban
distinto**. Medido en producción:

| opción | la pestaña decía | la baldosa decía | casos de verdad |
|---|---|---|---|
| Escalado | **1** | **43** | `escalado` 1 + `requiere_especialista` 42 |
| Listo | **0** | **27** | `listo_para_core` 27 |
| Esperando | **0** | **6** | `info_faltante` 6 |

Las baldosas agrupaban los estados canónicos y las pestañas contaban un estado
suelto. **Tres de las cinco decían 0 sobre 483 casos**, porque el canal real
nunca escribe `listo`, `esperando` ni `escalado` —ese es el vocabulario del
flujo simulado—. El control con el que se navega la bandeja llevaba meses sin
servir, con una baldosa al lado diciendo el número correcto.

Es la **tercera copia** del mismo defecto: ya se había arreglado en las métricas
(`estados-que-cuentan-las-metricas`) y en las propias baldosas
(`kpisDeLaBandeja`). Cada arreglo tapó una copia y dejó la siguiente.

#### Lo que hace ahora

Las cinco opciones **son** su grupo, contando y filtrando: el chip dice 406 y la
lista queda en 406. `src/core/case/filtro-de-estado.ts` define la partición —los
cinco no se pisan, que es lo que `ESTADOS_RESUELTOS` no da porque incluye
`cerrado`— y su test fija la propiedad de la que depende todo: **el contador y el
filtro salen del mismo conjunto**. Un chip que diga 43 y devuelva un caso es peor
que uno que diga 1.

Un estado suelto sigue funcionando en la URL y en la API: el CSV y el sondeo en
vivo piden `?status=requiere_especialista` y reciben eso exacto.

#### Y el layout, que era el pedido

Cuatro baldosas y seis pestañas menos, y el botón «Filtros» al lado del contador:
~140 px menos de encabezado en la pantalla que se mira ocho horas por día. **Nueve
filas donde antes entraban cinco.** Las marcas de lo puesto sólo existen cuando
hay algo puesto, así que sin filtros la lista empieza una línea más arriba.

Se fueron `FilterTabs` y `kpisDeLaBandeja`, sin un solo llamador, con sus tests. El
patrón de pestañas accesibles no se pierde: vive en `@/lib/ui/pestanas` y lo usa
la consola del agente.

Verificado en el navegador contra el ensayo con Playwright —claro, oscuro y 900
px— y con los 18 e2e de bandeja y selección.

### 🚦 Diez merges sin comprobar, y ninguno dejó rojo (2026-09-10)

Al mergear #154 miré el post-deploy y decía `cancelled`. No lo canceló nadie.

`deployment_status` llega también por cada preview y por cada estado
intermedio. Esas corridas saltean todo —`smoke` tiene la guarda y las demás
cuelgan de él— y terminan en `skipped`, así que parecían gratis. **Reservan el
turno igual.** Con `cancel-in-progress: false` GitHub guarda UNA sola corrida
esperando: cuando llega la siguiente, la que estaba en la cola se cancela.

    886336c  Production  ← el merge a main, encolado
    5dbf546  Preview     ← una rama cualquiera; lo desalojó

O sea que cualquier preview que se despliegue mientras espera el post-deploy de
un merge lo echa de la cola.

#### Cuántas veces pasó

Sobre las últimas 100 corridas del workflow: **10 commits de `main` quedaron con
su post-deploy en `cancelled`, y ninguno tuvo otra corrida que terminara.** Los
diez, entre el 09/09 y el 10/09:

    5330791  9d7c024  217f629  f56e5bd  b8e3686
    3c97810  fa04a11  d1fdd80  e76c2b3  886336c

Lo que no corrió en esos diez es lo único que mira producción de verdad: la
base, las migraciones aplicadas, R2 con una subida real, el modelo con una
llamada real, el token de WhatsApp y la casilla conectada. Esto existe porque
«R2 funcionó en cada corrida local durante horas mientras producción descartaba
todos los adjuntos» —el comentario que encabeza el workflow—.

Y no dejó rastro: `cancelled` no es rojo, se lee como que alguien la cortó a
propósito. Un CI verde no distingue «pasó» de «no llegó a correr».

#### El arreglo

El grupo compartido lo usa sólo lo que pasa la misma guarda que `smoke`.
Todo lo demás va a `post-deploy-sin-cola-<run_id>`: grupo propio por corrida,
donde no espera ni echa a nadie. La serialización contra la base de producción
—que es lo que el grupo existía para dar— no cambia.

Se ve recién en el próximo merge: el post-deploy de `main` tiene que llegar al
final en vez de quedar `cancelled`.

### 🙋 Waiting on you (not code)

- **¿Corro `pnpm achicar-payloads --apply` contra producción?** Libera 10.290 kB
  de 12.808 en `claim_messages` sacando la copia en base64 del cuerpo, que ya
  está decodificada en `body_text`/`body_html`. Es irreversible: el salto de
  línea y el relleno del base64 no se reconstruyen byte a byte. El CONTENIDO no
  se pierde. El arreglo hacia adelante ya está aplicado; esto es sólo para las
  356 filas viejas.

- **¿Para qué existe el rol `viewer`?** La conversación ya no le sale cruda, pero
  `fetchCaseRow` hace un `db.select()` pelado, así que la pantalla del caso le da
  igual el `policyholder_name` y el `policy_number`. Si `viewer` es «mira todo y
  no cambia nada», está bien como está. Si es «no ve datos personales», hace
  falta una proyección por rol en toda la pantalla, no un parche en una ruta.

- **Vercel llegó al tope de builds del día (10/09, plan Hobby).** No bloquea los
  merges —no es un check requerido— pero **no hay deploy hasta que se libere**, y
  sin deploy no corre el ensayo de conversaciones. Por eso quedaron sin tocar las
  dos optimizaciones del camino del agente.

- ~~**Reponer la contraseña de `claimmix_app`**~~ ✅ **HECHO 2026-08-26.** Rotada
  con `pnpm rol-app --rotar`, puesta en `.env.local` y en Vercel (producción), y
  verificada de punta a punta con `pnpm listo`: permisos sobre las 29 tablas, la
  capa aislando contra la base real —incluido que **rechace escribir** en la
  aseguradora de al lado— y las invariantes de arquitectura. Las cuatro en verde.

  Lo que NO se pudo verificar por comparación: el valor guardado en Vercel. Está
  marcado como sensible, así que `vercel env pull` devuelve `"[SENSITIVE]"` y no
  hay forma de contrastarlo con el local. Por eso `/api/health` ahora tiene una
  sonda propia de la capa de datos, que consulta con el rol restringido: si el
  valor de Vercel estuviera mal, el primer deploy lo dice —`DATABASE_URL_APP no
  autentica`— en vez de descubrirse cuando un analista abre la bandeja vacía.

- ~~**`main` acepta pushes que saltan la protección de rama**~~ ✅ **HECHO 2026-09-05.**
  `enforce_admins` activo en la protección de `main`: los diez checks valen
  también para el admin, y todo cambio entra por rama + PR. Lo que sigue es el
  relato original (2026-09-01). Los
  tres pushes de hoy contestaron «10 of 10 required status checks are expected»
  y pasaron igual. No es teórico: así llegó a producción un CI rojo —era la
  auditoría de dependencias, se arregló enseguida, pero si hubiera sido un test
  roto se desplegaba igual—. Se cierra de dos formas: trabajar con rama + PR, o
  sacar el bypass en la configuración de la regla desde la UI de GitHub. Queda
  a decisión tuya; por ahora se sigue pusheando a `main`.
- **Los primeros caracteres de `STAGING_DATABASE_URL` quedaron en un transcripto**
  (2026-08-31). Al armar un script de verificación imprimí los primeros 30
  caracteres de la cadena, que incluyen cuatro de la contraseña. Es la base del
  ENSAYO, no la de los clientes, y cuatro caracteres no son la contraseña — pero
  va anotado acá por la misma razón que los de abajo: lo que no se anota, no se
  rota.
- **La contraseña nueva de `claimmix_app` quedó impresa en el transcripto** de la
  sesión donde se rotó. Misma categoría que el token de WhatsApp y la clave de
  Google de más abajo: no se sabe filtrada, y ya no está sólo donde debería.
- **`INTEGRATION_TEST_PASSWORD` se escribió en texto plano a un archivo**
  (2026-09-01). Para entrar por el navegador y sacar capturas la extraje de
  `.env.local` a un archivo del directorio temporal de la sesión. Después el
  enfoque cambió —los guiones la leen de `.env.local` en memoria y nunca la
  escriben— y el archivo quedó ahí sin usarse hasta que se borró al cerrar.

  El riesgo concreto es bajo: es la cuenta sembrada de pruebas, no una de
  cliente; el archivo vivió en la misma máquina donde ya está `.env.local`; y ya
  no existe. Va anotado igual por la regla de arriba —lo que no se anota, no se
  rota— y porque el modo correcto ya estaba disponible: no había ninguna razón
  para que esa contraseña tocara el disco.
- ~~**Write to it once, from a real phone and a real mailbox**~~ ✅ **DONE 2026-08-24.**
  See "The last metre" below: a real mail, two real WhatsApps and a real photograph,
  all answered. Do it again after the next change to the mailbox, the number or their
  credentials — that is the only part no test can cover.
- **Rotate the Google OAuth client secret** (`GOCSPX-…`). It was read off a screenshot
  during the migration, and it now backs four env vars: `GMAIL_CLIENT_ID`/`SECRET` for
  the mailbox and `GOOGLE_CLIENT_ID`/`SECRET` for logging in. Rotating it forces a
  reconnect of the mailbox and a re-login, in that order.
- **Rotate the WhatsApp system-user token.** Meta echoed it inside an error response
  on 2026-08-23 and it is now in a chat transcript. Same standing as the
  `veltra.soporte` password below: it is not known to be leaked, and it is no longer
  only where it should be.
- **Vercel and Neon are still on the free plans.** The load test says the ceiling
  is the plan, not the code — that becomes a step-shaped outage the month it hits.
- ~~**New GCP project + `pnpm switch-gcp`**~~ ✅ **DONE 2026-08-24.** Extraction now
  runs on **`claimmix-506321`**, inside the `veltra-claimmix-org` organisation and on
  **its own billing account** (`0158E1-5C6451-D20FCE`), so the model's spend stops
  landing on a personal card. The ID is not `claimmix-veltra`: project IDs are
  immutable and `claimmix` was already taken by the personal project, so Google
  appended the number. Two projects are now called "claimmix" — worth renaming the old
  one's *display* name so nobody confuses them in six months.
  The old `claimmix` project is **deleted** (`DELETE_REQUESTED` 2026-08-24, restorable
  for 30 days). Everything that hung off it was moved first — Gmail OAuth client,
  Pub/Sub topic and push subscription, the login OAuth client, and the tuning bucket —
  and each move was proved against production before the next one started. The mailbox
  had to re-consent, which is what set off the incident recorded below.
- ~~**Turn `iam.disableServiceAccountKeyCreation` back on** for `claimmix-506321`~~
  ✅ **YA ESTABA, verificado en consola 2026-08-31.** Sobre el proyecto `claimmix`
  (ID `claimmix-506321`, dentro de `veltra-claimmix-org`), la restricción figura
  **Activa** y **heredada** de la organización. Lo mismo
  `iam.disableServiceAccountKeyUpload`. La anulación de nivel proyecto que esta
  nota decía que quedaba puesta **no está**: o se sacó en algún momento, o nunca
  llegó a persistirse.

  Vale la pena decir cómo casi lo leemos mal. La primera consulta se hizo con la
  cuenta equivocada —`ilan.daniele@gmail.com`, que ve `ilan-daniele-org` y ni
  siquiera puede describir `claimmix-506321`— y esa pantalla mostraba «Inactive /
  Inherit parent's policy». O sea que el estado se ve DISTINTO según con qué
  cuenta mires, y la versión equivocada era la que decía que faltaba hacer algo.

  Verificado leyendo la consola, no la API: gcloud sigue teniendo sólo la cuenta
  personal, así que no hay confirmación por CLI.

  **Cuándo vuelve a importar:** el día que se rote esa clave, `keys create` va a
  fallar. Ahí hay que poner una anulación temporal en el proyecto, rotar, y
  sacarla. La restricción bloquea CREAR claves, no invalida las existentes — la
  que está en Vercel y en GitHub sigue funcionando.
- **Delete the downloaded key** from `Downloads`. The value lives in Vercel, in GitHub
  and in the git-ignored copy in the repo; a service-account key in a Downloads folder
  is the next leak.
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
  `GOOGLE_CLOUD_PROJECT=claimmix-506321` (Veltra's org and billing since 2026-08-24;
  it was `claimmix` before), `GOOGLE_CLOUD_LOCATION=us-central1`,
  `VERTEX_EXTRACTION_MODEL=gemini-2.5-flash`, and the credentials: on Vercel the
  four `GCP_*` variables (OIDC, no key — see «Vercel le prueba a Google quién es,
  sin clave», 2026-09-05); locally `GOOGLE_APPLICATION_CREDENTIALS` with the key file.
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
  (`claimmix-veltra-sa-key.json`, since 2026-08-24 — the old `claimmix-vertex-sa-key.json`
  belonged to the deleted project and was removed) + `VERTEX_AI_TUNING_ENABLED=true` + project/location/bucket
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
| `knock-on-the-door.mts` | `pnpm knock` — deposita un mail con forma de denuncia en la casilla de verdad y le manda al webhook un payload firmado como lo firma Meta. Prueba el primer metro de la cadena sin que salga nada del edificio. Corre en cada deploy. |
| `rehearse-onboarding.mts` | `pnpm onboard` — gives a throwaway client the full onboarding, checks isolation, billing, the invoice freeze and the AI budget, then deletes it. Free. Run it before each real client. |
| `switch-gcp-project.mts` | `pnpm switch-gcp` — moves extraction to another GCP project in one command. Verifies the new key against Vertex BEFORE writing anything, then updates .env.local, Vercel and GitHub. Exits non-zero if any of the three could not be written: half a migration is worse than none. |
| `switch-mailbox.mts` | `pnpm mailbox` — swaps the intake mailbox without a moment of silence. |

The testing scripts — `check-everything`, `rehearse-conversations`, `smoke-production`,
`prove-delivery`, `load-test`, `pen-test` — are run through their `pnpm` aliases and
documented in [docs/TESTING.md](TESTING.md), not here.

⚠️ **Never `DELETE FROM cases` directly.** `training_examples` hangs off cases by *two*
cascading paths — `case_id`, and `agent_run_id` → `agent_runs.case_id` — so a plain
delete silently destroys the whole training set. `reset-cases-keep-training.mjs` detaches
both (`case_id` is nullable on each) before deleting, and rolls back if the approved
count moves.

### 🧱 El refactor arrancó (2026-08-25)

Las Fases 0-A, 1 y el primer pedazo de la 2, con producción andando todo el
tiempo. Todo está en `docs/ARQUITECTURA*.md`; acá el estado.

**La tenencia ya no depende de la memoria.** Producción tiene RLS, FORCE y
política en las 29 tablas, y existe `claimmix_app`, un rol sin `BYPASSRLS`. Los
filtros escritos a mano bajaron de **198 a 44**, y los que quedan están anotados
uno por uno.

```
pnpm tenancy        ¿la base separa, o sólo el código?
pnpm capa-datos     ¿la capa usa bien lo que la base ofrece?
pnpm esquemas       ¿los archivos de migración reproducen la base que corre?
pnpm arquitectura   las invariantes, en cada pnpm verify
```

⛔ **`DATABASE_URL` sigue apuntando al rol viejo, y es correcto.** El cambio
ocurre cuando no queden filtros escritos a mano: hasta entonces, algunas
consultas todavía se apoyan en ellos y otras ya no llevan ninguno. Con el rol
restringido, las primeras seguirían andando y las segundas devolverían cero. La
cadena está en `DATABASE_URL_APP`, ya cargada en Vercel.

**Lo que quedó pendiente, con motivo.** ~~`agent-tools` y `customer-matcher`
rompen sus tests… Los 44 filtros restantes…~~ **Desactualizado, corregido el
2026-09-09.** Los dos módulos ya migraron enteros, y `check-architecture.mjs`
dice hoy «10 de 10 permitidos» y «41 declaradas con su motivo»: los filtros
escritos a mano bajaron de 44 a 10. Alguien que retomara por este párrafo iba a
ir a hacer trabajo que ya está hecho.

**Y algo que conviene saber antes de confiar en `pnpm rehearse`:** falla con
diferencias distintas en cada corrida, porque conversa con el modelo real. Al
comparar dos versiones del orquestador, una tenía 3 diferencias y la otra 4, y
ninguna de las dos las mismas.

~~**No sirve como portón de CI tal como está.**~~ **Desactualizado, corregido el
2026-09-09.** Hoy SÍ es un portón: el job `rehearse` de `post-deploy.yml` depende
de `smoke` y bloquea a los que vienen después. La aleatoriedad se resolvió
corriéndolo dos veces y comparando con `comparar-ensayos.mjs`, así que lo que
falla es lo que falla en las dos.
