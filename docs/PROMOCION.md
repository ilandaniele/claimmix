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
| `Security audit` | `pnpm audit` de alto para arriba, y semgrep |
| `License audit` | ninguna licencia contagiosa |
| `CodeQL analysis (JavaScript/TypeScript)` | análisis estático de seguridad |
| `Buscar secretos` | gitleaks sobre el historial del PR |
| `Datos personales` | que no se cuele un dato de una persona |
| `Las invariantes se sostienen` | las reglas de arquitectura y de CI |
| `Bundle size check` | 300 kB comprimidos de JavaScript |
| `Tenencia y capa de datos` | que la base separe las aseguradoras |
| `Pen test (local)` | que ninguna ruta nueva conteste sin credenciales |

Los tres últimos eran nuevos y ya están marcados como requeridos, en `main` y en
`qa`: el paso 9 de más abajo cuenta cómo se decidió. `Integration tests`,
`Integration tests (Gmail polling)` y `Cobertura` también corren en cada PR, pero
no son requeridos y por eso no están en la tabla: un PR mergea con ellos en rojo.

### Después del deploy

Los siete de `deploy-checks.yml`: smoke, ensayo de conversaciones, timbre, pen
test de superficie, listas y parejas, permisos del rol y carga. Contra QA no
corre ninguno todavía: `post-deploy.yml` tiene un solo job, `produccion`, y el
`qa` que faltaría agregarle está bloqueado por dos motivos concretos:

1. `secrets: inherit` apuntaría los seis trabajos de `deploy-checks.yml` que
   corren EN EL RUNNER —`rehearse`, `timbre`, `carga`, `listas-parejas`,
   `permisos`, `pentest`— a `secrets.DATABASE_URL` / `DATABASE_URL_APP`, que son
   los de PRODUCCIÓN. El ensayo escribe doce conversaciones ahí, y eso está
   prohibido. La salida es partir `deploy-checks.yml` con un input tipo
   `solo_smoke`, o crear secretos de repo `QA_DATABASE_URL` /
   `QA_DATABASE_URL_APP` con la rama `qa` de Neon y pasarlos por `secrets:`
   explícito en vez de `inherit`.
2. Aunque se corriera sólo el smoke, hoy sale rojo seguro: `pnpm smoke --deep`
   necesita `CRON_SECRET` —el del repo es el de producción, y en `claimmix-qa`
   esa variable está entre las 63 vacías—, y además sube un archivo a R2 y
   comprueba el token de WhatsApp y la casilla de Gmail, que en QA se dejaron
   vacías a propósito. Para que el smoke contra QA signifique algo hacen falta
   dos decisiones del usuario: cargar un `CRON_SECRET` propio en `claimmix-qa`
   y como secreto de repo `QA_CRON_SECRET`, y decidir qué subconjunto de
   comprobaciones debe exigirle a QA.

Cuando se destrabe, contra QA van todos menos **carga**: el ensayo tiene
cuatrocientos casos contra los cientos de miles de producción, así que un p95
medido ahí no se puede comparar con el presupuesto de 500 ms.

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
`STAGING_*`: el servidor lee los primeros (`src/lib/db/index.ts:29` y
`src/data/scope.ts:109`) y los `STAGING_*` sólo los usan scripts locales—,
marcando Production, Preview y Development.

⛔ **Nunca las de producción.** QA existe para poder romper cosas.

### 4bis. Las once variables de `claimmix-qa`

Las 63 que Vercel creó al importar salen de `.env.example` y vienen VACÍAS. Estas
once hay que llenarlas, en los tres entornos del proyecto (Production, Preview,
Development).

Dos se **crean**, porque hasta #212 no estaban en `.env.example` y por eso Vercel
no las detectó. Las otras nueve ya existen vacías: se **editan**.

