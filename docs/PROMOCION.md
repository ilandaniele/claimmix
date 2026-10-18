# De dev a QA a producción

El camino de tres escalones ya tiene sus piezas: la rama `qa`, el proyecto
`claimmix-qa` en Vercel, su propia rama de Neon y un job que lo verifica después
de cada deploy. La parte de a mano —las variables de `claimmix-qa` y los
secretos `QA_*`— quedó hecha el 2026-09-20, y los pasos numerados de abajo dicen
cuál es cada una y qué se rompe si se deshace. Este documento cuenta cómo queda el camino, qué parte ya está hecha en
el repositorio, y qué parte hay que hacer en Vercel, GitHub y Google Cloud,
porque ningún script puede hacerla.

Se eligió que todo entre en el plan gratuito. No hace falta pagar nada.

## El camino

```
rama de trabajo  →  PR a  qa   →  deploy de QA   →  PR de qa a main  →  deploy de producción
```

Una rama de trabajo despliega sólo una vista previa de `claimmix`, detrás de
Vercel Auth y contra la base de ensayo (paso 5); no toca QA ni producción. `qa` despliega al proyecto de QA, contra
su propia rama de Neon —no la del ensayo, que la CI ya usa: ver el paso 4—. `main` despliega a producción. **A QA y a producción llega un despliegue por
promoción, no uno por PR**, que es lo que hace que entre en el plan gratuito.

