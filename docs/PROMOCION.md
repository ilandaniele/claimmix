# De dev a QA a producción

Hoy hay **un solo entorno**: la rama `main`, un proyecto de Vercel, una base de
Neon. Este documento dice cómo queda el camino de tres escalones, qué parte ya
está hecha en el repositorio, y qué parte hay que hacer a mano en Vercel, GitHub
y Google Cloud, porque ningún script puede hacerla.

Se eligió que todo entre en el plan gratuito. No hace falta pagar nada.

## El camino

```
rama de trabajo  →  PR a  qa   →  deploy de QA   →  PR de qa a main  →  deploy de producción
```

Una rama de trabajo no despliega nada. `qa` despliega al proyecto de QA, contra
la base de ensayo. `main` despliega a producción. **Cuesta un despliegue por
promoción, no uno por PR**, que es lo que hace que entre en el plan gratuito.

## Qué gatea cada paso

### Antes de mergear a `qa` o a `main`

Corren en cada PR, y estos son los que **impiden** mergear:

| | qué mira |
|---|---|
| `Type check`, `Lint`, `Build` | que compile y esté prolijo |
| `Unit tests` | la suite entera, más los flujos |
| `E2E tests (Playwright)` | la pantalla de verdad, contra su propia base |
| `Integration tests` | las rutas contra la base de ensayo |
| `Security audit` | `pnpm audit` de alto para arriba, y semgrep |
| `License audit` | ninguna licencia contagiosa |
| `CodeQL analysis (JavaScript/TypeScript)` | análisis estático de seguridad |
| `Buscar secretos` | gitleaks sobre el historial del PR |
| `Datos personales` | que no se cuele un dato de una persona |
| `Las invariantes se sostienen` | las reglas de arquitectura y de CI |
| `Bundle size check` | 300 kB comprimidos de JavaScript |
| `Tenencia y capa de datos` | que la base separe las aseguradoras |
| `Pen test (local)` | que ninguna ruta nueva conteste sin credenciales |

Los tres últimos son nuevos y **hay que marcarlos como requeridos a mano**: ver
el paso 9 más abajo.

### Después del deploy

Los siete de `deploy-checks.yml`: smoke, ensayo de conversaciones, timbre, pen
test de superficie, listas y parejas, permisos del rol y carga. Contra QA se
corren todos menos **carga**: el ensayo tiene cuatrocientos casos contra los
cientos de miles de producción, así que un p95 medido ahí no se puede comparar
con el presupuesto de 500 ms.

## Lo que hay que hacer a mano, en orden

Cada paso dice qué se rompe si se saltea.

### 1. El proyecto de QA en Vercel — HECHO

Vercel → New Project → el mismo repositorio `claimmix` → nombre `claimmix-qa`.

⚠️ Las 63 variables que Vercel «detecta» al importar salen de `.env.example` y
vienen VACÍAS. Eso es lo que hace seguro crear el proyecto: sin el token de Gmail
ni las credenciales de WhatsApp, QA no le puede escribir a nadie. Si en cambio se
importan las de producción, QA arranca leyendo la casilla real y puede mandarle
mensajes a asegurados de verdad.

⛔ **No usar «Import .env»** con el `.env.local` de la máquina, por lo mismo.

### 2. Que `claimmix-qa` sólo construya `qa` — HECHO

La rama de producción ya NO se elige en Settings → Git. Vercel la movió:

**Settings → Environments → Production → Branch Tracking** → `qa`.

Y el freno para no gastar el cupo de despliegues, en
**Settings → Build and Deployment → Ignored Build Step** → Behavior `Custom`:

```bash
[ "$VERCEL_GIT_COMMIT_REF" != "qa" ] && exit 0 || exit 1
```

Sin esto, el proyecto de QA construye cada rama y se come el cupo del plan
gratuito.

### 3. Que el proyecto de producción ignore `qa` — HECHO

