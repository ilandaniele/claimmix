# ClaimMix — Project Status & Recovery Notes

_Last updated: 2026-10-24. This file is the single source of truth for "where things stand."
Update it at the end of a work session so the next one can recover quickly._

> **TL;DR** — The system runs unattended: email + WhatsApp intake work, extraction goes
> through **Vertex AI** (postpay, no prepay wall), and the agent answers with the
> base Gemini model (no fine-tuned model is active anywhere) plus context pasted into the
> extraction prompt: up to 3 human-approved examples, admin rules and per-sender memory.
> Code rules still make the critical decisions; moving them into console-editable training
> is in progress (see "El agente aprende de la consola"). **WhatsApp runs on the real Argentine
> number**, verified, WABA approved. Intake mail arrives at **veltra.claimmix@gmail.com**
> and nothing else. 21–24 August went into hardening, then the commercial layer, then
> the last metre of the wire: the app was attacked on purpose, load-tested at a hundred
> simultaneous claimants, onboarding a second client was rehearsed end to end, a closed
> month's invoice is frozen, billing + portfolio have screens, and **both channels were
> driven end to end with real messages from a real person** — a mail, two WhatsApps and a
> photograph, all answered. **In production every check is green** (CI, CodeQL, secret
> scan and the seven post-deploy jobs, plus the `alcance` job that writes down what each
> run did and did not verify), and the extraction now bills to **Veltra's own Google
> Cloud project**. Carga now measures previews for real —
> `p95 530 ms · 0% fallidos · 67 pedidos`, run 35466095444 — after the Preview
> scope of `claimmix` got `DATABASE_URL`, `DATABASE_URL_APP` and
> `BETTER_AUTH_SECRET` pointing at the Neon rehearsal branch and the k6 account
> was swapped to an admin. The last red is closed: the nine `QA_*` repository
> secrets exist, so a QA deploy now runs its checks and its rehearsal. That
> needed QA to get a bucket of its own — `claimmix-qa-attachments`, separate
> from production's `claim-attachments` — which happened on the way out of the
> personal Cloudflare account and into Veltra's; the old bucket and its token
> were deleted on 2026-09-21. What is left is commercial:
> paid plans, and a first client.

## What ClaimMix is

Multi-tenant **FNOL (first-notice-of-loss) claim intake SaaS** for the Argentine
insurance market. Inbound claims (email, WhatsApp, or simulated) → AI extraction
(Gemini-first) → validated structured fields → analyst dashboard.

- **Stack:** Next.js 16 (App Router), React 19, TypeScript, Drizzle ORM, Neon
  Postgres, Better Auth, pnpm. Deployed on **Vercel (Hobby plan)**.
- **URLs:** prd en https://claimmix.vercel.app (proyecto `claimmix-prd`, desde el move
  del 2026-10-09) y dev en https://claimmix-dev.vercel.app (proyecto `claimmix`, con la
  base `ep-proud-resonance` y sus datos reales); ver «Ambiente prd» más abajo
- **AI:** Gemini `gemini-3.8-flash` en la multirregión `us` **via Vertex AI** (`GEMINI_TRANSPORT=vertex`;
  desde 2026-10-15, porque Google retira 2.5 el 20/10),
  `MOCK_AI=true` para local. **No hay fallback de OpenAI**: el extractor se borró
  y `OPENAI_API_KEY` no se lee en ningún archivo. El selector real es
  `resolverAiMode` (`MOCK_AI`, `AI_MOCK`, o Gemini sin configurar). En modo
  mock la denuncia queda vacía y en `requiere_especialista`: no se inventan
  datos (E16).

## Cómo probar que todo anda

`pnpm check` corre todo: tipos, lint, ~1960 tests, veintiséis conversaciones
enteras por WhatsApp y por mail sobre los canales simulados, y un chequeo
contra el deploy que está corriendo. **No le manda un mensaje a nadie.**

`pnpm prove --whatsapp <número>` / `--email <dirección>` es el único que manda
algo de verdad, para comprobar que la salida funciona.

`pnpm arquitectura` comprueba que ninguna consulta se salga de la capa de datos
y `pnpm permisos` que el rol restringido pueda hacer lo que ella le pide.
`pnpm bases:probar` da de alta dos inquilinos con una base cada uno y comprueba el
aislamiento, el espejo y el barrido, contra la rama `ensayo` del proyecto de Neon `claimmix-prd`.

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
- **Which Neon database is which — the names lie.** Production serves from
  `ep-proud-resonance-acbz9jqu`, a project outside the Veltra org. That is
  `.env.local`'s `DATABASE_URL`, Vercel Production's, and also the repository
  secrets `DATABASE_URL` and `DATABASE_URL_APP`: the post-deploy jobs that
  write (doorbell, rehearsal, pen test) write into the customers' database and
  sweep their own rows afterwards. `STAGING_DATABASE_URL` is the Veltra branch
  that is *named* `production` (`ep-damp-meadow-ac1xqhzs`), and only
  `ci.yml`'s integration and tenancy tests use it. Proved on 2026-09-21: the
  doorbell job found and deleted the case the deploy had just written to
  proud-resonance. Tell them apart by what is in them — real `email` and
  `whatsapp` cases — never by name. The live database was missing the 41
  global `known_claim_patterns`; they were seeded into it that day.
- **Second Vercel project: `claimmix-qa`.** Deploys the `qa` branch, reads the
  `qa` Neon branch (`br-muddy-mountain-acxm92sh`), public alias
  https://claimmix-qa.vercel.app. First real deploy: 2026-09-18. What that day
  taught, all of it verified against the live deploy:
  - **A QA deploy now runs what QA can run — and says out loud what it cannot.**
    `post-deploy.yml` has a `qa` caller that maps every secret one by one (never
    `secrets: inherit`, which would aim its six runner jobs at the PRODUCTION
    database, three of them writing) and switches each check on or off. QA runs
    the smoke — light, since `--deep` uploads a file and calls the model — plus
    `listas-parejas` and `permisos`, and it never runs the doorbell, the pen
    test or the load check. It runs the rehearsal once the `QA_R2_*`,
    `QA_GMAIL_TENANT_ID` and `QA_BETTER_AUTH_SECRET` secrets exist, and since
    2026-09-20 they do: QA got its own bucket, `claimmix-qa-attachments`, in the
    same Cloudflare account as production's `claim-attachments` but behind a
    token that cannot read the other bucket, in either direction. The gate
    compares QA's bucket and key against production's, the way it already
    compared the database strings. A new
    `alcance` job writes one row per check into the run summary — ran, ran and
    failed, or did not run and why — so a run is never green by absence. The
    `qa_secretos` gate refuses to start when the three required secrets are
    missing, and also when QA's database string equals production's (compared
    without printing either). The last QA deploy (`28249b4`, run 35551526692)
    ran smoke, permisos, código y base, the rehearsal and «Qué se preguntó»,
    all green; doorbell, pen test and this workflow's load check are off on
    QA by design — `load-tests.yml`'s k6 does run against QA's public alias,
    separately.
  - **✅ QA can be logged into.** On 2026-09-18 `POST /api/auth/sign-in/email`
    answered `403 INVALID_ORIGIN` because `NEXT_PUBLIC_SITE_URL` was empty, so
    `resolveBaseURL()` (`src/lib/auth/index.ts:14-18`) fell back to the hash
    host. The variable was loaded on 2026-09-20 and the same probe now answers
    `401 INVALID_EMAIL_OR_PASSWORD`, like production. «Continuar con Google»
    works too: Google accepts QA's `redirect_uri`, while a made-up one gets
    `redirect_uri_mismatch` (measured 2026-09-21). An address in QA's
    `ADMIN_EMAILS` that signs in with Google is provisioned as admin into
    `GOOGLE_DEFAULT_TENANT_ID`. A password signup gets an account with no
    profile, by design, until an admin attaches it. QA has no mailbox, so the
    password-reset mail never leaves.
  - **The two projects are told apart by the environment NAME, never the URL.**
    With more than one project GitHub disambiguates the environment as
    `Production – claimmix` / `Production – claimmix-qa` (en dash), while
    `environment_url` is `claimmix-<hash>-…vercel.app` for both. Every gate that
    must exclude QA reads the name; invariant 15 of `check-architecture.mjs`
    enforces it, in the job `if:` and in the `concurrency` group alike.
  - The QA hash URL sits behind Vercel Auth and the repo's automation bypass
    secret belongs to the other project, so k6 measures the public alias.
- **✅ The Preview environment of `claimmix` had no `DATABASE_URL`.** That was
  the whole 500, diagnosed on 2026-09-18 and closed on 2026-09-19 (see "Carga on
  previews" below). The deploy said it itself:

      GET /api/admin/health
      {"status":"degraded","db":"error","db_error":"DATABASE_URL is not set"}

  `CRON_SECRET` was missing from that scope too. Preview now carries the same
  value as production and the repository secret, because `load-tests.yml`
  sends the repository secret to previews. That value was rotated on
  2026-09-21 after it showed up in a screenshot: production, Preview, the
  repository secret and `.env.local` changed together, and the old value gets
  401.
  - **How it was narrowed, so nobody redoes it.** Measured from CI with the
    automation bypass, on the same preview deploy:

        /                  500   (sin x-vercel-error, "Internal Server Error")
        /login             500   (idem)
        /privacy           200   <!DOCTYPE html>…
        /demo              200   <!DOCTYPE html>…
        /api/health        401
        /api/admin/health  200   db_error: DATABASE_URL is not set

    `/privacy` and `/demo` are pages the middleware returns without consulting
    the session — public and not in `SOLO_ANONIMOS`. So are `/terms` and
    `/restablecer` (`src/proxy.ts:30,40,53-55`); an earlier version of this note
    called those two the only ones, and that was wrong. They
    serve whole HTML, which rules out the build, the runtime, the CSP and
    `instrumentation.ts`: a failing `exigirSecretoDeSesion()` would take them
    down as well. The split leaves exactly one suspect, `auth.api.getSession`,
    and `/api/admin/health` names it.
  - **A database outage takes `/login` down with it.** `src/proxy.ts` lists
    `/login` in `SOLO_ANONIMOS`, so even though the path is public the
    middleware still calls `auth.api.getSession` on it to bounce anyone who is
    already signed in. That is a query. There is no "degraded but you can still
    log in" mode: if the data layer is unreachable, the login page 500s too.
  - **Carga on previews is green since 2026-09-19.** The Preview scope of
    `claimmix` now carries `DATABASE_URL`, `DATABASE_URL_APP` and
    `BETTER_AUTH_SECRET` against the Neon rehearsal branch, and the k6 account
    was swapped from Paula (`analyst`) to Mariela (`admin`) because
    `/api/customers` and `/api/policies` require `CUSTOMER_PII_ROLES`, which
    excludes analysts on purpose. Run 35466095444: `p95 530 ms · 0% fallidos ·
    67 pedidos`. Carga is still not a required check on `main`.
  - **And when a target has no database it no longer dies without measuring
    anything.** Since 2026-09-18 the
    job probes `/api/admin/health` first — reading the body, not the status,
    because that endpoint answers 200 with the database down — and when there is
    no database it runs `tests/load/scenarios/publico.js` instead: the four
    session-free pages, one VU, thirty seconds, its own p(95) < 1000 ms budget.
    It still ends **red**, with an `::error title=Carga a medias` naming the half
    that was not measured, and the artifact is called `carga-publico` so the name
    does not lie about what is inside it. That fallback stays for any target
    that comes up without a database.
  - The `if: failure()` diagnostics that produced the table above live in
    `load-tests.yml` and cost nothing on a green run. Leave them.

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

**Catálogo 2027 (rama `billing/catalogo-precios-2027`, aprobado por el dueño el 28/10).**
Cuota única en unidades: cada denuncia gasta del cupo según por dónde entró (WhatsApp en el
número de ClaimMix 1, WhatsApp con la WABA propia del cliente 0,8, mail 0,5, web 1 a la
espera del dueño) y el excedente se cobra por unidad. `included_claims` pasa a significar
unidades; `volume.billable_claims` sigue siendo la cantidad de denuncias y `invoice.units`
trae el consumo pesado (las facturas congeladas antes no lo traen: se leen con `units =
claims`). Los pesos viven en `PESO_EN_DECIMAS` y `consumoDelMes`
(`src/lib/billing/plans.ts`); el SQL sólo cuenta cuatro cubetas disjuntas
(`src/server/billing/cuentas-sql.ts`) y `computeInvoice` cobra.

| Plan | Cuota mensual | Unidades incluidas | Excedente por unidad |
| --- | --- | --- | --- |
| `piloto` (la Prueba, por omisión en altas solas, `billing_status` trial) | US$ 0 | 50 | US$ 0 |
| `inicial` (nuevo) | US$ 19 | 12 | US$ 1,50 |
| `operativo` | US$ 390 | 320 | US$ 1,30 |
| `profesional` | US$ 1.100 | 950 | US$ 1,20 |
| `corporativo` | US$ 2.900 | 2.700 | US$ 1,10 |
| `enterprise` (contrato anual, piso negociable; la cuota es mensual) | US$ 8.000 | 8.000 | US$ 1,00 |

- El **Piloto guiado** no tiene mecanismo: el operador activa el plan a mitad de cuota por 60
  días y vuelve a activarlo a mano con la cuota entera. `/admin/altas` ya no deja activar
  `piloto` (daría una Prueba gratis sin vencimiento).
- La regla comercial vieja (excedente <= precio por unidad del plan propio) cae a propósito.
  La reemplazan dos invariantes que fija `billing-plans.test.ts`: la cuota por unidad incluida
  baja de plan en plan (US$ 1,583 > US$ 1,219 > US$ 1,158 > US$ 1,074 > US$ 1,000) y el excedente de un plan no
  pasa de la cuota por unidad del anterior.
- **Migración 0055** (`neon/migrations/0055_planes_por_unidades.sql`, A MANO, los deploys no
  la corren): permite `inicial` en `tenants_plan_check`, baja el `DEFAULT` de
  `tenants.included_claims` a 50 y agrega `cases.waba_propia boolean not null default
  false` (la marca la pone el webhook al crear el caso; sin la columna `/api/health` da 503
  y ningún caso se crea; el caso que abre un `siniestro_nuevo` la toma de `raw_payload` del
  mensaje que se parte, no del caso de antes: el cliente pudo cambiar de número). Se aplica antes del deploy, con `node scripts/migrate.mjs --apply`,
  en este orden: QA (`ep-wispy-flower`), la base viva (`ep-proud-resonance`, la de
  `DATABASE_URL` del CI), la rama `production` de Veltra (`STAGING_DATABASE_URL`) y por último
  `node scripts/migrar-bases.mjs --env prd` (control, ensayo y cada `t_<hex>` lista; confirmar
  el ensayo con `--env ensayo --dry`). Cada base se identifica por su canal de casos, no por
  el nombre.
- Los inquilinos existentes y las facturas congeladas no cambian de términos: cada uno guarda
  los suyos. El cambio de pesos sí mueve el mes en curso de todos (no está congelado) y sólo
  cambia plata donde ya había excedente. La cubeta de WABA propia (0,8) queda inerte mientras
  `ALTA_WABA_PROPIA` y `ALTA_APP_PROPIA` sigan apagadas.
- **Pendientes, sin implementar ni gancho en el código:** una prueba por CUIT; tope global de
  15 pruebas activas; corte de la Prueba a los 50 casos; regla de uso razonable (20 mensajes
  cuentan doble); aviso automático para el Piloto guiado; peso de web; si la etiqueta de
  `piloto` pasa de «Piloto» a «Prueba».

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
0015, fail-open); `RATE_LIMIT_PROVIDER` forces postgres/memory.

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

  Nota posterior (2026-10-07): `.gitignore` ahora también cubre
  `claimmix-506321-*.json`, el nombre con que Google baja la clave de este
  proyecto: la descarga sin renombrar ya no entra con un `git add -A`.
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
- **Dominio propio**: corre en `claimmix.vercel.app` (prd) y `claimmix-dev.vercel.app`
  (dev). Hace falta comprar y
  configurar uno.
- **VPS**: no aplica, y esta vez con la comprobación hecha. Volvió a preguntarse
  el 16/09/2026 —«desactivar el login por SSH con contraseña, poner otra forma de
  entrar al servidor Nginx»— y no hay tal servidor. Lo que se miró:

  | dónde se buscó | qué había |
  |---|---|
  | `~/.ssh/known_hosts` | una sola entrada, `github.com`: esta máquina nunca entró por SSH a ningún servidor |
  | `~/.ssh/config` | GitHub (dos cuentas) y los espacios de SAP BAS por túnel a `127.0.0.1`. Nada más |
  | servicios y puertos de esta PC | sin `sshd`, sin `nginx`, nada escuchando en 22, 80 ni 443 |
  | Compute Engine, en los cuatro proyectos de GCP | la API nunca se habilitó en ninguno: jamás hubo una máquina |
  | DNS | `claimmix.vercel.app` resuelve a IP anycast de Vercel; no hay dominio propio apuntando a ningún lado |
  | la respuesta de producción | `Server: Vercel`. No hay nginx delante |

  Quien retome esto: no hay `sshd_config` que editar ni puerto que cerrar. La
  superficie es Vercel, Neon y GCP, y se cierra en la consola de cada uno.

- **El único login por contraseña que queda es el del producto**, y hoy no lo usa
  casi nadie. Medido contra producción el 16/09/2026:

  | rol | usuarios | con Google | con contraseña |
  |---|---|---|---|
  | `analyst` | 3 | 3 | 0 |
  | `admin` | 2 | 2 | 1 |
  | `specialist` | 1 | 0 | 0 |

  O sea: las cinco cuentas que entran ya entran con Google, y una sola —un
  admin— conserva además una contraseña. El `specialist` no tiene ninguna de las
  dos porque nunca entra: existe para recibir el aviso de derivación.

  ⛔ **Apagar `emailAndPassword` no dejaría a nadie afuera, pero rompe las
  pruebas.** `tests/e2e/auth.setup.ts` y los tests de integración entran por el
  formulario con `PLAYWRIGHT_TEST_PASSWORD` e `INTEGRATION_LOGIN_PASSWORD`, a
  propósito: si el login se rompe, tienen que romperse ellos. Apagarlo de un
  lado deja la suite sin forma de entrar. Es una decisión, no un arreglo, y por
  eso queda acá y no en un PR.
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

  (28/09: con E10, cada aseguradora carga su propia lista de avisos en
  /configuracion, `tenants.specialist_alert_emails`. `SPECIALIST_ALERT_EMAILS`
  pasa a ser sólo el respaldo del tenant principal, antes de caer a los
  roles.)

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
`cleanup:cases` se borró (G9): borraba todos los casos del inquilino de la
base viva, y no servía para esto.

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

~~**Pendiente, y es una decisión de producto, no un defecto:** `renderConflict`
de WhatsApp muestra los valores del conflicto **sin enmascarar**~~ ✅ **HECHO
después:** el enmascarado se mudó a una sola función que corre en los dos lados
(`src/server/confirmations/messenger.ts:217-222,388-404`), así que el DNI entero
ya no sale por WhatsApp cuando el redactor está apagado.

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
- ~~**`renderConflict` de WhatsApp muestra los valores sin enmascarar**~~ ✅
  **HECHO después.** Sale enmascarado, con la misma función que el prompt
  (`src/server/confirmations/messenger.ts:217-222`).
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

- **Las reglas de semgrep** se siguen bajando del registro en cada corrida. Se
  pineó la HERRAMIENTA, que es por donde se ejecuta código, y después se cambió
  `--config=auto` por `p/typescript`, `p/owasp-top-ten` y `p/secrets` con
  `--metrics=off`, de modo que ya no le manda la URL del repositorio. Fijar el
  conjunto de reglas pide vendorearlo y cambia qué reglas corren.
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
- ~~**`renderConflict` de WhatsApp muestra los valores sin enmascarar**~~ ✅
  **HECHO.** `enmascarar` se sacó de `conflictosParaElRedactor` y ahora corre
  también en `renderConflict` (`src/server/confirmations/messenger.ts:217-222`),
  que es el texto que sale cuando el redactor está apagado o falla.