| variable | valor | tipo | crear o editar |
|---|---|---|---|
| `GEMINI_TRANSPORT` | `vertex` | Config | **crear** |
| `VERTEX_EXTRACTION_MODEL` | de `.env.local` | Secret | **crear** |
| `GOOGLE_CLOUD_PROJECT` | `claimmix-506321` | Config | editar |
| `GOOGLE_CLOUD_LOCATION` | `us-central1` | Config | editar |
| `AI_TENANT_DAILY_TOKEN_CAP` | `20000000` | Config | editar |
| `DATABASE_URL` | la rama `qa` de Neon | Secret | editar |
| `DATABASE_URL_APP` | la rama `qa` de Neon | Secret | editar |
| `GMAIL_TENANT_ID` | `10000000-0000-0000-0000-000000000001` | Config | editar |
| `GOOGLE_DEFAULT_TENANT_ID` | el mismo UUID | Config | editar |
| `BETTER_AUTH_SECRET` | uno NUEVO: `openssl rand -base64 32` | Secret | editar |
| `NEXT_PUBLIC_SITE_URL` | `https://claimmix-qa.vercel.app` | Config | editar |

Ese UUID es el inquilino «Seguros del Sur S.A.», y la rama `qa` ya lo tiene: se
sacó de la rama de ensayo, así que se llevó los tres inquilinos con ella.

`GOOGLE_DEFAULT_TENANT_ID` no figura en `.env.local` porque producción no la
define: el código cae a `GMAIL_TENANT_ID`. En QA hay que ponerle igual el mismo
UUID. Una variable declarada y vacía no es una variable ausente — `??` la da por
buena, devuelve la cadena vacía, y el alta de cualquier usuario nuevo muere con
«GOOGLE_DEFAULT_TENANT_ID … is required to provision new users».

**`NEXT_PUBLIC_SITE_URL` no es cosmética: sin ella no se entra a QA.** Better
Auth sólo acepta pedidos cuyo origen sea su propia `baseURL`, y esa URL sale de
`NEXT_PUBLIC_SITE_URL`; si falta, cae al host del deploy, que es la URL con hash
(`src/lib/auth/index.ts:14-18`). Medido el 18/09 contra el alias: un `POST
/api/auth/sign-in/email` con `Origin: https://claimmix-qa.vercel.app` contesta
`403 {"message":"Invalid origin","code":"INVALID_ORIGIN"}`, y el mismo pedido
contra producción contesta `401 INVALID_EMAIL_OR_PASSWORD` — o sea que allá
llega a mirar la credencial y en QA ni eso. Rompe el login del navegador, no
sólo el de k6.

**Los cuatro valores que no se escriben a mano.** Todo esto va en Git Bash, que
viene con Git para Windows; `clip` es de Windows y deja el valor en el
portapapeles, listo para pegar en Vercel sin que pase por pantalla.

- `VERTEX_EXTRACTION_MODEL`:
  `grep '^VERTEX_EXTRACTION_MODEL=' .env.local | cut -d= -f2- | tr -d '\r\n' | clip`
- `BETTER_AUTH_SECRET`: `openssl rand -base64 32 | tr -d '\r\n' | clip`
- `DATABASE_URL` y `DATABASE_URL_APP`: consola de Neon, proyecto **ClaimMix**,
  rama **`qa`** (`br-muddy-mountain-acxm92sh`), «Connection string». Una con el
  rol `neondb_owner` (esa es `DATABASE_URL`) y la otra con `claimmix_app` (esa
  es `DATABASE_URL_APP`).

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

Acá decía que el job `k6` de `load-tests.yml` estaba **rojo a propósito** porque
le faltaba un secreto. Ya no: `VERCEL_AUTOMATION_BYPASS_SECRET` existe en el repo
desde el 17/09, el job pasa esa puerta y corre k6 de verdad. Lo que antes venía
verde sin haber ejecutado k6 una sola vez ahora mide — y lo primero que midió
también es rojo, pero por otra cosa: contra una vista previa de `claimmix`, el
login devolvió **500**.