Acá decía «Settings → Git → agregar `qa` a las ramas ignoradas». **Esa pantalla
no existe**: Settings → Git sólo tiene el repositorio conectado, Git LFS, deploy
hooks y commits verificados. El mecanismo es el mismo Ignored Build Step, en el
proyecto `claimmix`, con la condición al revés:

```bash
[ "$VERCEL_GIT_COMMIT_REF" = "qa" ] && exit 0 || exit 1
```

Saltea sólo `qa` y construye todo lo demás — `main` y las vistas previas de los
PR, que hacen falta para los checks.

⚠️ Mirar **Production Overrides** antes de dar por hecho que quedó: si esa caja
tiene un comando, pisa al de Project Settings. Hoy está vacía.

### 4. La base de QA — HECHA, y es propia

Acá decía que QA apuntara a `STAGING_DATABASE_URL`. Se cambió: QA tiene su
**propia rama de Neon**, `qa`, sacada de la del ensayo.

El motivo es que la base de ensayo no está libre: contra ella corren los tests de
integración y los e2e de cada PR. Un QA que escriba ahí se pisa con la CI, y el
rojo que sale no dice cuál de los dos lo causó.

```
proyecto ClaimMix (odd-fire-27605230)
  rama production   ← lo que .env.local llama STAGING_DATABASE_URL
  rama qa           ← br-muddy-mountain-acxm92sh
```

Trae copiados los dos roles y los datos sembrados, así que las cuentas de prueba
ya están adentro. Comprobado sobre la rama nueva:

| rol | BYPASSRLS | tenants |
|---|---|---|
| `neondb_owner` | sí | 3 |
| `claimmix_app` | **no** | 3 |

Que `claimmix_app` NO tenga BYPASSRLS es la invariante que sostiene la separación
entre aseguradoras. Si algún día da «sí», la pared no existe.

En `claimmix-qa` van como `DATABASE_URL` y `DATABASE_URL_APP` —esos nombres, no
`STAGING_*`: el servidor lee los primeros (`src/data/scope.ts:21`) y los
`STAGING_*` sólo los usan scripts locales—, marcando Production, Preview y
Development.

⛔ **Nunca las de producción.** QA existe para poder romper cosas.

### 4bis. Las nueve variables de `claimmix-qa`

Las 63 que Vercel creó al importar salen de `.env.example` y vienen VACÍAS. Estas
nueve hay que llenarlas, en los tres entornos del proyecto (Production, Preview,
Development).

Dos se **crean**, porque hasta #212 no estaban en `.env.example` y por eso Vercel
no las detectó. Las otras siete ya existen vacías: se **editan**.

| variable | valor | tipo | crear o editar |
|---|---|---|---|
| `GEMINI_TRANSPORT` | `vertex` | Config | **crear** |
| `VERTEX_EXTRACTION_MODEL` | de `.env.local` | Secret | **crear** |
| `GOOGLE_CLOUD_PROJECT` | `claimmix-506321` | Config | editar |
| `GOOGLE_CLOUD_LOCATION` | `us-central1` | Config | editar |
| `AI_TENANT_DAILY_TOKEN_CAP` | `20000000` | Config | editar |
| `DATABASE_URL` | la rama `qa` de Neon | Secret | editar |
| `DATABASE_URL_APP` | la rama `qa` de Neon | Secret | editar |
| `GOOGLE_DEFAULT_TENANT_ID` · `GMAIL_TENANT_ID` | de `.env.local` | Config | editar |
| `BETTER_AUTH_SECRET` | uno NUEVO: `openssl rand -base64 32` | Secret | editar |

⚠ **Si el agente de QA queda mudo, mirá las dos primeras.** Son las que deciden
por dónde sale la extracción y con qué modelo, y su ausencia no rompe el build ni
el arranque: el síntoma llega recién con el primer mensaje que nadie contesta.

