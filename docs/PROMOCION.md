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

### 1. El proyecto de QA en Vercel

Vercel → New Project → el mismo repositorio `claimmix` → nombre `claimmix-qa`.

### 2. Que `claimmix-qa` sólo construya `qa`

En `claimmix-qa` → Settings → Git:

- **Production Branch**: `qa`
- **Ignored Build Step**:
  ```bash
  [ "$VERCEL_GIT_COMMIT_REF" != "qa" ] && exit 0 || exit 1
  ```

Sin esto, el proyecto de QA construye cada rama y se come el cupo de
despliegues del plan gratuito.

### 3. Que el proyecto de producción ignore `qa`

En `claimmix` → Settings → Git → agregar `qa` a las ramas ignoradas. Sin esto,
un push a `qa` despliega a **producción**.

### 4. Las variables de `claimmix-qa`

Copiar las del proyecto de producción **apuntando al ensayo**:
`STAGING_DATABASE_URL` y `STAGING_DATABASE_URL_APP` en lugar de las de
producción.

⛔ **Nunca las de producción.** QA existe para poder romper cosas.

### 5. Un secreto, y una cuenta que todavía no existe

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

Tres salidas, en orden de menos a más compromiso:

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

### 6. Workload Identity Federation para `qa`

En Google Cloud, el proveedor `github` del pool acepta hoy sólo la rama `main`.
Hay que agregar `qa` a su condición de atributos, o el ensayo de conversaciones
de QA no va a poder autenticar contra Vertex.

⛔ **No borrar la clave de la cuenta de servicio que está en la máquina local.**

### 7. El entorno `QA` en GitHub

GitHub → Settings → Environments → New environment → `QA`.

- Deployment branches: **selected**, y elegir `qa`.
- Cargar ahí los secretos del ensayo.

No tocar `Preview` ni `Production`: esos los creó Vercel.

### 8. La regla de rama para `qa`

GitHub → Settings → Branches → nueva regla para `qa`, con los mismos checks
requeridos que `main`, `enforce_admins` activado y «require branches to be up to
date».

### 9. Marcar como requeridos los tres checks nuevos

En la regla de `main`, agregar: `Bundle size check`, `Tenencia y capa de datos`
y `Pen test (local)`.

**Recién después de verlos verdes unas cuantas corridas.** Un check requerido que
todavía no demostró que es estable bloquea a todo el mundo.

Al 2026-09-17, sobre las últimas doce corridas de `ci.yml`: **10 verdes y ninguna
roja** para cada uno de los tres. Las otras dos salieron `cancelled`, y no son
inestabilidad: son dos empujones al mismo minuto en la misma rama, que el grupo
de concurrencia cancela a propósito.

`Pen test (local)` tuvo una roja antes de esa ventana, y ya está explicada: le
faltaba un `CRON_SECRET` de mentira, y sin él las rutas de cron contestan 500 y la
sonda las lee como abiertas. Lo arregló #196.

Para rehacer la cuenta antes de decidir:

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