Acá decía que faltaban **tres** secretos. Era falso: `LOAD_TEST_EMAIL` y
`LOAD_TEST_PASSWORD` no son secretos de GitHub, son variables que el workflow
arma solo desde `PLAYWRIGHT_TEST_EMAIL` y `PLAYWRIGHT_TEST_PASSWORD`
(`load-tests.yml:227-228`, desde #121). Crearlos no hubiera servido de nada.

Lo que falta de verdad es una sola cosa, y no se arregla con un secreto.

**El secreto ya está.** `VERCEL_AUTOMATION_BYPASS_SECRET` se creó en Vercel
—`claimmix` → Settings → Deployment Protection → Protection Bypass for
Automation— y se cargó en el repo el 17/09; aparece en `gh secret list`. Acá
decía que faltaba, y la línea sobrevivió al día en que se creó.

**Y falta una cuenta que k6 pueda usar donde k6 mide.** Los seis escenarios
arrancan haciendo login (`tests/load/helpers/auth.js:46-60`; sin credenciales,
`fail()`). La cuenta cableada hoy es la de Playwright, y esa vive en la base de
**ensayo**: `sembrar-para-integracion.mts` siembra contra `SEED_DATABASE_URL` o,
si no está, `STAGING_DATABASE_URL`, y se planta si le pasás la de producción
(`scripts/sembrar-para-integracion.mts:21-29`). La lista blanca de destinos
(`load-tests.yml:160-166`) acepta el alias de producción de `claimmix`, el de
`claimmix-qa` y las vistas previas del proyecto; los dos primeros de esa lista
—el alias de `claimmix` y sus vistas previas— leen la base de **producción**,
donde esa cuenta no existe. Acá decía que el login iba a devolver 401. Medido
contra una vista previa de `claimmix`, devolvió **500**.

Ese rastrillo ya se pisó una vez, y está anotado en `playwright.config.ts:75-79`:
«el login respondía “Credenciales inválidas” porque el servidor miraba
producción, donde esas cuentas no existen».

**Desde que QA tiene base propia, esto ya no pide una cuenta nueva.** La rama de
Neon se sacó del ensayo, así que las cuentas `PLAYWRIGHT_*` están adentro, y
`load-tests.yml` ya acepta `https://claimmix-qa.vercel.app` como destino.

**Y ahora k6 sí elige QA solo.** El job se dispara por `deployment_status`, y la
guarda pasó de excluir todo entorno que empiece con `Production` a
`(!startsWith(github.event.deployment.environment, 'Production') ||
endsWith(github.event.deployment.environment, '-qa'))` (`load-tests.yml:73-77`):
el entorno de producción del proyecto de QA se llama `Production –
claimmix-qa` —con guion largo, el nombre que arma GitHub para desambiguar dos
proyectos—, y ese sufijo ya entra por el `endsWith`. Cada deploy de la rama `qa`
mide solo, sin disparar nada a mano.

**Contra QA mide el ALIAS, no la URL del deploy** (`load-tests.yml:116-118`).
Medido el 18/09: la URL con hash de `claimmix-qa` está detrás de Vercel Auth
—contesta `{"protection":{"vercel_auth_enabled":true…}}` antes de llegar a la
aplicación— y el secreto de automatización que hay en el repositorio es el del
OTRO proyecto, así que ahí k6 mediría la puerta. El alias de producción de QA es
público, y además es la URL contra la que prueba una persona.

⛔ **Y va a seguir rojo hasta que `NEXT_PUBLIC_SITE_URL` esté cargada en
`claimmix-qa`** (paso 4bis): el login de `setup()` se come el `403
INVALID_ORIGIN` de arriba y la corrida muere antes de medir nada. El mensaje de
error lo dice con esas palabras desde ahora (`tests/load/helpers/auth.js:99-106`).

Las otras salidas, por si hace falta medir antes de que QA tenga un deploy:

1. **Medir contra QA a mano.** No queda nada por agregar: QA tiene su propia
   rama de Neon (paso 4), así que la cuenta de Playwright sirve tal cual, y el
   host `claimmix-qa.vercel.app` ya está en la lista blanca
   (`load-tests.yml:160-166`). Esa lista es un control de seguridad, así que el
   alias de QA entró literal, nunca como comodín tipo `claimmix*`.
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

**Un deploy de QA también llega etiquetado como producción.** Los dos proyectos
de Vercel mandan el mismo evento, porque cada uno pone la etiqueta sobre SU
propio entorno de producción. Y desde que hay dos, GitHub les agrega el nombre
del proyecto para desambiguarlos: `Production – claimmix` y
`Production – claimmix-qa`, con guion largo. Por eso las guardas comparan con
`startsWith(…, 'Production')` y no con `== 'Production'`: la igualdad exacta dejó
de ser cierta para los dos el día que nació el segundo proyecto.

⛔ **La rama no sirve para distinguirlos, y se aprendió rompiéndolo.** Vercel le
pone a `deployment.ref` el **SHA del commit**, no el nombre de la rama, así que
`deployment.ref == 'main'` no es cierto nunca: con esa guarda puesta el
post-deploy quedó muerto —el deploy llegó con `state: success` y la corrida
salió salteada—, que es el mismo defecto de «verde porque no corrió» que este
trabajo vino a sacar.

Lo que sí distingue a los dos proyectos es el **nombre del entorno**, no el host
de `environment_url`. El primer deploy real de QA mostró que ese campo NO sirve:
Vercel arma ese host con el nombre del proyecto MÁS un hash, y para los dos
proyectos el prefijo es el mismo, `claimmix-`:

| entorno | `environment_url` |
|---|---|
| `Production – claimmix` | `https://claimmix-nbjnatqfk-ilandaniele-3471s-projects.vercel.app` |
| `Production – claimmix-qa` | `https://claimmix-jerqmlxd5-ilandaniele-3471s-projects.vercel.app` |
| `Preview – claimmix` | `https://claimmix-ax2tnp71i-ilandaniele-3471s-projects.vercel.app` |

Ninguna URL de QA empieza con `https://claimmix-qa`. No era teórico: la corrida
35352800702 corrió el job `produccion` para el deploy `c83b750` —que es de
QA— y su Smoke de producción falló contra el alias de producción, que ese
deploy nunca tocó.

Ese NOMBRE del entorno sí distingue, entonces: el guard de hoy es
`startsWith(…, 'Production') && !endsWith(…, '-qa')`, escrito dos veces —en el
grupo de `concurrency` y en el `if` del job, porque GitHub no deja compartirlas
(`post-deploy.yml:104-105` y `:140-141`)—.

La invariante 15 de `check-architecture.mjs` exigía mirar `environment_url`: era
una premisa falsa, y estaba verde sobre un guard roto —las tres condiciones
sobre ese campo no excluían ninguna URL de QA, como muestra la tabla de arriba—.
Ahora exige `endsWith(github.event.deployment.environment, …)` en todo job que
gatee exigiendo `startsWith(…, 'Production')`, y además revisa el grupo de
`concurrency` como si fuera un job más: es la otra copia de la misma condición, y
ya se había olvidado una vez (#199 arregló el `if` del job y dejó el grupo con la
guarda vieja). Borra los comentarios antes de mirar, porque un job no queda
protegido por un comentario que nombre el campo.

**Un check que avisa y aprueba es peor que no tenerlo.** Tres jobs hacían eso
cuando les faltaba un secreto, y dos de ellos eran requeridos: podían pasar sin
haber corrido una línea. Ahora sólo un fork avisa —que es cuando GitHub retiene
los secretos por diseño— y cualquier otro caso falla. La invariante 13 lo fija.