⛔ **Gmail y WhatsApp se dejan vacías.** Así QA lee, extrae, clasifica y decide,
pero no le escribe a nadie. Un QA que puede mandar mensajes es un QA que puede
mandárselos a un asegurado real el día que alguien se equivoque de base.
Habilitarlo pide una casilla y un número de prueba propios — cuentas nuevas, no
configuración.

⚠ **QA comparte la cuota de Vertex con producción**: es el mismo proyecto de GCP.
El 2026-09-17, sin QA corriendo, devolvió `RESOURCE_EXHAUSTED` tres veces.

### 5. Un secreto, y dónde mide k6

Hoy el job `k6` de `load-tests.yml` está **rojo a propósito**. Antes venía verde
sin haber ejecutado k6 una sola vez, porque le faltaba un secreto y se salteaba
con un aviso. Ahora falla.

Acá decía que faltaban **tres** secretos. Era falso: `LOAD_TEST_EMAIL` y
`LOAD_TEST_PASSWORD` no son secretos de GitHub, son variables que el workflow
arma solo desde `PLAYWRIGHT_TEST_EMAIL` y `PLAYWRIGHT_TEST_PASSWORD`
(`load-tests.yml:164-165`, desde #121). Crearlos no hubiera servido de nada.

Lo que falta de verdad son dos cosas, y la segunda no se arregla con un secreto.

**Falta un secreto.** `VERCEL_AUTOMATION_BYPASS_SECRET` — Vercel → `claimmix`
→ Settings → Deployment Protection → Protection Bypass for Automation → crear,
y después `gh secret set VERCEL_AUTOMATION_BYPASS_SECRET`.

**Y falta una cuenta que k6 pueda usar.** Los seis escenarios arrancan haciendo
login (`tests/load/helpers/auth.js:46-60`; sin credenciales, `fail()`). La cuenta
cableada hoy es la de Playwright, y esa vive en la base de **ensayo**:
`sembrar-para-integracion.mts` siembra contra `STAGING_DATABASE_URL` y se planta
si le pasás la de producción. Pero `load-tests.yml:98-104` sólo acepta como
destino `claimmix.vercel.app` o una vista previa del MISMO proyecto, y las dos
leen la base de **producción**. El login va a devolver 401.

Ese rastrillo ya se pisó una vez, y está anotado en `playwright.config.ts:75-79`:
«el login respondía “Credenciales inválidas” porque el servidor miraba
producción, donde esas cuentas no existen».

**Desde que QA tiene base propia, esto ya no pide una cuenta nueva.** La rama de
Neon se sacó del ensayo, así que las cuentas `PLAYWRIGHT_*` están adentro, y
`load-tests.yml` ya acepta `https://claimmix-qa.vercel.app` como destino. Con el
secreto de Vercel puesto y QA desplegado, k6 mide contra QA con las credenciales
que ya existen.

Las otras salidas, por si hace falta antes de que QA esté en pie:

1. **Esperar a QA.** Cuando exista `claimmix-qa` con `STAGING_DATABASE_URL`
   (paso 4), la cuenta de Playwright sirve tal cual contra ese deploy. Hay que
   agregar el host de QA al `case` de `load-tests.yml:98-104`, que hoy lo
   rechaza — y esa lista blanca es un control de seguridad, así que se agrega el
   host exacto, nunca un comodín tipo `claimmix*`.
2. **Correrlo a mano contra localhost.** `pnpm sembrar` con
   `DATABASE_URL=$STAGING_DATABASE_URL`, levantar el servidor y `pnpm
   carga:smoke`. Mide la aplicación, no la red, y no necesita ninguna cuenta
   nueva.
3. **Crear una cuenta de analista en producción.** Es lo único que pone el job
   automático en verde hoy. ⛔ Es una credencial viva contra datos de clientes
   viajando en cada corrida; los escenarios sólo leen (`base.js:94-106`), pero
   el riesgo es real y la decisión es de la persona, no del repositorio.

### 6. Workload Identity Federation para `qa` — NO HACE FALTA

Acá decía que el proveedor `github` aceptaba sólo la rama `main` y había que
agregar `qa`. Se leyó la condición real y ya estaba cubierto:

```
assertion.repository=='ilandaniele/claimmix'
&& assertion.workflow_ref.startsWith('…/post-deploy.yml@')
&& (assertion.ref=='refs/heads/main' || assertion.event_name=='deployment_status')
```

El segundo término del `||` acepta cualquier rama cuando el evento es
`deployment_status`, que es exactamente como llega un deploy de QA.

⛔ **No ampliarla igual.** Abrir un límite de seguridad que ya alcanza sería
empeorarlo sin motivo.

⛔ **No borrar la clave de la cuenta de servicio que está en la máquina local.**

### 7. El entorno `QA` en GitHub — HECHO

Creado, con las ramas de despliegue restringidas a `qa`. `Preview` y `Production`
no se tocaron: esos los creó Vercel.

### 8. La regla de rama para `qa` — HECHA

Los mismos 14 checks requeridos que `main`, `enforce_admins`, «require branches
to be up to date» y resolución de conversaciones.

### 9. Marcar como requeridos los tres checks nuevos — HECHO

`Bundle size check`, `Tenencia y capa de datos` y `Pen test (local)` ya son
requeridos en `main` y en `qa`. La regla pasó de 11 checks a 14.

La evidencia con la que se decidió, sobre las últimas doce corridas de `ci.yml`:
**10 verdes y ninguna roja** para cada uno de los tres. Las otras dos salieron
`cancelled` por dos empujones al mismo minuto en la misma rama, que el grupo de
concurrencia cancela a propósito.

Para rehacer la cuenta:

```bash
for RID in $(gh run list --workflow=ci.yml --limit 12 --json databaseId --jq '.[].databaseId'); do
  gh run view "$RID" --json jobs --jq '.jobs[] | "\(.name) \(.conclusion)"'
done | grep -E '^(Bundle size check|Tenencia y capa de datos|Pen test)' | sort | uniq -c
```


## Dos trampas que ya están resueltas, y conviene no reabrir

**Un deploy de QA también llega como `environment == 'Production'`.** Los dos
proyectos de Vercel mandan el mismo evento con la misma etiqueta, porque cada
uno la pone sobre SU propio entorno de producción.

⛔ **La rama no sirve para distinguirlos, y se aprendió rompiéndolo.** Vercel le
pone a `deployment.ref` el **SHA del commit**, no el nombre de la rama, así que
`deployment.ref == 'main'` no es cierto nunca: con esa guarda puesta el
post-deploy quedó muerto —el deploy llegó con `state: success` y la corrida
salió salteada—, que es el mismo defecto de «verde porque no corrió» que este
trabajo vino a sacar.

Lo que sí distingue es el **host de `environment_url`**, que Vercel arma con el
nombre del proyecto. Hoy el guard excluye lo que empiece con
`https://claimmix-qa-`. **Cuando crees el proyecto, mirá un evento real antes de
confiar en ese prefijo**: si le ponés otro nombre, hay que ajustarlo. Para verlo:

```bash
gh api repos/ilandaniele/claimmix/deployments --jq '.[0:5][] | "\(.environment) \(.ref[0:7])"'
D=$(gh api repos/ilandaniele/claimmix/deployments --jq '.[0].id')
gh api "repos/ilandaniele/claimmix/deployments/$D/statuses" --jq '.[0].environment_url'
```

La invariante 15 de `check-architecture.mjs` exige que el guard mire ese campo,
y está probada: si se lo sacás, falla.

**Un check que avisa y aprueba es peor que no tenerlo.** Tres jobs hacían eso
cuando les faltaba un secreto, y dos de ellos eran requeridos: podían pasar sin
haber corrido una línea. Ahora sólo un fork avisa —que es cuando GitHub retiene
los secretos por diseño— y cualquier otro caso falla. La invariante 13 lo fija.