- ~~**Un adjunto rechazado por tamaño: la fila ya está y ahora se ve; falta
  avisarle al asegurado.**~~ ✅ **HECHO.** La señal `unArchivoNoEntro` entra a
  `src/core/case/reply-decision.ts` y la decisión `avisar-que-no-entro` sale sólo
  con el pedido en espera, aunque el agente haya decidido esperar, y nunca en un
  caso grave. La plantilla `attachment_too_large` (mail y WhatsApp) es texto
  fijo, sin redactor: el redactor lee «ahí va la foto» y agradece una foto que
  no entró. Cuando el pedido sale igual, la frase va al pie, fuera del redactor
  (`archivoQueNoEntro`, como `conPie` y `SI_NO_FUISTE_VOS`). El «10 MB» sale de
  `MAX_ATTACHMENT_SIZE_BYTES` (`src/core/mensajes/archivo-que-no-entro.ts`), no de
  una copia. Ensayo `archivo-pesado`: una foto de `MAX_ATTACHMENT_SIZE_BYTES + 1`
  en memoria, sin fixture y sin subir nada a R2. **Sigue abierto:** el cierre, el
  conflicto (D) y la derivación no mencionan el archivo, y sólo `size_exceeded`
  se avisa: `aggregate_size_exceeded` y `content_type_not_allowed` siguen sin
  decírsele al asegurado.
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
- ~~**`page` sin tope superior** (OFFSET ilimitado) y **`q` sin largo mínimo**~~ ✅
  **HECHO**: `page` acotado en la API (#135) y en la pantalla de clientes (16/09);
  `q` exige tres caracteres en `/api/cases`.
- **`audit_log` crece 142 filas por caso** y sigue sin retención (B19 agregó la de los casos y la purga de adjuntos, y a propósito no tocó la auditoría): a 100 k casos son
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

  Nota posterior (2026-10-07): `callGemini` ya lee `cachedContentTokenCount` y los
  logs `ai.email_extraction.attempt1`/`attempt2` y `ai.extraction.attemptN` lo
  traen como `cached_tokens`. El costo todavía no descuenta lo cacheado.
- **Los índices trigram con cero escaneos sirven**: el cero es artefacto de 483
  filas, no un índice mal formado. No borrarlos.
- **El barrido de `text-slate-400` respetó sus exenciones**: las diez restantes
  son iconos. Quedaron dos afuera del criterio —una hora relativa y una equis de
  12 px— y los placeholders, que no entraron.

  Nota posterior (2026-10-07): después del barrido entraron dos textos con ese
  gris —el vacío del tablero y el «automático» del plan de trabajo— y el contador
  de los chips de filtro también lo tenía; pasaron a `slate-500`, y
  `accesibilidad-que-faltaba.test.ts` ahora recorre todo `src/app/(app)`.
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
  Medido el 07/10 en tres corridas completas: entre 16 y 19 consultas por
  corrida (12 o 13 `verificar_poliza`, entre 4 y 6 `polizas_por_dni`). En dos de
  ellas un caso llegó al tope de tres, y la tercera llamada repetía la consulta,
  así que bajar el tope a dos sólo corta repeticiones. Las herramientas se quedan: `yaAveriguado` no distingue un padrón
  vacío de una póliza inexistente ni trae los números. El tope bajó de 3 a 2:
  hasta tres llamadas en vez de cuatro.
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
- **`readable()` del ensayo** → `src/core/email/texto-legible.ts` (antes `scripts/lib/texto-legible.mjs`). Se cambió cuatro
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

    16:26:25  886336c  Production  ← el merge a main, encolado
    16:27:58  5dbf546  Preview     ← se crea el run de una rama
    16:27:59  886336c  cancelled   ← un segundo después, sin un job arrancado

Ese segundo es la prueba: no se demoró la comprobación, se la sacó de la cola
otra corrida del mismo grupo. El run cancelado no tiene ni un job registrado.

**Lo que no está establecido** es qué eventos de preview encolan y cuáles no.
De cuatro previews consecutivos —los cuatro `env=Preview`— dos ocuparon el
turno y dos terminaron `skipped` enseguida. No importa para el arreglo: lo que
hay que garantizar es que nada que no pase la guarda pueda ocupar ese lugar, y
eso no depende de entender por qué a veces sí y a veces no.

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

### 📏 Carga falla por el 2% y no siempre (2026-09-10)

El post-deploy de `99fb6b6` se puso rojo en **Carga (lectura)**: «detalle de un
caso» con 5 analistas dio **p95 510ms** contra un presupuesto de 500. Los otros
seis jobs, verdes.

Diez minutos después corrió el de `0adcfa9` —que sobre el código de la app **no
cambia nada**: workflow, docs e invariante— contra la misma base de producción:

| consulta (p95) | `99fb6b6` 1/5/20 | `0adcfa9` 1/5/20 |
|---|---|---|
| bandeja | 195 / 323 / 285 | 137 / 205 / 212 |
| búsqueda por texto | 192 / 194 / 236 | 144 / 136 / **360** |
| detalle de un caso | 387 / **510** / 409 | 276 / **262** / 287 |

No es que una consulta se haya puesto lenta: **la corrida entera fue ~40% más
lenta**, y la que la siguió pasó cómoda. El sospechoso es el arranque en frío
del compute de Neon —la primera corrida en tocar la base después de un rato lo
paga—, aunque medido está el efecto y no la causa.

O sea que un job que corta el post-deploy entero se decide por 10ms sobre 500,
y el mismo número diez minutos después es 262. Carga ya había fallado 2 veces
en las últimas 6 corridas rojas (las otras 4 son el Ensayo).

**Qué hacer con esto es una decisión, no un arreglo**, y son dos lecturas
distintas de para qué está el presupuesto:

- **Medir en régimen**: descartar las primeras consultas de cada celda y medir
  con la base caliente. Es lo que siente un analista que lleva ocho horas
  trabajando, que es de quien habla «el tablero se siente lento».
- **Dejarlo como está**: 510ms en frío es lo que espera de verdad el primero
  que entra a la mañana, y taparlo con un calentamiento es esconderlo.

Lo que **no** corresponde es subir el número a 550: eso no cambia lo que pasa,
sólo deja de avisarlo.

### 🔒 Tres parches del escaneo de seguridad (2026-09-11)

El escaneo de Claude Security del 10/09 sobre `b4f66dc` devolvió tres hallazgos
verificados, todos en el camino del mail entrante. Los tres tienen parche, y cada
parche pasó por un verificador independiente que corrió la suite y por un
investigador fresco que atacó el diff desnudo. Ninguno descansa en lectura sola:
los tres traen un test en la suite que falla en la base y pasa con el cambio.

| | qué pasaba | qué hace el parche | lo que **no** hace, a propósito |
|---|---|---|---|
| **F7** `relevance-prefilter.ts` CWE-1333 | Tres regex con retroceso cuadrático sobre el HTML del mail, sin tope. 256 kB de `<a` sin cerrar: 35 s, más que la invocación. La marca de agua no avanzaba y el mismo mail se bajaba para siempre. | Recorridos lineales con `indexOf`, idénticos a los regex sobre 1,5 M de casos. 25 MB de `<script>` en 177 ms. | No pone tope de tamaño: el primer intento lo traía y el verificador lo rechazó porque cambiaba `allow` por `skip` en mails legítimos. Tampoco anota el mensaje en `mensajes_pendientes` antes de procesar. |
| **F8** `dispatch.ts` CWE-639 | La casilla con la que contestar salía del `To:` del mail entrante, buscada con el rol dueño, y valía cualquier fila habilitada: la respuesta a un extraño podía salir por la casilla de otro inquilino, con su DKIM y su refresh token. | La cuenta resuelta tiene que ser del inquilino que despacha; si no, el fallback por `enTenant` que ya existía. | No hace el refactor de resolver la casilla por `enTenant` y tratar `to_addr` como pista. Cierra el exploit con un invariante de una línea. |
| **F9** `thread-lookup.ts` CWE-639 | Un mail se pegaba a un caso sólo por sus propios encabezados. Los casos de WhatsApp guardan el teléfono en `email_thread_id`: un número adivinable metía a un extraño en la denuncia de la víctima y lo convertía en a quien el agente contesta. | Guardia de participante en los tres caminos (el `From` tiene que ser un `from_addr` entrante o un `to_addr` saliente del caso) y `channel IN ('email','email_sim')` en la rama por `email_thread_id`. Falla cerrado. | Sigue confiando en el encabezado `From`, que es la frontera estándar del threading por mail. El «token secreto por caso» **no hace falta** (decidido el 16/09): el id del caso en el asunto ya es un UUID inadivinable, y la guardia exige que el remitente participe. El camino por `Subject` filtra por canal desde el 16/09, con test. |

**Lo que cambia para un usuario real**, y es lo único: con F9, una respuesta desde
una dirección que el caso nunca vio abre caso nuevo en vez de pegarse. Las cuatro
rutas de respuesta legítima, el ensayo (una dirección por escenario, hilo por
asunto) y WhatsApp (nunca pasa por `threadLookup`) siguen iguales.

#### Lo que el escaneo no miró

Estos tres salen de **3 de 18 componentes**. El escaneo se quedó sin cuota a mitad
de camino: 53 de 60 investigadores fallaron, el barrido entero y los 18 votos del
panel de la primera corrida. Auth/RLS, el webhook de WhatsApp, los agentes de IA,
storage, facturación y las migraciones **no los leyó nadie**. Un escaneo entero a
`medium` es el tamaño que agotó el límite dos veces; uno acotado a los 15
componentes que faltan cierra el hueco más barato. El informe con la cobertura
exacta está en `CLAUDE-SECURITY-20260910-182639/` (fuera del repo por su
`.gitignore`).

### 📉 Carga: cuatro mediciones del mismo commit, y ninguna del código (2026-09-11)

El post-deploy de `ae4fa82` (los tres parches de seguridad, #158) dio rojo en
Carga: `detalle de un caso` p95 **383 / 744 / 856 ms** con 1/5/20 analistas.
Como el margen sobre 500 es más chico que el ruido (#157), «es ruido» no
alcanzaba: había que separar varianza de regresión.

| corrida | 1 | 5 | 20 | desde |
|---|---|---|---|---|
| post-deploy | 383 | 744 | **856** | runner de GitHub |
| rerun aislado | 388 | 409 | **557** | runner de GitHub |
| `pnpm load` local | 178 | 167 | 311 | esta máquina |
| rerun 2 | 262 | 258 | 284 | runner de GitHub |

Lo que descarta el código: los tres parches no tocan el camino de lectura (F7 y
F9 son intake, F8 es envío); la base tiene el mismo tamaño (483 casos, cero
creados hoy: el ensayo limpia lo suyo); y la columna de **1 analista** es
estable en todas (262–388). Si la consulta se hubiera encarecido, esa columna se
movería. Lo que explota es 5 y 20 —contención—, y consultas que nadie tocó
saltan al azar: `búsqueda por texto` dio 448 con 5 analistas en el rerun 1 y
357 con 20 en el rerun 2, cuando siempre da ~200.

Conclusión: el gate mide el camino runner → Neon bajo 20 concurrentes, no el
deploy. Regla que se siguió: dos reruns como máximo y **el número no se toca**
—subirlo a 550 deja de avisar, no cambia lo que pasa—. La decisión de fondo
sigue siendo la de #157, y sigue siendo tuya.

### ✅ Cuatro decisiones tomadas (2026-09-11)

Delegadas con «tomá vos las decisiones». Las cuatro, con su porqué:

| decisión | qué se hizo |
|---|---|
| **Carga: el presupuesto de 500 ms** | Ni subir el número ni aceptar el rojo al azar. **Una medición no es un veredicto**: si una celda pasa el presupuesto se mide otra vez y falla sólo si se repite (`medirCelda`, con test). Las dos mediciones van al reporte y la celda repetida lleva `*` en la tabla. Una celda con consultas falladas no se repite: eso no es ruido. |
| **`viewer`** | «Mira todo y no cambia nada». El código ya lo decía (`require-role.ts`, `CASE_EDITOR_ROLES`, el padrón negado igual que a `analyst`); ahora está escrito en `roles.ts` para que nadie lo reabra. La pantalla del caso queda como está. |
| **`achicar-payloads --apply`** | Aplicado: **356 filas, 12.808 → 2.518 kB**. Nadie en `src/` lee `body.data` de `raw_payload` y el arreglo hacia adelante llevaba días en producción; los bytes base64 eran una copia que nada consultaba. |
| **El escaneo de los 15 componentes** | Cerrado: las tres tandas corrieron enteras entre el 15 y el 16/09 (74, 134 y 128 archivos leídos de 74, 134 y 129), con 0, 5 y 1 hallazgos; los de la tanda 2 están parchados en #178 y el de la 3 en este mismo PR. Lo que dejaron sin veredicto, en «Waiting on you». |

### 🪪 Una póliza vencida se deriva sola, sin esperar a que el modelo pregunte (2026-09-16)

El ensayo `poliza-vencida` pasó de verde a rojo a las 19:14 con el mismo código:
7 de 7 corridas después (tres intentos del post-deploy de `5da01aa` y una local),
el agente le pedía fotos de los daños y la licencia a alguien cuya cobertura
venció en 2020, y el caso quedaba en `confirmacion_pendiente` en vez de
`requiere_especialista`.

**La causa no era el modelo: era que dependíamos de él.** Desde #130 el worker le
sirve al agente lo que ya averiguó («la póliza que dio existe en el padrón»),
pero no le decía que había vencido — `PolicyMatch` no traía `end_date`. Que la
derivación ocurriera dependía de que el modelo igual llamara a `verificar_poliza`.
Hasta esa tarde lo hacía; desde esa tarde, no. Una decisión de producto que el
worker ya tenía resuelta estaba en manos de la varianza del modelo.

**Lo que cambia.** La regla de vigencia (`status === "active"` y `end_date` no
pasada) vive una sola vez en `src/core/case/poliza-vigente.ts`; la usan
`verificar_poliza`, `polizas_por_dni` y el worker. `mirarPolizas` decide
`derivar` cuando la persona dio un número, coincide con lo encontrado y ninguna
de sus pólizas está en pie; `orchestratePostExtraction` lo lleva por el MISMO
`escalate` que la severidad — mismo estado, mismo mensaje, mismo aviso al
especialista, sin gastar ninguna llamada al modelo. Y la línea servida al prompt
ahora dice «la póliza no está vigente: venció el 2020-03-01» cuando corresponde,
para el caso que la derivación determinista no cubre (llegaron por DNI, sin
número).

Verificado: 17 tests nuevos (regla pura, texto servido, derivación de punta a
punta con un solo mensaje y sin pedido de documentación), y el ensayo:
`poliza-vencida` deriva, `busca-la-poliza` (póliza vigente) sigue igual.

**Los otros dos rojos del mismo post-deploy** —`choque-completo` turno 4 sin
respuesta y `mail-que-no-coincide-con-el-padron` sin los dos nombres— no se
repitieron en las dos corridas: son timeouts del proveedor y varianza, y la
intersección de las dos corridas ya los filtra.

### 🖥️ La bandeja, mirada al ancho en que se usa (2026-09-16)

Tres defectos que ninguna verificación iba a encontrar, porque todas miran
datos y estos se ven en la pantalla. La bandeja mide exactamente el alto de la
ventana, así que los 24 px de `pb-6` eran TODO el aire entre el paginador y el
borde; la barra lateral se quedaba con 232 px fijos; y la tabla era
`w-full table-auto` sin piso, así que el navegador estrujaba las columnas en
vez de comprometerse a un ancho — severidad y asignación quedaban ilegibles y
no había ninguna barra para llegar a ellas, porque no había nada que scrollear.

Ahora: `pb-8` (con las dos pantallas de carga copiando el valor, o el esqueleto
salta al hidratar), barra lateral de 208 px, y `min-w-[1080px]` en la tabla. El
contenedor de la lista ya era `overflow-auto`: con un piso real aparece la
barra horizontal. Por encima de 1080 manda `w-full` y nada cambia.

⛔ **No poner `overflow-x-auto` en el `<div role="region">` de `CasesTable`.**
`overflow-x: auto` obliga a `overflow-y: auto`, ese div pasa a ser el scroller,
y vuelve el bug de los scrollers anidados que el comentario de ahí existe para
evitar — además de romper el `sticky top-0` del encabezado.

**La primera columna es la fecha del siniestro, no el número del caso.** El
enlace se mudó con ella: la celda de la fecha es el `<a href>`, así que
Ctrl+click, botón del medio y «copiar dirección del enlace» siguen andando. El
dato sale de `extracted_fields` por subconsulta correlacionada, igual que la
póliza y el asegurado; una sola consulta. La clave es `accident_date`, la
canónica — `fecha_siniestro` es el alias en español, y en la base están las dos
con el mismo valor (159 casos contra 153, y ninguno tiene sólo el alias).

Medido antes de elegir la posición: de las 160 denuncias reales, **157 tienen
fecha**; de los 330 casos que no son denuncia, 2. La columna está poblada donde
importa y vacía donde no hay siniestro que fechar.

**Y simular un mail dejó de pedir el tipo de siniestro.** No era una pista para
el modelo: los `email_sim` pasan por `runEmailExtractionWorker`, cuyo prompt le
pide al modelo clasificar `claim_type` solo, y el resultado pisa lo sembrado.
Lo que el campo sí hacía era meter la palabra elegida en el asunto —que después
se interpola en el prompt, así que elegir «granizo» y pegar un choque le ponía
las dos cosas delante— y hacer que `cargarLoDelPrompt` cargara los ejemplos del
tipo equivocado. Los escenarios precargados siguen trayendo el suyo.

**Lo que no se pudo verificar acá, y cómo se verifica:** las pantallas privadas
piden sesión, y las credenciales de Playwright (`PLAYWRIGHT_TEST_EMAIL` /
`PLAYWRIGHT_TEST_PASSWORD`) viven sólo en CI. Así que el arreglo se fijó con un
test que MIDE en vez de mirar: `tests/e2e/la-bandeja-respira-y-scrollea.spec.ts`
comprueba el hueco en píxeles bajo la tarjeta a 1280×800 y que el contenedor de
la lista tenga de verdad a dónde scrollear. Una captura no habría servido: lo
que falla acá es aritmética de layout.

### 🔔 «Sin registro» en el timbre: lo que puede y lo que no puede significar (2026-09-18)

El post-deploy de `5e63300` salió rojo en `Tocar el timbre`, sólo en la rama de
mail, con el caso creado, 18 campos extraídos y ninguna respuesta:

```
   ✓ se creó el caso — e3c06ece-89f8-4f50-bd63-847a3d27de09
   ✓ extrajo los datos — 18 campo(s)
   ✓ no lo tomó por spam — info_faltante
   ✗ el agente contestó
   ✗ y la respuesta NO salió del edificio — sin registro
```

La re-corrida dio los siete jobs en verde sin tocar una línea, y el commit
siguiente también, así que como suceso es varianza. Lo que queda escrito acá es
lo otro: qué puede significar ese «sin registro», porque se investigó entero y
la próxima vez no hay que volver a hacerlo.

**«Sin registro» sólo puede ser cero filas.** `outbound_messages.status` tiene
`.default("queued")` (`src/lib/db/schema/core.ts:266`), así que no existe la
fila a medio escribir sin estado: o hay respuesta compuesta, o no hay fila.

**El `info_faltante` de la línea de arriba NO lo puso el agente.** Lo pone la
extracción: `status-after-extraction.ts:63` devuelve `info_faltante` en cuanto
falta un campo obligatorio, y `src/server/worker/extract.ts:790` lo escribe.
O sea que la extracción llegó al final, y lo que no dejó nada es la etapa del
agente.

**La rama silenciosa del orquestador no es candidata, y conviene saberlo.**
`orchestrate.ts:737` fija el estado y no escribe ningún mensaje —es correcto: no
se vuelve a preguntar lo mismo—, pero para entrar ahí hace falta `askOnHold`, y
`elPedidoQuedaEnEspera` es `(yaSePidio || elAgenteEspera) && …`
(`src/core/case/reply-decision.ts:70-72`). En un caso al que nadie le escribió
todavía las dos son falsas. El timbre crea un caso nuevo en cada corrida, así
que por ahí no pasa. Un silencio deliberado y una invocación cortada se ven
igual en el reporte; acá se distinguen por el código, no por el síntoma.

**Queda una sola explicación: la invocación no llegó al mensajero.** Es el
incidente que ya está contado en `src/server/email/gmail/gmail-poller.ts:193-205`
(08/09). El mail paga un salto más que WhatsApp: el poller le pasa el trabajo a
`/api/worker/extract`, que es otra invocación con su propio techo de 60 s
(`vercel.json:19`) y su propio arranque en frío, mientras que WhatsApp resuelve
`runIntakeAgent` adentro del `after()` de su propio webhook. Y el mail corre
primero, que es cuando la función está más fría. La asimetría es
infraestructural, no del agente: las dos ramas esperan lo mismo.

**Lo que esto NO arregla, y por eso no se tocó el camino del mail:** las tres
llamadas al modelo —extracción, deliberación y redacción— no tienen timeout de
proveedor por debajo del techo de la función. Un modelo que no contesta nunca
deja al asegurado esperando, y eso no se arregla esperándolo más tiempo desde el
guión. Lo que cubre ese caso es `barrer-trabados.yml`, que escala lo trabado
cada quince minutos.

**Lo que sí se arregló, que era del reporte y no del producto:** las dos cruces
de arriba contaban el mismo hecho dos veces y el resumen decía «2 problema(s)»
donde hay uno (#223), y las dos lecturas del guión no seguían la regla del
archivo — `replyFor` contaba vueltas en vez de mirar el reloj, y ni ella ni
`fieldsFor` filtraban por `tenant_id` (#224).

### ⏱️ El webhook de WhatsApp moría a los 60 s (2026-09-21)

El 21/09 a las 14:47 el log de producción mostró cuatro veces
`POST /api/webhooks/whatsapp 200 … Task timed out after 60 seconds`. El 200 ya
había salido; lo que se cortaba era el `after()`, que corre con el techo de la
ruta contado desde que entra el pedido. Adentro del `after()` van, en fila, la
corrida del mensaje que llegó, el barrido de trabados y hasta dos retomados, y
cada una puede llamar al modelo varias veces con 30 s de plazo. En 60 s no
entraban.

**Qué cambió:**

- El techo pasa a 300 s y vive en cada ruta que corre al agente
  (`export const maxDuration = 300`): los dos webhooks, los dos crons,
  `worker/extract` y `cases/[id]/re-analyze`. `vercel.json` ya no tiene bloque
  `functions`, porque una entrada ahí pisaría en silencio el número que el
  webhook usa para su reloj.
- El webhook y el cron de trabados le pasan a `retomarExtraccionesPendientes`
  cuándo se corta la invocación (`hasta`), y el barrido no empieza un retomado
  si quedan menos de `MINIMO_PARA_RETOMAR_MS` (120 s). Cuando corta, deja
  `retomar_pendientes.sin_tiempo` en el log.
- La reserva de extracción pasa de 3 a 5 min (`RESERVA_DE_EXTRACCION_MS`): una
  reserva más corta que la función deja que otra corrida tome el caso con la
  primera todavía viva. `tests/unit/techo-de-las-funciones.test.ts` exige que
  ninguna ruta del agente dure más que la reserva y que `vercel.json` no vuelva a
  tener `functions`.
- `barrer-trabados.yml` espera 320 s por intento (antes 60) y el job tiene 17
  min, así curl ve el 504 de Vercel en vez de abandonar un barrido vivo.

**Lo que no cambió:** los 40 s de presupuesto de la corrida, los 30 s de plazo
del modelo, el techo de 55 s de la variable, la espera del mail y los 500 ms de
Carga. Tampoco cuesta plata: en Hobby con Fluid el techo por defecto ya era 300.

### 🧹 Los barridos, la corrida muerta y el 429 (2026-09-21)

Lo que la nota de arriba dejó «visto y sin arreglar», más las dos decisiones
sobre el 429 que esperaban. Una línea por arreglo:

- **Retomar filtra por estado.** `ESTADOS_DE_ARRANQUE`
  (`src/core/case/estados-de-arranque.ts`) es la lista única de estados desde
  los que el worker arranca; el barrido, `marcarPendientes` y el worker la usan.
  Un `escalado` pendiente ya no ocupa lugar ni escribe auditoría en cada barrido.
- **Trabados no se come a los pendientes.** `reap-stuck` saltea los casos con
  `extraction_pending` y mide la antigüedad con `coalesce(updated_at, created_at)`.
- **Los dos crons ya no coinciden.** El de Vercel pasa a las 04:07. Y si igual
  se cruzan, la corrida que encuentra una reserva vencida sin marca la hereda y,
  antes de contestar, mira si ya salió una respuesta al último mensaje que la
  corrida muerta vio (`src/server/confirmations/ya-contestado.ts`). Si salió, no
  manda nada.
- **Los mails dejan de volver a la cola por el freno.** Un caso reencolado sin
  reserva viva ya no cuenta como «mail anterior en curso» en
  `simulation-throttle`.
- **Un lote de Meta corre una vez por pedido.** El webhook junta los casos del
  lote, marca pendientes todos menos el primero antes de empezar, y los corre en
  fila. Si el reloj no alcanza para el siguiente, corta y deja
  `webhooks_whatsapp.sin_tiempo`; los que quedaron los toma el barrido.
- **Una corrida muerta no manda la respuesta dos veces.** Ver el tercer punto.
  Y si la corrida heredada se queda sin reloj o reencola por un 429, devuelve la
  reserva vencida como la encontró, para que la próxima siga sabiendo que es
  heredada.
- **Un 429 de extracción es transitorio, como un TIMEOUT.** Vuelve a la cola con
  la marca puesta y no escala hasta el tercer intento. No se redespacha al
  instante: lo retoma el barrido, así un cupo agotado no quema los tres intentos
  en segundos. *Ampliado 2026-09-23:* un 429 o un TIMEOUT del reconocedor de
  negativas entra por la misma puerta y con el mismo tope. Ver «El parte que un
  429 daba por no rechazado». *Enmendado 2026-10-15:* el barrido sólo corría
  con tráfico de otro caso o con el cron diario, y en WhatsApp un caso cortado
  por un TIMEOUT de Gemini 3.8 esperó 5 minutos y otro quedó sin respuesta. Al
  soltar la reserva, el worker encola ahora el flujo durable
  `src/workflows/retomar-tras-corte.ts`, que espera 45 s y retoma ese caso con
  los mismos predicados del barrido (`retomarExtraccionesPendientes` con
  `caseId`, sin los dos minutos de espera). Sin reintentos del SDK, y el tope de
  tres intentos no cambia. Si el flujo no se puede encolar, se anota
  `retomar_pendientes.retoma_no_programada` y queda el barrido de siempre.
- **Un 429 en la deliberación queda a la vista.** `deliberate.ts` sigue
  cayendo a la plantilla, pero escribe `agent.deliberation_failed` en la
  auditoría con el estado y el código del proveedor. *Enmendado 2026-09-22:*
  si el último mensaje traía una pregunta, se contesta igual en la misma
  vuelta. Ver «La pregunta que un 429 dejaba sin respuesta».

**Riesgos que quedan, sabidos:**

- Si matan la corrida entre el envío por WhatsApp y la fila del registro, la
  heredada lo manda otra vez. Cerrarlo pide escribir la fila antes de enviar, y
  eso pide una migración.
- ~~La heredada se pierde en dos caminos: cuando el freno del mail difiere antes
  de tomar la reserva, y cuando falla el redespacho. Esa corrida contesta sin
  mirar si ya se contestó.~~ ✅ **HECHO 2026-10-07.** El freno marca pendiente
  sólo si, cuando arrancó la corrida, la reserva estaba libre o viva —lo que
  habría hecho al pedirla—; una vencida queda sin marca y la levanta el barrido
  como heredada. El redespacho que no llegó marca sólo si nadie tomó el caso
  desde que se soltó: quien lo tenga ya leyó el mensaje. Lo prueba
  `tests/unit/server/worker/extract.reserva-heredada.test.ts`; el ensayo no
  fuerza este camino.
- Un 429 de cupo diario gasta los tres intentos a lo largo de tres barridos y
  escala. Aceptado.
- `reap-stuck` saltea los pendientes, así que un caso que retomar difiere para
  siempre nunca escala.
- Un lote con varios remitentes comparte los 300 s de una sola invocación; los
  que no entran esperan al barrido, dos minutos después.
- Sin deliberación, una pregunta se reconoce sólo por los signos `?` y `¿`. Un
  «cuánto tarda» sin signos, un `?` pegado a una letra («tarda?Necesito») o
  una pregunta más allá de los primeros 4.000 caracteres quedan sin contestar,
  como antes. Un «¿Viste?» se toma por pregunta y reenvía el pedido que ya
  estaba en pie, con la frase honesta.
- Una pregunta que llega después del cierre, o en la vuelta en que sale un
  conflicto, sigue sin respuesta propia. Son huecos anteriores y no se tocaron.
  *Enmendado 2026-10-07:* la vuelta del conflicto ya contesta: la rama D manda
  `question` y el piso del mail y el de WhatsApp suman la frase honesta. La
  pregunta que llega después del cierre sigue igual.

### ✍️ Lo que el ensayo dejó ver de la redacción (2026-09-21)

Las 14 conversaciones pasaban todas las verificaciones y tres respuestas
sonaban mal. Todo está en `src/server/ai/compose-reply.ts`:

- **Un dato que ya entendimos se confirma, no se vuelve a pedir.** El brief
  decía «pedir corrección sólo si no es correcto», y el modelo lo leía como
  «pedir más precisión»: a Cecilia, que escribió «esta mañana», le citó
  «nos dijiste "mañana"» y le pidió la hora exacta; a Diego le puso «Lugar del
  siniestro (si no fue en Villa Mitre, correginos)». Ahora el brief pide
  preguntar si el valor es correcto, citado tal cual, sin pedir más precisión y
  sin atribuirle a la persona palabras que no escribió. La guarda que exige
  cada ítem de la lista buscaba la primera palabra del rótulo («lugar»,
  «hora»); citar el valor («¿fue en Villa Mitre?») no la dice, y en el primer
  ensayo con el brief nuevo el mensaje caía a la plantilla dos corridas de dos.
  Ahora citar el valor que ya tenemos también cuenta como pedirlo.
- **La respuesta a una pregunta va primero.** Diego preguntó cuánto tardaba y
  la respuesta llegó al final, abajo de la lista repetida entera. Pedirlo al
  final del brief no alcanzó: la pregunta ahora va pegada a lo que hay que
  decir, antes de la lista, con «empezá el mensaje contestándola».
- **El especialista no tiene género.** «Él se va a comunicar» salió en
  `poliza-vencida`. El brief lo pide y una guarda nueva
  (`escalation_gendered`) rechaza el mensaje y lo hace reescribir.

«¿Podrías ser más preciso?» no era un error: en condicional, vos y tú se
conjugan igual.

Visto y sin arreglar: cuando la deliberación falla (un 429 o un timeout de
Gemini), el orquestador arma el pedido solo y pide los primeros cinco
faltantes. Si el agente había pedido menos, la lista cambia, la guarda de no
repetir no la frena, y a un «ok» le contesta la lista entera: `silencio` dio
rojo así dos veces el 21/09, siempre con `deliberate.failed` en el log. Hay un
test que dice que un faltante nuevo en la lista merece mensaje, así que es una
decisión, no un arreglo de una línea.

### 🤐 El caso que contestó y quedó mudo (2026-09-22)

El post-deploy de QA dio rojo en `choque-completo` turno 4, en las dos
corridas: «esperaba 1 respuesta(s), hubo 0». Le habíamos pedido dos cosas —el
parte amistoso y la licencia—, la persona contestó una («no completamos ningún
parte amistoso, el otro conductor no quiso»), `resolveDeclinedDocs` la cerró en
la base, y el agente —que en su resumen seguía viendo los dos pedidos
abiertos— deliberó `intent: "wait"`. Ese «espero» solo apagaba la respuesta y
también la red de contención: la rama de acuse queda suprimida cuando el pedido
está en espera, así que no salía nada. La mitad del pedido que faltaba no se
volvía a pedir nunca y el caso se moría por abandono a los 14 días.

El fondo era que ningún dato de código registraba «la persona contestó lo que
le pedimos». Los dos resolutores escribían en la base y devolvían `void`: la
negativa cerraba el pedido y al mismo tiempo desaparecía como motivo para
hablar. Ahora los dos devuelven lo que cerraron, y eso entra a la decisión como
una octava señal, `nosContestoElPedido`, con el mismo argumento que ya estaba
escrito para el archivo que llega: fueron, lo miraron y contestaron.

No es regresión de la redacción: el diff anterior sólo tocó `compose-reply.ts`,
que corre después de la decisión y no puede cambiar `plan.intent`. Era un pozo
viejo que el modelo destapaba a veces; la corrida verde anterior y las dos rojas
son tiradas del mismo dado.

Dos cosas que el diagnóstico costó y conviene no repetir: el
`fsm_transition_skipped {to: "listo"}` del log es ruido estructural
—`estadoTrasExtraer` usa la palabra del vocabulario simulado para decir «no
falta nada» y la FSM la frena siempre—, y el `missing_fields_count` del worker
no conoce `missing_docs` ni `claim_field_confirmations`, así que un 0 ahí no
significa que no quede nada por pedir.

### ❓ La pregunta que un 429 dejaba sin respuesta (2026-09-22)

El ensayo `pregunta` dio rojo en el turno 2: la persona preguntó «¿cuánto
suele tardar esto?», la deliberación cayó por un 429 (`RESOURCE_EXHAUSTED`) y
no salió nada. Sin plan, `nosPreguntoAlgo` era siempre falso, y con el pedido
ya en pie `elPedidoQuedaEnEspera` callaba el caso.

- **Sin plan, la pregunta sale del mensaje.** `laPreguntaDelMensaje`
  (`src/core/mensajes/pregunta.ts`) la toma sólo por los signos `?` y `¿`, sin
  las URLs, con cuatro letras o más y hasta 400 caracteres. Con plan, manda el
  plan y el detector no se usa.
- **Sólo mira lo que escribió la persona, y sólo el principio.** Lee los
  primeros 4.000 caracteres, el tope por mensaje del extractor: la búsqueda es
  cuadrática en un tramo sin puntuación y un mail de un mega trababa el worker
  minutos. Corta la cita, también la de Outlook y Hotmail (guiones bajos, «De:»
  y «Enviado:», sin `>`), que traía nuestra propia pregunta, y la firma («--»),
  y descarta el pie de «¿necesitás imprimir este correo?»: con un «?» fijo,
  cada «gracias» de esa persona reenviaba el pedido. Esos cortes no van en
  `stripQuotedReply`: la firma trae nombre y teléfono, y un reenvío desde
  Outlook trae el siniestro debajo del mismo encabezado; el extractor necesita
  los dos.
- **Se contesta en la misma vuelta.** Sale el pedido que ya estaba en pie, sin
  alargarlo (#257 sigue valiendo), o el cierre si no falta nada. El turno no se
  reintenta ni se difiere.
- **La frase honesta vive en el piso, una vez.** `conRespuestaPendiente` la
  agrega al piso de WhatsApp (pedido y cierre) y la plantilla de cierre por
  mail la trae cuando hay pregunta, como ya la traía la de datos faltantes. Con
  el redactor apagado o caído, el piso es lo que sale.
- **La pregunta entra al redactor sin números enteros.** Ya no viene del
  resumen del agente sino del mensaje crudo, así que pasa por
  `sinNumerosEnteros` antes del prompt. No se anota en la auditoría ni en los
  logs.

El ensayo no puede forzar un 429 de la deliberación: este camino lo cubren
sólo los tests unitarios, en los dos canales.

### 🧾 El parte que un 429 daba por no rechazado (2026-09-23)

El ensayo `mail-completo` dio rojo en el turno 2 del 23/09. La persona escribió
que no habían completado ningún parte amistoso, el reconocedor de negativas
(`identifyDeclined`) cayó por un 429 y su catch devolvió `[]`.
`resolveDeclinedDocs` leyó eso como «no negó nada»: el turno terminó callado y
`parte_amistoso` quedó pedido.

- **Un 429 o un TIMEOUT del reconocedor devuelven el turno a la cola.**
  `identifyDeclined` relanza, el error sube por `orchestratePostExtraction` y lo
  agarra el catch del worker, el mismo de la extracción: marca pendiente, suma
  un intento y lo levanta el barrido. No se contesta, no se delibera y no se
  cierra nada.
- **Por qué no se sigue sin el dato, como con la pregunta.** Allá el piso es
  honesto: se contesta el pedido que estaba en pie. Acá seguir sin el
  reconocedor es afirmar algo falso, que la persona no negó nada, y volver a
  pedirle un papel que ya dijo que no existe.
- **Qué cuenta como pasajero.** `GeminiExtractionError` con `TIMEOUT` o 429:
  `esPasajero`, al lado de `errMeta` en `src/server/ai/gemini-extractor.ts`, y
  es el mismo predicado en el catch del worker y en el reconocedor. Un 400, un
  JSON inválido o cualquier otro error siguen como antes: se loguean y el turno
  sigue sin negativas. `documents.decline_identify_failed` y
  `documents.decline_check_failed` ahora llevan `error_name`, `status` y `code`,
  sin el mensaje. `errMeta` lee el `code` de la causa y, si no hay, el de arriba:
  así un `NeonDbError` sin envolver sigue diciendo su código de Postgres.
- **Cuándo se sigue sin él.** Si el turno no se puede retomar, relanzar lo
  mata: con la derivación ya mandada (severidad alta o póliza a derivar), con
  la corrida heredada ya contestada, o con el caso en un estado del que el
  worker no arranca (`listo`, `requiere_especialista`). El worker lo avisa con
  `sePuedeRetomar: puedeArrancar(newStatus)`; sin el aviso, se sigue con `[]`.
  En el turno 2 real el caso ya está en `info_faltante` o
  `confirmacion_pendiente`, así que sí vuelve a la cola.
- **El tope es el de la extracción.** Mismo contador `intentos_de_extraccion`,
  tres de por vida. Agotado, el caso escala por `provider_error` con el estado
  del proveedor en el registro. Antes ese turno quedaba mudo; ahora queda a la
  vista.
- **Qué rehace la retoma.** Vuelve a extraer (se paga otra llamada), a escribir
  el caso con los mismos valores y a pasar por el alta de documentos y el
  contacto, que son idempotentes. Lo que no lo es corre después del
  reconocedor: `resolveAnsweredConfirmations`, que consume la señal de la
  confirmación, y `reconcileAttachments`, que gasta una de las tres miradas de
  cada adjunto. Así la retoma encuentra las confirmaciones intactas y no mira
  dos veces un archivo por el mismo mensaje. Efecto de ese orden con el
  reconocedor sano: le llegan también los pedidos que un adjunto de este mismo
  mensaje va a cerrar, y el adjunto ya no se compara con un papel negado.
- **Queda afuera `identifyDocument`.** Un 429 al mirar un adjunto sigue
  leyéndose como «no es ninguno de los pedidos», y esa mirada cuenta.
- **Un documento no es una duda.** El `pnpm check` del 23/09 mostró otra puerta
  en `choque-completo`, turno 4: la negativa se reconoció y el parte quedó
  negado, pero el extractor leyó la misma frase como `parte_amistoso = "no"` a
  confianza media, `collectConfirmableFields` lo tomó como duda y el piso sin
  plan le volvió a pedir el papel. Ahora un documento no entra nunca por las
  confirmaciones: se pide sólo por `missing_docs`, que sabe si llegó y si se
  negó. El ensayo lo vigila con `noAsked: ["parte_amistoso"]` en ese turno y en
  el 2 de `mail-completo`.
- **Que no haya parte no es motivo para derivar.** Sin la duda fantasma la
  lista quedó vacía y la deliberación derivó el caso a un especialista en 3 de
  3 ensayos: leyó «el otro conductor no quiso» como algo que excede el trámite
  (criterio 6). El prompt ahora dice que un papel que no existe es lo más común
  en un choque y que, sin nada más pendiente, se elige `acknowledge`.
  `choque-completo` exige `status: "listo_para_core"` al final, como decía su
  descripción y nadie verificaba.

El ensayo no puede forzar un 429 del reconocedor: este camino lo cubren sólo
los tests unitarios, en los dos canales, con la retoma incluida.

### 🗓️ Lo que ya entendimos, dicho como lo diría una persona (2026-09-22)

El ensayo del 22/09 mandó cuatro frases con el valor de la base tal cual:
«¿…la fecha del siniestro fue 2026-09-22?», «no hubo personas lastimadas
(null)», «(false)» y «la hora aproximada fue "tarde"». El extractor escribe
`"null"` y `"false"` como texto, y un texto no vacío pasaba por valor; la fecha
iba en ISO; y el prompt del redactor pedía citar el valor «tal cual» y entre
comillas.

- **Se traduce una vez, en `buildAskList`.** `valorLegible`
  (`src/core/mensajes/valor-legible.ts`) dice la fecha como «22 de septiembre»
  (con año si no es el de hoy, en hora argentina y sin correr el día), los
  booleanos como sí o no, la gravedad de los heridos como sí o no, y el tipo con
  su nombre en castellano. Lo demás sale igual. De ahí lo toman el agente, el
  redactor, su control de campos y los dos pisos.
- **La base no cambia.** `claim_field_confirmations.suggested_value` y los campos
  extraídos siguen con el valor crudo. Sólo cambia lo que se muestra.
- **Lo que no se puede decir se pide, no se confirma.** `null`, `undefined`, el
  vacío, el tipo `other` o uno desconocido, una fecha ISO que no existe y
  cualquier documento («si» sólo dice que el extractor lo nombró) quedan fuera
  de `knownValues`: el campo sale como pedido. `valuesWeHold` ya no toma un
  `"null"` por valor, así que no tapa al alias que sí lo tiene.
- **Los pisos ya no traducen.** WhatsApp (`renderAsk`) y el mail
  (`missing-information-request`) usan el valor como llega. Traducir dos veces
  borraba el tipo, porque «daño por granizo» no es un tipo.
- **Con fila pendiente se muestra el valor de esa fila o ninguno.** Es el valor
  que cierra un «Confirmo»; mostrar el de un alias sería confirmar algo que no
  se preguntó.
- **El ensayo lo vigila en cada vuelta.** La comprobación `valor-crudo` marca un
  `null`, `undefined`, `true`, `false` o una fecha ISO en cualquier respuesta,
  aunque la vuelta no espere nada.
- **Un «ok» a una lista no la contesta.** Con los valores legibles, la duda
  inferida sobre los heridos llegó a la lista, y en el ensayo `silencio` el «ok»
  de Ana la daba por confirmada, eso contaba como respuesta y le volvía el
  pedido entero. Ahora un acuse solo (`esSoloUnAcuse`,
  `src/core/mensajes/acuse.ts`: «ok», «gracias», «dale, gracias», «👍»,
  mirando el mensaje entero) frente a un pedido de más de una cosa no cierra
  nada por afirmación, no cuenta como que contestó, y lo que queda de aquel
  pedido tampoco cuenta como pedido nuevo. «Sí», «Confirmo» y «correcto» siguen
  contestando, y un «ok» a una sola pregunta también. Esa duda sobre los
  heridos no tendría que haber existido: Ana nunca habló de heridos. Ver «Nadie
  dijo que no hubo heridos» (23/09).

Queda sin arreglar, de antes: el DNI y la póliza siguen yendo enteros en
`knownValues` hasta el redactor (AC24), y un «Confirmo» cierra todas las
filas preguntadas, no sólo las que la persona vio con valor.
*Enmendado 2026-10-07:* un «Confirmo» ya cierra sólo lo que el pedido mostró con
valor: el worker le pasa al orquestador los `propuestos` del último pedido. Lo
del DNI y la póliza en `knownValues` sigue igual.

### 🪪 Quien escribe no es el titular: se deriva sola, sin esperar al modelo (2026-09-23)

El ensayo `mail-que-no-coincide-con-el-padron` terminaba en
`confirmacion_pendiente` en vez de `requiere_especialista`. Lucía escribe por la
póliza de su padre: el padrón la encuentra, y ni el nombre ni el DNI son los del
titular. El pedido de confirmación salía bien. Lo que fallaba era la derivación.

**La causa era la misma que la de la póliza vencida (#187).** El worker ya sabía
que quien escribe no es el titular, pero la derivación dependía de que el modelo
deliberara `escalate`. Algunas corridas lo hacía y otras no.

**Lo que cambia.** `esTitularAjeno` (`src/core/case/titular-ajeno.ts`) decide con
lo que el worker ya buscó: todas las pólizas encontradas por número son de otra
persona, y en cada una el buscador marcó el nombre Y el DNI como distintos. El
worker lo pasa en `extractedOutput.titularAjeno`, y el orquestador deriva por el
mismo `escalate` que la severidad y la vencida, justo después de la rama D.

- **Un mensaje por vuelta.** El único que sale es el pedido de confirmación, con
  los dos valores enmascarados («R*** P***», «****0140»). `escalate` recibe
  `yaLeEscribimos` y suprime «tu reclamo fue asignado a un especialista». El
  estado, el evento `SPECIALIST_REQUIRED` y el aviso al especialista pasan
  igual. El motivo del registro es un texto fijo, sin nombres ni documentos.
- **Ese mensaje no pregunta nada.** El pedido llega con `titularAjeno` y, en vez
  de «¿Cuál es el correcto? Respondé por acá y seguimos», dice que los datos no
  coinciden con los del titular y que un especialista va a revisar el caso. El
  ensayo lo mostró: los dos valores son correctos (la póliza es del padre, el
  nombre es de la hija), así que la pregunta no tiene respuesta, y la
  respuesta no la lee el agente. Lo cambian los dos pisos (`renderConflict` y
  la plantilla de correo, que además titula «Tu reclamo pasa a un
  especialista») y la consigna del redactor. Dos guardas nuevas en
  `violation()` rechazan un «?» y un «tu auto» / «tu póliza», que también salió
  en el ensayo. Las de la derivación (pedir datos, darle género al
  especialista) valen igual para este mensaje.
- **Sin consultas nuevas.** Usa las coincidencias que el worker ya tenía, y no
  busca las iniciales del titular. Se ahorra la deliberación: al menos una
  llamada a Gemini menos por vuelta.
- **El formato no es otra persona.** Los puntos del DNI, las mayúsculas, los
  acentos, la coma y el orden del nombre no derivan: `mismoNombre` y
  `normalizarNombre` están en `src/core/matching/normalizar.ts`, y
  `inicialesDelTitularAjeno` usa la misma comparación. Una parte del nombre
  («Roberto» frente a «Roberto Paz») no es el mismo nombre.
- **Sin doble derivación.** Con severidad alta o una póliza a derivar, el caso
  ya se derivó arriba y esto no corre.

**Si la persona contesta después que el dato del padrón era el correcto, el caso
sigue derivado.** Es lo esperado: que la póliza sea del padre es justo lo que
tiene que mirar el especialista. Pero la respuesta no la lee nadie más que él:

- **Mail.** `requiere_especialista` no es un estado de arranque. El worker
  guarda el mensaje sin leerlo, deja `email_worker.mensaje_sin_leer` en `warn` y
  `MESSAGE_NOT_READ` (`estado_no_reanudable`) en la auditoría del caso.
- **WhatsApp.** `findExistingWhatsAppCase` sólo retoma `recibido`,
  `info_faltante` y `confirmacion_pendiente`, así que la respuesta abre un caso
  nuevo, sin el contexto del anterior.
- **La máquina de estados** sólo deja salir de `requiere_especialista` a
  `listo_para_core` o `cerrado`. Nada lo devuelve solo.
- **El pedido ya no invita a contestar.** Antes cerraba con «Respondé por acá y
  seguimos», una lectura que el agente no hace. Si igual contesta, pasa lo de
  arriba.

**Lo que sigue en manos del modelo.** Cero coincidencias porque el número de
póliza está escrito con otro formato (el guion no se normaliza, a propósito),
un padre y un hijo con el mismo nombre y distinto DNI, una coincidencia sólo
por DNI, y un solo dato en conflicto. Desde el 07/10 `detectConflicts` compara
el nombre con `mismoNombre`: acentos, mayúsculas, signos y el apellido primero
ya no son conflicto; una parte del nombre («Roberto» frente a «Roberto Paz») sí.

Verificado: 40 tests nuevos (la regla pura, la comparación de nombres, la señal
del worker por mail y WhatsApp, y la derivación en el orquestador con un solo
mensaje por los dos canales, sin deliberar y sin doble derivación), y 8 más
para el mensaje: los dos pisos sin pregunta y con los valores enmascarados, la
señal hasta el redactor, y las guardas del redactor. El ensayo del escenario
evita ahora «¿» y «tu auto», y exige «especialista».

### 🩹 Nadie dijo que no hubo heridos: se pregunta abierto (2026-09-23)

Los ensayos `goteo`, `silencio` y `foto-que-no-es-nada` le propusieron
«• ¿Hubo personas lastimadas?: no» a personas que nunca hablaron de heridos. El
prompt del extractor pedía `"none"` cuando no se mencionaba a nadie herido, así
que el silencio se guardaba como «no», se ofrecía para confirmar, y un «ok» lo
cerraba.

- **El prompt.** `"none"` sólo cuando la persona dice que nadie se lastimó; si
  no dijo nada, `null`, y ni `hay_heridos` ni sus alias van a `fields` ni a las
  dudas.
- **La guarda en el worker.** `sinHeridosSupuestos`
  (`src/core/case/heridos-supuestos.ts`) corre después de la hidratación y antes
  de la severidad. Si el texto de la persona no nombra heridos, borra el
  negativo de `hay_heridos` y sus alias, deja `hay_heridos` como duda sin valor
  (sale como pregunta abierta) y pone en `null` una `injury_severity` «none».
  Sólo borra negativos: un herido no se toca nunca, y borrar no cambia la
  severidad, `requiresSpecialist` ni la derivación. Mail y WhatsApp pasan por el
  mismo worker. Qué cuenta como nombrar heridos (`hablaDeHeridos`): herid, hiri,
  lastim (no «qué lastima»), lesión, lesionad, ileso/a/s, «sin víctimas» o «no
  hubo víctimas», «todos bien» o «todos estamos/están bien», «no nos/me pasó
  nada», «sólo daños materiales», y en inglés injur, hurt, wounded y
  «everyone/everybody is fine/ok/safe». «Víctima» sola no, ni «quemaduras»: fuera
  del léxico cuesta una pregunta de más, no tapa nada.
- **La respuesta a la pregunta abierta.** El extractor no ve nuestra pregunta,
  así que un «No» o un «Sí» sueltos no le dicen nada. `respuestaAHeridos` los lee
  sólo si `hay_heridos` fue lo único que pidió el último mensaje y se preguntó
  abierto: si la fila pendiente tiene un valor —«¿es correcto que no hubo
  personas lastimadas?», o un «none» de antes de este cambio—, un «Sí» es «sí,
  nadie» y lo cierra la confirmación. Lee cada mensaje que llegó después del
  pedido, sin saludos, firma (con o sin «Saludos»: nombre, teléfono, mail,
  «Enviado desde…») ni adjuntos sin texto, así que un «No» con un «gracias» o
  una foto atrás sigue siendo un «no». Un «no», «nadie», «ninguno», «todos
  bien» o «sólo el auto» cierra `hay_heridos` en «no» e `injury_severity` en
  «none», salvo que el modelo haya leído una herida. Un «sí» cierra en «sí»,
  sube la severidad a `high` (una `critical` queda), marca
  `requires_specialist` y deja `injury_severity` sin saber: el caso se deriva.
  Sin conversación cargada o sin la hora del pedido, lee el último mensaje. La
  consulta del pedido trae, en el mismo viaje, las claves, cuándo salió y las
  confirmaciones pendientes (`ultimoPedido`,
  `src/server/confirmations/ultimo-pedido.ts`); el orquestador recibe las
  claves y no la repite.
- **Un «ok» no confirma heridos sin valor.** En `resolveAnsweredConfirmations`,
  una afirmación no cierra `hay_heridos` si esta corrida no trae un valor para
  ese campo. Sí cierra lo demás que se preguntó. Un «sí» a un «no» que la
  persona dijo a medias (confianza entre 0,60 y 0,85) lo confirma como antes.
- **Lo confirmado no vuelve.** `analyzeEmailClaimGaps` devuelve
  `camposResueltos` (filas `confirmed`/`corrected`, en clave canónica, de la
  misma consulta; una `rejected` no, se vuelve a preguntar), y el orquestador
  los saca de las dudas del extractor, que relee toda la conversación y los
  listaba otra vez.
- **El redactor.** La consigna pide meter el valor adentro de la pregunta y
  nunca «¿pregunta?: valor». `violation()` rechaza como `pregunta_con_valor` un
  renglón, de lista o de prosa, con un valor pegado a la pregunta. La consigna
  también dice cómo va la lista: el verbo una sola vez en la frase que la abre,
  ítems sin «Decinos…» ni «Mandanos…», y lo que ya entendimos se confirma
  aparte, en su propia oración. Un ítem que igual arranca con «Decinos…» o
  «Mandanos…», solo o después de un «—» o un «:», se rechaza como
  `item_con_verbo`. Si la lista viene pegada a esa frase,
  `attempt()` le agrega el renglón en blanco. A un «perdón» se le contesta «no
  hay problema», no «gracias». La respuesta a una pregunta ya no dice «qué falta
  para avanzar», que la hacía pedir la documentación dos veces, y la consigna
  pide hablar en plural: nunca «te pido» ni «entiendo». El control de campos
  omitidos ya no toma «Si» como palabra clave de «Si hubo personas lastimadas»:
  para `hay_heridos` busca la raíz (lastim, herid, lesion), así que «¿Alguien
  resultó lastimado?» o «¿Es correcto que nadie resultó lastimado?» pasan.
- **El piso del mail.** Cuando el redactor se cae (un 429, por ejemplo), la
  plantilla pide cada dato por su etiqueta sola, como WhatsApp. Antes pegaba la
  instrucción atrás: «Fotos de los daños: Mandanos fotos de los daños.».
- **El ensayo lo vigila en cada vuelta.** La comprobación `propone-sin-heridos`
  (`scripts/lib/propone-sin-heridos.mjs`) falla si una respuesta propone «no
  hubo heridos» y ningún turno de la persona habló de heridos.

**Lo que queda.** Los casos abiertos antes de este cambio pueden tener una fila
vieja con el «no» supuesto: un «ok» ya no la confirma y un «Sí» o un «No»
sueltos no se leen como respuesta abierta, pero no se hizo backfill. Una
respuesta abierta que no es un «sí» o un «no» enteros («No, pero mi hijo se
golpeó», «No sé») queda para el extractor, y si no nombra heridos la pregunta
puede repetirse. Un negativo por debajo de 0,60 antes iba a `missing_docs`;
ahora queda como pregunta abierta.

### 🔁 Lo que acaba de decir no vuelve como «¿…, correcto?» (2026-09-23)

En el ensayo `goteo` (a1e0019), a «Fue un choque, ayer a la tarde» se le
contestó «¿Fue a la tarde, correcto?». En la vuelta siguiente esa pregunta
desapareció sin respuesta y apareció «Más o menos a qué hora fue.».

- **El eco.** La rama C del orquestador ya no pregunta un valor de confianza
  media que la persona escribió, palabra por palabra, contestando lo que se le
  pidió en la vuelta anterior (`dichoRecien`, `src/core/mensajes/lo-dicho.ts`):
  la fila se guarda `confirmed`. Qué campo es lo dice haberlo pedido, no el
  texto. No cuenta si lo escribió para negarlo («No, no soy Roberto Paz», «no
  fue un choque»), ni un número suelto (puede ser el DNI o la póliza). Lo
  inferido («ayer» como fecha), lo que choca con el padrón (rama D) y los
  heridos se siguen confirmando.
- **La franja no es una hora.** `esValorVago` marca una `hora_siniestro` sin
  dígitos ni hora dicha con palabras («a la tarde», «in the afternoon»). Entra
  como duda aunque el extractor la dé por segura, nunca sale como valor a
  confirmar (se pide la hora, con la misma consigna en cada vuelta), y la
  confianza alta no cierra su fila. La cierra contestar la pregunta: con una
  hora, con un «sí», con la franja sola («fue a la tarde») o con que no sabe
  («no me acuerdo», «I don't remember»); lo mira `contestaSinHora`, frase por
  frase, así que «esta tarde te mando las fotos» no la contesta. Un «sí» a una
  hora precisa la cierra aunque la extracción de esa vuelta no traiga la hora.
- **La pregunta que cambió sola.** La extracción relee la conversación y a
  veces se saltea un campo; la rama C pisaba la fila pendiente con un valor
  vacío. Ahora usa el valor y la confianza de la fila (`confidence` en
  `FieldNeedingConfirmation`), menos heridos: `sinHeridosSupuestos` vacía el
  «no» a propósito para preguntarlo abierto.
- **El redactor también.** La vuelta en que la persona escribió «La póliza es
  POL-3311-B» contestó «Entendemos que tu póliza es POL-3311-B, ¿es
  correcto?»: la póliza la había encontrado el agente, así que no estaba en la
  lista, y el redactor la sacó del último mensaje. El brief se lo prohíbe junto
  a ese mensaje, y la guarda `confirma_lo_que_escribio` de `compose-reply`
  (`confirmaLoQueEscribio`, en `lo-dicho`) rechaza una confirmación que trae un
  número de tres cifras o dos palabras con mayúscula del último mensaje que no
  estén en `knownValues`. El conflicto no pasa por ahí: nombra el valor a propósito.
- **Mail y WhatsApp**, es-AR y en-US: la regla está en el orquestador y en el
  redactor, que son los mismos para los dos canales.
- **El ensayo.** `goteo` corre `confirma-lo-dicho` y `hora-en-una-forma`
  (`scripts/lib/ensayo-confirmaciones.mjs`). Ver `docs/TESTING.md`.

**Lo que queda.** La coincidencia es literal salvo el nombre, que desde el
07/10 cuenta también rotado («Paz Roberto» es «Roberto Paz»; «José María Paz»
no es «María José Paz», y «Paz, Roberto» con coma tampoco cuenta). «Alem al
2300» contra «Av. Alem 2300» se sigue confirmando a propósito: el «Av.» lo puso
el extractor. Una hora que el extractor normalizó («18:00» de «a las 6») también,
igual que un valor que dio sin que se lo pidiéramos y un número suelto de
confianza media. «Fue esta tarde» ya cuenta como la franja sola: «esta», «este»
y «this» valen sólo antes de la franja.

### 🤝 Cuando hay heridos, la derivación empieza por el cuidado (2026-09-24)

En el ensayo `incendio-grave` (23/09), a quien contó que su señora estaba
internada con quemaduras se le contestó «Recibimos tu denuncia. Ya la derivamos
a un especialista…»: correcto, sin pedir nada, y de trámite.

- **La señal.** `hayHeridos` (`src/core/case/heridos-supuestos.ts`) lee lo ya
  extraído: `injury_severity` o `hay_heridos` en «sí». Alcanza el «Sí» a la
  pregunta abierta, que deriva el caso y deja `injury_severity` en null. Sin
  llamadas nuevas al modelo ni consultas.
- **Quién la lleva.** Sólo la derivación por gravedad (rama B), con
  `heridos: true` en los datos del mensaje. La del titular ajeno y la que
  decide el agente no la llevan, y la póliza vencida sin gravedad tampoco. Un
  caso grave con heridos sí, aunque la póliza haya vencido. Viaja sólo el
  booleano: ningún detalle médico, ni en el mensaje ni en la auditoría.
- **Los pisos.** WhatsApp antepone `CUIDADO` («Lamentamos mucho lo que están
  pasando.») a `ESCALATION_TEXT`; el mail lo pone como primer párrafo. Sin
  heridos, los dos salen byte por byte como antes.
- **El redactor.** Con `heridos` —el booleano de `message.data`, no el texto
  del piso, que en WhatsApp trae el nombre que escribió la persona—, el brief
  le pide abrir con una frase breve de cuidado, sin repetir lo que contó de las
  heridas ni diagnosticar ni prometer. La guarda `dropped_care` rechaza el texto que la
  saca, como `dropped_conflict` con los valores del conflicto, y
  `care_names_health` el que nombra heridas, internación o salud
  (`hablaDeLaSalud`); el resto de las guardas de la derivación siguen igual.
- **Una sola vez.** `CUIDADO` y los predicados de la guarda (`diceCuidado`,
  `pideDatos`, `hablaDeLaSalud`) viven en `src/core/mensajes/derivacion.ts`.
  Los pisos usan sólo la frase.
- **El ensayo.** `incendio-grave` y `mail-grave` corren `cuidado`,
  `sin-pedido` con `pideAlgo` —más ancho que la guarda, para que muerda lo
  que ella deja pasar— y no mencionan «internad», «quemadur» ni «recuper». Ver
  `docs/TESTING.md`.

**Lo que queda.** La frase existe sólo en castellano rioplatense: el mensaje al
asegurado no tiene idioma propio (`src/lib/i18n` es la interfaz). La rama B lee
la gravedad que dio la extracción, no `finalSeverity`. Una derivación en una
vuelta cuya extracción ya no nombra las heridas sale sin la frase.

### 💬 Responder por WhatsApp y el asistente, en el Plan Pro (2026-09-25)

**Responder desde el caso (P8, #295).** Quien atiende un caso llegado por
WhatsApp puede contestarle a la persona desde la conversación del caso
(`POST /api/cases/[id]/responder`). `src/core/whatsapp/puede-responder.ts`
decide si se puede y por qué no: plan, ventana de 24 h de Meta, agente todavía
activo, canal o rol. Fuera de la ventana la caja queda deshabilitada: mandar
una plantilla de Meta después de las 24 h no está hecho. La respuesta queda en
la auditoría y tiene su propio límite (`RESPUESTA_HUMANA`, 10 por minuto).

**El asistente (P9, #296).** `/asistente` responde preguntas sobre los casos
del inquilino con herramientas de sólo lectura
(`src/server/asistente/herramientas.ts`) y una guarda contra inyección de
instrucciones (`src/core/asistente/intencion.ts`). Todos los roles lo usan; a
quien sólo mira se le enmascaran los datos personales. Límite propio
(`ASISTENTE`, 20 por minuto).

**Plan.** Los dos son Plan Pro: `profesional`, `corporativo` y `enterprise`.
La barra marca `/asistente` como Pro. Con la promoción, el inquilino vivo
«Seguros del Sur S.A.» pasa de `piloto` a `profesional` por decisión del dueño.

**Tono del agente (#297).** Lo que la persona acaba de escribir no vuelve
como «¿…, correcto?» aunque nadie lo haya pedido, salvo nombre, DNI, email y
teléfono, que pueden ser de otra persona. Una fecha inferida no se afirma. Un
borrador con más ítems que campos pedidos se rechaza. Las plantillas de
respaldo saludan con el nombre de pila, y sólo en el primer mensaje: en una
vuelta posterior no vuelven a decir que la denuncia quedó registrada.

**Pendientes cerrados (25/09).** El aviso de traspaso dice que la persona del
equipo «puede» escribir desde otro número o correo, porque en el Plan Pro
también contesta desde el mismo número (`puede-responder.ts`). En el ensayo
`goteo`, con un solo dato pedido, el redactor copiaba como ítems los ejemplos
de «CÓMO VA LA LISTA» («Si alguien resultó lastimado», «Fotos de los daños»),
la regla de más ítems que campos rechazaba los dos intentos y salía la
plantilla. Los ejemplos ya no son campos reales y un dato solo va en una
oración, sin lista. `/metricas` no es Plan Pro (Pro son el asistente y P8):
no le faltaba respaldo en el servidor, la nota anterior estaba equivocada.

**Pen test (#294).** `attackTenantWall` ya no escribe: prueba la pared entre
inquilinos sólo leyendo. `scripts/migrate.mjs --forget` no se marca a sí mismo
como deriva.

**Decidido, sin cambios.** No queda nada abierto en esta sección.
- La pregunta por heridos puede repetirse en un mismo caso. Se deja así porque
  es una guarda de seguridad.
- La región de Vertex sigue en `us-central1`: el dueño rechazó `global` el
  25/09.

### 📋 El documento de mejoras a la interfaz, punto por punto (2026-09-26)

El documento «Mejoras a la interfaz y funcionalidad del agente» (Google Docs,
modificado por última vez el 17/09) lista 33 puntos, de A1 a H3. Una
auditoría contra el código marcó A3 como hecho (#192) y C6 como no aplicable:
«choque» es el ramo correcto para quien reclama por su propio auto. El resto
entró en dos lotes.

**Lote 1 (en `main` con #309).**
- #304: la pantalla del caso se lee (B1-B5, C2, C3, C7, C8, D1, D2, D4, E1,
  E3, E4). Estados reales de los documentos, un rótulo por dato, un panel «Qué
  falta» y una línea de tiempo sin «Motivo: null».
- #305: una clave canónica por dato, el teléfono de WhatsApp nunca como email,
  la parte A siempre es el asegurado, la derivación por severidad escrita una
  sola vez y toda lesión declarada deriva (C1, C3-C5, C7, D3, F2).
- #306: filtros sin carreras, «Mi cola» (`/bandeja?cola=mia`), el analista
  asignado en la bandeja y el tiempo hasta la primera respuesta medido con el
  primer mensaje saliente (A2, A5, E1, H1, H2).
- #307: la demo pública no muestra datos de salud, lleva a la bandeja y la app
  tiene un botón de ayuda (A1, A4, D4, F1).
- #308: los adjuntos se abren desde el caso por
  `GET /api/cases/[id]/attachments/[attachmentId]`, en streaming y con
  `CASE_EDITOR_ROLES` (E2, B5, D2). Viewer no abre archivos.
- El tope del bundle pasó de 300 a 310 kB en #304: `qa` ya pesaba 297 kB por
  crecimiento orgánico, con los dos diccionarios en un solo chunk y sin
  duplicados. Está dicho en el commit y en `docs/PROMOCION.md`.

**Lote 2 (decisiones del dueño del 26/09).**
- #310 (B3, H3): datos obligatorios por ramo en
  `src/core/case/required-fields.ts`: patente en los ramos de auto, provincia
  en todos, hora en `choque` y `rc`. «Listo para Core» pide que una persona
  confirme («Confirmar y dejar listo», auditado como `case.ready_confirmed`), y
  una corrida posterior del agente invalida la confirmación. La «Tasa de
  completitud automática» cuenta sólo los casos confirmados más los
  `enviado_a_core`, así que va a bajar: antes contaba casos que nadie había
  mirado.
- #311 (E5): los ejemplos de referencia del prompt tachan nombre y DNI
  (`[NOMBRE]`, `[DNI]`), también por clave canónica. El fine-tuning usa sólo
  casos `email_sim` y `whatsapp_sim`. Los eventos dicen «ejemplo de
  referencia, no se entrena ningún modelo».
- #312 (B6): «Reenviar pedido»
  (`POST /api/cases/[id]/reenviar-pedido`) y «Reabrir y reenviar» para un
  caso cerrado por abandono. Por WhatsApp sólo dentro de la ventana de 24 h.
  No se reenvía un pedido de menos de 10 minutos. La revisión de seguridad en
  Fable confirmó un hallazgo medio (P8-01: reabrir un caso que después cerró
  una persona) y quedó corregido con `ultimoCierreVigente`.
- #313: el Post-deploy de QA sobre #310 salió rojo en `mail-completo`. El
  agente eligió no pedir el parte amistoso en el primer turno y la negativa
  «No completamos ningún parte amistoso» se descartaba. Ahora cuenta la
  negativa de un documento pendiente que la persona nombra, aunque no
  estuviera en el último pedido, y la cita tiene que nombrarlo.
- #318: el export del agente (JSON de memoria y JSONL de aprobados) tacha
  nombres y DNI en cada ejemplo con `ejemploSinDatosDeLaPersona`, en todos los
  modos, también `full_admin_only`. Tacha a todas las personas del caso
  (asegurado, tercero, conductor), también en el few-shot. No alcanza a un
  nombre que nadie extrajo ni a un DNI escrito con espacios. El texto dice «ejemplo de referencia, no
  se entrena ningún modelo». El repo pasó a privado: CodeQL analiza sin subir
  el SARIF y falla con hallazgos de gravedad alta o crítica; los revisados
  y descartados van en `.github/codeql-descartados.txt`. Sin GitHub Pro
  no hay protección de ramas ni rulesets (la API da 403), así que la regla
  de rama + PR + promoción se sostiene a mano, y los minutos de Actions
  cuentan contra el cupo del plan gratuito.

**Lote 3 (ideas de un video de Instagram, 26/09).** Las cuatro funciones
pedidas ya existían: el asistente (#296), la respuesta por WhatsApp desde el
caso (#295), las series de `/metricas` (23/09) y el candado del Plan Pro. Este
lote las pule.
- #321: `/metricas` muestra la actividad del día, del mes y del año apenas
  debajo de las tarjetas, con reclamos por WhatsApp y por mail separados. El
  gráfico por estado usa los seis grupos de la bandeja.
- #322: la bandeja busca por nombre, nombre extraído, póliza o número
  `SIN-XXXX-XXXX` y filtra por período (hoy, 7, 30 y 90 días). Los
  contadores y el CSV siguen a los dos filtros.
- #323: la conversación del caso rotula quién escribió, muestra el
  vencimiento de la ventana de WhatsApp y el motivo concreto cuando no se
  puede responder. La respuesta humana graba la fila antes de mandar. El
  candado dice «Disponible con el Plan Pro».
- #324: el asistente se abre desde un botón flotante en cualquier pantalla
  (Plan Pro). Busca por número de caso y por nombre sin acentos. Si Gemini no
  responde, devuelve `IA_NO_DISPONIBLE` en vez de inventar.
- Las ideas que quedaban (el tablero, el estado del agente en la barra,
  «Tomar el control» y la agenda) se construyeron en #333 y #334, dentro de la
  auditoría de septiembre (abajo). El resumen diario por mail quedó sólo
  explicado.

**La auditoría técnica de septiembre y la limpieza (2026-09-27).** El informe
completo, con los 16 puntos pedidos, está en `docs/AUDITORIA-2026-09.md`.
Ningún PR renombra campos, estados, endpoints ni variables de entorno, y el
tope de 310 kB de `pnpm peso` no se tocó.
- #326: la regex del clasificador de gravedad escapa bien su clase;
  `/api/admin/health` no devuelve el texto del error de la base;
  `gmail-sender` saca CR/LF de los encabezados; `oauth-state` compara en
  tiempo constante; el alta de usuarios queda auditada; `confirm-training` da
  404 con una corrida de otro caso; los `fetch` a Graph cortan a los 30 s. Se
  borró `scripts/cleanup-cases.ts`, que vaciaba el inquilino de la base viva
  sin guarda.
- #327: la deliberación del agente toma como respaldo sólo lo que devolvió
  cada consulta, no los argumentos que escribió el modelo. Los valores del
  denunciante pasan por `sinCentinelas` antes del prompt. El resumen del
  asistente no afirma cobertura, pago ni monto, y se descarta si repite un
  número o un monto que no esté en la póliza ni en el caso (G12).
- #328: el re-análisis y el PATCH de estado son atómicos contra el estado
  leído (409 si otro lo cambió); `enviado_a_core` y `error_core` no se
  escriben desde la API; la auditoría guarda la IP sólo si es válida;
  `/admin/cartera` y `/api/admin/gmail-accounts` no dan 500 ante una entrada
  inválida; un mail que choca por `messageId` sigue con el caso existente en
  vez de perderse (G40, era el hallazgo alto). `messenger.ts` graba la fila
  `queued` antes de mandar el WhatsApp (G13).
- #329 y #330: se borraron el remitente SMTP, `runExtractionWorker`, 56 tipos
  y otros exports sin importadores, los scripts de la migración de filtros de
  tenant, `nodemailer`, `pino`, `@aws-sdk/s3-request-presigner` y 88 imports
  sin uso.
- #331: simplificaciones sin cambio de comportamiento. El escape de regex, el
  `errorCode` de los logs (22 copias), la comparación de DNI, teléfono y
  póliza en SQL (seis módulos) y el corte del dataset de entrenamiento viven
  en un solo lugar.
- #332: las once páginas de la app usan el idioma de la cuenta
  (`getAccountLocale()`), no sólo la cookie. `/metricas` cuenta sólo
  reclamos en la distribución por tipo y muestra los nueve tipos.
- #333: la bandeja filtra por riesgo de fraude (también en el CSV), se puede
  ver como tablero por estado (sólo lectura) y la barra lateral muestra si el
  agente está activo, en modo de prueba o sin presupuesto.
- #334: «Tomar el control» pasa un caso de WhatsApp a
  `requiere_especialista` para que responda una persona. Es Plan Pro, sólo en
  `info_faltante` o `confirmacion_pendiente`, y sólo cuando el agente terminó:
  el PATCH devuelve `FSM_INVALID_TRANSITION` si la reserva del agente está
  viva. La agenda (`/agenda`) lista dos vencimientos que ya salían de datos
  existentes: el cierre de la ventana de 24 h de WhatsApp y el cierre por
  abandono. Todos los roles la ven; quien no puede ver datos del cliente ve
  el titular tapado.
- «Devolver al agente» (E24) es el botón espejo: sólo aparece en un caso
  tomado con «Tomar el control» y lo suelta a `info_faltante` para que el
  agente retome. Mismo Plan Pro, mismo canal WhatsApp, guarda en `patchCase`
  — no es una arista nueva en `FSM_TRANSITIONS` (ver ADR 0003).
- El resumen diario por mail quedó sólo explicado en el informe, sin
  construir.

**La segunda vuelta de la auditoría (2026-09-28).** El dueño resolvió cada
ítem que arriba había quedado «sólo explicado». Los cambios están mergeados en
`qa`; llegan a producción con la promoción que lleva este PR. Estado punto por
punto de cada ítem: `docs/AUDITORIA-2026-09.md` §14.
- #338 (casos y agente): un analista sólo actúa sobre casos suyos o sin
  asignar, en el PATCH y en el re-análisis (E3); «Tomar el control» se
  bloquea mientras hay un mensaje en cola para el agente; más de 20 mensajes
  de un mismo número en 10 minutos se guardan sin llamar a Gemini y el caso
  pasa a «Para responder», sin el teléfono en la clave (E12); formulario y
  API comparten una sola clave de cupo (E21); `/api/demo/analyze` es sólo
  para roles que pueden editar (E9); y un remitente de mail sin autenticar no
  recibe pistas de memoria (E17). «Devolver al agente» (E24) ya quedó
  explicado arriba.
- #339 (datos personales y dependencias): `claimmix_app` pierde UPDATE y
  DELETE sobre `audit_log` (migración 0032, E6); `known_claim_patterns` pasa
  de políticas `FOR ALL` a una por comando, así que un inquilino ya no puede
  borrar ni cambiar una regla global (migración 0033, E5); el export
  `full_admin_only` tacha también `sender_profile`, los argumentos de las
  herramientas y las claves de teléfono o correo en `field_correction`;
  ningún caso real de Gmail entra a entrenamiento ni a few-shot; Sentry limpia
  breadcrumbs, cabeceras, cookies y query strings; un adjunto de Gmail que
  declara más del tope se descarta antes de bajarlo (E8); y sale
  `@tanstack/react-table` a favor de React simple, `googleapis` se reemplaza
  por `@googleapis/gmail` y `google-auth-library` queda en una sola versión
  (E19). De paso se arregló que la bandeja mostrara la fecha de siniestro un
  día antes en Argentina.
- #340 (avisos por aseguradora, pantalla pendiente, fine-tune y plantilla):
  cada aseguradora carga su propia lista de avisos para casos derivados a
  especialista en /configuracion (E10, migración 0034); quien tiene cuenta
  pero todavía no tiene fila de usuario ve una pantalla que explica que falta
  el alta de un admin, en vez de rebotar (E20); /metricas suma el «Resumen de
  ayer» (E23); la facturación no congela un mes anterior al alta del tenant
  (E15); el fine-tune de Vertex ya puede aprobarse y activarse sin que la
  sincronización pise esos estados, con el dataset armado sólo con casos
  simulados tachados (E18); el reenvío por WhatsApp pasadas las 24 h usa la
  plantilla `reabrir_denuncia` en cuanto Meta la apruebe; y la bandeja, la
  barra y /configuracion terminan de pasar a i18n (G30).
- #341 (CI y e2e): Playwright se niega a correr contra la base de producción
  y no reutiliza un servidor ajeno (E7); el CI compila una sola vez y los
  demás jobs bajan el artefacto, los despachos manuales validan el host antes
  de mandar el `CRON_SECRET`, y los techos de los overrides de pnpm y la
  lista de scripts de instalación quedan explícitos (E13); y un e2e nuevo
  abre un PDF de 8 MiB por la ruta de adjuntos y prueba que llega por
  streaming, contra el balde de QA.
- Este PR (barrido de tests): cierra E22, el último ítem técnico. `type-check`
  y `verify` corren con `--noUnusedLocals`, con las variables sin uso
  borradas, y los cerca de 57 bloques repetidos de puente de alcance en los
  tests quedan reemplazados por un solo `puenteDeAlcance`/`puenteSobreLibDb`,
  con una guarda que falla si vuelve el bloque viejo.
- Las migraciones 0032, 0033 y 0034 ya están aplicadas en staging, QA y
  producción (28/09, `ep-proud-resonance`, `migrate.mjs --apply`). Lecturas
  antes → después en prod: `audit_log` pasó de DELETE/INSERT/SELECT/UPDATE a
  sólo INSERT/SELECT para `claimmix_app`; `known_claim_patterns` pasó de 3
  políticas (dos `FOR ALL`) a 4 por comando, ninguna `ALL`; 41 reglas globales
  y 109362 filas de auditoría, iguales antes y después; la columna
  `tenants.specialist_alert_emails` quedó creada y vacía en los dos tenants.
  `pnpm permisos`, `pnpm tenancy` y `pnpm esquemas` dieron verde contra
  producción (39 tablas, 422 columnas, 116 índices, 410 restricciones, 81
  funciones y 33 políticas, iguales entre staging y prod).
- Limpieza del fine-tune: el modelo del 30/06 se dio de baja (el proyecto GCP
  viejo quedó `DELETE_REQUESTED`, la fila de Vertex pasó a `rejected` y
  `active_model` quedó nulo en prod y staging) y se purgaron 28
  `training_examples` de casos reales (25 de mail, 3 de WhatsApp), con el ok
  del dueño en el momento. Regla vigente: el próximo entrenamiento usa sólo
  casos `email_sim` y `whatsapp_sim` tachados; ningún caso real de Gmail
  entra a entrenamiento ni a few-shot.
- La plantilla de WhatsApp `reabrir_denuncia` (UTILITY, `es_AR`, id
  `1396391836035737`) ya está mandada a Meta, en la WABA 1727802301698317, la
  del número real. Estado: PENDING. El código detecta la aprobación solo, por
  `WHATSAPP_BUSINESS_ACCOUNT_ID`, con caché de 1 h si está aprobada, 10 min si
  está pendiente y 60 s ante un error de consulta.
- El e2e del PDF de 8 MB corre en el CI de #341 contra el balde de QA
  (`QA_R2_*`, sin secretos nuevos): 8388608 bytes, 341 trozos, 92 tests
  pasados, 0 salteados.
- Arreglos que salieron de ensayar «Tomar el control» contra el agente real:
  `auditoriaSiQuedo` tenía un bug que ya estaba en producción — un
  `insert().select()` sin `id` ni `created_at` y una guarda que comparaba
  contra una hora que el trigger pisaba — y hacía que la confirmación de
  listo (P6) y la reapertura (P8) respondieran «El caso cambió mientras lo
  mirabas» o quedaran sin auditar (cero `case.ready_confirmed` y cero
  reaperturas auditadas en producción hasta el arreglo en `fe7d15a`); y una
  regresión de cabeceras de WhatsApp (`headers` como `{}`, no como lista)
  tiraba abajo la extracción en cada mensaje de WhatsApp, arreglada en el
  mismo #338.
- Observaciones que quedan sin construir, riesgo bajo: en el ensayo de
  «Devolver al agente» el cliente dio la póliza POL-4471-A y, tras la
  devolución, escribió «póliza 4455», y el agente aceptó el número nuevo sin
  señalar la contradicción (resuelto el 15/10: ver «Póliza cambiada a mitad
  de la charla»); y el título del commit `fe7d15a` quedó cortado
  (le falta «auditadas»), sin corregir para no reescribir la historia.
- 28/09: el primer intento del script de la plantilla leyó mal `.env.local`
  (la línea del token de WhatsApp termina en un comentario) y Graph devolvió
  el token en el mensaje de error, que quedó en la salida de la sesión local;
  no salió a ningún otro servicio. Por decisión del dueño el token no se
  rota; el script ahora tapa el token en toda salida.
- `feat/listo-para-core-y-post-intake` (B25, sin mergear): sin conector de Core
  un caso quedaba para siempre en `listo_para_core`; ahora una persona lo pasa
  a mano a `en_liquidacion` («Entregado por fuera») o lo cierra, y de ahí a
  `pagado`, `rechazado` o `cerrado` (`SALIDAS_A_MANO`, ADR 0003). La migración
  0035 sólo cambia el CHECK de `cases.status` (sin columnas: pagado/rechazado
  usan `closed_at`, la fecha de `en_liquidacion` queda en la auditoría); hay
  que aplicarla a mano en staging, QA y producción antes del merge. Sin ella la
  ingesta sigue andando y marcar un estado nuevo da 500 (23514).
- `feat/entrega-al-core-b5` (B5, en PR a qa, sin mergear): el caso llega a un
  sistema de verdad. «Enviar al sistema central» manda un webhook firmado
  (HMAC-SHA256 sobre `t.body`, `Idempotency-Key` = caseId) a la URL que carga
  un admin en Configuración, y `/api/v1/cases` deja que el Core lea con una
  clave `cmk_<tenant>_<azar>` (sha256 en la base, 120/min por IP). `/api/v1`
  pagina por cursor, no por OFFSET, da fechas ISO en UTC, sólo casos reales
  (sin `_sim` ni remitentes reservados) y con dos minutos de margen tras el
  último cambio. Envían owner, admin y specialist (`CORE_SYNC_ROLES`). El destino
  se valida contra SSRF (https, 443, sin IP literal, DNS sólo a direcciones
  públicas, conexión a la IP validada, sin redirecciones). El secreto va
  cifrado con la misma clave que los tokens de Gmail. Contrato del receptor en
  `docs/entrega-al-core/README.md`. La migración 0036 crea
  `core_sync_settings` con RLS; hay que aplicarla a mano en staging, QA y
  producción antes del merge, como la 0035. Sin ella el envío queda
  `sin_configurar` (501, sin botón), `/api/v1` da 401 y Configuración avisa;
  `--exigir-al-dia` y «Migraciones aplicadas» dan rojo hasta aplicarla.
- `feat/documentos-y-voz-b1-b7-b8` (B1, B7 y B8 del informe de Clive, sin
  commitear ni mergear). B1: la IA lee PDFs y notas de voz (ogg, opus, mpeg,
  mp3, mp4, x-m4a, aac, wav, x-wav; sin AMR/3GPP), con firma y topes de
  siempre; el audio se transcribe en el worker, nunca en el webhook, y queda en
  `body_text` en el lugar del marcador, con `raw_payload.transcripcion`. B7: la
  misma extracción copia los datos de cada documento y `cruzarDocumentos`
  (src/core/case/contradicciones.ts) los cruza, junto con la fecha y el GPS del
  EXIF de las fotos, contra el reclamo y la póliza; los indicios van a
  `fraud_indicators` y al panel del analista, nunca a la persona. B8:
  `cases.resumen` sale del resumen de la extracción, sin otra llamada, y cada
  adjunto tiene su línea; la ficha marca duplicados (mismo hash) y los que no
  sirven. **La migración 0037 (`cases.resumen` y `claim_attachments.resumen`,
  `util`, `datos`, `metadatos`) se aplica a mano en staging, QA y producción
  ANTES del deploy**: la ficha lee todas las columnas de `cases`, y sin ella
  cada caso da 404; `/api/health` mira las cinco. El ensayo suma
  `nota-de-voz-y-pdf`: la constancia es un PDF inventado que está en el repo, y
  la nota de voz es un audio mudo hasta que el dueño deje una de verdad,
  sintética y sin datos de nadie, como `tests/fixtures/nota-de-voz.ogg`.

**Para decidir.**
- ~~`src/server/confirmations/messenger.ts` manda el WhatsApp antes de
  grabar la fila saliente~~. Resuelto en #328: graba la fila `queued` antes
  de mandar.
- ~~El export en `full_admin_only` sigue sacando en claro la memoria de
  remitentes (`sender_profile`, con nombre y DNI) y, en modo `full`, los
  argumentos de las herramientas en la auditoría. Es el modo en claro para
  un administrador; tacharlo es aplicar el mismo helper a esas filas.~~.
  Resuelto en #339: el export tacha `claim_memory` (valor tachado, clave
  como huella) y los argumentos de herramientas en `claim_events`, en todos
  los modos.
- ~~Un analista confirma o marca «Revisado» sólo en casos asignados, y la
  entrada real no asigna~~. Resuelto (E3): un analista actúa sobre uno suyo o
  sin asignar, nunca sobre uno de otro analista; misma regla en PATCH y en
  re-análisis (`puedeCambiarEstado`, decisión 27/09).
- «Reabrir y reenviar» sigue deshabilitado para WhatsApp hasta que Meta
  apruebe la plantilla: el barrido cierra a los 14 días, fuera de la ventana.
  Los casos de mail funcionan. 28/09: la plantilla `reabrir_denuncia` ya está
  mandada a Meta y el código la usa sola en cuanto pase a APPROVED; estado
  hoy, PENDING.
- ~~El modelo afinado del 30/06 se entrenó con ejemplos reales. No está
  activo: el inquilino usa el modelo base.~~ Resuelto (28/09): el modelo se
  dio de baja (proyecto GCP viejo `DELETE_REQUESTED`, fila de Vertex
  `rejected`, `active_model` nulo en prod y staging) y aprobar/activar quedó
  arreglado (E18). El próximo entrenamiento usa sólo casos `email_sim` y
  `whatsapp_sim` tachados.
- ~~Gmail «Limited Use» puede alcanzar a los ejemplos tachados de casos
  reales llegados por Gmail. Lo confirma el dueño.~~ Resuelto en #339:
  ningún caso real de Gmail entra a entrenamiento ni a few-shot; si no se
  puede saber el canal, se rechaza (`channel_unknown`) sin decir que vino por
  Gmail.
- ~~Falta verificar en un preview la apertura de un PDF de 8 MB por
  streaming.~~ Resuelto en #341: `adjunto-de-8mb.spec.ts` lo prueba en CI,
  por streaming, contra el balde de QA.

### ⏰ Mensajes tardíos y recordatorios de lo que falta (B3 y B4, 2026-09-29)

Dos huecos del informe de Clive del 28/09, en la rama
`feat/tardios-y-recordatorios-b3-b4`. Van en una sola rama y no en los dos PR
que pedía el plan.

**B3: qué pide el mensaje que llega tarde.** Cuando alguien escribe a un caso
que ya terminó, el worker clasifica el mensaje (`novedad_mismo_siniestro`,
`siniestro_nuevo`, `consulta_estado`, `otro`) y guarda un resumen seguro, sin
el texto crudo (`src/core/case/mensaje-tardio.ts`,
`src/server/cases/mensaje-tardio.ts`). La bandeja y el detalle muestran la
clase. Los especialistas reciben el aviso por el mismo canal y con los mismos
destinatarios que `alertSpecialists`. Un siniestro nuevo **no abre otro caso**:
lo decide una persona desde la bandeja. Esto se aparta del plan y lo tiene
que confirmar el dueño. Migración `0038_mensaje_tardio.sql`, con
`mensaje_tardio_reservado_en`: dos corridas sobre el mismo mensaje no lo
clasifican ni avisan dos veces, y una que murió se retoma a los 5 minutos.

**B4: recordatorios.** Si la aseguradora los prende en `/configuracion`
(apagados, 48 h, o 48 h y 5 días), el barrido nocturno de `reap-stuck` repite
el pedido de lo que falta a un caso en `info_faltante` que no contestó
(`src/server/confirmations/recordatorios.ts`). Cada etapa se reserva en
`case_recordatorios` antes de mandar, así que sale una sola vez aunque el
barrido corra dos veces. Nunca toca `cases`: el reloj del abandono sigue
igual. Por WhatsApp, pasadas las 24 h, sólo sale con la plantilla
`reabrir_denuncia` aprobada. Hoy está PENDING, así que esos recordatorios se
saltean con `plantilla_sin_aprobar`. Al cerrar un abandonado de un inquilino
con recordatorios, se manda un aviso de cierre por mail. Por WhatsApp se
saltea (`ventana_cerrada`). Si contestan ese aviso, el caso cerrado por
silencio vuelve a «Para responder» y el mensaje se clasifica como en B3. Sin
aviso (recordatorios apagados, o un cierre de antes de B4) la respuesta queda
sólo en la auditoría, como antes. Un cierre a mano sigue siendo la última
palabra. Migración `0039_recordatorios.sql`, con
`recordatorio_horas` en `'{}'` por defecto.

**Antes del deploy.** La 0038 y la 0039 se aplican a mano en staging, QA y
producción, en ese orden. Sin ellas, `/api/health` queda en rojo y la bandeja
falla con 42703. Sin la 0038 además no entra **ningún** caso: Drizzle lista
todas las columnas del esquema en el INSERT a `cases`, como en la caída de
0006-0009. El 29/09 ninguna de las dos estaba en la base del ensayo, y el
check cayó 21 de 22 escenarios en el primer mensaje por eso, no por el código.

### 🧾 Cobertura, monto estimado y presupuesto del taller (B6, B23 y B21, 2026-09-29)

Tres huecos del informe de Clive del 28/09, en la rama
`feat/cobertura-monto-presupuesto-b6-b23-b21`, que sale de la de B3 y B4. Todo
es para el equipo. Nada sale al asegurado: ni la respuesta del agente, ni su
prompt, ni sus herramientas, ni las plantillas, ni el aviso por mail al
especialista. `la-cobertura-no-sale-al-asegurado.test.ts` lo fija recorriendo
los imports.

**B6: cobertura contra la póliza.** En `/clientes/[id]` se sube el PDF de
condiciones de cada póliza (`POST /api/policies/[id]/condiciones`, sólo owner,
admin y specialist). Gemini lo lee una vez y guarda en `policies` las
coberturas (código, suma asegurada, franquicia) y el ámbito territorial.
`src/core/case/cobertura.ts` devuelve cubre, no cubre o dudoso, con motivos
codificados. Compara la fecha del siniestro, nunca la de hoy. El veredicto se
ve sólo en la ficha del caso. Una póliza que hoy no está activa da «dudoso»,
porque pudo estarlo el día del siniestro.

**B23: monto estimado.** Es un rango orientativo por tipo y gravedad
(`src/core/case/monto-estimado.ts`). Hay una tabla por defecto, en pesos de
septiembre de 2026, que cada aseguradora puede reemplazar en `/configuracion`
(`PATCH /api/admin/montos`). El worker guarda el rango en
`cases.monto_estimado` en cada extracción, con `origen: "tabla"`. El tipo
«otro» no tiene rango.

**B21: presupuesto del taller.** En los adjuntos del caso, un PDF o una foto
que parece un presupuesto muestra «Leer presupuesto»
(`POST /api/cases/[id]/attachments/[attachmentId]/presupuesto`). Gemini lee
los ítems y los importes, y los coteja con las fotos y el relato. La ficha
marca los ítems sin daño visible, los importes fuera de rango y un total que
no suma. El monto estimado pasa a `origen: "presupuesto"`.

**Las lecturas del modelo** pasan todas por `src/server/ai/leer-documento.ts`:
`checkBudget`, `registrarConsumoDelModelo` y un cupo propio por póliza o por
caso (5 cada 24 h). Sin cupo, sin presupuesto de IA o con una respuesta que no
valida, la pantalla dice «sin leer» y no se escribe nada. El texto va entre
centinelas. Lo que vuelve pasa por zod, y el texto libre, por el filtro de
resumen seguro.

**Antes del deploy.** La 0040 (`0040_cobertura_monto_presupuesto.sql`, siete
columnas que admiten NULL) se aplica a mano en staging, QA y producción, en ese
orden, después de la 0038 y la 0039. Sin ella no entra **ningún** caso: Drizzle
lista todas las columnas del esquema en el INSERT a `cases` y a
`claim_attachments`. Además la ficha de cada caso da «no existe», `/clientes/[id]`
falla con 42703 y `/api/health` queda en rojo.

**Para revisar.** Un viewer ve el panel de cobertura y la lectura del
presupuesto. `GET /api/cases/:id` devuelve `monto_estimado` a todos los roles
del equipo. Los montos por defecto son una estimación que tiene que validar el
dueño. Un PDF de condiciones de más de 10 páginas se rechaza.

### ⚖️ Responsabilidad en choques y reclamo de un tercero (B18 y B24, 2026-09-29)

Dos huecos del informe de Clive del 28/09, en la rama
`feat/responsabilidad-y-terceros-b18-b24`, que sale de la de B6, B23 y B21.
Todo es para el equipo que edita el caso (owner, admin, specialist, analyst).
Nada sale al asegurado: ni la respuesta del agente, ni su prompt, ni las
plantillas, ni el aviso por mail al especialista, ni `GET /api/cases/:id` para
un viewer. El agente nunca le dice a la persona quién tuvo la culpa.

**B18: responsabilidad.** La mecánica del choque (semáforos, quién embistió de
atrás, si venía por una vía con prioridad, un vehículo detenido) se saca del
relato, del parte amistoso y de la exposición policial en la misma llamada de
la extracción, sin llamada nueva al modelo. `src/core/case/responsabilidad.ts`
es una función pura que devuelve una opinión PRELIMINAR (asegurado, tercero,
compartida o no determinable) con la regla y el motivo. Cita la Ley 24.449:
art. 48 inc. g para el choque desde atrás, art. 44 para el semáforo, sólo si
quien lo enfrentaba venía en marcha (un vehículo detenido no se culpa), y art.
41 sólo cuando consta que no hubo excepción de prioridad. Con datos
insuficientes dice «no determinable» y lista lo que falta. Se calcula en los
choques (`choque` y `rc`) y se guarda en `cases.responsabilidad`; al
reclasificar el caso a otro tipo se borra, y la ficha nunca la muestra fuera de
un choque. La ficha la muestra con la marca «orientativa». Si dos documentos se
contradicen, `difiere` lo avisa.

**B24: reclamo de un tercero.** Una carta documento o un reclamo (PDF o foto)
se reconoce al leer el adjunto: reclamante, rubros, montos y plazos. Si llega
una historia clínica, `cruzarConHistoria` marca lo que no coincide o falta. La
ficha muestra la carta, el cruce y lo que falta. Las lesiones siguen derivando
al especialista como antes. Lo que se lee de los adjuntos y la mecánica no
llegan al log del agente ni al orquestador: el worker los saca antes.
La carta se lee con `after()` de Next, cuando la corrida ya soltó la reserva y
el worker ya contestó (si `after()` no está disponible, en el momento; se
importa de `next/server` de forma dinámica porque el bundle de pasos de
`pnpm flujos` arrastra `extract.ts` y Node no resuelve ese import estático), y sólo
si a la invocación le quedan tres plazos del modelo; si no, vuelve en la
próxima corrida. Así el re-despacho no espera la lectura y no vuelve el caso a
la cola. Una carta que llega a un caso que el agente ya no lee (derivado,
cerrado) también se lee para el equipo: los archivos del último mensaje que
nadie miró se reconocen en esa misma lectura. Una sola corrida a la vez lee
cada carta: la toma con una marca en `metadatos.leyendoCarta` (vence a los
3 minutos). Se leen todas las pendientes, una por contenido. Lo que ningún
reintento arregla (archivo, páginas, respuesta inusable) queda anotado en
`datos.sin_leer` y la ficha lo dice; lo pasajero (sin cupo, sin presupuesto,
modelo caído) se reintenta.

**Las lecturas del modelo** de este lote pasan por `leer-documento.ts`
(`checkBudget`, `registrarConsumoDelModelo`, cupo por caso con
`claveDeCupo` y su entrada propia en `RATE_LIMIT_CONFIGS`). El contenido del
documento va al modelo como archivo, con el sistema diciéndole que es dato, y
lo que vuelve pasa por zod y por `esResumenSeguro`. Sin cupo o sin presupuesto la ficha dice «sin leer» y no se
inventa nada.

**Antes del deploy.** La 0041 (`0041_responsabilidad_en_choques.sql`, una
columna `responsabilidad jsonb` que admite NULL) se aplica a mano en staging, QA
y producción, en ese orden, después de la 0040. Sin ella no entra **ningún**
caso: Drizzle lista todas las columnas del esquema en el INSERT a `cases`. El paso «Migraciones aplicadas» de `deploy-checks.yml` y `/api/health` quedan
en rojo hasta que se aplique. El ensayo `alcance-responsabilidad-clara` también la necesita en la
base del ensayo.

**Para revisar.** Un abogado tiene que revisar las citas de la Ley 24.449 (la
regla de vehículo detenido no cita nada porque el art. 39 inc. b no está
verificado). Los paneles nuevos son sólo para los roles que editan el caso: un
viewer no los ve, a diferencia del panel de cobertura. El aviso por mail al
especialista omite la línea «Resumen» entera si el resumen nombra la culpa o la
ley.

### Asignación, vencimientos, plan de trabajo y puntaje (B9, B10, B11 y B13, 2026-09-29)

Cuatro huecos del informe de Clive del 28/09, en la rama
`feat/asignacion-vencimientos-plan-puntaje-b9-b10-b11-b13`, que sale de la de
B18 y B24. Todo es para el equipo que edita el caso. Nada sale al asegurado: ni
la respuesta del agente, ni su prompt, ni las plantillas, ni `AgentMessage.data`,
ni lo que se sincroniza al Core, ni las columnas del CSV.
`tests/unit/analista-no-sale-al-asegurado.test.ts` recorre los imports a mano y
falla si alguno de esos caminos llega a un módulo nuevo o nombra una columna nueva.

**B9: asignación automática.** `src/core/case/asignacion.ts` elige el pool según
las reglas de la aseguradora (tipo de siniestro y/o turno, en hora argentina; gana
la primera que coincide y tiene a alguien que edite casos). El reparto por menor
carga de casos abiertos y el chequeo de que la persona exista y edite los decide
la base en la misma sentencia que asigna (`efectos-de-transicion.ts`). Sólo se
asigna sola cuando es el agente quien lleva el caso a `listo_para_core` o a
`requiere_especialista`, nunca en un cambio de estado manual; sin reglas, el caso
queda sin asignar. La asignación manual y la reasignación (`PATCH /api/cases/:id`) quedan
auditadas con quién las hizo, y `guarda-de-asignacion.ts` decide quién puede
tomar o soltar un caso.

**B10: vencimientos.** `src/core/case/plazos.ts`. El art. 56 de la Ley 17.418
(el asegurador se pronuncia dentro de los 30 días de recibida la información
completa) se ancla a `listo_para_core` y se rotula como orientativo; el art. 46
(el asegurado denuncia dentro de los 3 días) sólo informa en la ficha cuántos
días pasaron del hecho a la denuncia, como señal y no como decisión (ámbar al
pasar los 3, nunca rojo); no vence nada del analista. La cobertura de la ficha
también se rotula como orientativa. Además cada aseguradora
puede definir plazos propios (`tenants.plazos`). Los días son corridos y el
vencimiento cae al final del día argentino. La bandeja ordena y filtra por
vencimiento (`vence_en`), la agenda agrupa los casos con plazo, y las insignias
del navegador viven en `vencimiento-y-banda.ts`, sin zod, para no subir el
bundle. Re-analizar un caso que ya corría su plazo no lo reinicia (el plazo
vigente se reconoce por su clave, porque el worker lo deja en `listo` antes de
volver a `listo_para_core`), y la ficha muestra el título configurado del plazo
propio, no su clave.

**B11: plan de trabajo.** `src/core/case/plan-de-trabajo.ts` y
`case_plan_pasos`. Al llegar el caso a `listo_para_core` (o a `en_liquidacion`
si no lo tenía) se crea el checklist del tipo de siniestro, una fila por paso; el
título se copia al crear y no se regenera si la plantilla cambia. Algunos pasos
se tildan solos al entrar a `en_liquidacion` o `pagado`; los demás los tilda una
persona desde la ficha (`PATCH /api/cases/:id/plan`, auditado). `claimmix_app` no
borra pasos.

**B13: puntaje de complejidad.** `src/core/case/puntaje-complejidad.ts`. De 0 a
100, promedio ponderado de gravedad, fraude, lesiones y el monto estimado
(reusa `MontoEstimado`, B23), más campos propios de la aseguradora. Se recalcula
en la extracción, al confirmar un campo ponderado y al leer un presupuesto. Los
tres caminos cuentan los campos propios con lo guardado en `extracted_fields`,
no con lo que leyó el modelo, así una extracción nueva no deshace lo que confirmó
el analista ni cuenta un campo de baja confianza que nunca se guardó. La
bandeja lo muestra como banda (baja, media, alta) y se puede ordenar y filtrar.

**Configuración por aseguradora.** Pestaña «Trabajo del equipo» de `/agente`
(sólo admin): `GET` y `PATCH /api/admin/trabajo` para las reglas de asignación,
los plazos propios, el plan por tipo y los pesos del puntaje, más la carga de
cada persona. Cada sección se edita como JSON, el servidor lo valida con los
mismos esquemas del núcleo, y `valor: null` vuelve a los valores por defecto.
Cada cambio queda auditado con quién lo hizo y el valor de antes y de después.
Lo nuevo rige desde el próximo evento de cada caso: cambiar la configuración no
recalcula ni reasigna nada.

**Antes del deploy.** La 0042 (`0042_asignacion_plazos_plan_puntaje.sql`: tres
columnas nuevas en `cases`, cuatro en `tenants` y la tabla `case_plan_pasos` con
RLS forzada) se aplica a mano, en este orden y después de la 0040 y la 0041:
`ep-proud-resonance` (la viva, que es también la de los secretos `DATABASE_URL`
del CI), la rama `production` de Veltra (`STAGING_DATABASE_URL`) y
`ep-wispy-flower` (QA). Identificar cada base por su canal de casos, no por su
nombre. Es aditiva e idempotente y no siembra nada. Sin ella no entra **ningún**
caso ni abre ninguna ficha (Drizzle lista todas las columnas), y `/api/health` da
503 hasta que se aplique; además `pnpm permisos` y `pnpm tenancy` necesitan la
tabla nueva.

**Peso del bundle.** Esta tanda suma unos 6 kB al JavaScript del navegador
(los cuatro componentes nuevos y las cadenas de los dos diccionarios). Medido
con `pnpm build && pnpm peso` en Windows: 312 kB antes y 318 kB después,
contra un tope de 310. El primer intento traía zod al cliente (330 kB) y se
separó `vencimiento-y-banda.ts` para sacarlo. Bajar de 310 obliga a sacar código
o a que cada sesión baje sólo el diccionario de su idioma, como ya se anotó en el
commit que subió el tope de 300 a 310; subir el tope es decisión de quien mergea.

### Pregunta por caso, tablero de cartera, métricas del equipo y revisión de calidad (B12, B14, B15 y B22, 2026-09-30)

Cuatro huecos más del informe de Clive del 28/09, en la rama
`feat/chat-tablero-metricas-revision-b12-b14-b15-b22`, que sale de la de B9, B10,
B11 y B13. La migración es la `0043_asistente_y_desvios.sql`: la 0042 ya la usó
B9 a B13 (el plan de esta tanda daba por libre ese número, y no lo estaba).

**B12: preguntar por un caso al asistente Pro.** `src/server/asistente/pregunta-caso.ts`.
`POST /api/asistente` con `caseId` contesta sobre ese caso sin pasar por el
clasificador de intención; sin `caseId` todo sigue como estaba.
`GET /api/asistente?caseId=` devuelve el hilo guardado. El contexto se arma con
`cargarDetalleDeCaso` (el mismo que la ficha), y la respuesta se valida con
`resumenValido` contra los números que constan en el caso antes de mostrarse. El
hilo vive en `asistente_turnos`: un renglón es de un inquilino Y de una persona
(RLS forzada por los dos), así que un colega no lee lo que uno le preguntó. Un
viewer no recibe resúmenes de documentos ni cobertura, y su hilo se vuelve a
enmascarar con `redactString` al leerlo. El cupo es de 30 preguntas por día, por
persona y por caso (`ASISTENTE_CASO`); pasado el cupo o el presupuesto de IA
contesta 200 con `sinLeer` y no guarda nada. Si guardar el turno falla, la
respuesta igual sale. `sin-centinelas.ts` suma el historial del hilo a lo que
se trata como dato y no como instrucción. Los ataques están en
`pnpm pentest` (ver `docs/TESTING.md`).

**B14: tablero de cartera.** `/metricas` elige el período con `?periodo=` (el mes
en curso por defecto) y las tarjetas y las distribuciones —por situación, por tipo
y los analistas con más casos— lo siguen; antes eran de todo el histórico. La
serie de actividad cuenta los casos abiertos cada día por su situación **actual**.
`?vista=historial` muestra los últimos doce meses mes a mes, y
`GET /api/metricas/export.csv` los baja, sin datos de personas ni de casos. Las
consultas leen la auditoría con literales de evento para que use el índice parcial
`idx_audit_log_trayecto`, y `getTenantKpis` sigue siendo un solo viaje.

**B15: métricas del equipo.** Mediana de horas de recibido a listo y a cierre
(`ciclo.mediana_horas_listo`), mensajes por caso (los del asegurado más los
WhatsApp que salieron), completado confirmado por una persona (la tarjeta
`completitudAuto` pasó a `completadoConfirmado`) y «dónde se quedan los casos»,
las estadías por situación. La tasa «sin intervención» es una cota inferior: el
denominador son los reclamos de canal real del período y una intervención cuenta
si ocurrió antes de `listo`. La primera estadía y las que siguen abiertas no
entran a las estadísticas, ni el `listo` intermedio de una extracción completa ni
los cambios de situación que no se aplicaron.

**B22: revisión nocturna de calidad.** `src/core/desvios/reglas.ts` y
`src/server/desvios/revision-nocturna.ts`. Cuelga del cron de `reap-stuck`, con
una guarda de 60 s para no comerse la purga y un cupo de una vez por día
(`REVISION_DE_DESVIOS`: GitHub Actions llama a esa ruta cada 15 min y la revisión
son cinco `INSERT ... SELECT` sobre toda la auditoría), y cada regla corre aislada: si una
falla se registra (`desvios.regla_fallo`) y las demás siguen. Cinco reglas, todas
sobre casos de canal real: **(a)** un documento pedido hace más de 72 h y sin
recibir en un caso que espera al denunciante; **(b)** un caso cerrado en los
últimos 30 días que nunca pasó por un estado de completado (salvo el cierre por
abandono); **(c)** una derivación al equipo de más de 24 h que ninguna persona
tomó; **(d)** un plazo (`vence_en`, B10) vencido en un caso abierto; **(e)** un
caso cerrado en los últimos 30 días con pasos manuales del plan (B11) sin hacer.
Cada hallazgo se guarda en `case_desvios`, con clave (caso, regla, ancla): el
ancla es el instante del hecho, así que correr dos veces no duplica y un plazo
recalculado es otro desvío. Un desvío es historia y no se resuelve solo cuando el
caso se arregla. `/desvios` lista los hallazgos, del más nuevo al más viejo, con
un enlace al caso por fila; es para `REVISION_ROLES` (owner, admin y specialist,
porque no existe un rol supervisor) y el resto vuelve a la bandeja. El titular
sale tapado para quien no ve el padrón (`titularParaElRol`, compartida con la
agenda). No llama al modelo.

**Antes del deploy.** La 0043 crea `asistente_turnos` y `case_desvios` (las dos con
RLS forzada, y `case_desvios` de sólo lectura para `claimmix_app`; la escribe el
barrido con el rol dueño) y el índice parcial `idx_audit_log_trayecto`. Se aplica
a mano, en este orden y después de la 0042: `ep-proud-resonance` (la viva, que
es también la de los secretos `DATABASE_URL` del CI), la rama `production` de
Veltra (`STAGING_DATABASE_URL`) y `ep-wispy-flower` (QA). Identificar cada base
por su canal de casos, no por su nombre. El índice se crea sin `CONCURRENTLY`
porque `migrate.mjs` corre cada archivo en una transacción; en una base con mucha
auditoría conviene crearlo antes a mano, con `CONCURRENTLY`. Es aditiva e
idempotente. Sin ella `/api/health` da 503 y `pnpm permisos`, `pnpm tenancy` y
`pnpm capa-datos` necesitan las dos tablas.

**Lo que no se probó.** El SQL de la revisión nocturna corre contra Postgres en
la sección 7 de `pnpm capa-datos` (dos veces seguidas, para ver que la segunda no
repite nada), sobre un inquilino descartable. No se midió el p95 del tablero
contra una base con meses de auditoría. El primer barrido puede marcar hasta 30 días de casos ya cerrados. `cierre_sin_listo`
sólo mira casos abiertos después de la primera auditoría de un cambio de estado
del agente (`AUDITORIA_DEL_AGENTE_DESDE`): antes de eso el agente no dejaba rastro
y un caso viejo saldría como desvío sin serlo.

**Peso del bundle.** Sin cambios: 307 kB contra el tope de 310, medido con
`pnpm build && pnpm peso`. Los textos nuevos que sólo pinta el servidor viven en
`es-AR.servidor.ts` y `en-US.servidor.ts`; al navegador sólo llegaron `nav.desvios` y
las cadenas de la caja del asistente.

### Padrón por CSV, formulario web público y ramos nuevos (B16, B17 y B26, 2026-09-30)

Tres huecos más del informe de Clive del 28/09, en la rama
`feat/padron-formulario-ramos-b16-b17-b26`, que sale de la de B12, B14, B15 y B22.
La migración es la `0044_formulario_web_y_ramos.sql`. Es el único cambio de base.

**B16: padrón.** `src/core/padron/` (puro) y `src/server/padron/`. El CSV de
clientes y pólizas se sube a `POST /api/padron/vista-previa`, que dice qué filas
entran, cuáles se actualizan y cuáles traen error, sin escribir nada;
`POST /api/padron/importar` las aplica de a 500 filas con `enTenantVarias`.
También hay alta y edición a mano de clientes y pólizas
(`/api/customers/[id]`, `/api/policies/[id]`). Es cosa de admin y editor.

**B17: formulario web.** `/denuncia/[slug]` es público y lleva al inquilino por su
`slug`, nunca por el id interno. Nace apagado y se enciende desde `/agente`
(`FormularioWebPanel`). La página firma un token HMAC derivado por HKDF de
`BETTER_AUTH_SECRET`; además hay un campo trampa y límites por IP, por slug y por
correo en el limitador de Postgres. La denuncia entra como canal `web`, pasa por
el mismo despachador de extracción (`despachar-extraccion.ts`) y el seguimiento
sigue por correo.

**B26: ramos.** `src/core/case/ramos.ts` suma ART, vida, integral de comercio y
consorcio a los nativos. Cada aseguradora puede crear tipos propios, con nombre en
las dos lenguas y sus documentos y datos (`/agente`, pestaña «Tipos de siniestro»;
tabla `tenant_claim_types`). `cases.claim_type` deja de ser lista cerrada: el
CHECK sólo exige el formato de la clave.

**Peso del bundle.** 309,8 kB contra el tope de 310, medido con
`pnpm build && pnpm peso`. Esta tanda traía 310,5: las oraciones de
`FIELD_LABELS` que sólo lee el servidor pasaron a
`src/lib/labels/instruccion-de-campo.ts` y dejaron de viajar al navegador.

### Seguridad demostrable para vender a una aseguradora (B19, 2026-09-30)

Un hueco más del informe de Clive del 28/09, en la rama
`feat/seguridad-demostrable-b19`, que sale de la de B16, B17 y B26. La migración
es la `0045_sso_y_purga_de_adjuntos.sql`, aplicada a mano el 30/09 en producción
(`ep-proud-resonance`), staging y QA y verificada en vivo: RLS y `FORCE`, las dos
políticas, los cuatro índices y `claimmix_app` con sólo `SELECT` e `INSERT` en la
cola. PR #363.

**SSO OIDC por inquilino.** Plugin propio de Better Auth (`sso-inquilino`,
`src/lib/auth/sso-inquilino.ts`) con el núcleo puro en `src/core/sso.ts` y la red
en `src/server/sso/`. Un IdP por aseguradora, en `/configuracion`
(`SsoPanel`, servidor) y `/api/admin/sso` (GET, PUT, POST para verificar el dominio, PATCH para activar o exigir). El dominio del mail
sólo vale si se prueba con un TXT; la coincidencia es exacta y los proveedores
de correo abierto no entran. El callback valida firma (`jose`), `iss`, `aud`,
`nonce` y dominio. «Exigir SSO» apaga la contraseña y Google para ese dominio y
cierra sus sesiones; pide que el propio admin ya tenga su cuenta `sso:<inquilino>`
(no la de cualquiera), niega el alta por contraseña de ese dominio antes de crear
la cuenta, y deja pasar el alta hecha por un admin y el cambio de contraseña. Las
cuentas `sso:*` no están en `trustedProviders`, pero quien ya existía en el mismo
inquilino con ese mail se vincula por su id (las cuentas locales nacen con el mail
sin verificar; sin esto «exigir» dejaba afuera al admin). Cambiar issuer, dominio
o `client_id` apaga `activo` y `exigir`, y el secreto viejo no sobrevive a otro
issuer ni a otro `client_id`. Tabla nueva `sso_settings`, con RLS `FORCE` y el
secreto cifrado `aes-256-gcm`.

**Borrado diferido y recuperable de adjuntos.** Borrar un caso (`deleteCases`)
anota sus adjuntos en `adjuntos_por_purgar` en el mismo lote. El cron
`reap-stuck` los borra de R2 pasada la gracia (`PURGA_GRACIA_DIAS`, 30), de a 50
y uno por uno (`src/server/storage/purgar-adjuntos.ts`). `claimmix_app` sólo lee
e inserta en la cola, que sólo se agrega: sin `UNIQUE` ni `ON CONFLICT`, manda la
fila más nueva por `storage_path` y una purga lograda cierra las viejas del mismo
objeto. La purga y la retención corren UNA vez por día (cupo de 24 h pedido dentro
de la ventana de las 04 UTC): sin él, las cinco llamadas de esa hora gastaban los
cinco intentos de la purga. `PURGA_ADJUNTOS_MODO` nace en `apagado`.

**Retención de casos.** `src/server/cases/retencion.ts` y `src/core/retencion.ts`:
casos cerrados (`cerrado`, `pagado`, `rechazado`) con `closed_at` anterior a
`RETENCION_ANIOS` (5). Sólo dentro de la hora 04 UTC del cron y una vez por día,
hasta 200 por inquilino por corrida, y el `DELETE` vuelve a comprobar estado y
`closed_at` con el mismo predicado (`cerradoAntesDe`) que usa el listado.
`RETENCION_MODO` nace en `apagado`; `simular` sólo cuenta. No toca clientes,
pólizas, `audit_log` ni `no_relevante`. No hay cron nuevo.

**Pen test más ancho.** `pnpm pentest` suma `attackSso` (las rutas del plugin y
`/api/admin/sso` sin sesión, y un dominio privado desconocido) y tres sondas de
`cualesBorra` en la pared entre inquilinos. Sigue siendo de sólo lectura en
producción. `scripts/prove-data-layer.mts` suma la sección 5 (borrar el caso del
inquilino de al lado), que escribe y por eso sólo corre en CI o con `--escribe`.

**Documento de respuestas.** `docs/SEGURIDAD.md`, en formato CAIQ-lite: regiones,
cifrado, aislamiento, roles, SSO, retención, subprocesadores, backups y las
deudas dichas tal cual. Lo que no se pudo verificar dice «a verificar». La
política de privacidad pública no se tocó: el texto propuesto está en el
documento.

**Peso del bundle.** 309,87 kB contra el tope de 310, medido con `pnpm build && pnpm peso` (`pnpm peso` imprime 310 redondeado): B19 no sumó nada al navegador. El panel del SSO es un componente de servidor montado desde `configuracion/page.tsx`, y el margen que había era de 0,13 kB.

### 📊 La carga del tablero de métricas vuelve bajo 500 ms (0046, 2026-10-01)

Los diez lotes llegaron a main con la promoción #364 (cbf4d30), y el Post-deploy
de producción (run 36792967193) dio «Carga de lectura» en rojo, y era real: el
tablero de L8 (`getTenantKpis`) daba p95 de 1,3 s (mes) y 1,5 s (año + serie) con
20 analistas. El tope de 500 ms no se tocó. Arreglo en el PR #365, con la migración
`0046`, aplicada a mano el 01/10 en QA, producción (`ep-proud-resonance`) y
staging, con el acumulador sin diferencias contra `ai_usage`.

- **Cuellos.** El lateral `cambios` de `consultaDeCuellos`
  (`src/server/metrics/trayecto.ts`) lleva `offset 0`. Bajo RLS `uuid_out` no es
  leakproof, así que `target_id = c.id::text` no bajaba como condición de índice
  y el planner aplanaba el lateral en un Hash Join sobre toda la auditoría.
- **Uso de IA.** Las cuatro lecturas del tablero leen `ai_usage_mensual` en vez
  de recorrer `ai_usage`. La tabla la mantiene el trigger `trg_ai_usage_mensual`,
  la primera función `SECURITY DEFINER` del repo; la app sólo lee el acumulador.
  Si diverge, se recompone reaplicando la `0046` entera, nunca el backfill suelto.

La promoción #366 (8e7159c) dejó el Post-deploy de producción verde entero (run
36822794378). Peor caso de la Carga 492 ms (año + serie con 20 analistas), contra
1,5 s antes: pasa con 8 ms de margen, así que una consulta nueva sobre el tablero
se mide con `pnpm load` antes de promover. `pnpm check` completo verde el mismo día,
con 25 conversaciones sin diferencias.

En el mismo PR que esta nota, el override `brace-expansion@1` sube a `>=1.1.21`:
la 1.1.18 que traía eslint por `minimatch` 3 tenía dos alertas altas de Dependabot
(GHSA-qhr7-859c-m2p7, GHSA-6j4f-fj2g-mc7p) y una media (GHSA-q2hr-2g5m-vwhr), sólo
en desarrollo.

### 🔐 Auditoría con el skill de Cloudflare (security-audit-skill, 2026-10)

Corrida `run-1` del skill `security-audit` de Cloudflare sobre ec6b2fa (perfil
standard), sólo lectura de código: el host Windows no tiene sandbox, así que no se
ejecutó nada del repo. Siete olas de búsqueda con libro de cobertura (54 unidades),
tres votos independientes por candidato y un verificador fresco por registro final.
La séptima ola no trajo candidatos y el crítico final no pidió más trabajo. Quedaron
cuatro hallazgos confirmados (uno medio y tres bajos), diecinueve pistas para que
confirme el dueño y ningún hallazgo alto ni crítico.
Informe en `C:/Users/Ilan/security-audit-skill/claimmix/run-1/REPORT.md`, con
`FINDINGS-DETAIL.md` y `NEEDS-VALIDATION.md` al lado.

**Arreglado en este PR**

- Correo entrante: `dmarc=fail` cuenta como falla, y el `dmarc=pass` del primer
  encabezado de mx.google.com gana sobre spf softfail o dkim=fail
  (`src/core/email/autenticacion.ts`). Un mail con autenticación fallida nunca se
  suma a un caso existente (`thread-lookup.ts`). El poller saltea SPAM y TRASH.
- Respuestas: el destinatario se reduce a una sola dirección pelada
  (`bareAddress`); una lista de direcciones da `INVALID_RECIPIENT`
  (`src/server/email/dispatch.ts`).
- AC24 también en los ecos: el pedido de datos y el recordatorio repiten el
  documento y la póliza tapados (`orchestrate.ts`, `reenvio.ts`).
- La respuesta redactada por el modelo no puede traer enlaces ni direcciones de
  mail inventadas (`compose-reply.ts`, `pregunta.ts`); el resumen de la alerta al
  especialista se descarta si trae salto de línea, enlace, mail o dominio suelto
  (`specialist-alert.ts`, `mensaje-tardio.ts`).
- Sesiones con vencimiento absoluto de 30 días: ya no se renuevan con el uso
  (`src/lib/auth/index.ts`, `disableSessionRefresh`). Quien entró por contraseña
  vuelve a entrar al mes aunque la use todos los días.
- `/api/auth/verify-password` contesta 404 (la app no lo usa) y
  `/api/auth/change-password` tiene cupo en Postgres por persona
  (`AUTH_CAMBIO_CLAVE`, 5 cada 10 min); la pantalla de configuración muestra el
  aviso de demasiados intentos en es-AR y en-US.
- Casilla de Gmail: no se puede conectar una casilla que ya conectó otra
  aseguradora (`mailbox_taken`), y la lectura global por dirección ordena por
  `(created_at, id)`.
- Demo pública: un tope global de 100 admisiones por día, atómico, corre antes de
  `checkDemoBudget`, así que una ráfaga ya no desborda el gasto.
- WhatsApp: volver a alojar los medios respeta el tope de excedente E12
  (`intake-agent.ts`).
- Memoria del caso: los valores confirmados pasan por `sinCentinelas` antes de
  entrar en las pistas del prompt (`prompt.ts`).
- `audit_log`: `agent.note` y `specialist_required` se guardan redactados.
- Webhook de Gmail: un aviso de una casilla que no está conectada se confirma y se
  ignora (`listEnabledGmailAccounts`); antes caía al sondeo de la casilla de
  entorno.
- Operadores: `requireOperator` también exige `emailVerified`, así que un
  operador sin verificar pierde `/admin/cartera`. `POST /api/admin/users` no da
  de alta direcciones de `ADMIN_EMAILS` (`usuarios.error.operador`, es-AR y
  en-US).
- Google: una identidad cuyo perfil no trae `email_verified` en true no entra, no
  se enlaza a una cuenta existente y no da de alta (`user.validateUserInfo`).
  `/login` explica el error `email_no_verificado`. Antes, como Google es
  proveedor de confianza, Better Auth enlazaba sin mirar la marca.
- Adjuntos de Gmail: se bajan a lo sumo 20 partes por mensaje; las 20 siguientes
  quedan como rechazadas y el resto sólo se anota en el log. Cada bajada tiene
  un plazo de 15 s, y una bajada que falla deja una fila `download_failed` en vez
  de desaparecer. El texto de ese rechazo ya no dice «de WhatsApp».
- CI: los jobs de integración y E2E de cada PR generan un `BETTER_AUTH_SECRET`
  descartable y enmascarado por corrida en vez de leer el secreto del
  repositorio. El ensayo de producción (`deploy-checks.yml`) siguió con el suyo
  hasta #382.

**Resueltos en #382**

Las diez decisiones que quedaban abiertas se cerraron en un solo PR, con una
sola migración (la 0047).

- **From falsificado con autenticación neutra.** Para el canal `email`,
  `remitenteVerificado` (`src/core/email/autenticacion.ts`) pide prueba a favor:
  `spf=pass`, `dkim=pass` o `dmarc=pass` alineados con el dominio del From (el
  mismo dominio o un subdominio; en el `dmarc=pass` cuenta su `header.from`), leídos sólo del primer encabezado
  `Authentication-Results` de mx.google.com, porque los de abajo los pudo escribir
  el remitente. Sin esa prueba el mail no se suma a un caso existente
  (`thread-lookup.ts`) y el remitente no cuenta como autenticado en el worker, en
  la pantalla del caso ni en las confirmaciones. `email_sim`, WhatsApp y el
  formulario web siguen como estaban. Consecuencia: quien escribe desde un dominio
  sin DMARC, SPF ni DKIM alineado abre un caso nuevo en vez de seguir el viejo.
  `bareAddress` saca los comentarios `( )` y las comillas sin cerrar antes de
  buscar el `<...>`: un `From: atacante@example.com (<victima@example.com>)` es del
  atacante, no de la víctima, aunque los dos dominios alineen.
- **Alta anticipada de una dirección permitida.** `/registro` ya no pide
  contraseña: crea la cuenta con una al azar que nadie conoce, no deja sesión
  (`autoSignIn: false`) y manda el enlace de restablecimiento desde la casilla del
  inquilino. Quien abre el enlace elige su contraseña y entra; si la cuenta no
  tenía perfil, `on-password-reset` se lo da con el correo verificado. Todos los
  finales (creada, ya existía, sin casilla) redirigen a
  `/login?aviso=revisa_tu_correo`, así que tampoco se averigua qué direcciones
  existen. El mail consume el mismo cupo `auth:reset` que `/recuperar`, y el alta
  lo descuenta para cualquier dirección, esté o no en la lista: si no, el 429 de
  `/recuperar` delataba quién está habilitado. Quien da
  de alta una dirección ajena ya no la bloquea: el enlace le llega a su dueña.
- **Gasto de IA por tráfico anónimo.** Tres frenos. `checkBudget`
  (`src/server/ai/budget.ts`) suma un sub-tope diario para las llamadas sin
  `userId` (`AI_ANONIMO_DAILY_TOKEN_CAP`; sin la variable, el 60 % de
  `AI_TENANT_DAILY_TOKEN_CAP`, o sea 12 M de los 20 M de producción), así que lo
  que gasta quien no está logueado no deja sin cupo al equipo que sí. Cuando salta
  el tope mensual, el del inquilino o el anónimo, un correo avisa a los
  especialistas (`avisarPresupuestoAgotado`, a lo sumo uno por día y por
  inquilino, con el evento de auditoría `ai.budget_alerted`). Y el correo tiene
  cupo por remitente (`EMAIL_POR_REMITENTE`: 20 en 10 minutos, con la dirección
  hasheada): del mensaje 21 en adelante se guarda sin leerse, queda marcado para
  que lo conteste una persona y el poller no despacha el worker.
- **Casilla de Gmail repetida entre aseguradoras.** La migración 0047 crea el
  índice único `gmail_accounts_email_unica` sobre `lower(email)`, global entre
  inquilinos. Cierra la carrera entre dos callbacks de OAuth y la rehabilitación
  desde el panel: una fila deshabilitada sigue ocupando la casilla, y para
  liberarla hay que borrarla. Ante un 23505 el callback redirige a
  `mailbox_taken`, como ya hacía con su chequeo previo. Se aplicó a mano antes del
  merge en QA, producción y staging, sin duplicados previos; vuelta atrás:
  `DROP INDEX IF EXISTS public.gmail_accounts_email_unica`.
- **CRON_SECRET en Preview.** El alcance Preview de Vercel lleva un `CRON_SECRET`
  propio, distinto del de producción, y el repositorio guarda ese mismo valor como
  `PREVIEW_CRON_SECRET`. Sólo lo usa `load-tests.yml`, que elige entre
  `CRON_SECRET`, `QA_CRON_SECRET` y `PREVIEW_CRON_SECRET` según el destino ya
  resuelto. `deploy-checks.yml`, `post-deploy.yml` y `barrer-trabados.yml` aceptan
  sólo `claimmix-dev.vercel.app` y `claimmix-qa.vercel.app` (prd va por su propio job,
  con `vars.PRD_URL`): el deploy de una rama no
  recibe ningún secreto de producción ni de QA. Sin `PREVIEW_CRON_SECRET` el paso
  de diagnóstico de la Carga contra un Preview no interroga y la medición sigue
  igual.
- **El watch de Gmail sobrevive a la casilla deshabilitada.**
  `PATCH /api/admin/gmail-accounts` corta el watch al deshabilitar y lo vuelve a
  pedir al habilitar; la respuesta trae `watch` (`detenido`, `registrado`,
  `sin_cambio` o `fallo`). Un fallo no revierte el cambio de `enabled`: el cron
  renueva sólo las habilitadas y el webhook ignora los avisos de las demás.
- **Enlaces del formulario web reusados.** `DENUNCIA_WEB_SLUG_DIA` pone 300
  denuncias por día por formulario, sumadas todas las IP (el tope por hora dejaba
  pasar 4.800 al día rotando direcciones). Pasado el tope el envío abre el caso y
  la persona ve el mismo éxito, pero lo lee una persona y no la IA
  (`claim.message_not_read` con `tope_por_formulario`).
- **Qué identidad desbloquea qué consulta.** Las herramientas del agente
  (`agent-tools.ts`) ya no aceptan un DNI que escriba el modelo: `verificar_poliza`
  y `polizas_por_dni` usan el DNI que la persona misma dio en la conversación (el
  que el extractor sacó de lo que escribió, nunca el del padrón); sin DNI,
  `polizas_por_dni` contesta que falta y el agente lo pide. Además
  `compose-reply.ts` rechaza una respuesta que repita un dato del padrón que la
  persona no escribió (`dato_del_padron`): el agente pide confirmar sin dictar el
  número de póliza ni la patente que encontró.
- **Revocación por persona.** `DELETE /api/admin/users/[id]/sessions` cierra todas
  las sesiones de una persona del inquilino, con un botón en la pantalla de
  usuarios y el evento `auth.user_sessions_revoked`. Un admin no cierra las de un
  owner, y nadie cierra la propia por acá. Las sesiones abiertas caen dentro de
  los 60 s del `cookieCache`, pero la persona puede volver a entrar: no la deja
  afuera. Eso lo hace la baja (0053, `DELETE /api/admin/users/[id]`, evento
  `auth.user_deactivated`), que marca `users.dado_de_baja_en`, cierra sus sesiones
  y le niega cualquier sesión nueva por contraseña, Google o SSO. Las dos pantallas
  lo dicen.
- **Secreto de sesión que vieron los PR.** Ningún workflow lee ya el
  `BETTER_AUTH_SECRET` del repositorio: `ci.yml` y los pasos de `deploy-checks.yml`
  que importan `@/lib/auth` generan uno propio por corrida
  (`openssl rand -hex 32`, enmascarado), y `deploy-checks.yml` ya no lo declara
  ni lo hereda, así que QA dejó de pasar `QA_BETTER_AUTH_SECRET`. Los dos secretos
  del repositorio se borran después del merge. En la promoción se rotaron
  `BETTER_AUTH_SECRET` (sólo Vercel Production) y el `CRON_SECRET` de producción
  (Vercel, secreto del repositorio y `.env.local`): se cerraron todas las sesiones
  y los formularios web abiertos en ese momento piden recargar. No había dominios
  SSO pendientes de verificar, y los tokens de las casillas de Gmail se cifran con
  `GMAIL_TOKEN_ENCRYPTION_KEY`, que no cambió.

**Lo que quedó fuera de #382, a propósito**

- `/api/auth/sign-up/email` de Better Auth no se cierra con `disableSignUp`, que
  bloquearía también `auth.api.signUpEmail`, el que usan `/registro`,
  `/api/admin/users` y dos scripts. Se cierra por HTTP: la ruta
  `src/app/api/auth/[...all]/route.ts` lo contesta `NOT_FOUND` (`SIN_SALIDA`), y el
  alta por correo queda sólo en el servidor. Aun así, una cuenta creada por ahí
  antes de este cambio, con contraseña propia y sesiones abiertas, no recibe el
  perfil al restablecer: `onPasswordReset` se lo da únicamente si no tenía
  sesiones que cerrar (`auth.reset.perfil_no_dado_con_sesiones`), y un admin se lo
  adjunta a mano.
- El `cookieCache` de 60 s no se invalida al revocar sesiones: pide un hook de
  Better Auth o bajar `maxAge`, y `src/lib/auth/index.ts` ya decidió que el camino
  es invalidar y no acortar.
- Borrar una casilla de Gmail no corta el watch: el token de refresco se va con la
  fila y Google lo deja caer solo al revocarse el permiso.
- `remitenteVerificado` compara «igual o subdominio», que es DMARC en modo relajado
  y lo que Gmail ya evalúa en `dmarc=pass`; no usa la lista pública de sufijos
  (una dependencia nueva para un caso que la cabecera ya resuelve).
- Tope por remitente para `email_sim` (el ensayo se toparía a sí mismo) y para el
  formulario web por dirección (ya tiene `DENUNCIA_WEB_MAIL`, 3 por hora).
- Tabla o columna nueva para el tope anónimo, el aviso de presupuesto o los cupos:
  todo sale de `ai_usage` (con `user_id` nulo para lo anónimo) y de
  `rate_limit_counters`.
- Quitar los previews de `load-tests.yml`: es el único workflow al que le sirven
  (medir un PR antes de qa), y por eso existe `PREVIEW_CRON_SECRET`.
- Un mail de invitación propio para el alta: el de restablecimiento ya existe,
  sale de la casilla del inquilino y no registra el enlace.
- Sacar el DNI de la póliza encontrada cuando la persona no lo dio: la decisión es
  justamente que las consultas no se alimenten del padrón.

**Cerrado después de #383**

- **Dependabot #11 (`braces` <= 3.0.3, sin versión arreglada).** El único camino era
  eslint-config-next → `@next/eslint-plugin-next` → `fast-glob` 3.3.1 → micromatch →
  braces, y upstream sigue fijando fast-glob 3.3.1. El override
  `"@next/eslint-plugin-next>fast-glob": "npm:tinyglobby@^0.2.17"` saca 16 paquetes
  del lockfile, braces incluido (#384 a qa, #385 a main). Vale mientras nadie ponga
  `settings.next.rootDir` en la config de ESLint: tinyglobby expande un directorio sin
  glob a todo el árbol y con rutas absolutas de Windows devuelve []. Al subir
  eslint-config-next, mirar si el plugin dejó fast-glob y sacar el override. El mismo
  PR estabilizó el test «sin red» de plan-de-trabajo con `waitFor`.
- **Dependabot #375-#379, en lote.** Los cinco rangos suben en un solo PR a qa, porque
  sueltos no pasan el CI. El lockfile resuelve `@sentry/nextjs` 11.5.0, `jose` 6.2.12,
  `@testing-library/react` 16.3.3, `dotenv` 18.0.6 y `drizzle-kit` 0.31.11. Peso del
  bundle 299 kB.
- **Notas de endurecimiento de la ola 7 (scripts de CI, no eran hallazgos).**
  - `scripts/prove-data-layer.mts`: las secciones 5 y 6, que escriben y borran filas
    marcador, ya no corren si `DATABASE_URL` o `DATABASE_URL_APP` apuntan a
    `ep-proud-resonance` (la base de producción), si `DATABASE_URL` no es una URL o si
    las dos apuntan a bases distintas (la 5 sembraría en una y borraría en la otra);
    en ese caso el chequeo falla en vez de saltearse. Una `DATABASE_URL_APP` que no es
    URL corta antes de crear el pool, porque el TypeError del driver imprimía la
    cadena entera con la contraseña.
  - El host se lee con `hostDe()` de `tests/e2e/base-de-ensayo.ts`, el mismo que usan
    la guarda de los e2e y `sembrar-adjunto-grande.mts`: en minúsculas y con el
    `?host=` que el driver de Neon prefiere al de la URL, así un esquema en mayúsculas
    o un `?host=` no esquivan el veto.
  - La sección 4 se quedó fuera del gate a propósito: sólo escribe si la política la
    deja pasar, y en ese caso borra la fila enseguida. La cabecera del script ahora
    lo dice.
  - `explicar()`, el catch de `prove-tenancy.mts` y un manejador de
    `uncaughtException` en los dos scripts imprimen el código y la primera línea del
    mensaje con las URLs tapadas (`resumenDe()`), no el mensaje crudo del driver.
  - `prove-tenancy.mts` avisa cuando cae de `DATABASE_URL_APP` a `DATABASE_URL`.
  - En GitHub Actions los dos scripts tapan los nombres de los inquilinos con
    `::add-mask::` (`taparEnElLog()`, que escapa `%` y los saltos de línea).

### 📞 El número de WhatsApp por código, y la retoma tras un corte (2026-10-08)

Un PR con dos partes que no se tocan.

- **Número por código (apagado al escribirse; prendido en prd desde el 09/10).** Desde Configuración, el owner o el admin de un
  espacio del alta automática pide el código por SMS o llamada, lo escribe, y Meta
  suma su número a la WABA de la plataforma (`src/server/alta/numero-automatico.ts`,
  cliente de Graph en `src/server/whatsapp/alta-de-numero.ts`). Sólo corre con
  `ALTA_NUMERO_AUTOMATICO=1`, que cuando entró este PR no estaba en ningún ambiente (desde
  el 09/10 está en prd, ver «Estado al 2026-10-09»): sin ella, o sin la
  0049, nada llama a Graph. Sólo móviles argentinos (`+549` y diez dígitos), y el
  nombre visible es el del número de la plataforma. Cualquier caso raro termina en
  «revisión» con un mail al operador; `/admin/altas` sigue de respaldo. El número de
  la plataforma no se toca y nada borra números de la WABA. Los pasos, los topes y
  qué hacer con cada aviso están en `docs/whatsapp-setup.md`, parte F.
- **Tope de Meta.** Sin verificar la empresa, 2 números por portfolio y el de la
  plataforma ya ocupa uno: hoy entra un solo número automático. Es lo que dice la
  documentación, no se midió.
- **Retoma tras un corte.** Si una extracción anterior del caso falló por algo
  pasajero (`intentos_de_extraccion > 0`), la corrida siguiente lleva la corrección
  de concisión desde el primer intento y los dos intentos van a temperatura 0,3.
  Ojo con lo que mide la señal: `reintentarPorTimeout` suma por plazo, por 429 y por
  red caída (`esPasajero`), no sólo por una salida desbocada, y el contador no se
  reinicia nunca. O sea que vale para toda extracción posterior de ese caso, también
  la de un turno nuevo de la conversación, y no sólo para el reintento inmediato.
  Sin columna nueva; `maxOutputTokens`, el `thinkingBudget`, el plazo de 30 s y el
  no-reintento tras TIMEOUT quedan como estaban. Que esto corte las salidas
  desbocadas es una hipótesis: se valida con `pnpm rehearse <escenario>` y
  `pnpm smoke`, leyendo el transcripto.
- **Riesgos aceptados.** Las ventanas de 24 h de los cupos son fijas (en el borde del
  día se duplica el tope) y los cupos globales se comparten entre espacios; hoy manda
  el tope de Meta, así que no pesa. Los cupos de código no se devuelven una vez que
  se tocó Graph (el recorrido de la WABA también cuesta), y los de alta sólo cuando
  Meta pide aflojar: ante un timeout al agregar, el número pudo entrar y lo mira el
  operador (aviso `incierto`). La bienvenida de la bandeja dependía sólo de la
  bandera (se borró el 28/10 con L2); hoy lo que mira sólo la bandera es el aviso
  del número en `/alta`: por eso la 0049 se aplica antes de prenderla.

### Ambiente prd: tres proyectos y una base por cliente (2026-10-08, rama `feat/prd-bases`)

El plan: `claimmix` pasa a ser **dev** (mismo `project_id`, mismo pool WIF `vercel`, misma
base `ep-proud-resonance` con sus datos reales, alias `claimmix-dev.vercel.app`), `claimmix-qa`
no cambia, y la producción de los clientes es un proyecto nuevo, **`claimmix-prd`** (rama `prd`,
Neon Free `claimmix-prd` con una base de control `neondb` y una `t_<hex>` por cliente, R2,
pool WIF y topic de Pub/Sub propios). Recibe `claimmix.vercel.app` por un move atómico de
Vercel. La rama `ensayo` de ese proyecto, con endpoint propio y sin Vercel, es sólo para
`pnpm bases:probar`. Los pasos en orden, el Ignored Build Step de los tres proyectos, el orden
del move y la regla de a lo sumo una promoción a prd por día están en `docs/PROMOCION.md`
(sección «Prd»); cómo se prueba, en `docs/TESTING.md` (capa 9, «Después de cada deploy» y
`/api/health`).

- **Estado al 2026-10-09.** El código entró por #396 (a `qa`), #397 (a `main`) y #398 (a
  `prd`); el primer deploy de `claimmix-prd` está READY. La 0050 está aplicada a mano en las
  cinco bases (QA, dev, staging, control de prd y la rama `ensayo`), el inquilino casa tiene
  su base lista y su perfil control, y en prd están prendidas `BASE_POR_CLIENTE`,
  `ALTA_AUTOMATICA`, `ALTA_NUMERO_AUTOMATICO` y el remitente del alta (también en dev). El
  move del dominio se hizo el 09/10 con el OK del dueño: `claimmix.vercel.app` es prd (sigue
  respondiendo `claimmix-prd.vercel.app`), dev quedó en `claimmix-dev.vercel.app` y
  `vars.PRD_URL` apunta al dominio nuevo. Vertex anda en prd por el pool WIF `vercel-prd`; el
  webhook de WhatsApp y el push de Gmail de dev apuntan a `claimmix-dev`, y prd tiene su
  propio tópico `gmail-push-prd`.
- **Falta:** la prueba de punta a punta de un alta con el dueño, 24 h de logs y la
  verificación del negocio en Meta. R2 de prd quedó el 09/10 (#401) y Turnstile anda en dev y
  en prd (leído en `/registro` el 16/10).
- **El flag es de ida.** Con clientes vivos no se apaga `BASE_POR_CLIENTE`: la base de
  control no tiene sus datos de negocio. Para frenar se usa `ALTA_AUTOMATICA=0` y se arregla
  hacia adelante.
- **Bloqueantes abiertos:**
  1. ~~La cadena de migraciones 0001 a la última nunca corrió sobre una base vacía.~~
     Resuelto el 2026-10-09: corrió en control de prd y en la base del inquilino casa, y
     `pnpm bases:probar` salió verde contra la rama `ensayo`.
  2. Meta permite 2 números en la WABA hasta verificar el negocio.
  3. La pantalla de consentimiento de Google tiene que estar publicada; con los scopes de
     Gmail sin verificar hay un tope de 100 usuarios que comparten dev, QA y prd.
  4. ~~Confirmar que Vercel acepta mover un `*.vercel.app` entre proyectos.~~ Resuelto el
     2026-10-09: el move anduvo.
  5. Los términos de Vercel Hobby son de uso no comercial y prd tendría clientes que pagan.
     El dueño decidió no usar planes pagos; queda señalado.
- **Dónde se apartó la documentación del plan:** el plan decía que `claimmix` construye sólo
  `main`; los pasos 3 y 5 de `docs/PROMOCION.md` y `load-tests.yml` dependen de sus vistas
  previas, así que el Ignored Build Step de `claimmix` saltea `qa` y `prd` y construye el resto.

### Alta corta: correo y WhatsApp con el mínimo de pasos (2026-10-09, rama `feat/alta-corta`)

Para que un cliente nuevo de prd termine con su correo y su WhatsApp conectados sin pasar
por el operador. Con `BASE_POR_CLIENTE` y `ALTA_NUMERO_AUTOMATICO` apagadas no hay
`/preparando` ni número por código.

- **WhatsApp mientras se prepara la base.** `/preparando` muestra el formulario del número
  (el mismo `NumeroPanel` de Configuración) a un admin de un alta automática, mientras la
  base se crea. El destino de las acciones lo decide el servidor según la base esté lista o
  no; el refresco de la página se frena mientras el usuario escribe o espera un código.
- **Al terminar la base** va a `/bandeja`, sin aviso, si el número ya está conectado y hay
  una casilla de Gmail; si no, a `PRIMEROS_PASOS` (`/configuracion?primeros=1`) con
  «Primeros pasos», que ahora sale de los datos y no de la URL, y muestra el formulario
  del número en un solo lugar.
- **Gmail** se conecta desde Configuración, que avisa el resultado con una lista cerrada de
  diez casos y dice cómo seguir en cada falla. Conectar con la base sin terminar vuelve a
  `/preparando` sin abrir Google. El permiso pedido baja a `gmail.modify` y `gmail.send`
  (sin `gmail.readonly`).
- **Celular sin el 9.** Con el número automático prendido, un `+54` de diez dígitos sin el 9
  se rechaza en el alta con un aviso que muestra cómo escribirlo.
- **Pasos del cliente:** correo, celular con el 9, entrar con Google, el código por SMS en
  `/preparando` o Configuración y conectar Gmail en Configuración.
- **Destino único (28/10, L2).** El alta termina en `PRIMEROS_PASOS` en los tres ambientes:
  en dev y QA directo, en prd después de `/preparando`. Con WhatsApp y Gmail hechos va a
  `/bandeja`, sin aviso. La bienvenida de la bandeja y sus claves se borraron: los días de
  prueba los muestra `PruebaPanel` en Configuración.
- **Equipo y formulario en «Primeros pasos» (29/10, L3).** `pasosHechos` lee cuatro cosas en
  la misma consulta a control: WhatsApp conectado, una casilla de Gmail, un segundo usuario
  activo (`offset 1`: el alta crea sólo al dueño, y el segundo nace al aceptar la invitación
  o por SSO, no al invitar) y el formulario web activo. Configuración suma al admin de una
  autoalta dos pasos, «Invitá a tu equipo» (`/admin/users`) y «Activá el formulario web»
  (`/agente?tab=formulario`); cada uno sale cuando se cumple, y la sección sigue visible sólo
  mientras falte Gmail o el WhatsApp. `/agente` abre la pestaña de `?tab=` si es una de la
  lista (`pestanas-de-la-consola.ts`, compartido entre la página y la consola); lo demás
  arranca en «modelos». El destino al terminar la base no cambia. Sin migración, sin
  variable nueva, sin costo.
- **Invitaciones en lote (29/10, L1, rama `alta/invitar-en-lote`).** El diálogo «Invitar
  usuario» de `/admin/users` carga varias personas de una vez: una fila de nombre y correo por
  persona, un solo rol para todas y «Agregar otra persona» hasta el tope del día
  (`topeDeInvitacionesDelDia`, `src/server/alta/tope-de-invitaciones.ts`: el valor de
  `ALTA_TOPE_INVITACIONES_DIA`, 20 por omisión, y en una prueba a lo sumo 5; la página lo pasa
  como número al cliente, sin consulta nueva). El cliente manda un POST por fila, de a uno, a
  la ruta de siempre, que no cambió: contrato, Turnstile, cupos por red, `enAlta`, el 422 por
  dominio y la cookie `cm_pedido` quedan como estaban. Un 400 marca su fila y el lote sigue (no
  tocó el cupo); el 422 por dominio también la marca pero lo corta, porque la ruta toma el cupo
  antes del filtro de dominio (decisión vigente: probar direcciones ajenas no sale gratis) y
  seguir gastaría una invitación del día por fila, las cinco de una prueba en un clic; el
  primer 429 lo corta y marca lo que falta «sin cupo», sin reintento, porque en
  Postgres los intentos rechazados también cuentan (si el `Retry-After` es de un minuto o menos,
  el contador no contestó: no es «sin cupo hoy», y lo que falta queda rechazado con el mensaje
  del servidor); un error de red, un 403 o un 502 también
  cortan, porque valen para todas las filas. Un correo repetido en el lote, o ya invitado antes
  en el mismo diálogo, no se manda dos veces. El diálogo no se cierra mientras envía (Escape y
  Cancelar no hacen nada), y al final hay un solo aviso y una sola recarga de la lista. Sin
  migración ni variable nueva. Tests: `tests/unit/admin-users-lote.test.tsx` y
  `tests/unit/alta/tope-de-invitaciones.test.ts`.

### WABA propia por cliente: la causa de fondo del tope de números (2026-10-09, rama `feat/waba-propia`)

Hasta acá todos los números salían de la WABA «Veltra», y Meta la limita a 2 números hasta
verificar el negocio. Ahora cada cliente puede traer la suya con el popup de Meta
(Embedded Signup v4) y los mensajes salen de su número, con su token. Todo detrás de
`ALTA_WABA_PROPIA` (apagada); con ella apagada nada cambia. Receta, avisos y runbook en la
Parte G de `docs/whatsapp-setup.md`.

- **Tiempo de ejecución y panel del operador.** El token del cliente (cifrado con
  `wa:<tenantId>:<wabaId>` como AAD) lo abre `numeros.ts`; la WABA de la plataforma sigue
  con el token del entorno. Un envío que Graph rechaza con 190 (token) o 131042 (forma de
  pago) cae al correo y avisa al operador. `/admin/altas` muestra la WABA de cada espacio y
  tiene «Reintentar la conexión» y «Desvincular la WABA»; «Dar de baja el número» también
  borra el token pero no llama a Meta.
- **Lo que mira solo.** Los eventos `account_update` y `phone_number_name_update` del webhook
  (solo por la ruta firmada; una revocación se confirma con `debug_token` antes de darla por
  buena) y una revisión diaria dentro de `reap-stuck` (tokens vivos, plantilla, WABAs a
  medias hace más de 48 h).
- **Borrado de datos.** `POST /api/meta/borrado` es la URL de eliminación de datos de la app:
  verifica el `signed_request`, borra el token y el PIN de la WABA de ese usuario de
  Facebook y contesta con un código.
- **Arquitectura.** El chequeo #20 ahora cubre `whatsapp_wabas` (solo `panel-operador.ts`
  la escribe con el rol dueño); `TOPE_FILTROS` subió de 13 a 17 por los cruces de
  `waba-propia.ts` y `waba-publica.ts`, que se suman a `ARCHIVOS_CON_ENCONTROL`.
- **Decidido:** sin coexistencia con la app de WhatsApp Business; los clientes que ya están
  conectados siguen en la WABA de la plataforma; sólo celulares +54; plantilla UTILITY y
  perfil comercial FINANCE; tope de 10 WABAs nuevas por semana (`ALTA_TOPE_WABAS_SEMANA`).

### App de Meta propia del cliente: salud, panel, envío y documentación (2026-10-13, rama `feat/waba-propia`)

Segunda vía para conectar el número: el cliente arma su app en Meta y pasa App ID, App
Secret, token y WABA ID, sin depender de que Veltra pase la verificación del negocio ni la
revisión de la app. Todo detrás de `ALTA_APP_PROPIA` (apagada por omisión; en prd no se
prende hasta que un abogado revise). Receta, runbook del operador y secretos en la Parte H de
`docs/whatsapp-setup.md`. La 0051 es la misma de la Parte G (se editó, no hay 0052).

- **Salud diaria** (`waba-salud.ts`, dentro de `reap-stuck`, sólo si quedan 40 s): por cada
  fila `app_propia` revisa el App Secret y el token, lee `health_status` y escribe
  `puede_enviar`, mira el nombre visible en revisión, la plantilla y los recordatorios.
- **Envío** (`messenger.ts`): el `appsecret_proof` va en cada llamada; 368, 131031 (confirmado
  con la salud) y 131042 avisan al operador sólo en la app propia; el primer `wamid` marca
  `primera_respuesta_en`.
- **Panel** (`/admin/altas`): origen, App ID, webhook verificado, datos de la app, páginas
  legales con «Despublicar las páginas legales» (pide confirmar), primer mensaje, primera
  respuesta, «Puede enviar (según Meta)» y recordatorio. Avisos nuevos: `secreto_invalido`,
  `waba_restringida`, `waba_bloqueada`, `recordatorio`, `baja_fallida`.
- **Pendiente.** W6 (el ensayo manual) no se hizo: las incógnitas I1 a I42 siguen abiertas y
  el código usa el respaldo de cada una (tabla en la Parte H). Entre ellas, **I7 (App
  Review)** decide si la vía se publica para autoalta. No hay capturas del asistente. La
  página del cliente (`/conectar-whatsapp/app`) es de otro ítem y no estaba en este árbol.
- **Riesgo.** Pedir credenciales al cliente es zona gris en las Platform Terms de Meta (§6.a.iv);
  se sostiene sólo como proveedor de servicios con acuerdo previo (§5.a).

### Gemini 3.8, buenas prácticas y CI más barato (2026-10-14/15, promoción #435)

Todo llegó a prd en una sola promoción (#435, `8088fdb7`), con el Post-deploy de PRD verde
y `/api/health?deep=1` sin desfase de bases.

- **Gemini 3.8-flash** (#427, en `us`). La extracción cuesta unas 5 veces más que con 2.5.
  `VERTEX_EXTRACTION_MODEL` ya no existe en Vercel ni en GitHub: manda el default del código.
  3.8 escribe el número de póliza o `""` en `possible_*_matches[].policy_id`; desde #431 esas
  pistas caen a `[]` en vez de tirar la extracción.
- **Latencia de 3.8** (ensayo de QA): extracciones de 5–8 s, con un tramo de 7 minutos a
  14–25 s y 8 cortes a 30 s que la retoma cubrió. Antes de tocar `GEMINI_TIMEOUT_MS`, medir
  en prd `ai.email_extraction.attempt1` (`latency_ms`) y `ai.transport_timeout`.
- **Buenas prácticas** (#432): pantallas de error y de no encontrado, fuentes del sistema,
  `lock_timeout` en `scripts/migrate.mjs`, techo y `AbortSignal` en R2, `onRequestError` y
  release en Sentry. En auth, con tres refutadores: sesiones cerradas al restablecer la
  contraseña, mails después de la respuesta (`after()`), techo en `/reset-password` y en el
  Server Action de `/restablecer`.
- **Dependencias** (#428): Zod 4, Vitest 5, `@vercel/oidc` 4, minors y patches al día, Node 24
  en CI. Quedan afuera workflow 5, ESLint 10 y TypeScript 7 (Dependabot #434): trabajo propio.
- **CI más barato** (#417, #421, #429): un marcador de árbol saltea lo que ya pasó, CodeQL y
  Secretos sin `push`, `timeout-minutes` en todos los jobs, Dependabot separa los majors y el
  Post-deploy de dev no repite el ensayo que QA pasó sobre el mismo árbol. CI por PR bajó de
  51 a 19 minutos por corrida y CI por push de 54 a 3. Medir la semana siguiente contra los
  3288 minutos del 07–14/10.
- **Carga** (#425): el tablero de métricas y la bandeja mandan menos sentencias por lote. En
  dev dio 389 ms al primer intento (antes oscilaba entre 477 y 576).
- **Pen test** (#424): el asistente reintenta una vez si el modelo no contesta.

### workflow 5 y ESLint 10 (2026-10-15, #438/#439, en prd por #458)

Los majors que Dependabot juntó en #434, menos TypeScript 7. Entraron por #438 a qa (ensayo y
pen test verdes) y por #439 a main (`080eb325`); Dependabot cerró #434 solo.

- **workflow 5.2.0 y `@workflow/vitest` 5.0.3.** El código sólo usa `start()` y las directivas
  `"use workflow"`/`"use step"`, que no cambian. Los runs nuevos quedan en la región de la
  función (gru1, antes iad1); los de 4.x terminan en su deployment, sin migrar nada.
- **ESLint 10.12.** `eslint-config-next` 16.4 lo soporta; los avisos de peer de
  `eslint-plugin-import`, `jsx-a11y` y `react` son esperables.
- **TypeScript 7 afuera.** Compila el proyecto, pero typescript-eslint 8.71 no lo soporta y el
  lint no arranca. `dependabot.yml` ignora el major de `typescript` hasta que
  typescript-eslint/typescript-eslint#10940 lo resuelva.
- **Verificado.** Dev salteó el ensayo que QA ya había pasado, Carga 434 ms (peor caso), y el
  `pnpm check` completo dio verde en 14,4 min: 14 497 tests, flujos 3/3, 26 conversaciones y
  smoke sobre `080eb32`.

### Actions sin cuota hasta el 1/11, y CI que saltea lo que es sólo documentación (2026-10-15, #441)

El presupuesto de US$ 50 por mes de GitHub Actions de la cuenta se gastó entero el 15/10:
octubre suma US$ 64,08 brutos, de los que claimmix son 42,44 y uns-study 20,40 (propflow
0,85, republica-en-llamas 0,38). Desde ahí ningún job arranca («The job was not started
because an Actions budget is preventing further use») hasta que el ciclo se reinicia el
1/11. No se sube el presupuesto ni se cambia de plan.

- **Qué queda parado.** CI, CodeQL y Secretos de los PR, los Post-deploy de QA, dev y PRD, la
  Carga y el barrido `barrer-trabados`. Los casos trabados en prd los levanta sólo el cron
  diario de Vercel `/api/cron/reap-stuck` (04:07 UTC). #440 (sólo docs) está en qa sin
  veredicto: el ensayo del run 38711929216 se canceló a los 75 min por timeouts de Vertex y
  el reintento (el primero de dos) no arrancó por el presupuesto.
- **Dónde se fueron los minutos de octubre.** 7058 en total: CI de PR 3298, Post-deploy 1728,
  CI de push 795, CodeQL de PR 414, Secretos de PR 197, barrido 170, CodeQL de push 134 y
  Carga 101. Un PR que sólo tocaba documentación costaba unos 60 minutos (CI 30, CodeQL 5,
  Secretos 1 y QA de 22 a 25).
- **Sólo docs** (#441). Un commit que sólo cambia archivos `.md` (salvo
  `docs/PROMOCION.md`, que leen los tests, y todo `entrenamiento/`, que se empaqueta en código) sobre un árbol que ya pasó hereda su marca: `arbol`
  saltea los jobs de código, CodeQL no analiza y el Post-deploy de QA corre todo menos el
  ensayo, con el veredicto en verde y la marca `ensayo-verde-<árbol>`, así que dev tampoco
  ensaya. Un renombre desde un archivo de código, 300 archivos o más, o un error de la API
  cuentan como código. `tests/unit/ci-solo-docs.test.ts` corre los scripts reales con un `gh`
  falso; en Actions no se puede probar hasta el 1/11.
- **Aviso.** GitHub pasa `ubuntu-latest` a Ubuntu 26 desde el 19/10.

### DNI o CUIT, y tres decisiones de auth (2026-10-15, #442)

- **DNI o CUIT del titular** (#442, en la rama `agente/dni-o-cuit`). En `consorcio-por-mail` el
  agente le pedía DNI a un consorcio, que no tiene. La etiqueta de `dni` pasa a «DNI o CUIT del
  titular», la oración de pedido de `dni` y `dni_asegurado` nombra el CUIT para consorcios y
  empresas, el prompt de extracción acepta el CUIT en `dni`, y el control de campos caídos de
  `compose-reply.ts` toma «CUIT» como pedido del dato. Ensayo verde con 2.5-flash y con
  3.8-flash; unit tests y `pnpm check --local --fast` verdes. Espera CI (ver abajo).
- **Póliza cambiada a mitad de caso.** Al escribir esta sección quedaba como decisión del
  dueño, porque el aviso parecía chocar con AC24. Lo resolvió #443 sin aflojarlo: el agente
  pregunta cuál vale sin repetir ningún número (ver la sección siguiente).
- **Prefetch fuera del proxy: descartado.** Sacar del matcher los pedidos con
  `next-router-prefetch` ahorraría invocaciones, pero ese header lo pone el cliente: cualquiera
  se saltearía la redirección a `/login` y el CSP con nonce.
- **`cookieCache` de 60 s: se queda.** Ya estaba decidido (ver más arriba): el remedio es
  invalidar, no acortar, y eso pide un hook de Better Auth. La pantalla avisa la demora.
- **Restablecer contraseña no es atómico: aceptado.** Better Auth cambia la clave y cierra las
  sesiones en sentencias separadas sobre `neon-http`, que no tiene transacciones interactivas.
  Hacerlo atómico pide pasar ese camino a un pool por WebSocket; no compensa el riesgo hoy.
- **Latencia de 3.8 en prd: sin datos.** La base de prd tiene 0 casos y 0 eventos de
  proveedor; no hay tráfico que medir. En local, una extracción tardó 25 s.
- **CI parado hasta el 1/11 (resuelto el 16/10).** El presupuesto de Actions del mes se
  agotó y todos los jobs fallaban a los 2–3 s. Con el repo público otra vez Actions corre sin
  cuota, y #436–#453 llegaron a prd por #458.

### Póliza cambiada a mitad de la charla (2026-10-15, #443, en prd por #458)

Cierra la observación del ensayo `devolver-al-agente` (#338, `AUDITORIA-2026-09.md`): la
persona daba `POL-4471-A` y después escribía «póliza 4455», y el agente tomaba el número nuevo
sin decir nada. Plano en `.claude/handoff/poliza-cambiada.md`.

- **Detección.** `src/core/case/poliza-cambiada.ts` compara las dos sin dejarse engañar: «4471»
  es `POL-4471-A` dicha a medias y «4455» no es `2914455123`. El orquestador mira lo que leyó el
  extractor y, además, lo que el texto da como póliza («póliza 4455»): el extractor relee toda la
  charla y a veces se queda con la primera.
- **Pregunta sin números (AC24).** Con otra póliza, la rama D manda `POLIZA_CAMBIADA` («no
  coincide con el que teníamos… ¿nos escribís el número correcto?»), sin repetir ninguna de las
  dos. La plantilla, el mensaje de WhatsApp y el redactor la llevan; el redactor no ve los
  dígitos del último mensaje y dos guardas rechazan un texto que la omita o cite un número.
- **Resolución.** `cases.policy_number` sigue con la primera mientras la fila queda pendiente
  con las dos. La respuesta la cierra un paso propio con `polizaElegida`; si eligió la nueva,
  se actualiza el caso. «No sé» o «la primera» dejan la fila pendiente y se vuelve a preguntar.
- **Pólizas cortas en el prompt del redactor.** `sinNumerosEnteros` pedía seis dígitos y
  `POL-4471-A` llegaba entera: el ensayo devolvió «entendemos que la póliza es la POL-4471-A».
  Ahora una póliza con prefijo y cuatro o cinco dígitos entra como `POL-****`; la patente no se
  toca. El prefijo queda a propósito: con `****` solo, el modelo escribió «la patente es la ****».
- **Verificado.** Tests unitarios, `tsc` y ESLint verdes. `pnpm rehearse devolver-al-agente` con
  `gemini-3.8-flash` (el de los entornos desplegados): verde, el turno 5 pregunta sin números y
  ninguna respuesta cita 4471 ni 4455. Con 2.5 local el turno 6 salió rojo dos de cuatro veces
  por el desboque conocido del extractor (8192 tokens, el corte de 30 s lo vuelve TIMEOUT sin
  reintento); con `GEMINI_TIMEOUT_MS=0` reintenta con la corrección de MAX_TOKENS y queda verde.
  `pnpm check --local` con 3.8 verde: las 26 conversaciones sin diferencias (26,6 min). La
  primera corrida encontró dos mocks de `gap-analyzer` sin `MEDIUM_CONFIDENCE_LOW`.

### Repo público otra vez (2026-10-16, #451)

El 16/10 de madrugada el repo volvió a ser público para que Actions corra en runners
estándar sin gastar el presupuesto. El dueño aceptó que la historia de git sigue teniendo
datos reales de una denunciante (DNI, correo, número de denuncia y apellido, desde
bba09343, #30), además de su propio celular y un ID de facturación: la historia no se
reescribió. #451 los saca del árbol actual con datos sintéticos.

- **Antes del cambio** se borraron 286 runs de `barrer-trabados` y 78 runs fallidos de la
  Carga: sus logs tenían el JSON del barrido y detalle de salud.
- **Ruleset 25217107** «main, qa y prd: sólo por PR»: esas ramas no se pueden borrar, no
  aceptan force-push y todo entra por PR (0 aprobaciones, sin bypass). Todavía no exige
  checks: eso espera al renombre de los jobs del CI. La protección clásica de septiembre
  (14 contextos y `enforce_admins`) no volvió.
- **Secret scanning y push protection** prendidos, con 0 alertas. La aprobación de
  workflows de forks queda en el default de GitHub (contribuyentes nuevos).
- **Logs públicos.** Todo log y artefacto de Actions es público: ningún workflow imprime
  datos personales, detalle de salud ni secretos. #451 lo cierra para el barrido
  (`resumen()` en lugar de `cat respuesta.json`) y para `mirar-salud` (`sinDetalle` en
  Actions). Hasta que #451 llegue a main, el barrido de dev y prd sigue publicando el
  detalle enmascarado.
- **Carga y forks.** Un `deployment_status` corre el workflow del SHA desplegado, así que
  la puerta `origen` de `load-tests.yml` es sólo una alarma. El control real es la Git Fork
  Protection de Vercel, prendida en los tres proyectos, y no autorizar nunca el preview de
  un fork.
- **CodeQL** vuelve a subir el SARIF porque el repo no es privado. En un PR de fork el
  token es de sólo lectura y la subida falla.
- **Programados.** En un repo público GitHub apaga los workflows programados tras 60 días
  sin commits. Si el repo se queda quieto, el barrido se reactiva a mano.
- **Retención de logs** en el default: con un día se perderían las marcas
  `ensayo-verde-*` y `ci-verde-*`.
- Se relanzaron CI, CodeQL y Secretos de #446 y #448–#451. #448–#451 entran a qa juntos
  con #446, en `integra/lote-1-11`.

### CI ordenada por entorno: DEV, QA y PRD (2026-10-16, #452, en prd por #458)

Cada corrida del post-deploy se titula `DEV · deploy <sha>`, `QA · deploy <sha>` o `PRD · deploy <sha>`, y sus checks llevan el entorno adelante (`DEV / Smoke del deploy`, `QA / Ensayo de conversaciones`, `PRD · Smoke y salud de las bases`). Los siete workflows siguen, con un nombre que dice cuándo corren (`PR y main · Chequeos del código`, `Post-deploy · DEV, QA y PRD`, `Programado · Barrer trabados en DEV y PRD`, que desde el lote de las notas del 14/10 es `Programado · Barrer trabados en DEV, QA y PRD`). No se saca ningún check: `Tipos` y `Lint` pasan a ser un solo job, `Tipos y lint`.

- **Dev sin `inherit`.** El job `produccion` pasó a llamarse `dev` y mapea sus catorce secretos uno por uno: ningún caller usa `secrets: inherit`, y `tests/unit/ci-secretos-del-reusable.test.ts` frena un secreto declarado que no llegue.
- **Caché y tiempo.** Cada job que instala guarda la caché de pnpm. Con el repo público los runners estándar no se cobran: esto acorta la corrida de cada PR (el plan estimó ≈2 min de runner por push, sin medir), no ahorra plata. El k6 `carga` y `secrets.yml` siguen en `ubuntu-latest`, y el job `origen` y los logs sin detalle de #451 quedan como estaban.
- **Disparos a mano.** El de `deploy-checks.yml` se fue. El del post-deploy corre sólo desde `main` y sólo contra el alias de dev, con el interruptor `ensayar` (`gh workflow run post-deploy.yml --ref main -f ensayar=false`). Residuo aceptado: ese freno vive en el archivo disparado, y el ruleset 25217107 (sólo por PR) no frena un `workflow_dispatch` desde una rama. Quien edite el freno en una rama y la dispare expone los secretos de dev (el ensayo igual falla en WIF). Lo mismo valía antes por el disparo de `deploy-checks.yml`, que corría código de la rama con todos los secretos.
- **Marcas que saltean trabajo.** `ensayo-verde-<árbol>` sólo cuenta si la subió el post-deploy de un deploy de QA en verde, y `ci-verde-<árbol>` sólo si la subió `ci.yml` desde un commit que ya está en la historia. Antes valía cualquier artefacto con ese nombre. Limita quién puede dejar una marca; no es una firma.
- **Cadenas de DEV.** El shell de QA y el de los e2e ya no las reciben: la comparación «¿es la misma base?» va en la expresión y al shell llega sólo `true` o `false`.
- **k6.** QA tiene su propia cola (`carga-qa`) y cada proyecto la suya para las vistas previas (`carga-preview-<environment>`): antes una vista previa podía cancelar la carga de QA. Contra PRD no corre nunca, ni por un deploy ni por una vista previa del proyecto de prd ni a mano.
- **Invariantes.** La 12 rechaza un grupo de `concurrency` armado con `github.ref`, y la 15 también lee el `run-name`.
- **Checks obligatorios.** Con el OK del dueño, el 16/10 se creó el ruleset 25264579 «main y qa: checks del CI obligatorios», aparte del 25217107 y sin bypass. Exige diez checks de GitHub Actions: `Tipos y lint`, `Tests unitarios`, `Tests de integración`, `Build`, `Tests E2E`, `Aislamiento de tenants`, `Bases por cliente`, `Pen test local`, `Peso del bundle` y `Credenciales, datos personales y arquitectura`. Quedan afuera `Vulnerabilidades` (una alerta nueva lo pone rojo sin cambio de código) y el estado `Post-deploy QA`. Un job salteado por la marca de sólo-docs cuenta como pasado. Si se renombra uno de esos jobs, hay que editar el ruleset en el mismo PR o ningún PR se puede mergear.
- **Primeras corridas.** QA sobre `2cfb8b42` (#454): `QA · deploy <sha>`, verde entero al primer intento, ensayo en 13 min y pen test en 3. DEV sobre `251b799d` (#455): `DEV · deploy <sha>`, el ensayo se salteó por la marca del árbol de QA y la Carga dio p95 de 434 ms en el peor caso. `pnpm check` completo sobre `251b799d`: verde en 14,5 min (26 conversaciones). Con el sólo-docs #457 (`392681ad`), DEV volvió a saltear el ensayo y la Carga dio 492 ms. PRD sobre `98a30dcb` (#458): `PRD · deploy <sha>`, smoke y salud de las bases verdes al primer intento.
- Mergear sólo con `gh run list --workflow=post-deploy.yml --status in_progress` vacío: los grupos de `concurrency` cambiaron de nombre.

### Un audio mudo no inventa una denuncia (2026-10-16, #453)

El Post-deploy de QA sobre `e6e25edd` dio rojo en `nota-de-voz-y-pdf`: el caso se derivaba a un especialista en el turno de la nota de voz y el PDF siguiente no se leía. Sin fixtures, la nota es `tests/fixtures/placeholder.ogg`, 2 s de Opus en silencio, y gemini-3.8-flash le inventó voz en 3 de 6 llamadas de una sonda (un robo con la ventana rota, una piedra en el parabrisas). La transcripción falsa reemplazaba al marcador y la deliberación derivaba por hechos que nadie contó. En producción pasaba lo mismo con un audio con ruido.

- **Tope de palabras.** `transcribir.ts` descarta una transcripción con más de cuatro palabras por segundo de audio, más cuatro de gracia (`metadatos.segundos`, medido al recibir; sin duración no se juzga). Log `email_worker.transcripcion_inverosimil`, sólo con las cuentas.
- **El marcador solo no cuenta hechos.** Un mensaje que es sólo `[Mensaje de audio adjunto]` no se delibera ni sube la gravedad del caso (`gravedadSinHechosNuevos`).
- Tres corridas de `nota-de-voz-y-pdf` sin fixtures, verdes; en una, la guarda descartó 21 palabras para 2 s de audio. La temperatura no se tocó: Google desaconseja bajarla en Gemini 3.
- Entró a qa junto con #452 por #454 (`2cfb8b42`) y a main por #455 (`251b799d`). En QA, sin fixtures, el ensayo de conversaciones pasó al primer intento.

### Promoción a prd del 16/10 (#458)

Con el OK del dueño, #458 llevó main a prd (`98a30dcb`). Entraron la pregunta por la póliza cambiada y el cierre con la póliza del caso (#443, #444), la retoma sola tras un timeout de Gemini (#447), el tope de palabras del audio (#453), DNI o CUIT (#442), el remitente de QA y la caja de Turnstile (#448, #449), el repo público (#451), workflow 5 y ESLint 10 (#438) y la CI por entorno (#441, #445, #452). No había migraciones nuevas. El Post-deploy de PRD (`PRD · Smoke y salud de las bases`) dio verde al primer intento. Desde ese día el dueño pidió que dev, qa y prd estén siempre iguales hasta nuevo aviso: lo que entra a qa sigue el mismo día a main y a prd.

Lo que todavía no es igual (leído en `/registro` de cada ambiente el 16/10): prd muestra el desafío de Turnstile, la opción de alta con correo y el aviso del número por código; dev muestra Turnstile y el correo pero no el número por código (`ALTA_NUMERO_AUTOMATICO`); QA no muestra ninguno de los tres (faltan las claves de Turnstile, el remitente o `GMAIL_CLIENT_ID`/`GMAIL_CLIENT_SECRET`, y la bandera). Igualarlos son variables de Vercel. El 17/10 el dueño decidió (D1, b) prender el número por código también en dev y en QA, y las banderas se cargan en el lote de A12 de `docs/PUESTA_EN_MARCHA.md`. El único lugar libre de la WABA de Veltra es primero del cliente ficticio de prd, y QA, sin token de WhatsApp, manda esas altas a revisión con `sin_credencial`.

### El agente aprende de la consola (2026-10-16, PR #461, que suma #460)

Revisión del 16/10, leída en el código y en las bases: el agente no actúa según un modelo entrenado. Cada caso lo atiende `gemini-3.8-flash` sin ajustar, siguiendo instrucciones escritas a mano. Las decisiones críticas las toma el código: gravedad y derivación (`severity-classifier.ts`, `extract.ts`), qué pedir (`required-fields.ts`, `required-docs.ts`), contestar o callar (`reply-decision.ts`), orquestación y estados (`orchestrate.ts`, `fsm.ts`). Lo único aprendido es contexto pegado al prompt de extracción (hasta 3 ejemplos aprobados, reglas del admin, memoria por remitente), y no llega a `deliberate` ni a `compose-reply`. Activar un modelo ajustado no tenía efecto: el transporte de Vertex ignora `active_model`, y `activateFineTunedModel` lo dejaba en nulo. En dev el tenant de prueba tiene 19 reglas y 207 ejemplos; en prd no hay ninguno.

Decisiones del dueño (16/10):
- El agente decide según el entrenamiento. En código queda sólo un piso que el entrenamiento no puede bajar: heridos o muerte pasan a una persona, se tapan los datos personales, no se promete cobertura ni montos, y se respeta el tope de gasto.
- El entrenamiento base vive en el repo, así es igual en dev, qa y prd. La consola lo muestra y cada cliente suma o corrige lo suyo encima. Un cambio a la base se escribe en la consola y se pasa al repo.
- Las reglas de código pasan al entrenamiento sin perder lo que anda: primero en modo sombra (el agente decide según el entrenamiento, el código sigue decidiendo y se registra cada diferencia), y una decisión pasa al entrenamiento sólo cuando el ensayo y el eval muestran que coincide.
- Un fine-tuning pago en Vertex no se lanza sin OK del dueño, y antes tiene que pasar el eval.

La política con la que arranca el agente salió de tres archivos de código y pasó a Markdown en `entrenamiento/base/`. Las reglas que el equipo escribe en la consola pueden llegar, detrás de una bandera apagada, a los pasos que deciden y redactan la respuesta. Y un modo sombra mide cuánto coincide el modelo con el código, para saber algún día qué decisiones se le pueden pasar. **Sin migración, sin llamadas nuevas a Gemini y, con la bandera apagada, sin cambios en los prompts del agente**: los prompts dorados lo prueban byte a byte. Esto es el Lote A (A0 a A16); el Lote B está diseñado y no se construyó.

- **Dónde vive la base y cómo se cambia.** `entrenamiento/base/<paso>/NN-<slug>.md`, con paso `extraccion`, `decidir` o `redactar`: 20 secciones, 16 de modo `prompt` (el texto exacto que recibe el modelo, copiado de lo que corría) y 4 de modo `sombra` (describen una regla del código y no entran a ningún prompt de producción). Se cambia **editando el `.md`, corriendo `pnpm entrenamiento:empaquetar` y abriendo un PR**. El comando escribe `src/core/agente/entrenamiento-base.generated.ts`, un módulo sin imports (Turbopack de Next 16 no trae `?raw`, el ensayo corre con tsx en el mismo proceso y Vercel no empaqueta los `.md`; es el patrón de `scripts/empaquetar-bases.mjs`), con una versión de doce caracteres que cambia con cualquier letra de la base. Como viaja con el código, es la misma en dev, qa y prd. **La consola nunca escribe el repo** ni llama a la API de GitHub. Un `.md` editado sin empaquetar lo frena el test de deriva (`tests/unit/entrenamiento-base.test.ts`), y uno de modo `prompt` cambia lo que ve el modelo, así que también frena los prompts dorados (`tests/unit/prompts-del-agente.test.ts`). Ese PR no cuenta como «sólo documentación» para el salto de CI de #441: corre entero.
- **Qué queda en código.** Lo que es piso o estructura. En la extracción: el rol, el contexto temporal, las reglas de seguridad, el bloque `INJURY`, los campos, los archivos y las partes. En `deliberate`: los datos, las acciones, «REGLA QUE NO SE NEGOCIA», el menú de herramientas, el formato de salida y `validate`. En `compose`: `escalation`, `closing`, los conflictos con el traspaso, la pregunta, `PROHIBIDO`, `FORBIDDEN` y la guarda de cuidado.
- **La pestaña Base y la propuesta descargable.** En `/agente`, sólo lectura: la versión, las 20 secciones con su texto tal como corre (modo `prompt` o `sombra`, y la ruta del archivo), una tabla de tipos de regla contra los pasos que las leen (con los pasos que hoy no leen tachados mientras la bandera está apagada) y un botón. Lo arma el servidor, sin consultas; el costo es del orden de 25 a 30 KB de texto en cada carga de `/agente`. El botón baja `GET /api/admin/prompt-rules?formato=propuesta` (admin u owner): las reglas **activas** del cliente en Markdown, agrupadas por el último paso del agente que las lee, con las secciones de ese paso al lado, para que una persona decida si alguna merece un PR a la base. El archivo se llama siempre `propuesta-entrenamiento.md` (sin cliente ni fecha) y abre con `REVISAR ANTES DE SUBIR: texto escrito por el cliente` y un aviso: el repo es público. Pasa cada título y cada texto por `paraElPrompt` y `sinContactos`, así que **tapa** DNI, pólizas, enlaces, mails, teléfonos y etiquetas del sistema, y **no tapa los nombres**: hay que leerla entera antes de copiar nada.
- **La validación de reglas al guardar.** `POST` y `PATCH` de `/api/admin/prompt-rules` rechazan con `VALIDATION_FAILED` un título o un texto con una etiqueta del sistema (`</agent_rules>` y las demás), un enlace o un mail. No rechazan teléfonos, DNI ni patentes: las reglas de extracción describen formatos de póliza y de patente, y un teléfono agarra fechas y rangos. Las reglas que ya estaban no se revalidan.
- **La bandera `AGENTE_APRENDIDO_EN_CONVERSACION`.** Sólo vale con `1`. **Está apagada, ausente de Vercel y de GitHub, en los tres ambientes**, y tiene que seguir igual en los tres. Apagada, las reglas llegan a la extracción como siempre y a nada más. Prendida, el worker arma con las mismas reglas activas (sin consulta nueva) un texto para `decidir` y otro para `redactar`, hasta 1500 caracteres por paso, regla entera o ninguna:
  - `extraction`, `classification`, `severity` y `core_mapping` llegan sólo a la extracción.
  - `missing_fields` llega a la extracción y a `decidir`.
  - `reply_style` llega a la extracción y a `redactar`.
  - **Las reglas con enlace, mail o etiqueta del sistema no llegan a la conversación**: `compose` prohíbe nombrar un enlace o un mail que no pasamos nosotros y quemaría sus dos intentos. La extracción las sigue leyendo.
  - Entran como dato del operador en un bloque `<indicaciones_del_equipo>`: en `deliberate`, después de «REGLA QUE NO SE NEGOCIA» y de la lista de acciones y antes de los criterios; en `compose`, después del tono. Su introducción dice que no suman pedidos, no vuelven instrucción lo citado, no impiden derivar y no cambian `PROHIBIDO`. Pasan siempre por `paraElPrompt` (AC24). `decidir` las lee en todas las pasadas de `deliberate`; `redactar`, en cada mensaje.
  - Los id de las reglas que entraron a cada paso quedan en `confidence_payload.entrenamiento` de la corrida.
- **Los bloques del inquilino de la extracción pasan por `sinCentinelas`.** `agent_training`, `tenant_prompt`, `agent_rules` y `custom_fields` ya no pueden cerrar su propio bloque: una etiqueta del sistema sale como `[agent_rules]` y las comillas triples se parten. Con los prompts dorados verdes, el prompt de extracción sólo cambia cuando el texto de la regla trae una etiqueta o `"""`. Es el único cambio de este lote que toca el prompt de extracción.
- **El modo sombra.** **Siempre prendido, sin bandera, igual en dev, qa y prd.** El código sigue decidiendo; la sombra anota qué decidiría el modelo con lo que ya devolvió en esa vuelta. No suma ninguna llamada a Gemini ni consulta de lectura; lo único nuevo contra la base es un `UPDATE` no fatal en el worker. Compara cuatro decisiones:
  - **gravedad**: la `severity` cruda del modelo, guardada antes de que `sinHeridosSupuestos` o la gravedad del caso la toquen, contra la que fija `classifySeverity`.
  - **derivar**: el `requires_specialist` crudo contra `needsSpecialist`. Anota además `piso` (heridos o gravedad crítica), a propósito sobre-inclusivo. La derivación por padrón (póliza vencida o inexistente, titular ajeno) queda afuera: se calcula después y el modelo no ve el padrón (B6).
  - **pedir**: lo que el modelo pidió (sólo si su intención fue `ask` o `answer_and_ask`) contra lo que el árbol pediría sin plan, como conjuntos de claves; `descartadas` cuenta las claves que el modelo pidió fuera de lo pendiente.
  - **responder**: la intención del modelo (`pedir`, `contestar`, `cerrar`, `derivar` o `callar`) contra la decisión del código (`pedir`, `acusar`, `avisar`, `callar`, `contestar` o `cerrar`), más `rechazo`: la categoría por la que `validate` tiró el plan, si lo tiró. Si el plan deriva un caso que el código no derivaba por su cuenta, se anota `agente: derivar` contra `codigo: sin_derivar` y cuenta como diferencia.
  - **El contrafáctico de responder es una aproximación.** Es la decisión del árbol sin plan: sin espera del agente, con la pregunta leída del mensaje, sin «aprendimos algo» y con el «ya se pidió» calculado con lo último que pedimos. No repite `alreadyAskedFor` (sería una consulta) ni mira `checkConfirmationAlreadySent`. `avisar` no se compara: el agente no tiene equivalente.
  - **Sin plan no hay opinión** (deliberate apagado, caso grave, audio sin transcribir, presupuesto agotado o error): esa vuelta cuenta como «sin opinión», no como diferencia. La opinión llega por un callback, también cuando `validate` rechaza el plan.
  - **Dónde se guarda.** En `agent_runs.confidence_payload.sombra`, un jsonb que ya existía: `{ v: 1, gravedad?, derivar?, pedir?, responder? }`. `gravedad` y `derivar` van en el `INSERT` de `logAgentRun` (sólo si hay denuncia y el parseo salió bien); `pedir` y `responder` se suman después con `anotarSombraEnLaCorrida`, un `UPDATE` por `enTenant` filtrado por corrida y caso que no pisa lo anterior y, si falla, sólo deja un log con el código. Sólo guarda enums, booleanos, categorías, id y claves con forma de campo (`/^[a-z0-9_]{1,40}$/`, hasta diez): ni PII ni texto libre. Ni la evaluación ni la propuesta leen `input_payload` ni `output_payload`; un test lo comprueba.
  - **Cómo se mide.** Hay coincidencia si son iguales (los conjuntos, en `pedir`); si falta una opinión, o el código dice `avisar`, no se compara. Mide coincidencia, **no acierto**. `bajaElPiso` es `derivar.piso` con el agente diciendo que no deriva: una diferencia de gravedad sola no lo baja. El ensayo imprime una línea `◐ sombra` por corrida y un resumen que no cuenta para el veredicto; `pnpm sombra:evaluar` mide gravedad, derivar y pedir sin pasar por el ensayo (ver `docs/TESTING.md`).
- **El umbral propuesto** (lo decide el dueño). Una decisión es candidata a pasar al modelo con **al menos 95 % de coincidencia sobre al menos 100 comparaciones** con opinión de los dos lados, en la evaluación completa para gravedad, derivar y pedir y en dos ensayos completos seguidos para las cuatro, y con **cero** `BAJA EL PISO` en total. Recién entonces es candidata (B1), una por PR y con el OK del dueño. La parte de piso de derivar (heridos o muerte) no pasa nunca, aunque coincida al 100 %. En código: `cumpleElUmbral` en `src/core/agente/sombra.ts`.
- **El piso y dónde vive.** Ningún texto de entrenamiento, ni de la base ni del cliente, toca estos cuatro puntos: viven en código y en validadores deterministas, no en prompts. `tests/unit/piso-del-agente.test.ts` prueba cada uno con una regla que pide justo lo contrario.
  - **Heridos o muerte van a una persona.** `hayHeridos` y `classifySeverity` con su léxico (`severity-classifier.ts`), `needsSpecialist` en `extract.ts`, y en `orchestrate.ts` `isHighSeverity`, `derivaSola` y la escalada antes de deliberar. `deliberate` no opina en un caso grave, y el bloque `INJURY` de la extracción queda literal en `prompt.ts`. Las indicaciones entran recién en `deliberate`, que no opina cuando hay heridos.
  - **PII tapada (AC24) y nada cruza inquilinos.** `paraElPrompt` (`src/core/ai/para-el-prompt.ts`) con enlaces, DNI, pólizas, pólizas cortas, el número de póliza cambiada y centinelas, aplicado siempre por `bloqueDeIndicaciones`; las reglas con enlace, mail o etiqueta quedan afuera de la conversación; la propuesta sale tapada; la sombra guarda sólo claves seguras; todo va por `enTenant`, con RLS.
  - **No prometer cobertura ni montos.** `PROHIBIDO` y la pregunta en `compose-reply.ts`, `FORBIDDEN` y `violation` (mandan a la plantilla), `llevaCuidado` y el traspaso de la derivación, y `validate` de `deliberate`. El bloque del cliente va después del tono y su introducción dice que no cambia `PROHIBIDO`; la garantía es `FORBIDDEN`, que es determinista.
  - **Tope de gasto.** `checkBudget` en el worker antes de extraer, `reservarSiEsPrueba` con las llamadas por deliberación y `registrarConsumoDelModelo`. La sombra no suma llamadas y el bloque del cliente no suma pasadas: sólo tokens, hasta 1500 caracteres más la introducción.
- **El permiso que necesita la sombra, comprobado el 16/10** (sólo lectura): `select has_table_privilege('claimmix_app', 'agent_runs', 'UPDATE');` da `true` en dev y QA, y en prd da `true` en la base del inquilino (`t_<hex>`). En `neondb` de prd da `false`, y está bien: con `BASE_POR_CLIENTE=1` esa es la base de control, donde el rol de la app sólo lee las tablas de negocio, y los datos de cada aseguradora viven en su base. Para comprobarlo en prd hay que mirar la base del inquilino, no la de control. Si algún día diera `false` donde viven los casos, la sombra de `pedir` y `responder` queda vacía sin romper nada (el error se anota con su código en `agent_runs.sombra_error`), y se ve en el ensayo. No hay migración ni cambio de variables de entorno.
- **Las 19 reglas de dev, sin tocar.** Dev tiene 19 reglas de una semilla vieja de junio; qa y prd tienen cero. Este lote no las borra, ni las desactiva, ni las edita, ni las copia a la base; con la bandera apagada siguen entrando sólo a la extracción, como hoy, y la validación nueva no las revalida.
- **Verificación.** `pnpm check --local` del 16/10 en verde, en 13,8 min: tipos, lint, 14.989 tests unitarios, invariantes y las 26 conversaciones sin diferencias con lo esperado, con `gemini-3.8-flash`. La primera lectura de la sombra en ese ensayo (no cuenta para el resultado): gravedad 40/40 (100 %), derivar 39/40 (98 %), pedir 10/21 (48 %), responder 23/30 (77 %), 29 vueltas sin opinión y **un `BAJA EL PISO`**: en `accidente-personal-fractura` («me fracturé la muñeca», sin palabras de gravedad) el modelo no derivaba y el código sí, y el caso terminó en `requiere_especialista`. Es justo lo que el piso tiene que atajar, y confirma que la parte de heridos de derivar no pasa al modelo. Pedir y responder están lejos del umbral. El `pnpm check` completo después del deploy, con el transcripto leído, está en «Promoción del 17/10», más abajo. Los tests unitarios prueban qué texto llega y que el piso se sostiene con el modelo mockeado, no que el modelo siga las reglas del cliente: eso sólo se ve en un ensayo con la bandera prendida.

**Decisiones que esperan al dueño**

1. **Prender `AGENTE_APRENDIDO_EN_CONVERSACION`**, siempre con el mismo valor en dev, qa y prd. Recomendación: no prenderla hasta resolver las 19 reglas de dev y ver un ensayo local con la bandera en `1`.
2. **Qué tipos de regla llegan a cada paso.** Hoy `missing_fields` va a `decidir` y `reply_style` a `redactar`, que es lo que promete la consola. La crítica de seguridad propone que `decidir` reciba `severity` y `reply_style`, y que `extraction`, `missing_fields`, `classification` y `core_mapping` queden sólo en la extracción. Es una línea en `PASOS_POR_TIPO`.
3. **Las 19 reglas de dev, sin borrar nada.** Desactivar las de `reply_style` y `missing_fields` que chocan con la base («usted», «Estimado/a» y la firma contra el voseo y el tono; «número de caso» y «plazo de 5 días hábiles» contra `PROHIBIDO` y `FORBIDDEN`, con lo que cada respuesta caería a la plantilla después de gastar dos llamadas; «bloquear sin póliza» empuja a `deliberate` a pedir fuera de la lista y `validate` tira el plan), desactivar el truco `[email_sim]` o las 19 (para que los tres ambientes queden iguales también en datos), o dejarlas como están con la bandera apagada. Desactivarlas las saca también de la extracción de dev: hay que volver a ensayar y leer el transcripto. El truco `[email_sim]` nunca va a la base ni a un entrenamiento. Las que describen bien el comportamiento de hoy (fecha AAAA-MM-DD, patentes Mercosur, criterio de `is_claim`) se pueden llevar a la base con la propuesta de la consola y un PR, si el ensayo las respalda; nada se siembra con `export-training.mjs`, que cruza inquilinos y lee `.env.local`.
4. **El umbral** de arriba (95 %, 100 comparaciones, evaluación completa más dos ensayos y cero `BAJA EL PISO`).
5. **El costo y el momento de la evaluación completa.** `pnpm sombra:evaluar --todos` son unas 163 extracciones con `gemini-3.8-flash`, el doble con `--sin-sombra`, y no se ven en el tope ni en `/metricas`. Por omisión corre con un límite de 10.
6. **`extraction.json`.** Si sigue mostrando `confidence_payload.sombra` y `.entrenamiento` a todos los roles. No tienen PII y la ruta ya expone `raw_agent_output`; si no se quiere, se quitan en la ruta con un destructurado.
7. **«Como máximo 4 cosas»** en el criterio 4 de `deliberate`, contra `MAX_ASK_ITEMS = 5`. Queda byte a byte; corregirlo es un PR a `entrenamiento/base/decidir/01-criterios.md` y cambia el comportamiento.
8. **Las indicaciones en todas las pasadas de `deliberate`** (lo que hace hoy) o sólo en la pasada 0. Con sólo la 0, los turnos con consulta ignoran la regla.
9. **El texto de las introducciones del bloque**, que ya no dicen «mandan ellas», y si el criterio 6 (póliza vencida, abogados, angustia) se refuerza en la base.
10. **El alcance de la validación al guardar.** Hoy rechaza etiquetas, enlaces y mails; sumar teléfonos, DNI y patentes da falsos positivos en fechas y en ejemplos de formato.
11. **Dónde vive la pestaña Base.** Los 25 a 30 KB en cada carga de `/agente`, o una página propia `/agente/base`.
12. **El piso de derivar en la sombra:** heridos o gravedad crítica. Es sobre-inclusivo a propósito; una gravedad alta por pérdida total no es piso.
13. **El Lote B**, todo con OK del dueño y ninguno construido:
    - B1: pasar al entrenamiento cada decisión que cumpla el umbral, una por PR; el piso nunca pasa.
    - B2, B3 y B8: el ajuste pago de Vertex (servir el modelo ajustado, la compuerta de aprobación con `eval:extraccion` y el desfase del JSONL de entrenamiento). Sólo después de la evaluación y con el OK de gasto.
    - B4: los candidatos a ejemplo y los id de ejemplos por corrida, nunca de `email_sim` ni `whatsapp_sim` ni con texto de corridas por mail.
    - B5: el léxico del piso de heridos con negaciones («no hubo heridos»), en código.
    - B6: medir la derivación por padrón, con una llamada extra sólo en el ensayo o la evaluación y detrás de una variable de entorno.
    - B7: reglas del cliente en una sola línea en el prompt de extracción, con el snapshot regenerado y revisado.
    - B9: los agregados de la sombra en la consola.
    - B10: filtrar las claves inventadas que el extractor devuelve por culpa de una regla.
14. **Propuestas para un PR en un repo público.** Se tapan DNI, pólizas, enlaces, mails y teléfonos, pero no los nombres: el dueño las lee antes de abrir el PR.

### Alta automática, lote 1 (2026-10-16, PR #461)

Los cuatro ítems chicos del «Plan para que el alta sea automática» (`docs/PUESTA_EN_MARCHA.md`) que no esperaban una decisión del dueño. Sin migración ni variables nuevas. Entran en el mismo PR que el Lote A del agente, para gastar un solo deploy.

- **Ítem 1.** El menú lateral del operador muestra «Altas», con enlace a `/admin/altas`. Un admin de un cliente no lo ve.
- **Ítem 5.** `/admin/altas` muestra la mediana y el p95 de lo que tardó un espacio en quedar listo en los últimos 30 días, desde `tenant_bases` (`src/server/alta/panel-operador.ts`; el formato sale de `src/core/fecha/duracion.ts`).
- **Ítem 6.** El guardia, `/configuracion` y `/api/health` leen el tope con la misma función, `topeMensualDelProyecto()` en `src/lib/topes.ts`. Antes health leía el 0 como 200 y la pantalla mostraba siempre 200. Con `MONTHLY_BUDGET_USD=0` el guardia frena la IA de los clientes (la demo sigue con su tope, `DEMO_MONTHLY_BUDGET_USD`), la pantalla dice «IA frenada» y health queda en `degraded` con HTTP 200: un `down` daría 503 y tumbaría el smoke, el `curl -fsS` del Post-deploy y el barrido. Que 0 quiera decir «sin tope» (opción B) lo decide el dueño.
- **Ítem 12.** `.env.example` nombra todas las variables que lee el código, y `tests/unit/env-example-completo.test.ts` falla si aparece una nueva sin anotar.
- **Verificación.** Suite entera en verde (14.319 tests) antes de sumar el Lote A. La revisión de Fable pidió un test que fije que el guardia frena con el tope en 0 y precisar que la demo tiene su propio tope; las dos cosas están. La auditoría #90 queda parcial: health todavía repite la suma del gasto del mes.

### Promoción del 17/10: la consola del agente y el alta, lote 1, en los tres ambientes

#461 entró a qa el 17/10 a las 00:05 UTC (`00c7d9c9`), y con él quedaron mergeados #459 y #460. #462 lo llevó a main a las 00:23 UTC (`16b059de`, mismo árbol que qa) y #463 de main a prd a las 00:53 UTC (`9501f548`), el mismo día, porque dev, qa y prd tienen que estar iguales. Sin migraciones ni variables nuevas, y `AGENTE_APRENDIDO_EN_CONVERSACION` sigue ausente en los tres ambientes.

- **QA.** Post-deploy sobre `00c7d9c9` (run 38984817593): smoke, migraciones y permisos, secretos propios y ensayo de conversaciones en verde, las 24 sin diferencias con lo esperado.
- **La sombra en QA.** El ensayo de QA escribe la sombra en la base de QA, lo que confirma el permiso de `UPDATE` en `agent_runs` con tráfico real. Resumen del ensayo (no cuenta para el resultado): gravedad 36/36, derivar 36/36, pedir 7/18 (39 %), responder 17/23 (74 %), 31 vueltas sin opinión y **cero `BAJA EL PISO`**. De las 11 diferencias de pedir, 7 son el modelo pidiendo exactamente lo mismo que el código menos un campo: cuatro cosas donde el código pide cinco. Es el «como máximo 4 cosas» del criterio 4 de `deliberate` contra `MAX_ASK_ITEMS = 5` (decisión 7 de la lista de arriba), así que esa parte de la diferencia la pone la base, no el modelo; con el mismo tope, pedir quedaría cerca de 14/18. Las de responder son `pedir` contra `callar` en los dos sentidos. Gravedad y derivar ya están al 100 % pero con 36 comparaciones, lejos de las 100 que pide el umbral.
- **DEV.** Post-deploy sobre `16b059de` (run 38986311850) en verde: smoke, migraciones y permisos, entrada por WhatsApp y mail, pen test y carga del tablero (p95 del peor caso 385 ms, contra 500 de presupuesto). El ensayo se salteó porque QA ya había ensayado el mismo árbol.
- **`pnpm check` completo después del deploy de dev.** El primer intento quedó rojo en verify por un artefacto local: `tests/unit/env-example-completo.test.ts` recorría también `src/app/.well-known/workflow/`, la ruta que genera el build de workflow 5 y que está en `.gitignore`, y encontraba `FORCE_COLOR` y `NO_COLOR`. En CI esa ruta no existe y por eso pasaba. El test ahora la saltea (constante `GENERADOS`). El segundo intento, con el arreglo, dio verde en 13,7 min: 15.025 tests, invariantes, las 26 conversaciones sin diferencias con lo esperado y el smoke de dev sobre `16b059d`. La sombra de ese ensayo: gravedad 40/40, derivar 39/40, pedir 9/19 (47 %) y responder 19/29 (66 %), con 12 vueltas sin opinión en pedir y 2 en responder. Hubo **un `BAJA EL PISO`**, otra vez en `accidente-personal-fractura`, y el piso lo atajó: el caso terminó en `requiere_especialista`. De las 10 diferencias de pedir, 8 son el tope de cuatro contra cinco de la decisión 7.
- **El transcripto, leído.** Una revisión con un lector por conversación y un refutador por hallazgo dejó 8 de 25 hallazgos, todos de gravedad media o baja. Ninguno toca PII, promesas de cobertura o montos, ni el piso. El de gravedad media es de `goteo`: en el turno 3 el agente dice que sólo faltan la póliza y la patente, y en el 4 suma provincia, hora y fotos; la sombra muestra que el modelo pedía más que el código. Revisado en el código, no es un error: el `pedir.codigo` de la sombra es `normalizarFaltantes(sinPlan)`, el árbol sin plan, y lo que se le pide de verdad a la persona ya sale del plan del agente. Los otros siete son de tono y redacción: el mail de derivación a especialista (`src/server/email/templates/specialist-escalation.ts`) no saluda por el nombre aunque lo tiene, da como referencia el UUID entero, firma como ClaimMix frente al asegurado de otra compañía y mezcla «reclamo», «denuncia» y «escalado»; los recordatorios de 48 h y 5 días (`recordatorios.ts`) no saludan ni dicen que repiten un pedido anterior; el mail de `mail-grave` abre sin nombrar a Laura; y dos saludos del modelo sin la coma del vocativo («Hola Marta.», «Hola Diego,»). Los recordatorios y la coma se arreglan en el lote siguiente; el resto es decisión del dueño.
- **PRD.** `PRD · Smoke y salud de las bases` sobre `9501f548` (run 38988417465) en verde.
- **Paridad.** `git rev-parse origin/{qa,main,prd}^{tree}` da el mismo árbol en los tres: `d45e8496`.

### Tono del transcripto (2026-10-17, rama `agente/tono-transcripto`)

Tres arreglos de redacción que salieron de leer el transcripto del `pnpm check` del 17/10. Los dos primeros son reglas de cómo escribir, así que viven en el entrenamiento base y no en el código; el tercero es un dato que le faltaba al redactor.

- **El recordatorio dice que repite el pedido.** Los recordatorios de 48 h y 5 días y el reenvío manual salían como cualquier mensaje de seguimiento. Ahora `enviarPedido` (`src/server/confirmations/reenvio.ts`) manda `repitePedido: true`, `messenger.ts` lo pasa a `composeReply`, y el prompt suma la sección nueva `entrenamiento/base/redactar/07-recordatorio.md` (`redactar.recordatorio`) sólo en ese caso. Si redactar falla, el piso de WhatsApp abre con «Te recordamos que necesitamos». Los pedidos nuevos de `orchestrate.ts` no llevan la señal.
- **Saludo en WhatsApp.** Dos oraciones en `redactar/04-canal-whatsapp.md`: saludar sólo en el primer mensaje, con coma en el vocativo («Hola, Marta.»), y en una charla que sigue arrancar sin «Hola» (directo o con el nombre). La segunda salió de la revisión del transcripto: con sólo la coma, el turno 2 de `nota-de-voz-y-pdf` volvió a abrir con «Hola, Lucía.» y repitió el pedido palabra por palabra.
- **Los seguimientos no se escriben como primer mensaje.** Con la regla de 04 sola, la derivación del turno 3 de `nota-de-voz-y-pdf` y la pregunta de póliza del turno 5 de `devolver-al-agente` seguían abriendo con «Hola, …». La causa: sólo los pedidos de datos de `orchestrate.ts` traen `isFollowUp`, y sin él `composeReply` le dice al modelo «Es el primer mensaje que le mandamos.»; el dato equivocado le gana a la regla. Ahora `writeReply` decide con `esSeguimiento(message)` (`src/server/confirmations/messenger.ts`): usa `isFollowUp` si viene y, si no, mira `outbound_messages` con `hasPriorOutbound`, como ya hacía el mensajero web, que pasa a usar la misma función. El redactor corre antes de que se escriba la fila del mensaje actual, así que ese mensaje nunca cuenta como previo. Un primer mensaje que quedó en `failed` también cuenta como previo, igual que en los llamados que ya existían.
- **Entrenamiento base.** 21 secciones, 17 de prompt. Los prompts dorados de WhatsApp cambian sólo por la oración nueva y hay uno nuevo, `compose-recordatorio-whatsapp.txt`.
- **Lo que no se toca.** `goteo` no es un error (ver la sección de arriba). El mail sin saludo con nombre, el UUID como referencia, la firma de ClaimMix y «reclamo» en los asuntos son decisiones del dueño.
- **Revisión del transcripto.** Un workflow comparó el transcripto nuevo con el del 17/10 (13 hallazgos, 4 sobrevivieron al refutador). Además del saludo repetido, quedan tres que son variación del modelo y no salen de este cambio: `foto-que-no-es-nada` dejó de pedir la fecha en el turno 2 sin que la persona la diera (el plan del agente la sacó; el escenario pasa igual), `mail-grave` no dijo «llamá a la línea de emergencias de tu póliza» aunque el brief de derivación lo pide (en el ensayo anterior sí estaba; si se repite, una guarda como `dropped_handoff` lo ataja, pero suma código y es decisión del dueño), y un ítem del recordatorio quedó cortado: «La hora aproximada en que fue».
- **Verificación.** Tipos, lint, `--comprobar` y 15.034 tests verdes. `pnpm check --local` verde con los dos primeros arreglos (16,8 min, 26 conversaciones sin diferencias) y ensayo de cuatro escenarios verde con la regla nueva de 04. Con `esSeguimiento`, ensayo de `nota-de-voz-y-pdf` y `devolver-al-agente` verde y ningún turno de seguimiento abre con «Hola»; sombra: gravedad 6/6, derivar 6/6, pedir 2/2, responder 3/6, 0 baja el piso. En esa corrida `nota-de-voz-y-pdf` no llegó a derivar (el turno 2 cortó por tiempo y se retomó), así que la derivación la cubre el test nuevo de `whatsapp-messenger.test.ts`.

### Promoción del 17/10 (segunda): el tono del agente en los tres ambientes

#465 entró a qa el 17/10 a las 02:29 UTC (`897d6a3c`) y reemplazó a #464, que quedó cerrado. #466 lo llevó a main a las 02:48 UTC (`1a6ce97a`, mismo árbol que qa) y #467 de main a prd a las 03:17 UTC (`d67d6bfe`), el mismo día, porque dev, qa y prd tienen que estar iguales. Sin migraciones ni variables nuevas.

- **QA.** Post-deploy sobre `897d6a3c` (run 38995205249) en verde en 17,6 min: secretos propios, smoke, migraciones y permisos, ensayo de conversaciones (las 24 sin diferencias con lo esperado, en 14 min) y pen test.
- **La sombra en QA.** Resumen del ensayo (no cuenta para el resultado): gravedad 35/35, derivar 34/35, pedir 6/18 (33 %), responder 18/24 (75 %), 8 vueltas sin opinión en pedir y 2 en responder. **Un `BAJA EL PISO`**, otra vez en `accidente-personal-fractura`, y el piso lo atajó: el caso terminó derivado a especialista con gravedad alta. De las 12 diferencias de pedir, 9 son el tope de cuatro contra cinco de la decisión 7; las otras 3 son el modelo pidiendo un campo de más o de menos (licencia, hora, provincia y fotos). Las de responder son `callar` contra `pedir` en los dos sentidos y una `contestar` contra `pedir`.
- **DEV.** Post-deploy sobre `1a6ce97a` (run 38996465465) en verde: smoke, migraciones y permisos, entrada por WhatsApp y mail, pen test y carga del tablero (p95 del peor caso 453 ms, contra 500 de presupuesto). El ensayo se salteó porque QA ya había ensayado el mismo árbol.
- **`pnpm check` completo después del deploy de dev.** Desde `C:/Users/Ilan/cmchk` sobre `1a6ce97a`, en verde en 16,8 min: tipos, lint, tests, las 26 conversaciones sin diferencias con lo esperado y el estado del deploy de dev en orden. Todos los primeros mensajes de WhatsApp saludan con coma en el vocativo («Hola, Martín.») o con «Hola.» cuando todavía no hay nombre (`goteo` y `archivo-pesado`), y ningún mensaje de una charla que sigue vuelve a decir «Hola»: la derivación del turno 3 de `nota-de-voz-y-pdf` ahora abre «Lucía, derivamos la denuncia…». Sombra: gravedad 39/39, derivar 37/39, pedir 10/21 con 8 vueltas sin opinión, responder 23/28. Las dos diferencias de derivar son el `BAJA EL PISO` de `accidente-personal-fractura`, atajado como en QA, y `nota-de-voz-y-pdf`, donde el agente no derivaba y el código sí; los dos casos terminaron derivados. De las 11 diferencias de pedir, 8 son el tope de cuatro contra cinco.
- **PRD.** `PRD · Smoke y salud de las bases` sobre `d67d6bfe` (run 38998273647) en verde.
- **El transcripto, leído.** Una revisión con un lector por tramo (WhatsApp en dos partes, mail y el piso) y refutadores dejó 6 de 19 hallazgos, ninguno del piso: ni PII, ni promesas de cobertura o montos, ni lesiones sin derivar. El de gravedad media es una regresión que trajo la regla nueva de 04: los seguimientos ya no acusan recibo. En la corrida anterior había cuatro «Gracias, Martín.» y aperturas como «Perfecto, Martín» o «Bárbaro, Martín»; en esta, ninguna, y los turnos 2 y 3 de `choque-completo` arrancan directo con el pedido («Martín, mandanos el parte…»). El modelo leyó «arrancá directo o con el nombre» como «sin cortesía»; se arregla en el lote siguiente. Los otros son de gravedad baja: el ítem «La hora aproximada en que fue» quedó cortado en el turno 2 de `nota-de-voz-y-pdf` y en los recordatorios de `recordatorio-por-mail` (variación del modelo, ya vista en la revisión anterior), y el texto fijo del piso `CUIDADO` (`src/core/mensajes/derivacion.ts`) dice «lo que están pasando» a una sola persona, igual que antes.
- **Paridad.** `git rev-parse origin/{qa,main,prd}^{tree}` da el mismo árbol en los tres: `8cbb8e92`.

### Acuse de recibo en WhatsApp (2026-10-17, rama `agente/acuse-de-recibo`)

Arregla la regresión que encontró la lectura del transcripto de la segunda promoción: con «arrancá directo o con el nombre», los seguimientos de WhatsApp dejaron de agradecer lo que la persona mandaba. Es una regla de redacción, así que el cambio es una oración de `entrenamiento/base/redactar/04-canal-whatsapp.md` y no código.

- **La regla.** En una charla que sigue, sigue sin decirse «Hola». Si en su último mensaje la persona mandó datos, fotos o archivos que pudimos usar, el agente lo agradece en una frase corta: en un seguimiento, «Gracias, Marta.» (o «Gracias.» si todavía no sabe el nombre); en el primer mensaje, después del saludo y sin repetir el nombre («Hola, Marta. Gracias por los datos.»). En un acuse de recibo, el agradecimiento no es una frase aparte: va dentro de las dos oraciones del acuse. Si la persona preguntó algo, primero va la respuesta. No agradece en un recordatorio, en un caso grave (fuego, heridos, robo), si la persona pidió perdón o si lo que mandó no sirvió: en el primer mensaje saluda igual, y en un seguimiento arranca directo o con el nombre.
- **Por qué las excepciones.** La primera versión decía sólo «agradecéselo antes que nada». Una revisión de la redacción contra el resto del entrenamiento encontró cuatro lugares donde eso choca: el recordatorio (`07-recordatorio.md`, la persona no mandó nada), la sobriedad de los casos graves y la regla de no agradecer un perdón (`06-tono.md`), el archivo que no se pudo usar, y el primer mensaje, donde «antes que nada» podía poner el «Gracias» antes del saludo o duplicar el acuse de `03-acuse.md`. Una segunda revisión encontró que el «Gracias» se sumaba al «tomamos nota» de `03-acuse.md` y pasaba su tope de dos oraciones, y el ensayo mostró «Hola, Martín. Gracias, Martín.» en un primer mensaje; de ahí dos aclaraciones. Una tercera revisión encontró que «ahí arrancá directo» podía sacar el saludo del primer mensaje de un caso grave, contra la apertura de `CUIDADO` de `compose-reply.ts` («Abrí (después del saludo, si saludás)»), y que «sus dos oraciones» no decía si el saludo contaba; el ensayo mostró además un seguimiento sin agradecer cuando todavía no se sabía el nombre. Una cuarta revisión encontró que el «Gracias» del principio chocaba con «Empezá el mensaje contestándola» de `compose-reply.ts` cuando la persona pregunta algo, y que «el saludo no cuenta» no tenía a qué referirse, porque un acuse nunca es el primer mensaje. La versión final separa el seguimiento del primer mensaje, pone la respuesta antes del agradecimiento, mete el agradecimiento dentro del acuse y suma «Gracias.» sin nombre. Queda como estaba el ejemplo «Gracias por los datos» del primer mensaje (la revisión proponía «por lo que nos mandaste»): un primer mensaje casi siempre trae datos escritos.
- **Entrenamiento base.** 21 secciones, reempaquetado; los tres prompts dorados de WhatsApp (`compose-ask-whatsapp.txt`, `compose-poliza-cambiada-whatsapp.txt`, `compose-recordatorio-whatsapp.txt`) cambian sólo por esa oración. No hay cuerpo en inglés para esta sección, así que no cambia nada de i18n.
- **Verificación.** Cinco versiones de la oración, cada una con su workflow (type-check, lint, `entrenamiento:empaquetar --comprobar` y la suite completa, 15.034 tests verdes) y una revisión de la redacción contra el resto del entrenamiento; la quinta revisión, sólo de regresiones, no encontró ninguna. Ensayos contra el agente real: v1 (cinco escenarios) verde; v2 rojo sólo en el turno 3 de `choque-completo` por `claim_attachments_bucket.upload_failed` (la subida de la licencia a R2 desde la red local falló y la licencia nunca se leyó: infraestructura, no redacción); v3 (los mismos cinco) verde, con `choque-completo` pasando; v4 y v5 (ocho: los cinco más `incendio-grave`, `accidente-personal-fractura` y `archivo-pesado`) verdes y sin `upload_failed`. Con v5, los seguimientos vuelven a abrir con «Gracias, Martín.», «Gracias, Roberto.» o «Gracias, Lucía.», los primeros mensajes con «Hola, Martín. Gracias por los datos.», y ninguna charla que sigue vuelve a decir «Hola»; los casos graves (incendio, fractura) saludan y no agradecen, y no se agradecen ni el archivo de más de 10 MB ni la nota de voz sin voz. Sombra de v5: gravedad 19/19, derivar 17/19, pedir 8/13, responder 11/15; las dos diferencias de «derivar» son la derivación de `nota-de-voz-y-pdf` y la fractura, y el único BAJA EL PISO es otra vez la fractura (la sombra no derivaría, el código deriva, el piso lo ataja y el caso termina en `requiere_especialista`). Queda como variación del modelo el turno 2 de `goteo`: todavía sin nombre, no agradeció en ninguno de los tres últimos ensayos. `foto-que-no-es-nada` T2 (`ignored_unclaim`) y `devolver-al-agente` T3 (el caso lo tiene una persona) quedan en silencio, como en corridas anteriores.

### Promoción del 17/10 (tercera): el acuse de recibo en los tres ambientes

#468 entró a qa el 17/10 a las 04:23 UTC (`b204dd25`). #469 lo llevó a main a las 04:44 UTC (`f16652f0`, mismo árbol que qa) y #470 de main a prd a las 19:00 UTC (`8a64ed8e`), el mismo día, porque dev, qa y prd tienen que estar iguales. Sin migraciones ni variables nuevas.

- **QA.** Post-deploy sobre `b204dd25` (run 39002465574) en verde en 18 min: secretos propios, smoke, migraciones y permisos, ensayo de conversaciones (las 24 sin diferencias con lo esperado) y pen test. La carga de k6 (run 39002465482) también en verde.
- **La sombra en QA.** 36 vueltas: gravedad 36/36, derivar 35/36 con el BAJA EL PISO de la fractura atajado por el piso, pedir 6/17 (8 de las 11 diferencias son el tope de 4 contra `MAX_ASK_ITEMS = 5`) y responder 19/26.
- **DEV.** Post-deploy sobre `f16652f0` (run 39003765605) en verde: smoke, entrada por WhatsApp y mail, migraciones y permisos, pen test y carga del tablero (p95 peor caso 411 ms). El ensayo se salteó porque QA ya había ensayado el mismo árbol.
- **`pnpm check` completo después del deploy de dev.** Verde en 15,1 min al segundo intento: tipos, lint, tests y las 26 conversaciones sin diferencias con lo esperado. El primer intento cortó en la verificación por la caída conocida del worker de vitest en Windows, con cero tests fallidos. La sombra, leída de las líneas `◐ sombra` del log: 39 vueltas, gravedad 39/39, derivar 38/39 (el mismo BAJA EL PISO de la fractura, atajado por el piso), pedir 10/21 (8 de las 11 diferencias son el tope de 4 contra 5) y responder 21/29.
- **PRD.** `PRD · Smoke y salud de las bases` sobre `8a64ed8e` (run 39060635332) en verde.
- **El transcripto, leído.** Comparado con el del check anterior, con un refutador por observación: 12 observaciones de tono, las 12 refutadas (variaciones entre corridas o textos fijos del código, no del agente). Los seguimientos vuelven a agradecer («Gracias, Martín.»), y no aparece PII, ninguna promesa ni nada que toque el piso.
- **Paridad.** `git rev-parse origin/{qa,main,prd}^{tree}` da el mismo árbol en los tres: `cfb98a63`.

### Puesta en marcha: las decisiones de A1 (17/10)

El dueño eligió las opciones de A1 de `docs/PUESTA_EN_MARCHA.md`. Las banderas entraron en el lote de A12 (ver la sección siguiente).

- **D1 (b).** `ALTA_NUMERO_AUTOMATICO` en 1 también en dev y QA (prd la tiene desde el 09/10). El único lugar libre de la WABA es primero del cliente ficticio de prd; en dev nadie pide el código hasta que esa alta termine y su número se borre (D5), o hasta A5. QA va sin token de WhatsApp: sus altas por código terminan en revisión con `sin_credencial`.
- **El resto.** D2: `BASE_POR_CLIENTE` en 0 en dev y QA, excepción declarada. D3: Gmail de prueba de Gonzalo en QA, sin número de WhatsApp hasta su propia WABA. D4 (a): dominio propio del dueño. D5: borrar el número del cliente ficticio y suspender el espacio. D6: `ALTA_AUTOMATICA` en 1 en QA. D7: topes iguales a prd; `MONTHLY_BUDGET_USD` y `AI_TENANT_DAILY_TOKEN_CAP` más altos en dev y QA. D8: el dueño es operador en los tres, Gonzalo no. D14: sin MCP de WhatsApp. D15: reportes por chat o correo al dueño.
- **Hallazgo de Meta.** El tope de dos números es por portfolio de negocio, no por WABA (https://developers.facebook.com/docs/whatsapp/cloud-api/phone-numbers: «New business portfolios are initially capped at two registered business phone numbers.»). Veltra es un solo portfolio y su número de la plataforma ya usa un lugar, así que una WABA nueva dentro de Veltra no suma lugares, y cada WABA necesita su propio número de la plataforma. Una WABA y un token por ambiente esperan a A5: receta en `docs/PUESTA_EN_MARCHA.md`, «Después de A5: una WABA y un token por ambiente».

### Puesta en marcha: el lote de variables de A12 (17–18/10)

Variables de Vercel cargadas y borradas con OK del dueño, sin leer ni copiar ningún valor secreto. Prd no se tocó.

- **Cargadas en dev y QA (17/10).** `ALTA_NUMERO_AUTOMATICO=1`, `ALTA_TOPE_BASES=30`, `ALTA_TOPE_MB=350` y otra vez `ALTA_TOPE_GLOBAL_DIA=5`; en QA también `ALTA_AUTOMATICA=1`. Los topes quedan iguales a prd (D7).
- **Borradas porque el código no las lee (17/10).** 17 en total. En dev: `OPENAI_API_KEY`, `OPENAI_MODEL` y las cinco `SMTP_*`. En QA: `GEMINI_API_KEY` (muerta desde Vertex), las cuatro `INTEGRATION_*_PASSWORD` (son secretos de GitHub, no de Vercel), `OPENAI_API_KEY`, `STAGING_DATABASE_URL(_APP)` y las dos `UPSTASH_*`.
- **Borradas para igualar a prd (18/10).** En QA, `SENTRY_DSN` y `NEXT_PUBLIC_SENTRY_DSN`: Sentry es opcional y prd no lo tiene. En dev, `SIMULATE_WORKER_DELAY_MS` y `SIMULATE_WORKER_MAX_DELAY_MS`, con lo que valen los defaults de `simulation-throttle.ts` (5000 y 120000 ms). Quedan 67 variables en dev y 65 en QA, ninguna sobrante.
- **QA y el correo.** `/registro` de QA no ofrecía el correo porque `GMAIL_CLIENT_ID` y `GMAIL_CLIENT_SECRET` existen pero vinieron vacíos del import del 17/09. `GMAIL_TOKEN_ENCRYPTION_KEY` y las dos de Turnstile ya tenían valor. El 18/10 el dueño decidió que QA tenga su propio cliente OAuth de Gmail, `claimmix-qa`, tipo «Aplicación web», en el mismo proyecto de Google Cloud que el de dev y prd y con el mismo tope de 100 usuarios; sus URI de redirección son el callback de Gmail de QA (`https://claimmix-qa.vercel.app/api/admin/gmail-accounts/callback`) y `http://127.0.0.1:53682/` para el script del remitente. El dueño pone el ID y el secreto en `.env.qa.local` y corre `token-remitente.mts --vercel claimmix-qa --correo <casilla>`, que los sube a `claimmix-qa` y vuelve a emitir el remitente: el del 15/10 salió del cliente de dev. Después le dice «listo» a Claude. Hecho el 18/10: el script cargó el cliente y el remitente en `claimmix-qa`, el merge de #474 (`32c65a14`) fue el redeploy, y `/registro` de QA muestra el correo, Turnstile y el aviso del número por código. El secreto viejo de «ClaimMix QA» (del 19/09) no lo usa nadie.
- **Gmail por ambiente, cargado por script (18/10).** `scripts/token-remitente.mts --vercel <proyecto>` sube, en QA y en prd, el cliente de Gmail del archivo del ambiente (`.env.qa.local`, `.env.prd.local`) y después el remitente; se niega si el cliente repite el de otro ambiente. `scripts/sync-vercel-env.mjs` sólo carga dev, desde `.env.local`. El dueño decidió que prd tenga su propio cliente, en su propio proyecto de Google Cloud (`claimmix-prd-veltra`, «ClaimMix PRD») y con la misma cuenta de facturación, con el tema, la suscripción y la cuenta de servicio de Pub/Sub en ese proyecto (OK del dueño para los permisos de IAM, sólo ahí). prd no tenía casillas conectadas, así que el cambio de cliente no rompe ninguna. Dev se queda con el cliente original. La receta está en `docs/PUESTA_EN_MARCHA.md` (prd, paso 1).
- **Prd, hecho el 19/10.** En `claimmix-prd-veltra`: APIs de Gmail, Pub/Sub e IAM, el tema `gmail-push-prd` con permiso de publicar para la cuenta de Gmail, la suscripción push `gmail-push-prd-sub` (sin vencimiento) y la cuenta de servicio `gmail-push-prd`. En `claimmix-prd`: `PUBSUB_TOPIC` y `PUBSUB_SERVICE_ACCOUNT` nuevas; el dueño creó la pantalla de consentimiento, la publicó (pedía la página principal, la política de privacidad y las condiciones) y creó el cliente web `claimmix-prd`; `token-remitente.mts --vercel claimmix-prd` subió el cliente y emitió el remitente con `veltra.claimmix@gmail.com`. Todo vale desde el deploy de #477. Con OK del dueño, el 19/10 se borraron el tema `gmail-push-prd` y la suscripción `gmail-push-prd-sub` viejos del proyecto de dev; la cuenta de servicio `pubsub-push-gmail` queda, porque también la usa la suscripción de dev (`gmail-inbound-push`).
- **Redeploy.** Dev se redeployó el 18/10 sobre `49c7dc32` para tomar el lote. QA se redeployó con el merge de #474 (`32c65a14`) el 18/10. prd se redeployó una sola vez, el 19/10, con la promoción #477 (`48fb6cd6`), que llevó también el arreglo de la sección siguiente; el Post-deploy de PRD salió verde y `/registro` de prd muestra el correo, Turnstile y el aviso del número.

### Un siniestro nuevo por WhatsApp sobre un caso terminado (19/10, #479)

El 19/10 el dueño mandó una denuncia nueva por WhatsApp a dev y no tuvo respuesta. El mensaje llegó, pero el mismo teléfono tenía un caso de prueba del 15/10 en `listo_para_core`: `findExistingWhatsAppCase` lo sumó a ese caso, el worker no arrancó al agente porque el estado no se reanuda, el clasificador de tardíos dijo `siniestro_nuevo` y sólo se avisó al equipo por mail.

- **Qué cambia.** Si el tardío de WhatsApp sale `siniestro_nuevo`, se abre un caso nuevo con el episodio (los entrantes sin contestar desde la última respuesta, hasta diez) y el agente lo atiende como cualquier denuncia. El caso viejo no cambia de estado. Auditorías nuevas: `claim.late_message_split` en el viejo y `claim.opened_from_late_message` en el nuevo.
- **Cuándo no se corta.** El corte se decide dentro del `INSERT`: no se corta si el caso ya se partió, si una persona lo tomó, o si hubo una respuesta humana por plantilla dentro de las últimas 24 h. En esos casos queda como antes, «Para responder» y aviso al equipo. Mensajes y adjuntos que llegan durante el corte siguen al caso donde está el mensaje.
- **Toma con reasignación.** Una toma que además reasigna quedaba auditada como `case.assigned` y la guarda del agente no la veía; ahora queda como `case.status_changed` (`src/server/cases/patch.ts`).
- **Límites.** El caso nuevo vuelve a pedir el nombre (no copia datos personales del viejo) y `assigned_to` no pasa al caso nuevo. La regla de las 24 h es un supuesto a confirmar con el dueño.
- **Probado.** `pnpm check --local` en verde con las 26 conversaciones del ensayo, entre ellas la nueva `tardio-siniestro-nuevo`, con el transcripto leído. El `FOR SHARE` sobre `claim_messages` pide UPDATE y la política RLS de UPDATE: verificado para el rol de la app en dev, QA y la base del inquilino de prd.
- **En los tres ambientes (19/10).** qa por #479 (`c1b548be`), main por #480 (`4b9fc723`, con el `pnpm check` completo en verde) y prd por #477 (`48fb6cd6`), con el Post-deploy de QA, DEV y PRD en verde. El árbol es el mismo en los tres.

### Alta automática, lote 2 (20/10, #484)

Tres ítems más del «Plan para que el alta sea automática» que no esperaban una decisión del dueño. Sin migración ni variables nuevas. Los ítems 2 y 3 (Gmail por origen y casilla vencida; banderas del alta en `/api/health`) ya habían entrado por #475.

- **Ítem 4.** «Conectar a mano» en `/admin/altas` le pone al número el webhook del ambiente (override por número) y lo vuelve a leer antes de anotarlo (`src/server/alta/panel-operador.ts`, `ponerElWebhook` en `pasos-del-numero.ts`). Si el número ya tiene un webhook propio de otro ambiente contesta `webhook_ajeno` y no lo toca; si Meta lo rechaza, `sin_webhook`; sin credencial, WABA o URL https, `sin_credencial`. El número de la plataforma no se toca.
- **Ítem 11.** `/admin/altas` muestra los lugares libres de la WABA del ambiente (`src/server/alta/lugares-de-la-waba.ts`). `/admin/cartera` suma prueba, estado y MB de la base propia y costo de IA por denuncia, en la misma consulta.
- **Ítem 13.** `src/lib/topes.ts` es el único lugar donde se leen los topes del entorno; `entero()` sale y `tests/unit/lib/topes-unico.test.ts` lo fija.
- **Límites.** Hasta A5, dev y prd comparten app y WABA: conectar a mano en dev un número de prd sin override le pondría el webhook de dev. Si la anotación rechaza el número después de poner el override, el override queda, igual que en el camino automático. La tarjeta cuenta números de la WABA, no el tope de Meta por portfolio.
- **Probado.** tsc, lint y 15.425 tests unitarios en verde; la revisión de seguridad de Fable no encontró nada. Falta la prueba con una persona del ítem 4.

### Promoción del 20/10 a prd y #487 en QA (#486, #488)

- **A prd.** #486 llevó qa a main (`10e3770a`) y #488 llevó main a prd (`2e5d7eed`): el lote 2 del alta automática (#484) y la guía con A3 de tres direcciones por ambiente y D4 en (b) (#485). main y prd tienen el mismo árbol, `c988cd18`. El Post-deploy de PRD sobre `2e5d7eed` salió en verde (run 39520796397).
- **En QA, todavía no en main ni en prd.** #487 (`ec21f4a5`, árbol `e8f50f0d`): el ítem 9 del plan, lote 1, la prueba del alta de punta a punta en cada deploy de QA. Sigue a main y a prd con la próxima promoción.

### D4 automático: el analista como alias de la Gmail del administrador (21/10, #489)

No hay dominio propio, así que en un espacio de prueba ninguna invitación pasaba el filtro de dominio, y D4 (b) pedía que el dueño activara a mano cada espacio con cuota 0 antes de invitar al analista. #489 lo resuelve sin activar nada y sin escribir en el espacio: D4 (d), la opción B del diseño, aprobada con cambios de seguridad. Sin migración ni variables nuevas.

- **Qué cambia.** En `POST /api/admin/users`, con el espacio en prueba (`enPrueba`: autoalta y prueba), además de una dirección del dominio del administrador se acepta un alias `+` de su propia casilla de Gmail (`aSuPropiaCasilla`, `src/app/api/admin/users/route.ts:131-150`). `casillaDeGmail` (`src/lib/email/reserved.ts:86-98`) reduce `local[+alias]@gmail.com` a la casilla de fondo, sin puntos ni alias, y no cruza gmail.com con googlemail.com: la invitada y la del administrador tienen que dar la misma. La casilla del administrador tiene que tener el correo verificado (`user.emailVerified === true`); si no, la invitación se rechaza por dominio.
- **Qué no cambia.** El orden del endpoint: cupo (cinco por día), dominio, dirección de operador (202 sin enviar), asiento `USER_INVITED`, sello y envío. Las direcciones de `ADMIN_EMAILS` siguen bloqueadas aunque lleguen por un alias, porque se comparan exactas (`isOperatorEmail`). El botón «activar» de `/admin/altas` queda como estaba. No hay activación automática ni escrituras nuevas en el espacio.
- **Qué queda asentado.** El asiento de `USER_INVITED` lleva `{ rol, alias: true }` cuando la invitación salió por la casilla propia, sin la dirección; `{ rol, bloqueada: true }` para un operador; `{ rol }` en el resto.
- **El texto del rechazo.** `usuarios.error.dominio` (`src/lib/i18n/es-AR.servidor.ts:397`) ahora dice que en la prueba se puede invitar a personas del propio dominio o a un alias `+` de la misma casilla de Gmail.
- **La aceptación.** `/invitacion` no ofrece Google para una dirección Gmail con `+` (`src/app/invitacion/page.tsx:162`): Google devuelve la casilla base, que no coincide con la invitada. Queda la contraseña.
- **Límites.** No sirve para invitar a un compañero con su propia Gmail: para eso, la activación a mano (b) o un dominio propio (a). Pasa también la casilla base sin alias o con otros puntos, porque es la misma bandeja. La pantalla de aceptación sólo oculta Google cuando la dirección lleva `+`.
- **Tests.** `tests/unit/admin-users-invitacion.test.ts`, `tests/unit/reserved-vedadas.test.ts` y `tests/unit/invitacion-page.test.tsx`.
- **Ambientes.** En los tres desde el 21/10: #489 a qa (`a109947a`), #490 a main (`45714c00`) y #493 a prd (`796e314c`). main y prd tienen el mismo árbol, `7ddfbf53`, y el Post-deploy de PRD sobre `796e314c` salió en verde (run 39708862978).
- **Guía.** `docs/PUESTA_EN_MARCHA.md` pasa a D4 (d): A1, A3, dev paso 8, QA paso 8, prd pasos 10 y 14, «Si prueban otros en prd», C1, «Cuando entra un cliente real» y «Decisiones pendientes». De paso corrige restos viejos de la guía: el número por código figuraba apagado en dev y QA (está en 1 en los tres desde el 17/10), `/admin/altas` figuraba fuera del menú lateral (está en el menú del operador desde #461) y el texto del rechazo se citaba en `es-AR.servidor.ts:387`, que es `:397`.

### Paridad de banderas entre dev, QA y prd (21/10, #495)

Ítem 10 del plan de `docs/PUESTA_EN_MARCHA.md`: hasta ahora las variables de los tres proyectos se comparaban a mano (A12).

- **Qué entra.** `pnpm paridad` (`scripts/paridad.mjs` y `scripts/lib/paridad.mjs`, sólo `fetch` y módulos de Node) le pide `/api/health` a dev, QA y prd con el Bearer de cada uno, junta `banderas` y lista lo que difiere. Las excepciones viven sólo en `EXCEPCIONES`, cada una con su motivo. Un ambiente ilegible (sin secreto, 401, sin respuesta) no tapa la comparación del resto.
- **Sólo avisa.** El job `paridad` de `post-deploy.yml` corre al lado de los chequeos, sin `needs` (esperar a los reusables es esperar al ensayo entero), en cualquiera de los tres deploys y deja `::warning::` y el resumen del run. `continue-on-error` va en el job y en el paso, para que no ponga roja la corrida de QA y anule la marca `ensayo-verde-<árbol>`; el script sale siempre con 0 y `qa_veredicto` no lo espera: nunca pone rojo un deploy. El ambiente recién desplegado se lee recién cuando `/api/health` sirve el commit del deploy (el alias de Vercel se mueve después del aviso); si no llega en unos tres minutos queda ilegible, no se compara el build viejo.
- **Logs públicos.** En Actions salen sólo la clave, el tipo de diferencia y qué ambientes coinciden (`dev=qa≠prd`), nunca un valor. Los valores se ven corriéndolo a mano. El secreto de cada ambiente viaja sólo a su origen, y la URL de prd sale de `vars.PRD_URL`.
- **Tests.** `tests/unit/paridad.test.ts` (comparador, contrato de valores, URL de prd y script sin red) y la parte de `tests/unit/ci-prd.test.ts` que fija el job.
- **Lo que sigue en manos del dueño.** Los valores reales de D7 en dev y QA (hoy desconocidos en la guía) y los huecos de `AI_PRUEBA_*` y `ALTA_PRUEBA_DIAS`: el comparador pide que sean iguales, pero no decide cuánto valen. Si algún día debe bloquear en vez de avisar, es decisión suya.
- **Primera corrida, a mano (21/10).** dev contra prd da tres diferencias. Dos son `omision`: `AI_PRUEBA_MONTHLY_USD_POR_INQUILINO` y `AI_PRUEBAS_MONTHLY_BUDGET_USD` no están cargadas en dev (rige el valor por defecto de `src/lib/topes.ts`, 1 y 30) y en prd están cargadas con esos mismos valores, así que el efecto es igual pero `/api/health` informa el valor crudo. La otra es `regla`: `SIGNUP_ALLOWED_EMAILS` está cargada en dev con `ALTA_AUTOMATICA` en 1; con el alta automática prendida la lista no cambia nada en tiempo de ejecución (`altaAbierta` en `src/lib/auth/registro-permitido.ts`), pero tapa la prueba de autoalta si algún día se apaga. Sacarla de dev es decisión del dueño. QA no se pudo leer en local porque `.env.local` no tiene `QA_CRON_SECRET`; en Actions sí se lee.
- **Ambientes.** Entra a qa junto con #494 por una sola rama de integración (`integra/paridad-sembrar`), para pagar un solo CI y un solo ensayo de QA, y sigue a main y a prd por la regla de ambientes iguales.

### Sembrado por la puerta del alta (21/10, #494)

`pnpm sembrar` creaba las cuentas de prueba con `signUpEmail` fuera de `enAlta`, y el gancho del alta rechaza con 422 toda alta que no entra por ninguna puerta. En CI no se notaba porque las cuentas ya existen en la base del ensayo y el sembrado sólo les pone la contraseña al día. Contra una base nueva, como la de un ambiente independiente, se plantaba en la primera cuenta. Ahora `scripts/sembrar-para-integracion.mts` usa `enAlta("correo", …)`, igual que el modo `--carga` del mismo script. Entra a qa con #495 por la misma rama de integración.

### Lote de la segunda auditoría (22/10, #499)

La segunda corrida de los catorce prompts (un Workflow de sólo lectura, con seguridad en Fable) dio 55 hallazgos confirmados, y security-auditor, re-corrido en cinco alcances, sumó cuatro más (S1 a S4). Todos los arreglos entran en un solo lote, `lote/auditoria-limpieza`, con un commit por área.

- **Migraciones, aplicadas a mano antes del merge.** 0052 (índices de las FK de `agent_runs` y `training_examples`) y 0053 (`users.dado_de_baja_en`) están en QA, dev, staging, prd (control y `t_20000000000000000000000000000002`) y la rama de ensayo de prd. `--exigir-al-dia` da verde en las tres y `bases:empaquetar --comprobar` da 53.
- **S1, baja de usuarios.** Un DELETE nuevo en `/api/admin/users/[id]`, sólo para administradores, que no sirve contra uno mismo ni contra un dueño; lo deshace un PATCH con `{activo:true}`. `filaDeUsuario` ignora a los dados de baja y `session.create.before` (`revisarSesionNueva`) corta la contraseña, Google y el SSO del inquilino con `usuario_de_baja`. Tras la baja no entra nadie nuevo por ningún camino. Quien ya tenía la pestaña abierta conserva su rol hasta 30 s, sólo en las instancias que ya tenían su fila en memoria (`filaDeUsuario`); la que atendió la baja lo corta en el acto. La cookie de sesión (60 s) sola no da datos: sin fila, el layout, las páginas y las APIs lo rechazan. Esos 30 s son un residuo aceptado, no algo cubierto: las altas, bajas y cambios de rol miran a quien pide en la base, no en la caché, pero lo demás que haga en esos 30 s no siempre deja fila en `audit_log`. Las lecturas de casos y de adjuntos (salvo abrir un presupuesto o bajar el JSON de `export-to-core`) no se auditan, y desconectar o cambiar una casilla de Gmail (`/api/admin/gmail-accounts`) o reprocesar los sin clasificar (`/api/admin/reprocess-unclassified`) tampoco dejan fila. La baja no rota la clave de `/api/v1` ni el secreto del webhook de core-sync: al dar de baja a un admin, rotarlos a mano. Si el espejo a `t_<hex>` falla dos veces seguidas, la copia espera al próximo `espejarTodas`, que corre al final de `reap-stuck` sólo si sobra tiempo: en prd `barrer-trabados` cada dos horas (`23 */2`, GitHub puede demorarlo horas) y Vercel una vez por día a las 04:07 UTC.
- **S2 a S4.** El tope del formulario web cuenta la dirección canónica (sin alias `+` ni puntos de Gmail), un analista no responde por WhatsApp un caso asignado a otra persona, y `agent/export`, `metricas` y `export-to-core` pasan por `entrar()` con cupo de pedidos.
- **B1 a B9.** Los cortes pasajeros de Gemini vuelven a la cola en vez de escalar, entran los mails sólo HTML y la ubicación y los contactos de WhatsApp, la salud y los crons avisan cuando algo falla, las bases por cliente no se traban en `creando`, hay contraste y títulos por pantalla en los dos idiomas, las pruebas de carga miden lo que dicen y se va código duplicado. El detalle por hallazgo está en el cuerpo del PR.
- **Guía.** El mail agente es la Gmail de Veltra en los tres ambientes (decisión del dueño del 22/10), «Activa» sólo donde se prueba; en prd primero sale de `CASILLAS_DE_DEV`.
- **Comprobación.** `pnpm check --local` en verde salvo `mail-tardio-pregunta-como-va`, que cortó por un timeout de Gemini en el clasificador del mensaje tardío; ensayado solo dio verde, y `pnpm smoke` contra dev también.
- **Ambientes.** Entra a qa por #499 y sigue a main y a prd el mismo día, por la regla de ambientes iguales.
- **Queda afuera.** H3 (índice duplicado) espera una corrida de Carga en QA, y «marcar respondido» sigue como está: hoy lo hace cualquiera del equipo, por diseño de la cola.

### Lote 2 de la auditoría (22/10)

Lo que el lote anterior dejó para después, en `lote/auditoria-2`. Sin migraciones ni textos nuevos fuera del evento de la línea de tiempo.

- **Baja, alta y rol con candado por espacio.** `cambiarUsuario`, en `src/app/api/admin/users/[id]/route.ts`, junta las tres operaciones en un solo lote de control (`enControlVarias`): primero `pg_advisory_xact_lock(hashtext('admins'), hashtext(<espacio>))`, después la lectura del rol de antes y el UPDATE, con una guarda `EXISTS` sobre quien pide, leído de la base: vivo, y owner, o admin que no toca a un owner ni asigna owner. Dos admins que se dan de baja a la vez quedan en fila: el segundo ya ve al primero dado de baja y recibe 403, así que al espacio siempre le queda quien lo administre. Un admin dado de baja o degradado hace segundos, con la caché todavía en owner, tampoco cambia a nadie. Toda ruta nueva que escriba `users.role` o `users.dado_de_baja_en` tiene que pasar por `cambiarUsuario`, y el 400 contra uno mismo es parte de la invariante.
- **Reintento del espejo.** `espejarSinFallar` vuelve a intentar una vez en el acto, porque la copia vieja dura hasta el próximo barrido; con `3D000` (la base no existe todavía o ya no está) no reintenta. Sigue anotando sólo el código.
- **Auditoría de `export-to-core`.** Bajar el JSON deja `case.exported_to_core` en el mismo lote que la lectura (`auditoriaSiExiste`, con el `tenant_id` sacado del propio caso), con payload vacío y sin datos personales. Falla cerrado: si el registro no entra, tampoco sale el JSON. Acople: el registro lleva el `actor_id` y `audit_log.actor_id` tiene FK a `users`, así que si el actor todavía no está en la copia `t_<hex>` (espejo pendiente) la exportación da error en vez de bajar el JSON sin rastro. La línea de tiempo lo muestra con quien lo pidió y no cuenta como intervención en las métricas.
- **Prueba pendiente: concurrencia real.** Las pruebas de este lote miran el SQL y el orden del lote, no el candado. Falta una de integración con base: bajas mutuas en paralelo entre dos admins que dan `[200, 403]`, con exactamente uno dado de baja y sin `40P01`; caché vieja de owner que da 403; habilitación entre dados de baja que da 403. Va en `tests/integration` con `skipIf(!INTEGRATION_ENABLED)`. En el CI usa `STAGING_DATABASE_URL` (`ci.yml:470`), o QA con las herramientas del repo; nunca contra prd. Con limpieza propia y después del Post-deploy.

### El alta en dos pasos (22/10, rama `alta/dos-pasos`)

Quien crea una cuenta puede venir a dar de alta su empresa o a sumarse a una que ya usa ClaimMix, y `/registro` le pedía la empresa y el WhatsApp junto con la cuenta. Ahora el alta tiene dos pasos y la rama todavía no está mergeada.

- **Paso 1, `/registro`.** Sólo la cuenta: nombre, correo y términos, o Google. El enlace sellado conserva el `info` HKDF `alta-correo` y la hora de vida, y lleva únicamente `{e, nombre, locale, exp}`. El enlace de `/alta/correo` crea la cuenta, verifica el correo, abre la sesión y sigue en `/alta`; no crea perfil, espacio, número ni cupo de `alta:ip`.
- **Paso 2, `/alta`.** Dos caminos en `<details name="camino">`: «Dar de alta mi empresa» (empresa, WhatsApp y términos, que llama a `crearEspacio` y `crearInquilino` como antes) y «Mi empresa ya usa ClaimMix», un texto fijo sin consulta a la base: pide al administrador que invite la dirección de la sesión (no manda a `/login` ni al SSO: una cuenta del paso 1 todavía no tiene perfil y el SSO la rechaza con `sin_perfil`). Si el propio navegador trae la cookie `cm_invitacion` de esa dirección (`invitacionDeLaSesion`), el enlace «Seguir con tu invitación» a `/invitacion` reemplaza ese pedido y el camino se abre solo. La pestaña del navegador dice «Alta».
- **Qué se movió.** La lógica del alta vive en módulos de servidor sin `"use server"`: `src/server/alta/cuenta-del-enlace.ts` (nuevo, `crearCuentaDelEnlace`) y `src/server/alta/crear-espacio.ts` (antes `destinos.ts`, ahora `crearEspacio`). Las acciones `crearCuentaDesdeCorreo` y `crearMiEspacio` son envoltorios finos, y `tests/unit/alta/acciones-de-alta-sin-reexportar.test.ts` fija que no la publiquen. Se borró `src/server/alta/cookie.ts` (la cookie `cm_alta` ya no se usa).
- **Recuperar el acceso sin perfil.** Una cuenta del paso 1 no tiene perfil y puede ser sólo de Google. Cuando pide recuperar el acceso, `src/server/notify/password-reset.ts` le manda el mail de «recuperar» (antes, sin perfil, el de «activar») con el texto `correo.recuperar.noFuisteSinPerfil`, que no dice que la contraseña actual sigue funcionando, y lo cuenta contra el cupo del remitente del tipo `recuperacion` (antes, `alta`). `correoDeEnlace` (`src/server/notify/correos-de-alta.ts`) recibe el parámetro `sinPerfil` para eso. Ningún tope cambia (`ALTA_TOPE_CORREOS_DIA`, `ALTA_TOPE_POR_DESTINATARIO_DIA`), sólo en qué contador se gasta (`docs/SEGURIDAD.md`, deuda 12 d). `tests/unit/notify/password-reset.test.ts`.
- **Controles que siguen.** Turnstile, `auth:up`, `auth:ip`, `alta:correo-ip`, `alta:ip`, el aviso neutro, el correo de operador, el dominio con SSO, el alta cerrada, el tope global de 24 horas dentro de la función de la 0048 y `provisionUserProfile`. Sin migración ni variables nuevas.
- **Ensayo de QA.** `scripts/probar-alta.mts` corre los módulos de verdad (ya no una copia) en dos pasos y suma el escenario `v` (enlace con la forma vieja) y los códigos `enlace_ok`, `enlace_viejo_ok`, `registro_pide_empresa` y `enlace_creo_espacio` (`docs/TESTING.md`, capa 11).
- **Al desplegar.** Un enlace del correo emitido con la forma vieja (empresa y número adentro) vale una hora y abre sólo la cuenta: la empresa escrita se pierde y se pide en `/alta`. Para volver atrás dentro de esa hora, el código viejo rechaza los enlaces nuevos como vencidos. Una cookie `cm_alta` vieja ya no tiene lector y vence sola.
- **Lo que decide el dueño.** (a) Qué ve en `/alta` quien tiene cuenta sin espacio y su dominio exige SSO (`sin_perfil` con SSO): hoy ve el mismo texto fijo. (b) Si `/alta` debería listar las invitaciones vigentes de la dirección (opción B): no se hizo, agrega una consulta y una posible fuga (`docs/SEGURIDAD.md`, deuda 12).
- **A probar en QA.** El destino de Google (`newUserCallbackURL`): si no llega a `/alta`, el respaldo es `/bandeja`, luego `/pendiente` y luego `/alta`.
- **Tests.** `registro-page`, `registro-actions`, `invitacion`, `pendiente-page`, `admin-users-invitacion`, `probar-alta-orden`, `probar-alta-reglas` y `tests/unit/alta/` (`alta-page`, `correo-actions`, `crear-mi-espacio`, `preparar-espacio`, `token-de-registro`, `cuenta-del-enlace`, `crear-espacio`, `acciones-de-alta-sin-reexportar`). No hay specs de Playwright para `/registro`, `/alta`, `/alta/correo` ni `/invitacion`.

### Número por código para cualquier código de país (24/10, rama `alta/numero-cualquier-pais`)

`/alta` y el número por código sólo aceptaban celulares argentinos. Ahora aceptan el número de la empresa con el código de cualquier país. La rama todavía no está mergeada.

- **Qué cambia.** `partirNumero` (`src/server/whatsapp/alta-de-numero.ts`) corta el número con una tabla de códigos de país de la UIT que vive sólo en el servidor (`CODIGOS_DE_PAIS`, un `Set`, sin dependencias nuevas). La tabla es libre de prefijo: probando 1, 2 y 3 dígitos, a lo sumo un código coincide. Quedan afuera los no geográficos (800, 808, 870, 878, 881, 882, 883, 888, 979, 991) y el 997. `PartesDelNumero.cc` pasa a ser un `string`. La parte nacional se deja entera: el 0 troncal no se saca (Italia lo conserva).
- **+54 sigue igual.** Un `+54` sigue pidiendo el 9 y diez dígitos (`+549…`). `aRevision("pais")` queda sólo para un código que no es válido o no se reconoce, y para un `+54` que no es celular.
- **El desvío de `waba-propia.ts`.** El plan decía usar `partirNumero` en `vincularWaba` (`src/server/alta/waba-propia.ts`, donde antes había `startsWith("+54")`). Se usa `codigoDePais`, que sólo mira el código. Motivo: ahí el corte por `pais` viene después de canjear el código de Meta, así que cortar con `partirNumero` por un `+54` sin el 9 que Meta ya registró (un fijo) perdería el token y gastaría el cupo. El centinela `waba-propia.test.ts` («el mismo número con o sin el 9…») lo cuida. En `numero-automatico.ts`, en cambio, el corte viene antes de Graph, así que ahí `partirNumero` sigue bien y los cupos de código vuelven con `pais`.
- **Textos.** `alta.whatsapp.ayuda`, `alta.error.datos` y `alta.avisoNumero.motivo.pais`, en es-AR y en-US juntos, con ejemplos ficticios: dicen que es el número de la empresa y no el celular personal de quien administra, y que lleva el código de su país. El placeholder del campo en `/alta` es `+…`: ya no sugiere un país. `E164` se exporta de `src/server/alta/validar.ts` para no repetir la expresión.
- **Qué no cambia.** El 9 argentino: `alta.error.celular`, `faltaElNueveArgentino`, `mismoNumero` y el `'^[+]549'` del SQL siguen igual, porque tratan a `+549` y `+54` como el mismo número. No hay migración: 0048 y 0051 ya aceptan cualquier E.164. El bundle queda intacto: la tabla es de servidor y `TOPE_KB` (310 y 48) no se mueve.
- **Residuos.** (1) No hay largo por país: un número mal tipeado con un código válido llega a Meta y termina en `rechazo`. Para que eso no agote `ALTA_TOPE_NUMEROS_DIA` (de toda la plataforma, 2 por defecto), en `sumarALaWaba` (`src/server/alta/numero-automatico.ts`) un `rechazo` de Graph al agregar devuelve ese tope diario: no entró ningún número. El cupo del espacio (uno por hora) y los de código se quedan gastados, porque el pedido sí salió a Graph; un `meta` (timeout, 5xx, 2xx sin id) no devuelve nada, porque el número pudo entrar. (2) El popup de la WABA propia precarga país AR y zona horaria `UTC-03:00`. (3) `mismoNumero` sólo normaliza el 9 argentino. (4) El 997 queda afuera. (5) La plantilla `reabrir_denuncia` está en español y el agente atiende en es y en en-US: el dueño tiene que saberlo antes de prender un cliente de otro país.
- **Tests.** `tests/unit/whatsapp/alta-de-numero.test.ts` (válidos y nulos de `partirNumero`, libre de prefijo, `codigoDePais`), `tests/unit/alta/numero-automatico.test.ts`, `tests/unit/alta/waba-propia.test.ts`, `tests/unit/alta/aviso-numero-en-revision.test.ts` y `tests/unit/alta/alta-page.test.tsx`.
- **Guía.** `docs/whatsapp-setup.md` (seis líneas editadas en el lugar, sin mover ninguna) y `docs/PUESTA_EN_MARCHA.md` A3 (qué tiene `ADMIN_EMAILS` en dev, sin direcciones).
- **Número de la plataforma, verificado el 24/10 sin tocar nada.** Conectado, Cloud API, calidad verde, TIER_250, con el webhook de la app apuntando a dev hasta A5. Los datos de la línea están en «The real number is live», más arriba.
- **Comprobación.** `pnpm verify` en verde (tipos, lint, 16013 pruebas, flujos, datos personales, arquitectura) y `pnpm check --local` en verde, con las 26 conversaciones del ensayo sin diferencias al primer intento. El `pnpm check` completo (con el smoke de producción) queda para después del deploy.
- **Ambientes.** Entra a qa por PR y sigue a main y a prd el mismo día, por la regla de ambientes iguales.

### Avisos de topes al operador y mes argentino (24/10, rama `alta/avisos-topes`, #514)

Ítems 7 y 17 de `docs/PUESTA_EN_MARCHA.md` (P3 y P14, decisión D13): el operador se entera por mail cuando el uso pasa el 80 % o llega al 100 % de un tope, y el día y el mes del presupuesto son los argentinos. Van juntos porque, si el 7 saliera solo, sus marcas vencerían a las 00:00 UTC y el cambio de mes del 17 repetiría los mails. El PR todavía no está mergeado.

- **Qué avisa.** Los cuatro topes que cuestan plata o cierran el alta: el gasto de IA del mes (`MONTHLY_BUDGET_USD`), el pozo de las pruebas (`AI_PRUEBAS_MONTHLY_BUDGET_USD`), la cantidad de bases de cliente (`ALTA_TOPE_BASES`) y los MB del proyecto de Neon (`ALTA_TOPE_MB`). Un tope en 0 no avisa (en `MONTHLY_BUDGET_USD` es la IA parada a propósito; en los `ALTA_TOPE_*`, que no hay tope).
- **Dónde corre.** `avisarTopes` (`src/server/alta/aviso-de-topes.ts`) es un paso más del barrido de `reap-stuck`, global y detrás de un try/catch: nunca frena lo demás, y el JSON del barrido suma `avisos_de_topes`. Corre en cada barrido (cada 15 minutos en dev, cada 2 h en QA y prd); lo que evita la repetición es la marca.
- **Una vez por umbral, tope y mes.** La marca es una fila de `rate_limit_counters` cuyo `window_start` es el primer instante del mes siguiente, así que `purgeExpiredRateLimits` no la toca hasta que el mes termina. La clave es `aviso-tope:<nombre>:<tope>:<umbral>:<AAAA-MM>`: lleva el valor del tope, así que subirlo en medio del mes y volver a llegar al 80 % avisa de nuevo. La marca del 100 % pone también la del 80 %: un gasto que baja del 100 al 80 no manda un «80» tarde. La marca se pone después del mail, no antes: una puesta antes y huérfana (la corrida murió en el envío, que no tiene plazo y Vercel corta a los 300 s, o la base perdió la respuesta del insert) dejaría ese umbral mudo todo el mes, incluso el 100 % con la IA ya cortada. Si el mail no sale o la corrida muere, no queda marca y el barrido siguiente reintenta; lo que se acepta a cambio es que dos corridas simultáneas, o una que mandó y no llegó a marcar, repitan el mail una vez (el workflow serializa los barridos y el cupo global del tipo `topes` acota el resto). Sin migración y sin variables nuevas.
- **Tres sentencias por barrido como máximo, no una por tope.** Una de medición: `sumaMensualDelProyecto` (`src/server/ai/budget.ts`, con el mismo cálculo de gasto que `checkBudget`) trae también las bases y los MB (`extras`), y del catálogo sólo mide lo que tiene tope; si falla se registra como `alta.aviso_topes_medicion_fallo`, no como `budget.monthly_check_error`, que es del guardia de IA. Una para leer las marcas ya puestas, `marcasPuestas`, con todas las claves juntas. Y una para ponerlas, `ponerMarcas`, sólo si el mail salió a alguna dirección. El destinatario y el envío son los de `aviso-operador.ts` (`destinatariosDeOperacion`, `mandarAlOperador`), los mismos de los otros dos avisos al operador. El tope de bases y el de MB salen de `topeDeBases` y `topeDeMb`, y las medidas del SQL de `src/server/alta/catalogo.ts`: es el mismo texto que usa el corte del alta en `crear-inquilino.ts`, así que el aviso no contradice al cierre. El 100 % es `>=`, como el corte; las cifras del mail se redondean sin pasarse, para que el 80 % no diga «350 de 350».
- **El mail.** Uno solo por barrido a cada dirección de `ADMIN_EMAILS`, con una línea por cada umbral nuevo, por la casilla remitente del ambiente (`enviarCorreoDelSistema`, tipo propio `topes` con su cupo diario global, aparte de `operador` y sin cupo por dirección, para que el del 100 % no quede atrás de los tres por día de esa casilla). Textos en es-AR y en-US (`alta.avisoTope.*`); no lleva datos de nadie, sólo números y nombres de tope.
- **El mes es el argentino (ítem 17).** `inicioDelMes` (`src/core/fecha/inicio-del-mes.ts`) devuelve el inicio de `mesArgentino`, la medianoche de acá del primero (03:00 UTC). La marca vence al fin de ese mes y el `AAAA-MM` de la clave sale de `diaArgentino`. El guardia del gasto (`checkBudget` y `checkDemoBudget`, `src/server/ai/budget.ts`) cuenta el día desde `medianocheHaceDias(1)` y el mes desde `inicioDelMes`, con un solo «ahora» por cálculo para que el día y el mes no queden en lados distintos de la medianoche; `/api/health` suma desde el mismo instante. Siguen en UTC, a propósito: el limitador, el cupo de la 0048, las ventanas del barrido, `/admin/facturacion` y `/admin/cartera`. Efecto visible: el tope diario de tokens se renueva a las 00:00 de acá y no a las 21:00, y el día del deploy, si sale entre las 21 y las 24 de acá, cuenta más uso que antes. Sin migración, SQL ni textos nuevos.
- **Tests.** `tests/unit/alta/aviso-de-topes.test.ts` (umbrales, una vez por umbral, tope y mes, tope subido a mitad de mes, 100 % que marca el 80 %, redondeo sin pasarse, marcas leídas en una sentencia y puestas después del mail (no queda marca si el envío tira o no sale a nadie, y el barrido siguiente reintenta), sin remitente ni destinatarios, tope en 0, sin datos personales), `tests/unit/core/inicio-del-mes.test.ts` (la fecha vive en `src/core/fecha/inicio-del-mes.ts`, pura; el borde del 31 a las 23:59 y el de diciembre a enero) y casos nuevos en `aviso-operador` (los dos helpers), `budget-prueba` (el evento de la falla, y el día y el mes argentinos del guardia), `health-route` (la medianoche argentina del primero, la misma que el guardia), `rate-limit-postgres`, `una-sola-clave-de-cupo`, `remitente-sistema` (sin cupo por dirección), `cron-reap-stuck-route` e `i18n`.
- **El transcripto de `check --local`, leído.** Nada de lo que tocó la rama es del agente y el ensayo dio 26/26. Una sola cosa se arregló, y es del redactor: ante «¿Qué tengo que mandarles?» el mail abría con «todavía no tenemos los detalles de tu cobertura ni los tiempos de resolución» (3 de 3 corridas de `recordatorio-por-mail` abrían con una salvedad así), porque el bloque de la pregunta de `compose-reply.ts` mandaba nombrar lo que no sabemos aunque nadie lo hubiera preguntado. Ahora sólo se dice lo que se preguntó y, si lo que preguntó es qué mandar, la respuesta es la lista con una frase que la presente. Con el cambio, 3 de 3 corridas abren «Para avanzar con tu denuncia, necesitamos…», y `pregunta` («¿Cuánto suele tardar esto?») sigue contestando que no hay plazo. Dorado `compose-derivacion-con-pregunta-mail.txt` actualizado, diff leído. Quedan como estaban: el caso nuevo de `tardio-siniestro-nuevo` vuelve a pedir nombre y póliza (el diseño de #479: no copia datos personales del caso viejo), el turno 2 de `nota-de-voz-y-pdf` repite el pedido con el audio mudo (ya anotado el 17/10), y el «DNI o CUIT (DNI …, o CUIT …)» duplicado del mail es variación del modelo desde #442.
- **Falta.** La prueba en QA, que corre el dueño: bajar `ALTA_TOPE_MB` a 1 en QA y redeployar QA (la variable rige sólo en el deploy nuevo), esperar al barrido (o disparar `barrer-trabados.yml`), ver llegar el mail, volver a 350 y redeployar otra vez (mientras esté en 1 el alta de QA queda cerrada). Cada redeploy gasta un build de Hobby.
- **Ambientes.** Entra a qa por PR y sigue a main y a prd el mismo día, por la regla de ambientes iguales.

### Costo por caso (25/10, rama `facturacion/costo-por-caso`, ítem 15)

Ítem 15 de `docs/PUESTA_EN_MARCHA.md` (P5, decisión D13): `/admin/facturacion` muestra cuánto cuesta un caso, con la mediana, el p95 y la cantidad de casos del mes. Sale de `ai_usage`, que hasta hoy no sabía de qué caso era cada llamada. Entró a qa por #517, a main por #518 y a prd por #519 el 26/10 (prd `328ad49a`, árbol `acf6b037`); la 0054 está en las seis bases desde el 25/10.

- **Migración 0054, a aplicar a mano antes del merge.** `ALTER TABLE public.ai_usage ADD COLUMN IF NOT EXISTS case_id uuid`, una sola sentencia, repetible. Nula, sin FK (control recibe la misma fila y no tiene `cases`; borrar un caso no debe tocar el gasto ni disparar el trigger de la 0046 por fila), sin índice (un `CREATE INDEX` sin `CONCURRENTLY` dentro de la transacción del runner frena las escrituras), sin default y sin backfill: el uso anterior queda sin caso. No lleva GRANT ni POLICY (los permisos son por tabla y la política por `tenant_id`) y el acumulador `ai_usage_mensual` (0046) no se toca: su trigger nombra sus columnas y no la ve. Orden, con `node scripts/migrate.mjs --apply` por TCP: QA (`ep-wispy-flower`, `QA_DATABASE_URL`), dev (`ep-proud-resonance`, que también es la base de los secretos `DATABASE_URL` del CI), `STAGING_DATABASE_URL` y `node scripts/migrar-bases.mjs --env prd` (control, rama de ensayo y bases `t_<hex>`). Cada base se identifica por su canal de casos y no por su nombre; después, la consulta `EXCEPT` de la cabecera de la 0046 tiene que dar vacía en cada una. Sin ensayo, Post-deploy ni otro workflow corriendo mientras se migra. Vuelta atrás: primero revertir el código; después `ALTER TABLE public.ai_usage DROP COLUMN IF EXISTS case_id` y `node scripts/migrate.mjs --forget 0054 --apply` en cada base. Al revés vuelve el 42703.
- **Por qué no se puede desplegar antes.** Drizzle nombra `case_id` en cada INSERT a `ai_usage`. Con el código desplegado y la columna sin aplicar, el INSERT da 42703, `recordUsage` se lo traga y ningún gasto de IA se anota: los topes, los avisos del 80 y el 100 %, el acumulador de la 0046 y la facturación quedan ciegos. Por eso `/api/health` exige la columna (`ai_usage.case_id` en `required`: sin ella el chequeo de migraciones da `down`) y `VERSION_ESPERADA` es 54 (`bases.desfase`). Se regeneró `plantilla.generated.ts` con `pnpm bases:empaquetar`; `--comprobar` da 54. El código viejo con la columna puesta sigue andando.
- **Qué se anota.** `recordUsage` y `registrarConsumoDelModelo` reciben `caseId` como último parámetro, opcional y `null` por defecto; la fila lleva `case_id: caseId && esUuid(caseId) ? caseId : null`. La guarda existe porque la demo anónima manda `"demo"` como caso: un no-uuid daría 22P02, el reintento sólo saca `user_id` y la fila se perdería. `esUuid` sale de `src/data/bases.ts` (no se copió la regex). Pasan el caso que ya tienen la extracción, la deliberación, los documentos, el mensaje tardío, la transcripción, `leerDocumento` (obligatorio: `caseId: string | null`, con `lectura-reclamo`, `pregunta-caso` y la ruta del presupuesto) y el redactor (`ComposeReplyInput.caseId: string`, obligatorio, que pasa `writeReply` del mensajero); el asistente pasa `detalle.id` en `resumenDelCaso`. Sin caso, a propósito: el asistente general, la demo y las condiciones de póliza (`caseId: null`). Obligatorio donde se pudo, porque opcional se pudre: el llamador que lo olvida deja la fila sin caso y no falla nada. No se agregó ninguna consulta para averiguar el caso.
- **La cifra.** `computeStatement` sigue en tres `enTenant` (inquilino, conteos, gasto). La tercera suma un campo, `costos_por_caso`: una subconsulta cruda con `json_agg` del gasto agrupado por `case_id`, unida a `cases` (sin alias) con el filtro de período de siempre (`esCasoReal`, casos creados en el mes). Lo que no es de un caso, o es de un caso borrado, queda afuera por el join. `costoPorCaso` (`src/lib/billing/costo-por-caso.ts`, puro) saca la mediana y el p95 con interpolación como `percentile_cont`, a cuatro decimales, y acepta el arreglo ya parseado o como texto. `ai_cost.per_case` es opcional: sin casos con gasto no hay cifra.
- **La pantalla.** `/admin/facturacion`, en «Lo que costó», suma la fila «Costo por caso (mediana · p95 · casos)» y una nota: es estimado a precio de lista de Gemini y cobra la caché entera, así que la factura de Google puede salir algo menor. Textos en es-AR y en-US (`facturacion.costoPorCaso*`, sólo en los diccionarios del servidor).
- **El mes es el UTC, a propósito.** `/admin/facturacion` sigue en el mes UTC (ítem 17 lo dejó así) y el costo por caso usa el mismo período. `ai_usage_mensual` usa el mes argentino: no se mezclan.
- **Facturas congeladas.** La liquidación congela el resumen (`per_case`) y no la lista cruda. Las anteriores a la 0054 no lo tienen y dicen «sin datos de costo por caso en este período» (no «este mes»: la pantalla abre meses pasados, y una liquidación sin el dato no se distingue de un mes sin casos con gasto); nunca se recalculan ni se vuelven a congelar.
- **Tests.** `tests/unit/migracion-0054.test.ts`, `tests/unit/billing/costo-por-caso.test.ts`, `costo-por-caso-sql.test.ts` y `facturacion-costo-por-caso.test.tsx`; en `billing-freeze` (el resumen, y la factura vieja sin `per_case`), `budget-control`, `todo-lo-que-gasta-se-anota`, `gasto-de-la-demo-anonima`, `cupo-por-usuario`, `health-route` y `plantilla-bases` casos nuevos; y las aserciones de cada llamador que ahora pasa el caso (`deliberate`, `case-documents`, `compose-reply`, `email-messenger`, `lectura-reclamo`, `leer-documento`, `presupuesto-route`, `condiciones-route`, `pregunta-caso`, `responder`, `mensaje-tardio`, `transcribir`, `extraccion-fallida-se-anota`). La subconsulta se comprueba por su forma, no contra una base con casos (`docs/TESTING.md`, «Costo por caso»).
- **Falta.** Que el dueño aplique la 0054 en el orden de arriba; después, `--exigir-al-dia` en verde en las tres y `pnpm bases:empaquetar --comprobar` en 54, y recién ahí `pnpm check` completo y el PR a `qa`. Esta sección dice «aplicadas» cuando eso ocurra, no antes. Para ver la cifra: abrir `/admin/facturacion` con casos del mes y comprobar que la cantidad coincida con los casos del mes de `/metricas`. El primer mes es parcial (el uso previo a la 0054 no tiene caso), y un cambio de modelo (el 3.8 cuesta unas cinco veces el 2.5) mueve la mediana.
- **Ambientes.** Entra a qa por PR y sigue a main y a prd el mismo día, por la regla de ambientes iguales, con la 0054 ya aplicada en las cuatro bases.

### Pedir acceso en /alta (26/10, rama `alta/pedir-acceso`, ítem 16)

Ítem 16 de `docs/PUESTA_EN_MARCHA.md` (P7, decisión D13): la persona con el correo verificado y sin perfil ve «Pedir acceso» junto a «Mi empresa ya usa ClaimMix», y los administradores de su dominio reciben un mail. La rama sale de `facturacion/costo-por-caso` (#517, que ya entró a qa, main y prd) para no chocar con sus filas de la guía. Sin migración ni variables nuevas. Entró a qa por #522, a main por #524 y a prd por #525 el 26/10 (prd `0fd80a3b`, árbol `44a1c4dc`).

- **Neutralidad.** `pedirAcceso()` (`src/app/alta/actions.ts`) no recibe argumentos, pasa la guarda que comparte con `crearMiEspacio` (`personaDelAlta`), agenda `after(() => pedirAccesoAlEspacio({ userId, email }))`, deja la cookie `cm_pedido` de 2 minutos (id de la sesión; sólo la escribe la acción, la página la lee con `pedidoDeLaSesion`) y vuelve siempre a `/alta`; antes de contestar no consulta la base ni cuenta nada. El botón sale igual haya o no un espacio para el dominio, y el texto del estado es fijo. Con una dirección de proveedor abierto (`dominioDeEmpresa` da null) la página no lo ofrece ni muestra el estado, porque no habría a quién avisar: sale de la dirección de la sesión, no de la base, y no dice qué empresas son clientes. Queda un canal de tiempos teórico, aceptado en `docs/SEGURIDAD.md` §11.12.
- **Qué hace `pedirAccesoAlEspacio`** (`src/server/alta/pedir-acceso.ts`, nunca lanza). Sale sin hacer nada si no hay remitente del sistema o el dominio es público. Cupo `alta:acceso-persona` (uno por día, sobre la dirección canónica, con falla cerrada; cuenta aunque no haya espacio). Una sola consulta de administradores (`owner` y `admin` activos, verificados, no bloqueados, de espacios que no estén suspendidos ni dados de baja, del dominio exacto, sin `ADMIN_EMAILS` ni quien pide, y sólo si quien pide no tiene perfil; hasta 20). Cupo `alta:acceso-espacio` (cinco por día y espacio, vuelve si no salió ningún mail). Un mail de texto fijo por administrador, en su idioma, por `enviarCorreoDelSistema` con el tipo nuevo `acceso`, que tiene su tope global y no cuenta por dirección ni por IP: por administrador rige el tope del espacio, o el cuarto pedido del día no saldría. `esDominioPublico` suma los proveedores de internet argentinos, como dominios completos por igualdad exacta (`fibertel.com.ar`, `speedy.com.ar`, `arnet.com.ar`, `ciudad.com.ar`, `uolsinectis.com.ar`, `sinectis.com.ar`, `telecentro.com.ar`, `telecentro.net.ar`, `infovia.com.ar`). Es la lista de todos, así que también cierra `/api/admin/sso` (ningún espacio reclama esos dominios) y la invitación de un espacio en prueba en `/api/admin/users` (un administrador con `@fibertel.com.ar` ya no invita a otra casilla del mismo proveedor, igual que con Gmail); decisión tomada, fijada con tests de los dos endpoints. `dominioDeEmpresa` (`src/core/sso.ts`) junta «dominio válido y no público» para la página y para `pedirAccesoAlEspacio`.
- **El mail.** `correoDePedidoDeAcceso` (`src/server/notify/correos-de-alta.ts`), claves `correo.acceso.*` y `alta.pedirAcceso`/`alta.pedido` en es-AR y en-US. Lleva la dirección de quien pide, sola en su línea, y el enlace a `/admin/users`; no lleva el nombre de la empresa ni el de nadie. Lo registrado es `{ administradores, enviados }` o el nombre de un error.
- **Tests.** `tests/unit/alta/pedir-acceso.test.ts` y `pedir-acceso-accion.test.ts` nuevos; `alta-page.test.tsx`, `acciones-de-alta-sin-reexportar.test.ts`, `remitente-sistema.test.ts`, `core/sso.test.ts`, `admin-users-invitacion.test.ts` y `integration/admin/sso.test.ts` ampliados. `ultimoValor` (`src/lib/ultimo-valor.ts`, con su test) reemplaza las copias de `/alta`, `/alta/correo` e `/invitacion`.
- **Falta.** La prueba en QA, que corre el dueño (`alta:probar` no ejecuta `after()` y usa un remitente falso): un administrador en un dominio de QA, una persona nueva de ese dominio con el correo verificado, «Pedir acceso» y el mail una sola vez. El check completo en dev (`b1b9c6bf`) dio rojo sólo en goteo T4 por timeouts de Vertex; goteo dio verde solo y `pnpm smoke` también.
- **Ambientes.** En los tres ambientes desde el 26/10, por la regla de ambientes iguales.

### 🙋 Waiting on you (not code)

- **Puesta en marcha por ambiente.** La guía paso a paso para dejar dev (cuenta del dueño),
  QA (cuenta de Gonzalo) y prd (cliente ficticio) completos e iguales, con quién hace cada
  paso, las decisiones D1 a D15 y el plan para que el alta sea automática, está en
  `docs/PUESTA_EN_MARCHA.md`. Hechos al 19/10: A1, A2, A6, A10, A11 y A12. Faltan A3, A4,
  A5, A7, A8 y A9 (de A7 sólo entrar una vez con Google en prd), y las decisiones D10 a D13.
  A3 son tres direcciones por ambiente: administrador y analista como alias `+` de Gmail, y
  el mail agente como una Gmail propia. D4 pasó el 21/10 a (d) (#489): no hay dominio propio,
  y el analista se invita como un alias `+` de la misma Gmail que el administrador, sin
  activar el espacio. Desde el 21/10 está en los tres ambientes (#493 a prd).
- **Tono de los mails (del transcripto del 17/10).** Cuatro cosas que son copia del producto y
  quedan como están hasta que decidas: el mail no saluda por el nombre (`05-canal-mail.md`), la
  referencia es el UUID entero y no una corta, los mails firman como ClaimMix frente al
  asegurado de otra compañía, y los asuntos dicen «reclamo» mientras la plantilla de especialista
  mezcla «denuncia», «escalado» y «derivamos». Además, la coma del vocativo es regla sólo de
  WhatsApp (`04-canal-whatsapp.md`): en el ensayo de QA del 17/10 el mail de `mail-completo`
  abrió «Hola Martín.». Si la querés también en mail, va en `05-canal-mail.md`.
- **Limpieza del 15/10.** Desinstalar la GitHub App `supabase`: Supabase no se usa y su
  check «Supabase Preview» sale rojo en los PR. En `.env.local`, poner
  `VERTEX_EXTRACTION_MODEL=gemini-3.8-flash` o borrar la línea.
- **App propia del cliente: antes de prenderla.** (1) W6, el ensayo manual en dev con un
  portfolio de prueba nuevo y el chip de repuesto; cierra las incógnitas I1 a I42 de la
  Parte H. (2) Decidir con eso si hace falta App Review (I7, Q35): si hace falta, la vía no se
  publica para autoalta. (3) Abogado (Q15): anexo `#app-propia`, Platform Terms §6.a.iv y §5.a,
  y las plantillas `legal.*`; hasta entonces nada en prd. (4) Generar `WHATSAPP_APP_SECRETS_KEY`
  (32 bytes en base64), una distinta por ambiente y con copia fuera de Vercel. (5) Hecho: la
  0051 está en QA, dev, staging y prd (comprobado el 15/10). (6) Pegar el texto propuesto del anexo y de la sección de
  privacidad (Parte H, «pendiente del dueño») en `src/app/terms` y `src/app/privacy`: el código
  no los toca. (7) `ALTA_APP_PROPIA=1` en dev, y `pnpm check` completo después del deploy.

- **WABA propia: lo que queda de Meta, en este orden.** Es el bloqueo de Meta que queda: sin la
  verificación del negocio y la revisión de la app, un cliente nuevo no puede abrir el
  popup. (1) Verificar el negocio Veltra (CUIT con la razón social exacta). (2) Datos de la
  app: ícono, `/privacy`, `/terms` y la URL de eliminación de datos
  `https://claimmix.vercel.app/api/meta/borrado`. (3) Onboarding de Tech Provider. (4)
  Revisión de la app con acceso avanzado a `whatsapp_business_management` y
  `whatsapp_business_messaging`. (5) Facebook Login for Business y una configuración de
  Embedded Signup v4 con token que no vence: el `config_id` es `META_ES_CONFIG_ID`. (6)
  Hecho: la app está suscripta a `account_update` y `phone_number_name_update` (leído por
  Graph el 15/10). (7) Hecho: la 0051 está en QA, dev, staging y prd (comprobado el 15/10).
  (8) Probar
  solo en dev, con un portfolio de prueba nuevo y una SIM libre, y confirmar que el
  `user_id` de `debug_token` es el mismo que trae el `signed_request` del borrado. (9)
  Cambiar el texto de `src/app/privacy/page.tsx` con la sección `#meta` propuesta en la
  Parte G: ese archivo lo toca el dueño. (10) La app en modo Live y una sola promoción.
- **24/10: A9, `CASILLAS_DE_DEV` de prd y los pasos de Meta.** A9 está hecho: un presupuesto
  de US$ 20 por mes, sólo aviso (alertas al 50, 90 y 100 %), sin tope. La casilla del agente
  (veltra) salió de `CASILLAS_DE_DEV` en prd. `docs/PUESTA_EN_MARCHA.md` tiene el paso a paso
  de Meta para la WABA propia por cliente, de T1 a T9, en «Meta: una organización por
  cliente».
- **Ambiente prd: lo que queda del dueño.** (R2 de prd y los hostnames de Turnstile ya
  están.) Un alta de punta a punta en `claimmix.vercel.app` con un correo y un celular
  propios; la verificación del negocio en Meta para pasar de 2 números en la WABA; y avisar
  a los clientes de dev con SSO o API v1 del dominio nuevo. La política de privacidad
  nombraba el permiso `gmail.readonly`, que el alta corta ya no pide; desde el 24/10 nombra
  `gmail.modify` y `gmail.send` (D12). Lista completa en `docs/PROMOCION.md`, sección «Prd».
- **Número por código.** La 0049 (`claimmix_numero_automatico`) ya está en QA, dev,
  staging y prd (comprobado el 15/10). La bandera está prendida en prd desde el 09/10, y el alta
  del cliente ficticio de prd es la prueba en vivo (receta en `docs/whatsapp-setup.md`). El 17/10
  el dueño decidió prenderla también en dev y en QA (D1, b), en el lote de A12. Queda decidir si
  se verifica la empresa en Meta para subir el tope de números (A5); la prueba real en QA espera
  a su propia WABA y a su token. La retoma tras un corte no necesita migración.
- **Después del deploy: `pnpm check` completo y `pnpm knock`.** El mail real que
  deposita el timbre trae el `Authentication-Results` alineado de Gmail y tiene que
  seguir abriendo o siguiendo caso: es la única prueba de la decisión sobre el From
  contra un correo de verdad, porque los escenarios del ensayo son `email_sim`.
- **Carga de lectura: aplicar la 0046 ANTES de mergear.** El tablero de métricas
  hacía 1,3 s (mes) y 1,5 s (año + serie) de p95 con 20 analistas contra un tope
  de 500 ms. Dos causas: los cuellos aplanaban su lateral en un Hash Join sobre
  todo `idx_audit_log_trayecto` (arreglado con `offset 0`, sin migración) y las
  cuatro lecturas de IA recorrían `ai_usage` entera. Esas pasan a leer
  `ai_usage_mensual`, que mantiene un trigger (`0046_uso_de_ia_por_mes.sql`).
  Se aplica a mano, con el dueño de la base (necesita `BYPASSRLS`), en este orden:
  QA (`ep-wispy-flower`), producción (`ep-proud-resonance`) y la rama `production`
  de Veltra. Sin ella `/metricas` falla con 42P01, `/api/health` cae con «faltan:
  ai_usage_mensual» y el CI queda rojo por `--exigir-al-dia`. Después de aplicarla,
  `pnpm load` compara el acumulador contra `ai_usage` y la sección 6 de
  `pnpm capa-datos` (en CI, contra la rama `production` de Veltra) prueba el
  trigger con un INSERT, los permisos de `claimmix_app` y la cascada de `users`:
  sin la 0046 en esa base también queda rojo. Si el acumulador diverge se
  recompone volviendo a aplicar la 0046 entera (`--forget 0046 --apply` y
  `--apply`), no corriendo su backfill suelto. Si el dueño la rechaza, el commit
  de `offset 0` va solo.
- **B19: la 0045 ya está aplicada** (30/09, en producción, staging y QA). El
  `CASE` del PUT y el `EXISTS` del PATCH de `/api/admin/sso`, la cola de purga
  (incluido borrar dos veces el mismo objeto) y la retención en `simular` ya
  corren contra Postgres en la sección 7 de `pnpm capa-datos`, en cada corrida
  del CI; no hace falta repetirlos a mano en QA. Pendiente, lo que esa prueba no
  cubre (simula R2 y no enciende ningún modo):
  - Confirmar la separación de buckets de R2: QA tiene el suyo
    (`claimmix-qa-attachments`); falta confirmar el de staging contra el de
    producción.
  - Decidir cuándo pasar `RETENCION_MODO` y `PURGA_ADJUNTOS_MODO` de `apagado` a
    `simular` y después a `borrar`. No se encendieron en ningún ambiente.
  - Verificar la ventana de PITR de Neon en el plan vigente y probar una
    restauración. Verificar la región de la base de producción y la ubicación del
    balde de R2.
  - SOC 2, ISO 27001 y un pen test externo: no son código, están en
    `docs/SEGURIDAD.md` como pendientes del dueño.
  - **Cancelar una purga:** el dueño hace
    `UPDATE adjuntos_por_purgar SET purgar_despues = NULL` (con `WHERE` por
    inquilino o caso). Un `NULL` es una purga cancelada, salvo que después se
    borre otro caso que comparta el objeto: la fila nueva manda.
  - **Apagar «exigir SSO»** si alguien se queda afuera: el dueño hace
    `UPDATE sso_settings SET exigir = false WHERE tenant_id = '<id>'`.
  - Que alguien revise el texto de privacidad propuesto en `docs/SEGURIDAD.md`
    (bcrypt por scrypt, cinco roles, regiones reales, retención apagada por
    defecto) y, si lo aprueba, lo pase a `src/app/privacy/page.tsx`.

- **B16, B17 y B26: la 0044 ya está aplicada** (30/09, en producción, staging y
  QA). Falta encender el formulario de un inquilino de prueba y mandar una denuncia real por
  la web: el ensayo no tiene escenario del canal `web`.

- **B12, B14, B15 y B22: la 0043 ya está aplicada** (30/09, en las tres bases).
  Falta mirar
  el primer barrido de `/desvios` (puede traer hasta 30 días de cierres viejos) y
  decidir si hace falta un rol supervisor: hoy la pantalla es de owner, admin y
  specialist.

- **B3 y B4: la 0038 y la 0039 ya están aplicadas** (29/09, en las tres bases).
  Falta confirmar que un mensaje tardío que cuenta otro
  siniestro no abra un caso nuevo solo.

- **B6, B21 y B23: la 0040 ya está aplicada** (29/09, en las tres bases). Falta
  validar la tabla de montos por defecto y decidir si un viewer puede ver
  cobertura, monto y presupuesto.

- **B18 y B24: la 0041 ya está aplicada** (30/09, en las tres bases). Falta que
  un abogado revise las citas de la Ley 24.449 (art. 41, 44 y 48 inc. g) y
  confirme el art. 39 inc. b para la regla de vehículo detenido.

- **B9, B10, B11 y B13: la 0042 ya está aplicada** (30/09, en las tres bases).
  El tope de `pnpm peso` no subió: se recortó código hasta entrar en 310 kB.
  Falta que alguien defina las reglas de
  asignación y los plazos propios de cada aseguradora en la pestaña «Trabajo del
  equipo».

- ~~**Qué hacer con la respuesta a un caso ya derivado.**~~ ✅ **RESUELTO
  25/09 en #293 (P6).** `findExistingWhatsAppCase` suma el mensaje al caso en
  `requiere_especialista` (`ESTADOS_WHATSAPP_QUE_SUMAN_MENSAJES`), y por mail
  el hilo ya caía en el caso. En los dos canales el agente calla y el caso
  queda en «Para responder». Lo cubre el ensayo `escribe-despues-del-cierre`.

- **Escaneo de seguridad: las tres tandas están cerradas.** Tanda 1 (auth,
  seguridad, rate-limit, `src/app/api`; 15/09, `cc89d00`): 74/74 archivos, 0
  hallazgos, sello `verified`. Tanda 2 (`src/server` sin `email`, `src/core`,
  `src/lib/db`, `src/lib/schemas`, `neon`; 15-16/09, `b8c079e`): 134/134
  archivos, 5 hallazgos MEDIUM que son 3 defectos, **parchados en #178** con un
  test cada uno (propiedad del caso en `confirm-field`, saneo de los ejemplos
  aprobados, nombre y correo del padrón enmascarados en el conflicto). Tanda 3
  (`src/app/(app)`, `src/app/(auth)`, `src/components`, `scripts`; 16/09,
  `933a7e9`): 128/128 archivos, 1 hallazgo LOW, parchado en este mismo PR (la
  URL del rol de ensayo va por el entorno y no por argumento). Informes en
  `CLAUDE-SECURITY-20260915-170931/`, `-20260915-220949/` y `-20260916-130237/`.
  Receta que funcionó: investigadores en Sonnet 5 por una copia del script del
  plugin con `model` explícito, panel en Fable 5.1.

  Lo que quedó sin veredicto, **F19 de la tanda 2** —los tokens OAuth de Google
  guardados en texto plano en `account`, dos votos a favor y el tercero caído
  por cuota— se cerró igual en **#181**: la app nunca leía esos tokens, así que
  ya no se piden refresh tokens (`accessType: "offline"` afuera) y lo que se
  guarda va cifrado con el secreto de auth (`account.encryptOAuthTokens`); las
  filas viejas se reescriben cifradas en el próximo ingreso con Google. En el
  mismo PR, los dos endurecimientos que el panel no consideró hallazgo: fuera
  el `ssl: { rejectUnauthorized: false }` muerto de seis scripts, y
  `POST /api/health/knock` borra sólo un mensaje con la marca del timbre en el
  asunto, con test.

- **Dependabot (#163-#172), cerrado salvo uno.** Entraron de a uno con
  post-deploy verde entre cada uno: #163, #164, #167, #168, #170 (next 16.3.5),
  #172 y #165; los dos rojos se resolvieron aparte: #176 subió las tres acciones
  de CodeQL juntas (dependabot subía sólo `analyze` y el análisis rechazaba la
  mezcla de versiones), #177 subió nodemailer a 10 con sus propios tipos, y
  **#182** subió better-auth a 1.7.4: su adapter de Drizzle lee `db._` al
  cargar el módulo y el proxy perezoso conectaba para contestar, así que el
  build de Vercel, sin `DATABASE_URL`, reventaba (#169); ahora el proxy
  contesta el esquema sin conectar, con test. La tanda del 21/09 (#239-#248)
  entró junta en **#251**, con post-deploy y Carga de QA en verde. No queda
  ningún PR de dependabot abierto.

- **La última alerta de Dependabot no tenía PR que mergear: `devalue` < 5.9.1.**
  Cerrada el 18/09 con #221. No hay dependencia directa sobre `devalue`: entra
  por `workflow@4.8.5` → `@workflow/core@4.8.5`, así que dependabot no podía
  abrir un bump y actualizar el `package.json` no la movía. Se fija en
  `pnpm.overrides` con `">=5.9.2"`, que es lo que el repositorio ya hace con
  otras ocho transitivas (`esbuild`, `browserslist`, `postcss`, `fast-uri`,
  `nanoid`, `qs`, `undici`, `sharp`). Cuando una alerta señale una transitiva,
  ése es el camino: override, `pnpm install --lockfile-only`, `pnpm verify`.
  Hoy no queda ninguna alerta abierta.

- **El ensayo del post-deploy ya no cae por un pico de Gemini.** El 15/09 dio
  rojo 5 de 8 veces por `transport_timeout` (30 s) en dos a cinco casos de mail
  por corrida, con producción sana. Desde #175, cuando un turno esperaba
  respuesta y el worker dejó el caso pendiente, el ensayo lo retoma una vez con
  el mismo `runIntakeAgent` que usa el barrido. Ante un rojo, mirar primero
  `--log-failed` por `transport_timeout`; regla de la casa: hasta dos reruns, el
  umbral no se toca.
  El 22/09 el mismo timeout dio «no reconoció fotos_danos en la foto» en
  `choque-completo`: el turno de la foto no cuenta respuestas, así que no se
  retomaba, y el reconocedor sólo corre después de una extracción que terminó.
  Ahora se retoma todo turno que no pida silencio, y si el caso sigue pendiente
  el ensayo dice que el modelo no contestó. Y los 30 s pasaron a ser de la
  llamada entera: `fetchGemini` armaba un `AbortSignal.timeout` nuevo por
  intento, con backoffs en el medio, y un timeout llegó a durar 48.498 ms.
  El mismo día, `silencio` volvió a hablar en el turno 3: un «gracias» le
  devolvía la lista de cuatro puntos entera. La extracción relee la
  conversación en cada vuelta, volvió más confiada sobre un campo que nadie
  había preguntado, y al cerrarse esa fila pendiente el caso lo leía como
  «contestó lo que le pedimos». La fila se sigue cerrando —si no, la vuelta
  siguiente la vuelve a preguntar—, pero cuenta como respuesta suya sólo lo que
  le pusimos delante, que es la misma guarda que ya tenían los documentos
  declinados: una pregunta que nunca se hizo no se puede contestar.
  Y todavía habló una vez más en el mismo turno, ahora porque un 429 dejó a la
  deliberación sin plan: la tabla armaba la lista desde cero y salían cinco
  puntos donde dos mensajes antes había cuatro. La lista crece porque la
  extracción vuelve más segura en cada relectura —el conteo fue de 2 a 4 y a 5
  sin que ella contara nada—, y quien decide que el pedido cambió es el agente.
  Sin plan se repite el pedido que ya está en pie, y sólo si no queda nada de
  aquel —o nunca hubo uno— se arma con lo que falta, porque quien escribe por
  primera vez merece respuesta aunque el agente no haya podido pensar. El acuse
  de recibo pide lo mismo: es un juicio sobre el último mensaje, y sin
  deliberación no hay juicio. Todo en #257.

- ~~**Dos decisiones sobre el 429**~~ ✅ **DECIDIDAS 2026-09-21, enmendada
  2026-09-22.** Un 429 de
  extracción vuelve a la cola como un TIMEOUT, y uno en la deliberación sigue
  cayendo a la plantilla pero deja `agent.deliberation_failed` en la
  auditoría. Detalle en «Los barridos, la corrida muerta y el 429». La
  enmienda: si el mensaje traía una pregunta, se contesta igual en la misma
  vuelta; ver «La pregunta que un 429 dejaba sin respuesta».

- ~~**¿Corro `pnpm achicar-payloads --apply` contra producción?**~~ ✅ **HECHO 2026-09-11.**
  356 filas, 12.808 → 2.518 kB. Nadie en `src/` lee `body.data` de `raw_payload`
  (el único lector es `->>'profile_name'`) y el arreglo hacia adelante llevaba
  días en producción sin que nada se rompiera. Liberaba 10.290 kB
  de 12.808 en `claim_messages` sacando la copia en base64 del cuerpo, que ya
  está decodificada en `body_text`/`body_html`. Es irreversible: el salto de
  línea y el relleno del base64 no se reconstruyen byte a byte. El CONTENIDO no
  se pierde. El arreglo hacia adelante ya está aplicado; esto es sólo para las
  356 filas viejas.

- ~~**¿Para qué existe el rol `viewer`?**~~ ✅ **DECIDIDO 2026-09-11: «mira todo y no
  cambia nada».** Lee lo mismo que `analyst` —la pantalla del caso entera— y no
  escribe; el padrón se le niega igual que a `analyst` (`CUSTOMER_PII_ROLES`).
  Escrito en `roles.ts`. La pregunta era: la conversación ya no le sale cruda, pero
  `fetchCaseRow` hace un `db.select()` pelado, así que la pantalla del caso le da
  igual el `policyholder_name` y el `policy_number`. Si `viewer` es «mira todo y
  no cambia nada», está bien como está. Si es «no ve datos personales», hace
  falta una proyección por rol en toda la pantalla, no un parche en una ruta.

- ~~**Vercel llegó al tope de builds del día (10/09, plan Hobby).**~~ ✅ **LIBERADO
  2026-09-11.** Volvieron los deploys y el post-deploy dio 7/7 en `ae4fa82` y
  `c9899bc`. Lo que sigue es el relato original. No bloquea los
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
- **Rotate the Google OAuth client secret** (`GOCSPX-…`) of the dev and prd client. It
  was read off a screenshot during the migration, and it now backs four env vars:
  `GMAIL_CLIENT_ID`/`SECRET` for the mailbox and `GOOGLE_CLIENT_ID`/`SECRET` for logging
  in. Rotating it forces a reconnect of the mailbox and a re-login, in that order. QA's
  Gmail client (`claimmix-qa`, since 18/10) is another one and this rotation does not touch it.
- **Rotate the WhatsApp system-user token.** Meta echoed it inside an error response
  on 2026-08-23 and it is now in a chat transcript. Same standing as the
  `veltra.soporte` password below: it is not known to be leaked, and it is no longer
  only where it should be.
- **Vercel and Neon are still on the free plans.** The load test says the ceiling
  is the plan, not the code — that becomes a step-shaped outage the month it hits.
- ~~**New GCP project + `pnpm switch-gcp`**~~ ✅ **DONE 2026-08-24.** Extraction now
  runs on **`claimmix-506321`**, inside the `veltra-claimmix-org` organisation and on
  **its own billing account** of the organisation, so the model's spend stops
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

(28/09: those real-inbox examples, and every other `training_example` from a real
`email`/`whatsapp` case, were purged under the Gmail Limited Use rule — no real
Gmail case may enter training or few-shot. Going forward, only tagged
`email_sim`/`whatsapp_sim` cases feed a new training run.)

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
- ~~**WhatsApp — real number**~~ ✅ **DONE.** It took two attempts: a personal line
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
  (28/09: retired. Row went `eval_pending` → `rejected`, old GCP project
  `DELETE_REQUESTED`, `active_model` null in prod and staging. No model is
  active; the next training run uses only tagged `email_sim`/`whatsapp_sim`
  cases.)
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

`AI_ANONIMO_DAILY_TOKEN_CAP` (optional) caps the tokens a tenant spends per day on
calls without a user (mail, WhatsApp, the web form); it defaults to 60 % of
`AI_TENANT_DAILY_TOKEN_CAP`. Vercel's Preview scope has its own `CRON_SECRET`, and the
repo keeps the same value as `PREVIEW_CRON_SECRET` (only `load-tests.yml` reads it).

⚠️ `AI_TENANT_DAILY_TOKEN_CAP` (and `AI_ANONIMO_DAILY_TOKEN_CAP`, when set) lives in
**two** places and they must agree: Vercel (production) and the GitHub **repo variable**
(the post-deploy rehearsal, which runs in the runner). See the post-deploy section above for what happens when they don't.

## Verify / build commands
`pnpm type-check` · `pnpm lint` · `pnpm test:unit` · `pnpm build`.
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
