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

## Qué gatea cada paso

### Antes de mergear a `qa` o a `main`

Corren en cada PR, y estos son los que **impiden** mergear:

| | qué mira |
|---|---|
| `Tipos`, `Lint`, `Build` | que compile y esté prolijo |
| `Tests unitarios` | la suite entera, más los flujos |
| `Tests E2E` | la pantalla de verdad, contra su propia base |
| `Vulnerabilidades` | `pnpm audit` de alto para arriba, y semgrep |
| `Licencias` | ninguna licencia contagiosa |
| `Análisis CodeQL` | análisis estático de seguridad |
| `Credenciales` | gitleaks sobre el historial del PR |
| `Datos personales` | que no se cuele un dato de una persona |
| `Invariantes de arquitectura` | las reglas de arquitectura y de CI |
| `Peso del bundle` | 300 kB comprimidos de JavaScript |
| `Aislamiento de tenants` | que la base separe las aseguradoras |
| `Pen test local` | que ninguna ruta nueva conteste sin credenciales |

Los tres últimos eran nuevos y ya están marcados como requeridos, en `main` y en
`qa`: el paso 9 de más abajo cuenta cómo se decidió. `Tests de integración`,
`Tests de Gmail` y `Cobertura` también corren en cada PR, pero
no son requeridos y por eso no están en la tabla: un PR mergea con ellos en rojo.

### Después del deploy

Los siete de `deploy-checks.yml`: smoke, ensayo de conversaciones, timbre, pen
test de superficie, listas y parejas, permisos del rol y carga.

Contra producción corren los siete. Contra QA corre lo que QA puede correr, que
no es ni «ninguno» ni «todos»: `post-deploy.yml` tiene ahora un job `qa` que
llama al mismo workflow con los secretos de QA mapeados uno por uno —nunca
`secrets: inherit`, que apuntaría a la base de PRODUCCIÓN los seis trabajos que
corren en el runner, tres de los cuales escriben— y con un interruptor por
chequeo.

| Chequeo               | Producción   | QA          | Por qué                                                                                                                                               |
| --------------------- | ------------ | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Smoke                 | sí, `--deep` | sí, liviano | `--deep` sube un archivo y llama al modelo; no es lo que ese run prueba                                                                               |
| Ensayo                | sí           | sí          | sube adjuntos de verdad, al balde propio de QA, no al de producción                                                                                   |
| Canales de entrada    | sí           | no          | QA no lleva Gmail ni WhatsApp: no le escribe a nadie, a propósito                                                                                     |
| Paridad de documentos | sí           | sí          | sólo le pregunta al catálogo                                                                                                                          |
| Permisos del rol      | sí           | sí          | sólo le pregunta al catálogo                                                                                                                          |
| Pen test              | sí           | no          | la pared entre inquilinos necesita el inquilino de demo, que en QA no está                                                                            |
| Carga de lectura      | sí           | no          | 400 casos contra cientos de miles no comparan con el mismo presupuesto; el k6 de `load-tests.yml` sí corre contra QA, aparte, contra su alias público |

**Lo apagado no queda callado.** El job `alcance` corre al final, aun con todo
rojo, y escribe en el resumen del run una fila por chequeo: corrió, corrió y
falló, o NO corrió y por qué. De ahí venía el verde por ausencia — cuatro jobs
verdes de los que tres ni arrancaron se leen igual que siete chequeos pasados.

El smoke de QA toleraba `almacenamiento` (input `smoke_tolera`) mientras QA no
tenía balde; desde el 20/09 lo tiene y el chequeo liviano da verde solo, así que
la tolerancia se sacó. Tolerado no es probado: cuando algo se tolera, el script
lo imprime con `·` y termina nombrándolo bajo «Sin verificar en este entorno».
`whatsapp` y `gmail` no hace falta tolerarlos, que sin configurar avisan y no
fallan.

#### Los secretos de repositorio que necesita QA

Settings → Secrets and variables → Actions. Sin los tres primeros el job
`qa_secretos` corta la corrida y no se chequea nada; los demás sólo encienden
el ensayo.