Hay un tercer escalón en camino: `claimmix-prd`, la producción de verdad, con una base
por cliente. Desde que exista, el proyecto `claimmix` pasa a ser **dev**, y «producción» en
este documento sigue queriendo decir `claimmix` hasta la sección
[Prd](#prd-producción-de-verdad-en-su-propio-proyecto), que usa los nombres nuevos.

## Qué gatea cada paso

### Antes de mergear a `qa` o a `main`

Corren en cada PR, y estos son los que **impiden** mergear:

| | qué mira |
|---|---|
| `Tipos y lint`, `Build` | que compile y esté prolijo (tipos y lint van en un mismo job; el lint corre aunque los tipos fallen) |
| `Tests unitarios` | la suite entera con el piso de cobertura, más los flujos |
| `Tests E2E` | la pantalla de verdad, contra su propia base |
| `Vulnerabilidades` | `pnpm audit` de alto para arriba, semgrep y ninguna licencia contagiosa |
| `Análisis CodeQL` | análisis estático de seguridad |
| `Credenciales, datos personales y arquitectura` | gitleaks sobre los commits del PR, que no se cuele un dato de una persona, y las reglas de arquitectura y de CI |
| `Peso del bundle` | 310 kB comprimidos de JavaScript |
| `Aislamiento de tenants` | que la base separe las aseguradoras |
| `Pen test local` | que ninguna ruta nueva conteste sin credenciales |
| `Post-deploy QA` (sólo con base `main`) | que el deploy de QA de este mismo commit pasó todos sus chequeos |

`Peso del bundle`, `Aislamiento de tenants` y `Pen test local` eran nuevos y ya
están marcados como requeridos, en `main` y en `qa`: el paso 9 de más abajo
cuenta cómo se decidió. `Tests de integración` también corre en cada PR, pero
no es requerido y por eso no está en la tabla: un PR mergea con él en rojo. La
cobertura dejó de ser un job aparte: `Tests unitarios` corre la suite una sola
vez, con el piso de `vitest.config.ts`.

Un árbol que ya pasó no se vuelve a probar. El PR a `qa`, el PR de `qa` a
`main` y el push a `main` suelen armar el mismo árbol de archivos; el job
`arbol` de `ci.yml` busca el artefacto que `marcar` dejó cuando ese árbol
pasó entero, y si lo encuentra los jobs que sólo miran el código se saltean.
GitHub cuenta un job salteado como aprobado. `Vulnerabilidades` y `Análisis
CodeQL` corren igual, porque una alerta nueva no necesita que cambie el código.
`Análisis CodeQL` y `Credenciales, datos personales y arquitectura` no corren
en el push a `main`: lo que llega ahí ya pasó por el PR. CodeQL vuelve a mirar
todo los lunes y gitleaks el historial entero los domingos.

Lo mismo vale para un commit que sólo cambia documentación sobre un árbol que ya
pasó: `arbol` lo compara con su padre y, si todo lo que cambió son archivos
`.md` (salvo este, que leen los tests), hereda la marca del padre y deja la del
árbol nuevo. CodeQL hace la misma comparación y no analiza.

Un PR suelto de Dependabot no corre la suite: el job `lote` lo pone en rojo, y
los PRs se juntan en una rama desde `qa` que sí la corre entera.

El último, `Post-deploy QA`, no corre en el PR: es el estado que el job
`qa_veredicto` de `post-deploy.yml` (que se llama «QA · Veredicto sobre el
commit», para que sólo el estado lleve ese nombre) publica sobre el commit
desplegado a QA
cuando terminan sus chequeos, con el pen test —la pared con un inquilino propio
y los ataques al agente— incluido. Sólo cuenta con base `main`: el PR de `qa` a
`main` tiene por cabeza ese mismo commit, y un QA rojo, o que no corrió, o que
corrió sin el ensayo por faltar los `QA_R2_*`, tiene que frenar la promoción. Un PR a `qa` no lo puede tener, porque el deploy de QA
sale después de mergearlo. Todavía no está marcado como requerido: GitHub sólo
deja elegir un estado que ya se publicó, así que se marca después de verlo en una
promoción. Y con el repositorio privado la regla no se impone sola: se mira antes
de mergear.

### Después del deploy

Los seis chequeos de `deploy-checks.yml` —smoke, ensayo de conversaciones,
entrada por WhatsApp y mail, pen test, migraciones y permisos de la base, y carga
del tablero— más el resumen de lo que corrió. En la lista de chequeos de GitHub
aparecen con el entorno adelante: `DEV / Smoke del deploy`, `QA / Ensayo de
conversaciones`.

Contra DEV corren los seis. Contra QA corre lo que QA puede correr, que no es ni
«ninguno» ni «todos»: el job `qa` de `post-deploy.yml` llama al mismo workflow con
los secretos de QA mapeados uno por uno —con los de DEV apuntaría a la base de
DEV, que tiene datos reales, los trabajos que corren en el runner, tres de los
cuales escriben— y con un interruptor por chequeo. El job `dev` también mapea
sus catorce secretos uno por uno, con su mismo nombre: ningún caller usa
`secrets: inherit`, y `tests/unit/ci-secretos-del-reusable.test.ts` frena un
secreto declarado que no llegue. El disparo a mano del post-deploy corre sólo
desde `main` y sólo contra el alias de dev.

| Chequeo                           | DEV          | QA          | Por qué                                                                                                                                               |
| --------------------------------- | ------------ | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Smoke                             | sí, `--deep` | sí, liviano | `--deep` sube un archivo y llama al modelo; no es lo que ese run prueba                                                                               |
| Ensayo de conversaciones          | sí           | sí          | sube adjuntos de verdad, al balde propio de QA, no al de DEV                                                                                          |
| Entrada por WhatsApp y mail       | sí           | no          | QA no lleva Gmail ni WhatsApp: no le escribe a nadie, a propósito                                                                                     |
| Migraciones y permisos de la base | sí           | sí          | sólo le pregunta al registro de migraciones y al catálogo: permisos, y que el rol no saltee RLS                                                       |
| Pen test                          | sí           | sí          | en QA la pared se arma con un inquilino efímero y un caso propio (`--pared-propia`), que se borran al terminar; DEV y PRD lo rechazan                 |
| Ataques al agente (`--agent`)     | no           | sí          | gastan tokens del cupo del inquilino y escriben casos; contra DEV se corren a mano al tocar el agente o los prompts; contra PRD, nunca                |
| Carga del tablero                 | sí           | no          | 400 casos contra cientos de miles no comparan con el mismo presupuesto; el k6 de `load-tests.yml` sí corre contra QA, aparte, contra su alias público |

**Lo apagado no queda callado.** El job `alcance` corre al final, aun con todo
rojo, y escribe en el resumen del run una fila por chequeo: corrió, corrió y
falló, o NO corrió y por qué. De ahí venía el verde por ausencia — cuatro jobs
verdes de los que tres ni arrancaron se leen igual que seis chequeos pasados.

El smoke de QA toleraba `almacenamiento` (input `smoke_tolera`) mientras QA no
tenía balde; desde el 20/09 lo tiene y el chequeo liviano da verde solo, así que
la tolerancia se sacó. Tolerado no es probado: cuando algo se tolera, el script
lo imprime con `·` y termina nombrándolo bajo «Sin verificar en este entorno».
`whatsapp` y `gmail` no hace falta tolerarlos, que sin configurar avisan y no
fallan.

#### Los secretos de repositorio que necesita QA

Settings → Secrets and variables → Actions. Sin los cuatro primeros el job
`qa_secretos` corta la corrida y no se chequea nada; los demás sólo encienden
el ensayo.

| Secreto                                                                        | Qué es                                       | Sin él                              |
| ------------------------------------------------------------------------------ | -------------------------------------------- | ----------------------------------- |
| `QA_DATABASE_URL`                                                              | la rama de Neon de QA                        | no corre ningún chequeo             |
| `QA_DATABASE_URL_APP`                                                          | la misma rama, con el rol `claimmix_app`     | ídem                                |
| `QA_CRON_SECRET`                                                               | el `CRON_SECRET` cargado en `claimmix-qa`    | ídem: el smoke no puede preguntar   |
| `QA_GMAIL_TENANT_ID`                                                           | el inquilino de QA                           | ídem: el pen test no tiene dónde armar su señuelo |
| `QA_R2_ACCOUNT_ID`, `QA_R2_ACCESS_KEY_ID`, `QA_R2_SECRET_ACCESS_KEY`, `QA_R2_BUCKET` | el balde propio de QA, `claimmix-qa-attachments` (misma cuenta de Cloudflare que producción, otro token) | el ensayo no corre |

⛔ **`QA_DATABASE_URL` no es la de producción, nunca.** `qa_secretos` compara
las dos cadenas sin imprimir ninguna y corta si son la misma. Sin esa
comparación, el ensayo escribiría y borraría casos en la base de un cliente y
no habría nada que lo mostrara hasta después.

⛔ **`QA_R2_BUCKET` tampoco es el de producción.** `qa_secretos` compara el
balde y la llave contra los de producción, igual que las cadenas de la base, y
corta si coinciden: con los de producción el ensayo subiría y borraría adjuntos
de un cliente. La cuenta sí es la misma a propósito —los dos baldes viven en la
misma cuenta de Cloudflare, con un token cada uno—, así que `QA_R2_ACCOUNT_ID`
no se compara.

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

### 4bis. Las diecisiete variables de `claimmix-qa`

Las 63 que Vercel creó al importar salen de `.env.example` y vienen VACÍAS. Estas
diecisiete hay que llenarlas. La que cuenta es Production: `claimmix-qa` sólo
construye la rama `qa`, y ése es su entorno de producción. Hoy casi todas están
también en Preview, y las dos `DATABASE_URL*` también en Development; no hace
falta, pero no molesta. `NEXT_PUBLIC_SITE_URL` está sólo en Production.

Dos se **crean**: `GEMINI_TRANSPORT` porque hasta #212 no estaba en
`.env.example` y Vercel no la detectó; `ADMIN_EMAILS` porque nunca estuvo ahí,
sólo nombrada en un comentario. Las otras quince ya existen vacías: se
**editan**. `VERTEX_EXTRACTION_MODEL` ya no va: el modelo lo fija el código, y
una variable cargada lo pisa.

| variable | valor | tipo | crear o editar |
|---|---|---|---|
| `GEMINI_TRANSPORT` | `vertex` | Config | **crear** |
| `GOOGLE_CLOUD_PROJECT` | `claimmix-506321` | Config | editar |
| `GOOGLE_CLOUD_LOCATION` | `us-central1` | Config | editar |
| `AI_TENANT_DAILY_TOKEN_CAP` | `20000000` | Config | editar |
| `DATABASE_URL` | la rama `qa` de Neon | Secret | editar |
| `DATABASE_URL_APP` | la rama `qa` de Neon | Secret | editar |
| `GOOGLE_DEFAULT_TENANT_ID` | `10000000-0000-0000-0000-000000000001` | Config | editar |
| `BETTER_AUTH_SECRET` | uno NUEVO: `openssl rand -base64 32` | Secret | editar |
| `CRON_SECRET` | uno NUEVO: `openssl rand -hex 32` | Secret | editar |
| `NEXT_PUBLIC_SITE_URL` | `https://claimmix-qa.vercel.app` | Config | editar |
| `R2_ACCOUNT_ID` | la cuenta de Cloudflare donde vive `claimmix-qa-attachments` | Config | editar |
| `R2_ACCESS_KEY_ID` | token propio de QA | Secret | editar |
| `R2_SECRET_ACCESS_KEY` | token propio de QA | Secret | editar |
| `R2_BUCKET` | `claimmix-qa-attachments` | Config | editar |
| `GOOGLE_CLIENT_ID` | de Google Cloud (OAuth) | Config | editar |
| `GOOGLE_CLIENT_SECRET` | de Google Cloud (OAuth) | Secret | editar |
| `ADMIN_EMAILS` | direcciones admin, mismo formato que `SIGNUP_ALLOWED_EMAILS` | Config | **crear** |

Ese UUID es el inquilino «Seguros del Sur S.A.», y la rama `qa` ya lo tiene: se
sacó de la rama de ensayo, así que se llevó los tres inquilinos con ella.

`GOOGLE_DEFAULT_TENANT_ID` no figura en `.env.local` porque producción no la
define: ahí el código cae a `GMAIL_TENANT_ID`
(`src/lib/auth/provision.ts:106-108`). En QA no hay tal red —`GMAIL_TENANT_ID`
queda vacía, sin casilla—, así que `GOOGLE_DEFAULT_TENANT_ID` es la única
variable que lleva el UUID. Una variable declarada y vacía no es una variable
ausente — `??` la da por buena, devuelve la cadena vacía, y el alta de
cualquier usuario nuevo muere con «GOOGLE_DEFAULT_TENANT_ID … is required to
provision new users».

Los cuatro `R2_*` sostienen el smoke de almacenamiento; `GOOGLE_CLIENT_ID` y
`GOOGLE_CLIENT_SECRET`, el login con Google; `ADMIN_EMAILS`, que esa primera
entrada por Google quede de admin (`src/lib/auth/provision.ts:36-39`).

No hace falta una variable más para el tope de IA de lo anónimo mientras no se
defina en Vercel: `AI_ANONIMO_DAILY_TOKEN_CAP`, sin definir, vale el 60 % de
`AI_TENANT_DAILY_TOKEN_CAP` (12 M con los 20 M de QA), y un ensayo completo gasta
alrededor de 1,5 M. El ensayo entra sin `userId`, así que es el tope que lo
frenaría primero. El runner lee los dos topes de las variables del repositorio
(`deploy-checks.yml`): `AI_TENANT_DAILY_TOKEN_CAP` y, si se define,
`AI_ANONIMO_DAILY_TOKEN_CAP`. Si un día se define en Vercel, definila también
como variable del repo con el mismo valor; sin ella el runner usa el 60 % y no el
de Vercel.

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

- `BETTER_AUTH_SECRET`: `openssl rand -base64 32 | tr -d '\r\n' | clip`
- `CRON_SECRET`: `openssl rand -hex 32 | tr -d '\r\n' | clip`. Pegalo en Vercel
  y, sin cerrar el portapapeles, también en el secreto de repositorio
  `QA_CRON_SECRET`: tienen que ser el MISMO valor o el smoke contra QA recibe
  un 401 de `/api/health` y la corrida entera queda roja sin haber medido nada.
- `DATABASE_URL` y `DATABASE_URL_APP`: consola de Neon, proyecto **ClaimMix**,
  rama **`qa`** (`br-muddy-mountain-acxm92sh`), «Connection string». Una con el
  rol `neondb_owner` (esa es `DATABASE_URL`) y la otra con `claimmix_app` (esa
  es `DATABASE_URL_APP`).

⚠ **Si el agente de QA queda mudo, mirá `GEMINI_TRANSPORT` y que no haya quedado
un `VERTEX_EXTRACTION_MODEL` viejo.** Deciden por dónde sale la extracción y con
qué modelo, y ninguna rompe el build ni el arranque: el síntoma llega recién con
el primer mensaje que nadie contesta.

⛔ **`GMAIL_TENANT_ID`, `GMAIL_USER_EMAIL` y `WHATSAPP_ACCESS_TOKEN` se dejan
vacías.** Así QA lee, extrae, clasifica y decide, pero no le escribe a nadie.
Un QA que puede mandar mensajes es un QA que puede mandárselos a un asegurado real el día que alguien se equivoque de base.
Habilitarlo pide una casilla y un número de prueba propios — cuentas nuevas, no
configuración.

⚠ **QA comparte la cuota de Vertex con producción**: es el mismo proyecto de GCP.
El 2026-09-17, sin QA corriendo, devolvió `RESOURCE_EXHAUSTED` tres veces.

### 5. Dónde mide k6 — HECHO contra vistas previas

El job *Vista previa · Carga k6* de `load-tests.yml` (*QA · Carga k6* contra QA;
contra PRD no corre) mide de verdad. La corrida 35466095444, contra
una vista previa de `claimmix`, dio `smoke: p95 530 ms · 0% fallidos · 67
pedidos`. Llegar ahí pidió tres cosas, y ninguna de las tres se ve desde el
workflow.

**Un secreto.** `VERCEL_AUTOMATION_BYPASS_SECRET` se creó en Vercel —`claimmix`
→ Settings → Deployment Protection → Protection Bypass for Automation— y se
cargó en el repositorio el 17/09. Sin él, el job se salteaba k6 entero y salía
verde sin haber medido nada.

**Cuatro variables en el alcance Preview de `claimmix`**, cargadas el 19/09
(Settings → Environment Variables), sin tocar las de `Production`. Vercel admite
el mismo nombre dos veces mientras los entornos no se solapen. Las cuatro, y por
qué cada una:

- `DATABASE_URL` apuntando a la rama de Neon de **ensayo** —la misma que usa
  Playwright—, **nunca** a producción. Ahí vive la cuenta con la que entra
  `setup()`; `sembrar-para-integracion.mts:21-29` se planta si le pasás la de
  producción. Sin esto el login devolvía **500**: la vista previa arrancaba
  entera menos la base.
- `DATABASE_URL_APP` a esa misma rama, **con el rol restringido**. La capa de
  datos la lee sin respaldo (`src/data/scope.ts:109`, «esta capa NO usa
  DATABASE_URL») y las seis rutas del smoke pasan todas por ahí. Si entra como
  el dueño, `src/data/scope.ts:187` corta la corrida y nombra el usuario: un rol
  con BYPASSRLS haría pasar las pruebas leyendo los datos de todas las
  aseguradoras a la vez.
- `BETTER_AUTH_SECRET` con un valor **propio de Preview**, distinto del de
  `Production`. Es el que firma las cookies de sesión, y las vistas previas son
  públicas salvo por el bypass: compartir el secreto significa que una cookie
  fabricada contra cualquier vista previa vale también contra
  `claimmix.vercel.app`. Se genera con `openssl rand -base64 32`. Sin él la
  sonda elegía `smoke` —la base contestaba— y `setup()` moría con «El login
  contestó 500»; el log del deploy lo decía: `[BetterAuthError] You are using
  the default secret`. El comentario de `src/lib/auth/index.ts:26-50` explica
  por qué better-auth no rompe solo y por qué la comprobación vive en
  `instrumentation.ts`.
- `CRON_SECRET`, con un valor **propio de Preview**, distinto del de `Production`
  y del de QA, que se guarda también en el repositorio como `PREVIEW_CRON_SECRET`
  (`openssl rand -hex 32`, el mismo en los dos lados). No cambia lo que se mide:
  lo usa el paso de diagnóstico `¿Qué dependencia del deploy no contesta?`, que
  corre con `if: failure()` e interroga `/api/health` con `Bearer`.
  `load-tests.yml` elige el secreto por el destino ya resuelto: `CRON_SECRET` para
  el alias de producción, `QA_CRON_SECRET` para el de QA y `PREVIEW_CRON_SECRET`
  para cualquier otra vista previa. Si el de Preview no coincide, ese paso recibe
  401 y el diagnóstico se pierde justo el día que sirve; si falta
  el secreto que toca (`PREVIEW_CRON_SECRET` para una vista previa), el paso corta
  con «Falta el CRON_SECRET de este host» y no interroga: ninguno cae al de otro
  ambiente. `barrer-trabados.yml` corta igual. Hasta #382 era el mismo valor que
  el de producción, y el código de una rama sin revisar corría en Preview con el
  bearer interno de producción. Los otros tres workflows con secretos
  (`deploy-checks.yml`, `post-deploy.yml` y `barrer-trabados.yml`) ya no admiten
  vistas previas: aceptan sólo `claimmix-dev.vercel.app` y `claimmix-qa.vercel.app`
  (prd tiene su propio job, con `vars.PRD_URL`).
  El valor propio de Preview todavía hay que cargarlo (ver «Waiting on you» de
  `docs/PROJECT_STATUS.md`).

**Y una cuenta con el rol correcto.** Con las cuatro variables cargadas la
corrida seguía roja: `32.9% fallidos · 79 pedidos`, 26 fallos exactos = 13
vueltas × 2 rutas. La cuenta cableada era `PLAYWRIGHT_TEST_EMAIL`, o sea Paula,
que `sembrar-para-integracion.mts` siembra como `analyst`, y `/api/customers` y
`/api/policies` exigen `CUSTOMER_PII_ROLES` (`src/lib/auth/roles.ts:35`), que a
propósito no incluye a los analistas: por ahí salen DNI, correo y teléfono. El
job usa ahora `PLAYWRIGHT_ADMIN_EMAIL` con `INTEGRATION_ADMIN_PASSWORD` —la
contraseña que el sembrador realmente le escribe a Mariela— y las seis rutas
contestan 200.

Ese rastrillo ya se había pisado una vez, y está anotado en
`playwright.config.ts:75-79`: «el login respondía “Credenciales inválidas”
porque el servidor miraba producción, donde esas cuentas no existen».

#### Contra QA

`load-tests.yml` acepta `https://claimmix-qa.vercel.app` y QA tiene base propia
(paso 4), así que las cuentas `PLAYWRIGHT_*` están adentro y no hace falta crear
ninguna.

**k6 elige QA solo.** El job se dispara por `deployment_status` y la guarda pasó
de excluir todo entorno que empiece con `Production` a
`(!startsWith(github.event.deployment.environment, 'Production') ||
endsWith(github.event.deployment.environment, '-qa'))` (`load-tests.yml:73-77`):
el entorno de producción del proyecto de QA se llama `Production – claimmix-qa`
—con guion largo, el nombre que arma GitHub para desambiguar dos proyectos— y
ese sufijo entra por el `endsWith`.

**Contra QA mide el ALIAS, no la URL del deploy** (`load-tests.yml:116-118`).
Medido el 18/09: la URL con hash de `claimmix-qa` está detrás de Vercel Auth
—contesta `{"protection":{"vercel_auth_enabled":true…}}` antes de llegar a la
aplicación— y el secreto de automatización que hay en el repositorio es el del
OTRO proyecto, así que ahí k6 mediría la puerta. El alias de producción de QA es
público, y además es la URL contra la que prueba una persona.

✅ **Cargada.** `NEXT_PUBLIC_SITE_URL` está en `claimmix-qa` desde el paso 4bis:
el login de `setup()` ya no choca con el `403 INVALID_ORIGIN`
(`tests/load/helpers/auth.js:99-106`) y k6 contra QA corrió verde (run
35551526536).

#### Cuando el destino no tiene base

El job sondea `/api/admin/health` antes de elegir qué correr, y mira el CUERPO y
no el código (ese endpoint es público y contesta 200 igual con la base caída).
Sin base corre `tests/load/scenarios/publico.js`: las cuatro páginas que el
middleware sirve sin leer la sesión —`/privacy`, `/demo`, `/terms`,
`/restablecer`, ver `src/proxy.ts:30,40,53-55`—, un VU, treinta segundos, con
umbral propio de p(95) < 1000 ms porque son páginas de marketing y no el
presupuesto de 500 ms del producto.

Y termina en rojo igual: la mitad de adentro no se midió, y un verde que no
midió lo que dice medir es peor que un rojo. El paso escribe un `::error
title=Carga a medias` que nombra lo que NO se midió, y el artefacto se llama
`carga-publico` y no `carga-smoke`, para que el nombre no mienta sobre lo que
hay adentro.

`publico` también se puede pedir a mano (`workflow_dispatch` → escenario
`publico`, o `pnpm carga:publico` contra cualquier URL). Pedido a mano sale
verde: ahí medir sólo la mitad pública es lo que se pidió, no una corrida a
medias.

#### Medir a mano

`pnpm sembrar` con `DATABASE_URL=$STAGING_DATABASE_URL`, levantar el servidor y
`pnpm carga:smoke`. Mide la aplicación, no la red, y no necesita ninguna cuenta
nueva.

⛔ Crear una cuenta en **producción** para que k6 la use sigue descartado: es una
credencial viva contra datos de clientes viajando en cada corrida. Los
escenarios sólo leen (`base.js:94-106`), pero el riesgo es real y ya no hace
falta: la vista previa mide con la base de ensayo.

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
no se tocaron: esos los creó Vercel. Ningún workflow declara `environment:`,
así que hoy no cuida nada.

### 8. La regla de rama para `qa` — HECHA

Los mismos 14 checks requeridos que `main`, `enforce_admins`, «require branches
to be up to date» y resolución de conversaciones.

### 9. Marcar como requeridos los tres checks nuevos — HECHO

`Peso del bundle`, `Aislamiento de tenants` y `Pen test local` ya son
requeridos en `main` y en `qa`. La regla pasó de 11 checks a 14.

La evidencia con la que se decidió, sobre las últimas doce corridas de `ci.yml`:
**10 verdes y ninguna roja** para cada uno de los tres. Las otras dos salieron
`cancelled` por dos empujones al mismo minuto en la misma rama, que el grupo de
concurrencia cancela a propósito.

Para rehacer la cuenta:

```bash
for RID in $(gh run list --workflow=ci.yml --limit 12 --json databaseId --jq '.[].databaseId'); do
  gh run view "$RID" --json jobs --jq '.jobs[] | "\(.name) \(.conclusion)"'
done | grep -E '^(Peso del bundle|Aislamiento de tenants|Pen test local)' | sort | uniq -c
```


### 10. Los secretos `QA_*` del repositorio — HECHO

Los ocho existen desde el 2026-09-20, y el deploy de QA de esa noche corrió
todos sus chequeos, ensayo incluido, en verde. Van en
Settings → Secrets and variables → Actions del repositorio, y la tabla de
«Después del deploy» dice qué apaga cada ausencia.

Los cuatro obligatorios son `QA_DATABASE_URL`, `QA_DATABASE_URL_APP`,
`QA_CRON_SECRET` y `QA_GMAIL_TENANT_ID`. Los dos primeros son las mismas cadenas
de Neon que se cargaron en Vercel en el paso 4bis; el tercero, el mismo
`CRON_SECRET` que se generó ahí; el cuarto, el inquilino donde el pen test deja
su caso señuelo. Sin alguno de los cuatro el job `qa_secretos` corta la corrida
con el motivo escrito en el resumen: no hay chequeo que pueda correr sin ellos, y
no correr no se muestra como verde.

⛔ **Nunca las cadenas de producción.** `qa_secretos` las compara sin imprimir
ninguna de las dos y falla si coinciden, porque el ensayo escribe y borra casos
donde apunte. La comparación es la última red, no el permiso para probar.

El inquilino ya existe: como fila en la rama `qa` de Neon y como
`GOOGLE_DEFAULT_TENANT_ID` en `claimmix-qa` —no como `GMAIL_TENANT_ID`, que ahí
queda vacía—.

Los otros cuatro, los `QA_R2_*`, son opcionales y encienden el ensayo de
conversaciones. Son los del balde propio de QA, `claimmix-qa-attachments`.
Pasarle los de producción haría que el ensayo de QA suba y borre adjuntos en el
balde de los clientes: sin los cuatro el ensayo queda apagado, y el job
`alcance` lo nombra como no verificado en cada corrida.

Dos secretos del repositorio no son de QA. `PREVIEW_CRON_SECRET` es el
`CRON_SECRET` del alcance Preview de `claimmix` (paso 5): un valor propio,
distinto del de producción y del de QA, que sólo lee `load-tests.yml`. Y
`BETTER_AUTH_SECRET` y `QA_BETTER_AUTH_SECRET` ya no se leen en ningún workflow
—cada job que importa `@/lib/auth` genera el suyo por corrida—, así que se pueden
borrar del repositorio.

## Prd: producción de verdad, en su propio proyecto

Hasta acá «producción» fue el proyecto `claimmix`. Con prd en marcha ese proyecto pasa a
ser **dev** (conserva su `project_id`, el pool WIF `vercel`, los secretos, la base y los
datos reales) y la producción de los clientes es un proyecto nuevo, `claimmix-prd`. Esta
sección usa los nombres nuevos. El estado de cada paso, y qué falta, está en
[PROJECT_STATUS.md](PROJECT_STATUS.md).

### Los ambientes

| ambiente | proyecto de Vercel | rama | base | dominio |
|---|---|---|---|---|
| dev | `claimmix` | `main` | `ep-proud-resonance`, datos reales; `BASE_POR_CLIENTE` apagado para siempre | `claimmix-dev.vercel.app` |
| qa | `claimmix-qa` | `qa` | `ep-wispy-flower` | `claimmix-qa.vercel.app` |
| prd | `claimmix-prd` | `prd` | proyecto de Neon `claimmix-prd` (plan Free, `aws-sa-east-1`): la base de control `neondb` y una `t_<hex>` por cliente | `claimmix.vercel.app` desde el move del 2026-10-09; `claimmix-prd.vercel.app` sigue respondiendo |

Fuera de Vercel hay dos más, y ninguno recibe tráfico: la rama `ensayo` del
proyecto de Neon `claimmix-prd`, que sólo usa `pnpm bases:probar` (secretos `PRD_ENSAYO_DATABASE_URL` y
`PRD_ENSAYO_DATABASE_URL_APP`), y la rama `production` del proyecto de Neon de Veltra
(`STAGING_DATABASE_URL`), que sólo usa `ci.yml`.

prd tiene todo propio: el bucket `claimmix-prd-attachments` de R2, el pool WIF `vercel-prd`
(su condición mira el proyecto `claimmix-prd`), el topic de Pub/Sub `gmail-push-prd` con su
suscripción `gmail-push-prd-sub`, y `CRON_SECRET`, `BETTER_AUTH_SECRET` y clave de cifrado
nuevos. Comparte con dev la app de Meta, la WABA (con su token) y, hasta que tenga el suyo
(proyecto de Google Cloud propio, por crear), el cliente OAuth de Google. Por eso los
webhooks de dev necesitan un override en Meta, y prd lleva las guardas «de otro ambiente»:
`SLUGS_DE_DEV`, `NUMEROS_DE_DEV`, `CASILLAS_DE_DEV` y `URL_DEL_OTRO_AMBIENTE` (ver `.env.example`).

### El camino a prd

```
… →  PR de qa a main  →  deploy de dev  →  PR de main a prd  →  deploy de prd
```

- La rama `prd` se crea una vez, por API, desde el SHA de `main` (crea la referencia, no
  es un push de cambios). Después sólo avanza con un PR de `main` a `prd`. Nunca un push
  directo; con el repositorio privado GitHub no impone la regla, así que se sostiene a mano.
- **A lo sumo una promoción a prd por día.** El plan Hobby tiene un tope de deploys por día
  y, con tres proyectos en el mismo repositorio, llegar al tope deja a todos sin deploy y
  sin ensayo del agente durante 24 h. Si ya hubo una promoción hoy, la siguiente espera a
  mañana; si se juntaron varios cambios, van todos en un solo PR.
- `ci.yml`, `codeql.yml` y `secrets.yml` se disparan con PRs hacia `main` y `qa`, no hacia
  `prd` (`tests/unit/ci-prd.test.ts` lo fija): el commit que llega a prd ya los pasó dos
  veces y repetirlos gastaría minutos de Actions. Lo que se mira antes de mergear es a
  mano: que el PR traiga un commit de `main` cuyo post-deploy de dev terminó en verde.
- Después del deploy corre el job `PRD` de `post-deploy.yml` (el smoke liviano y
  `/api/health?deep=1`, que falla si `bases.desfase`) y, cada dos horas, el barrido de
  `barrer-trabados.yml`. Los dos usan `secrets.PRD_CRON_SECRET` y `vars.PRD_URL`. No hay
  ensayo del agente, ni pen test, ni timbre, ni carga en prd: ver «Después de cada deploy»
  en [TESTING.md](TESTING.md).

### El Ignored Build Step, en los tres proyectos

Con tres proyectos conectados al mismo repositorio, cada push construiría en los tres y se
comería el cupo de despliegues del plan gratuito. Cada proyecto ignora las ramas que no son
suyas, en **Settings → Build and Deployment → Ignored Build Step → Custom** (exit 1
construye, exit 0 saltea):

```bash
# claimmix-qa: sólo qa
if [ "$VERCEL_GIT_COMMIT_REF" = "qa" ]; then exit 1; else exit 0; fi

# claimmix-prd: sólo prd
if [ "$VERCEL_GIT_COMMIT_REF" = "prd" ]; then exit 1; else exit 0; fi

# claimmix (dev): saltea qa y prd; construye main y las vistas previas
if [ "$VERCEL_GIT_COMMIT_REF" = "qa" ] || [ "$VERCEL_GIT_COMMIT_REF" = "prd" ]; then exit 0; else exit 1; fi
```

`claimmix` no se limita a `main` porque sus vistas previas siguen haciendo falta: el k6 de
`load-tests.yml` mide contra ellas (paso 5). Y `claimmix-prd` además lleva
**Settings → Environments → Production → Branch Tracking → `prd`**, como `claimmix-qa` lleva `qa`
(paso 2).

Antes de pisar nada, leer por la API (sólo lectura) el comando que tiene hoy cada proyecto, y
confirmar con un deploy reciente que `VERCEL_GIT_COMMIT_REF` trae el nombre de la rama y no un
SHA, que es lo que sí pasa con `deployment.ref` (ver la primera trampa, más abajo). Mirar también
**Production Overrides**: un comando ahí pisa al de Project Settings.

El job `PRD` no entra en el reparto por rama sino por el nombre del entorno: dev es
`Production – claimmix`, qa termina en `-qa` y prd termina en `-prd`, y cada job de
`post-deploy.yml` mira el suyo.

### Las dos fases

El trabajo va en dos fases. En la primera prd existe, sirve el dominio y anda con **una sola
base**, como dev; la segunda le pone una base por cliente.

**Fase 1: prd con una sola base, `ALTA_AUTOMATICA=0` y `BASE_POR_CLIENTE=0`.** Cada paso dice
quién lo hace: el dueño (cuentas de Google, Cloudflare, Meta, y todo lo que pide un
navegador) o el asistente.

1. Asistente: poner el Ignored Build Step de arriba en `claimmix` y en `claimmix-qa`.
2. Asistente: el alias `claimmix-dev.vercel.app` en el proyecto `claimmix`, sirviendo el mismo
   deploy de dev. Los workflows ya lo usan como URL por defecto: tiene que existir antes de
   que esos cambios lleguen a `main`.
3. Dueño: en Google Cloud, el origen y las dos redirect URIs de `claimmix-dev.vercel.app` y de
   `claimmix-prd.vercel.app`, una por cliente OAuth (la lista de cada host, QA incluido, está en
   «Las URI de Google, una por host», más abajo), y la pantalla de consentimiento publicada:
   con los scopes de Gmail sin verificar hay un tope de 100 usuarios, compartido por todos
   los clientes del proyecto (dev, QA y prd). En Cloudflare, los dos hostnames en Turnstile.
4. Asistente: el inventario de dev, con SELECT sobre la base de dev: números conectados,
   casillas de Gmail, slugs de formulario, SSO, claves de API v1, invitaciones y
   verificaciones vivas. Llena `SLUGS_DE_DEV`, `NUMEROS_DE_DEV` y `CASILLAS_DE_DEV`.
5. Asistente: el override de Meta hacia `claimmix-dev` por cada número conectado (el real
   incluido) y por cada WABA, verificado con un GET. Dueño: la suscripción de Pub/Sub de
   dev pasa a empujar a `claimmix-dev`, y se avisa a los clientes de dev con SSO o API v1
   que cambien el redirect URI del IdP y la URL base.
6. Asistente: mergear P15, P18 y P16 por el camino de siempre (PR a `qa`, `pnpm check`
   completo contra QA, PR de `qa` a `main`).
7. Dueño: `npx neonctl auth`. Asistente: el proyecto de Neon `claimmix-prd` en
   `aws-sa-east-1`, con la misma versión de Postgres que dev, y la cadena del dueño en
   `.env.prd.local`. El endpoint de su base de control va en `HOST_DE_BASE_PRD` de
   `scripts/lib/hosts-vetados.mjs`: mientras sea `null`, los scripts de bases se niegan a
   correr contra prd.
8. **Bloqueante.** Asistente: las migraciones hasta la 0049, en orden, sobre `neondb` de prd
   (`psql -v ON_ERROR_STOP=1 -f` por cada archivo de `neon/migrations`). **La cadena nunca
   corrió sobre una base vacía**: un fallo se arregla con una migración nueva, nunca
   editando una vieja. Después `pnpm esquemas` contra dev, el rol de la app (`pnpm rol-app`,
   `pnpm permisos`) y el inquilino casa: una fila fija en `tenants`, con
   `DEFAULT_TENANT_ID` igual a su id y sin autoalta. El operador entra por `ADMIN_EMAILS`.
9. Asistente: el proyecto de Vercel `claimmix-prd` (repositorio, rama `prd`, Ignored Build
   Step, OIDC, alias `claimmix-prd.vercel.app`). Dueño: el pool WIF `vercel-prd` sin tocar
   el pool `vercel` ni la clave local, el bucket `claimmix-prd-attachments` con un token
   limitado a ese bucket, y el topic `gmail-push-prd` con la suscripción `gmail-push-prd-sub`
   empujando a `https://claimmix-prd.vercel.app/api/webhooks/gmail`. Ese alias queda para
   siempre: la suscripción no cambia con el move.
10. Asistente: las variables de prd. Desde el 17/10 los secretos los pega el dueño en la
    pantalla de Vercel (Settings > Environment Variables), nunca por chat ni por script, y el
    asistente carga sólo banderas y topes. Salvo `GMAIL_CLIENT_*` y el remitente: los carga
    el dueño con `scripts/token-remitente.mts --vercel`. Qué lleva está en la lista de abajo.
11. Asistente: `gh secret set PRD_CRON_SECRET`, `gh variable set PRD_URL --body
    https://claimmix-prd.vercel.app` y la rama `prd`, creada por API desde el SHA de `main`.
12. Asistente: el primer deploy de prd (PR de `main` a `prd`), el login del operador en
    `claimmix-prd.vercel.app`, `/admin/altas`, `GET /api/health?deep=1` y el job `PRD` en verde.
13. El move del dominio, en el orden de la sección siguiente.
14. Dueño: mirar los minutos de Actions (Settings → Billing and plans → Usage). El barrido
    de prd suma unas 360 corridas por mes al cupo de 2000 minutos del repositorio privado.

**Fase 2: una base por cliente.** `BASE_POR_CLIENTE` es de ida (ver abajo), así que va
detrás de pruebas y de un orden fijo:

1. Asistente: aplicar la 0050 (`tenant_bases` con su lease y `schema_migrations`) a mano en
   QA, en dev, en staging y en la base de control de prd, y después `pnpm esquemas`.
2. Asistente: mergear P1 a P14 y P17 con el flag apagado. Un cambio que toca autorización o
   secretos (P1, P4, P6, P7, P8, P13, P18) lo revisa Fable, y sin cuota, Opus 5.5.
3. Asistente: crear la rama `ensayo` del proyecto de Neon `claimmix-prd` y cargar sus dos
   secretos en GitHub.
4. **Bloqueante.** Asistente: `pnpm bases:probar` en verde, y el job `Bases por cliente` de
   `ci.yml` también (capa 9 de [TESTING.md](TESTING.md)).
5. Asistente: la promoción a prd (la de ese día), con el job `PRD` en verde.
6. Asistente: llevar control de prd al día con el registro:
   `node scripts/migrar-bases.mjs --env prd --dry` y después sin `--dry`.
7. Asistente: la base del inquilino casa. Antes se borran de control los casos de prueba
   que casa haya creado en la fase 1, porque quedarían huérfanos. Después,
   `pnpm exec tsx --tsconfig tsconfig.rehearsal.json scripts/preparar-base.mts --env prd --tenant <DEFAULT_TENANT_ID>`
   hasta que su fila de `tenant_bases` diga `lista`. No se deshace.
8. Asistente: `BASE_POR_CLIENTE=1` en `claimmix-prd` y un redeploy. El login del operador
   anda, y `GET /api/health?deep=1` devuelve `bases.lista` en 1 y `bases.desfase` en
   `false`.
9. Asistente: el perfil control. `node scripts/migrar-bases.mjs --env prd --perfil control`,
   `pnpm permisos --perfil control` y `pnpm permisos --perfil cliente --base t_<hex de casa>`.
   Ese día los logs de control van a mostrar 42501: cada uno delata una escritura de negocio
   que se olvidó de mover a la base del cliente, y hay que mirarlos.
10. Asistente: abrir el alta, con `ALTA_AUTOMATICA=1`, y probarla de punta a punta con una
    cuenta de prueba (Google, Gmail y un número de prueba que provee el dueño). Después
    se borra su base con `node scripts/purgar-bases.mjs --env prd --tenant <prueba> --apply`.
    No se deshace.
11. Dueño: la verificación del negocio en Meta. Mientras no esté, Meta deja 2 números en la
    WABA y hoy entra uno solo (`ALTA_NUMEROS_MAXIMOS_WABA`).
12. Dueño, opcional y último: renombrar el proyecto `claimmix` a `claimmix-dev`. Antes se
    lee (sólo lectura) el proveedor del pool `vercel`: si su condición o su mapeo dependen
    del nombre del proyecto, no se renombra.

**Lo que lleva `claimmix-prd`:**

- `BASE_POR_CLIENTE`: `0` en la fase 1, `1` en la fase 2.
- `ALTA_AUTOMATICA`: `1` desde que se abrió el alta (paso 10 de la fase 2).
- `ALTA_TOPE_GLOBAL_DIA=5`, `ALTA_TOPE_BASES=30` y `ALTA_TOPE_MB=350`: el plan Free de Neon
  tiene 500 MB por proyecto.
- `DEFAULT_TENANT_ID`: el inquilino casa.
- `SLUGS_DE_DEV`, `NUMEROS_DE_DEV`, `CASILLAS_DE_DEV` y
  `URL_DEL_OTRO_AMBIENTE=https://claimmix-dev.vercel.app`.
- `PUBSUB_TOPIC`: el de prd. Vertex con el proveedor del pool `vercel-prd`.
- Presupuestos de IA: US$ 50 en total, US$ 1 por inquilino de prueba y US$ 30 para todos los
  de prueba juntos.
- Cargadas: `GMAIL_CLIENT_*`, `ALTA_NUMERO_AUTOMATICO=1`, `ALTA_REMITENTE_*`, `TURNSTILE_*` y `R2_*`.
- Vacías a propósito: `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_TENANT_ID`, `GMAIL_TENANT_ID`,
  `GMAIL_REFRESH_TOKEN`, `GMAIL_USER_EMAIL` y `DEMO_TENANT_ID`. prd no tiene número ni casilla
  propios hasta que un cliente los conecte.

### El move del dominio, en este orden y sin plan B

**Hecho el 2026-10-09**, pasos 1 a 7, con el OK del dueño: Vercel aceptó mover el
`*.vercel.app` y `vars.PRD_URL` ya es `https://claimmix.vercel.app`. Queda el paso 8. Los
pasos siguen acá por si alguna vez hay que repetirlo.

`claimmix.vercel.app` era el alias de dev, y estaba impreso, embebido en webhooks y
registrado en Google, Meta y Cloudflare. Pasó a prd sin soltarlo en ningún momento, y sólo
cuando todo lo que apuntaba a él ya apuntaba a otro lado:

1. prd está desplegado y probado en `claimmix-prd.vercel.app` (pasos 9 a 12 de la fase 1).
2. El alias `claimmix-dev.vercel.app` sirve el mismo deploy de dev (paso 2).
3. Google OAuth y Turnstile aceptan los tres hosts (paso 3).
4. Los webhooks de dev ya no dependen del dominio: overrides de Meta por número y por WABA
   verificados con un GET, y la suscripción de Pub/Sub de dev empujando a `claimmix-dev`
   (paso 5).
5. dev pasa `NEXT_PUBLIC_SITE_URL` a `https://claimmix-dev.vercel.app` (y `NEXT_PUBLIC_APP_URL`
   si está cargada), redeploya, y se prueba el login con Google y con correo en
   `claimmix-dev`. Las invitaciones y verificaciones vivas se reenvían desde dev.
6. El move, atómico:

   ```
   POST https://api.vercel.com/v1/projects/claimmix/domains/claimmix.vercel.app/move
   {"projectId": "<id de claimmix-prd>"}
   ```

   **Si responde un error, se aborta.** El dominio sigue en dev, prd sigue en
   `claimmix-prd.vercel.app` y decide el dueño. **Nunca `DELETE` y después `POST`**: entre
   los dos el dominio no tiene dueño, y los webhooks de Meta y de Gmail que apuntan ahí
   caen en el vacío.
7. prd pasa `NEXT_PUBLIC_SITE_URL` a `https://claimmix.vercel.app` y redeploya;
   `vars.PRD_URL` pasa a la misma URL (`gh variable set PRD_URL --body https://claimmix.vercel.app`),
   y se comprueba con `curl -I` y un login.
8. Se miran 24 h los logs de `claimmix-prd` (`vercel logs`):
   `whatsapp.webhook.numero_desconocido`, `webhooks_gmail.mailbox_not_connected`,
   `INVALID_ORIGIN` y los 404 de `/denuncia`. Cada aparición se corrige con el override o el
   slug que faltaba. Un número de dev sin override, o una WABA sin override, llega a prd
   después del move y se descarta con 200; Meta no reintenta y el mensaje se pierde.

### BASE_POR_CLIENTE es de ida

Con `BASE_POR_CLIENTE=1` cada inquilino vive en su base y la de control ya no tiene sus datos
de negocio. **Apagarla con clientes vivos los deja sin datos.** Para frenar el crecimiento se
pone `ALTA_AUTOMATICA=0` (o se baja `ALTA_TOPE_GLOBAL_DIA` a 0) y se arregla hacia adelante,
con una migración o un fix. Dev, QA y staging la dejan en `0` siempre.

### Migrar después de un cambio de esquema

Una migración nueva no se aplica sola en ninguna base. Con el flag prendido hay que llevarla
a control y a cada `t_<hex>` existente:

```bash
node scripts/migrar-bases.mjs --env prd --dry   # qué haría
node scripts/migrar-bases.mjs --env prd         # control, y después cada base `lista`
pnpm bases:empaquetar                           # la cadena que aplica el workflow a una base NUEVA
```

`pnpm bases:empaquetar --comprobar` falla en `ci.yml` si la cadena empaquetada quedó atrás de
`neon/migrations`. Entre que sale el código y que se migran las bases hay una ventana en la
que faltan columnas, y la ve el post-deploy: `bases.desfase`.

### Lo que queda abierto

1. La cadena de migraciones nunca corrió sobre una base vacía (paso 8 de la fase 1 y paso 4 de
   la 2).
2. Meta permite 2 números en la WABA hasta verificar el negocio.
3. La pantalla de consentimiento de Google tiene que estar publicada, y sus scopes de Gmail
   sin verificar tienen un tope de 100 usuarios que comparten dev, QA y prd.
4. Hecho el 09/10: Vercel aceptó mover `claimmix.vercel.app` a `claimmix-prd`.
5. Los términos de Vercel Hobby son de uso no comercial, y prd con clientes que pagan choca
   con eso. El dueño decidió no usar planes pagos; queda señalado.
6. Hecho: `HOST_DE_BASE_PRD` es `ep-sweet-salad` (`scripts/lib/hosts-vetados.mjs`).

### Las URI de Google, una por host

El login con Google (Better Auth) y la conexión de casillas arman su `redirect_uri` con
`NEXT_PUBLIC_SITE_URL` (`resolveBaseURL()` y `urlDeVueltaDeGmail()` en
`src/lib/auth/base-url.ts`): una por ambiente, sin importar por qué host entró el navegador.
Cada URI va en su cliente OAuth; si `GOOGLE_CLIENT_ID` y `GMAIL_CLIENT_ID` son el mismo
cliente, las dos van en ése.

Cada ambiente lleva su cliente de Gmail: dev el suyo, QA `claimmix-qa` (en el mismo proyecto
de Google Cloud que el de dev) y prd, por decisión del dueño del 18/10, uno propio en su propio
proyecto de Google Cloud, pendiente de crear. Hasta entonces prd usa el de dev.

| Ambiente | Host (`NEXT_PUBLIC_SITE_URL`) | Login, cliente de `GOOGLE_CLIENT_ID` | Casillas, cliente de `GMAIL_CLIENT_ID` |
|---|---|---|---|
| prd | `https://claimmix.vercel.app` | `https://claimmix.vercel.app/api/auth/callback/google` | `https://claimmix.vercel.app/api/admin/gmail-accounts/callback` |
| dev | `https://claimmix-dev.vercel.app` | `https://claimmix-dev.vercel.app/api/auth/callback/google` | `https://claimmix-dev.vercel.app/api/admin/gmail-accounts/callback` |
| QA | `https://claimmix-qa.vercel.app` | `https://claimmix-qa.vercel.app/api/auth/callback/google` | `https://claimmix-qa.vercel.app/api/admin/gmail-accounts/callback` |
| local | `http://localhost:3000` | `http://localhost:3000/api/auth/callback/google` | `http://localhost:3000/api/admin/gmail-accounts/callback` |

- `claimmix-prd.vercel.app` queda por la suscripción de Pub/Sub (paso 9), pero no se entra
  por ahí, porque Better Auth sólo acepta su `NEXT_PUBLIC_SITE_URL`; si sus URI están, no
  molestan.
- Las vistas previas (host con hash) no tienen URI: ni el login con Google ni Gmail andan
  ahí.
- Cada cliente de `GMAIL_CLIENT_ID` lleva además `http://127.0.0.1:53682/`, la vuelta de
  `scripts/token-remitente.mts`. Con `--vercel claimmix-qa` o `--vercel claimmix-prd`, el
  script sube a ese proyecto el cliente de su archivo (`.env.qa.local`, `.env.prd.local`) y el
  remitente.
- La URI de Gmail de prd va en el cliente `claimmix-prd`, del proyecto de Google Cloud propio
  de prd, con su pantalla de consentimiento publicada y su propio tope de 100 usuarios sin
  verificar. Hasta que exista, va en el de dev.
- Si falta una URI, Google muestra `redirect_uri_mismatch`. Un `NEXT_PUBLIC_SITE_URL` con
  barra final deja la de Gmail con `//` y da el mismo error.

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

Ese NOMBRE del entorno sí distingue, entonces: el guard de DEV es
`startsWith(…, 'Production') && !endsWith(…, '-qa') && !endsWith(…, '-prd')`, y
los de QA y PRD son el mismo par con su `endsWith` sin negar. Van escritos en el
grupo de `concurrency`, en el `run-name` y en el `if` de cada job de
`post-deploy.yml`, porque GitHub no deja compartir una condición entre jobs.

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
