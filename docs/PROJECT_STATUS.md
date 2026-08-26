# ClaimMix — Project Status & Recovery Notes

_Last updated: 2026-08-24. This file is the single source of truth for "where things stand."
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
  OpenAI optional fallback (currently an invalid key), `MOCK_AI=true` for local.

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

### 🙋 Waiting on you (not code)

- **La contraseña de `claimmix_app` en producción quedó rotada y hay que
  reponerla.** El ensayo se la cambió por una aleatoria que descartó (ver "La
  base separa a las aseguradoras"), así que `DATABASE_URL_APP` —en `.env.local`
  y en Vercel— ya no autentica. **No hay caída**: lo desplegado todavía usa el
  rol viejo. Pero es lo primero que hay que hacer antes de desplegar la capa de
  datos, o la aplicación arranca sin poder consultar nada.
  Se repone con `pnpm rol-app`, que genera una nueva y la imprime; después va a
  `.env.local` y a Vercel (`vercel env rm` + `vercel env add DATABASE_URL_APP`).

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
- **Turn `iam.disableServiceAccountKeyCreation` back on** for `claimmix-506321`. New
  organisations enforce it by default and it had to be overridden — at project level,
  not org — to create the one key we needed. The override is still there.
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

**Lo que quedó pendiente, con motivo.** `agent-tools` y `customer-matcher`
rompen sus tests de una forma que no es el puente ni el contexto: piden entender
el mock a fondo. Los 44 filtros restantes son los que el análisis marcó como no
mecánicos — joins que pueden estar acotando la tabla del otro lado, y `or(` que
pueden ser el caso de las filas globales.

**Y algo que conviene saber antes de confiar en `pnpm rehearse`:** falla con
diferencias distintas en cada corrida, porque conversa con el modelo real. Al
comparar dos versiones del orquestador, una tenía 3 diferencias y la otra 4, y
ninguna de las dos las mismas. Sirve para leer transcriptos —para eso está— pero
**no sirve como portón de CI tal como está**: un chequeo que falla al azar se
deja de mirar, que es exactamente cómo se perdieron las 28 políticas de RLS
durante meses.