| Secreto                                                                        | Qué es                                       | Sin él                              |
| ------------------------------------------------------------------------------ | -------------------------------------------- | ----------------------------------- |
| `QA_DATABASE_URL`                                                              | la rama de Neon de QA                        | no corre ningún chequeo             |
| `QA_DATABASE_URL_APP`                                                          | la misma rama, con el rol `claimmix_app`     | ídem                                |
| `QA_CRON_SECRET`                                                               | el `CRON_SECRET` cargado en `claimmix-qa`    | ídem: el smoke no puede preguntar   |
| `QA_GMAIL_TENANT_ID`                                                           | el inquilino de QA                           | el ensayo no corre                  |
| `QA_BETTER_AUTH_SECRET`                                                        | el de `claimmix-qa`                          | el ensayo no corre                  |
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

### 4bis. Las dieciocho variables de `claimmix-qa`

Las 63 que Vercel creó al importar salen de `.env.example` y vienen VACÍAS. Estas
dieciocho hay que llenarlas. La que cuenta es Production: `claimmix-qa` sólo
construye la rama `qa`, y ése es su entorno de producción. Hoy casi todas están
también en Preview, y las dos `DATABASE_URL*` también en Development; no hace
falta, pero no molesta. `NEXT_PUBLIC_SITE_URL` está sólo en Production.

Tres se **crean**: `GEMINI_TRANSPORT` y `VERTEX_EXTRACTION_MODEL` porque hasta
#212 no estaban en `.env.example` y Vercel no las detectó; `ADMIN_EMAILS` porque
nunca estuvo ahí, sólo nombrada en un comentario. Las otras quince ya existen
vacías: se **editan**.

| variable | valor | tipo | crear o editar |
|---|---|---|---|
| `GEMINI_TRANSPORT` | `vertex` | Config | **crear** |
| `VERTEX_EXTRACTION_MODEL` | de `.env.local` | Secret | **crear** |
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

**`NEXT_PUBLIC_SITE_URL` no es cosmética: sin ella no se entra a QA.** Better
Auth sólo acepta pedidos cuyo origen sea su propia `baseURL`, y esa URL sale de
`NEXT_PUBLIC_SITE_URL`; si falta, cae al host del deploy, que es la URL con hash
(`src/lib/auth/index.ts:14-18`). Medido el 18/09 contra el alias: un `POST
/api/auth/sign-in/email` con `Origin: https://claimmix-qa.vercel.app` contesta
`403 {"message":"Invalid origin","code":"INVALID_ORIGIN"}`, y el mismo pedido
contra producción contesta `401 INVALID_EMAIL_OR_PASSWORD` — o sea que allá
llega a mirar la credencial y en QA ni eso. Rompe el login del navegador, no
sólo el de k6.

**Los cinco valores que no se escriben a mano.** Todo esto va en Git Bash, que
viene con Git para Windows; `clip` es de Windows y deja el valor en el
portapapeles, listo para pegar en Vercel sin que pase por pantalla.

- `VERTEX_EXTRACTION_MODEL`:
  `grep '^VERTEX_EXTRACTION_MODEL=' .env.local | cut -d= -f2- | tr -d '\r\n' | clip`
- `BETTER_AUTH_SECRET`: `openssl rand -base64 32 | tr -d '\r\n' | clip`
- `CRON_SECRET`: `openssl rand -hex 32 | tr -d '\r\n' | clip`. Pegalo en Vercel
  y, sin cerrar el portapapeles, también en el secreto de repositorio
  `QA_CRON_SECRET`: tienen que ser el MISMO valor o el smoke contra QA recibe
  un 401 de `/api/health` y la corrida entera queda roja sin haber medido nada.
- `DATABASE_URL` y `DATABASE_URL_APP`: consola de Neon, proyecto **ClaimMix**,
  rama **`qa`** (`br-muddy-mountain-acxm92sh`), «Connection string». Una con el
  rol `neondb_owner` (esa es `DATABASE_URL`) y la otra con `claimmix_app` (esa
  es `DATABASE_URL_APP`).

⚠ **Si el agente de QA queda mudo, mirá las dos primeras.** Son las que deciden
por dónde sale la extracción y con qué modelo, y su ausencia no rompe el build ni
el arranque: el síntoma llega recién con el primer mensaje que nadie contesta.

⛔ **`GMAIL_TENANT_ID`, `GMAIL_USER_EMAIL` y `WHATSAPP_ACCESS_TOKEN` se dejan
vacías.** Así QA lee, extrae, clasifica y decide, pero no le escribe a nadie.
Un QA que puede mandar mensajes es un QA que puede mandárselos a un asegurado real el día que alguien se equivoque de base.
Habilitarlo pide una casilla y un número de prueba propios — cuentas nuevas, no
configuración.

⚠ **QA comparte la cuota de Vertex con producción**: es el mismo proyecto de GCP.
El 2026-09-17, sin QA corriendo, devolvió `RESOURCE_EXHAUSTED` tres veces.

### 5. Dónde mide k6 — HECHO contra vistas previas

El job *Carga con k6* de `load-tests.yml` mide de verdad. La corrida 35466095444, contra
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
- `CRON_SECRET`, con el mismo valor que el secreto del repositorio. No cambia lo
  que se mide: lo usa el paso de diagnóstico `¿Qué dependencia del deploy no
  contesta?`, que corre con `if: failure()` e interroga `/api/health` con
  `Bearer`. Si no coincide, ese paso recibe 401 y el diagnóstico se pierde justo
  el día que sirve.

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

Los nueve existen desde el 2026-09-20, y el deploy de QA de esa noche corrió
todos sus chequeos, ensayo incluido, en verde. Van en
Settings → Secrets and variables → Actions del repositorio, y la tabla de
«Después del deploy» dice qué apaga cada ausencia.

Los tres obligatorios son `QA_DATABASE_URL`, `QA_DATABASE_URL_APP` y
`QA_CRON_SECRET`. Los dos primeros son las mismas cadenas de Neon que se
cargaron en Vercel en el paso 4bis; el tercero, el mismo `CRON_SECRET` que se
generó ahí. Sin alguno de los tres el job `qa_secretos` corta la corrida con el
motivo escrito en el resumen: no hay chequeo que pueda correr sin ellos, y no
correr no se muestra como verde.

⛔ **Nunca las cadenas de producción.** `qa_secretos` las compara sin imprimir
ninguna de las dos y falla si coinciden, porque el ensayo escribe y borra casos
donde apunte. La comparación es la última red, no el permiso para probar.

Los otros seis —`QA_GMAIL_TENANT_ID`, `QA_BETTER_AUTH_SECRET` y los cuatro
`QA_R2_*`— son opcionales y encienden el ensayo de conversaciones. El inquilino
ya existe: como fila en la rama `qa` de Neon y como `GOOGLE_DEFAULT_TENANT_ID`
en `claimmix-qa` —no como `GMAIL_TENANT_ID`, que ahí queda vacía—; el secreto
de Better Auth también existe en `claimmix-qa`. Los de R2 son los del balde
propio de QA, `claimmix-qa-attachments`. Pasarle los de producción haría
que el ensayo de QA suba y borre adjuntos en el balde de los clientes: sin los
cuatro el ensayo queda apagado, y el job `alcance` lo nombra como no verificado
en cada corrida.

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

Ese NOMBRE del entorno sí distingue, entonces: el guard de producción es
`startsWith(…, 'Production') && !endsWith(…, '-qa')`, y el de QA es el mismo par
con el `endsWith` sin negar. Van escritos cuatro veces —una en el grupo de
`concurrency`, que además tiene su propia cola para QA, y una en el `if` de cada
job (`produccion`, `qa_secretos`, `qa`)—, porque GitHub no deja compartir una
condición entre jobs: `post-deploy.yml:115-120`, `:153-154`, `:200-201` y
`:310-311`.

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
