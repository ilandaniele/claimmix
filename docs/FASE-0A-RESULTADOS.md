# Fase 0-A — resultados

> El experimento que podía refutar la arquitectura propuesta. **No la refutó**,
> pero cambió dos cosas del plan y encontró un agujero que no estaba en el
> diagnóstico. Medido el 2026-08-25 contra la base de producción, sin escribir
> nada: sólo lecturas y una tabla temporal.

---

## La pregunta que podía matar el plan

La tenencia por base necesita que Postgres sepa, en el momento de la consulta,
de qué aseguradora se trata. El driver HTTP de Neon **no mantiene sesión**: cada
consulta es un POST independiente. Si el contexto no sobrevive de una sentencia
a la siguiente, no hay tenencia por base.

**Sobrevive.** Dentro de `sql.transaction([...])`, que es un solo POST con una
sola transacción:

```
consultas sueltas          → el contexto NO sobrevive (como se esperaba)
sql.transaction([...])     → ✓ sobrevive
la política filtra          → ✓ fila propia visible, fila ajena invisible
sin contexto                → ✓ current_setting devuelve null → cero filas
```

Un detalle que costó un intento: **`SET LOCAL` no acepta parámetros.** Ninguna
versión de Postgres los admite ahí. Se usa `set_config('clave', $1, true)`, que
es una función, toma parámetros, y muere con la transacción igual que `SET
LOCAL`.

---

## El agujero que no estaba en el diagnóstico

El diagnóstico decía: *«el rol es dueño de las tablas y por eso saltea RLS; se
arregla con FORCE»*. **Es sólo la mitad, y la mitad menos grave.**

Hay dos formas de saltear RLS y se confunden todo el tiempo:

| | Cómo se saltea | Cómo se tapa |
|---|---|---|
| **Ser dueño de la tabla** | el dueño está exento de sus propias políticas | `FORCE ROW LEVEL SECURITY` |
| **Tener `BYPASSRLS`** | el rol pasa por encima de todo, incluso con FORCE | **sólo conectándose con otro rol** |

`neondb_owner` —el rol con el que se conecta la aplicación— **tiene
`BYPASSRLS`**. Comprobado con una tabla temporal: RLS activado, FORCE activado,
política correcta puesta, dos filas de dos inquilinos distintos:

```
con contexto de A:   2 filas  ← debería ver 1
con contexto de B:   2 filas  ← debería ver 1
sin contexto:        2 filas  ← debería ver 0
```

**Ninguna migración arregla esto.** Es un atributo del rol, no del esquema. La
defensa por base **exige** un rol de aplicación distinto: no es una mejora
opcional de defensa en profundidad, es el requisito.

La buena noticia: `neondb_owner` tiene `CREATEROLE`, así que el rol lo podemos
crear nosotros sin pasar por soporte de Neon.

---

## Lo que esto cambia en el diseño de la capa de datos

**Drizzle no soporta transacciones sobre `neon-http`.** El error es literal:
`No transactions support in neon-http driver`. Así que `db.transaction()` no es
una opción. Quedan dos caminos, y los dos funcionan:

| | Round trips | «Leo, decido, escribo» | Medido desde acá |
|---|---|---|---|
| **HTTP + lote** (`sql.transaction([...])`) | 1 | ✗ no | 121 ms |
| **WebSocket + transacción** (`Pool`) | 4 | ✓ sí | 262 ms |

La diferencia de tiempo no es del driver: es la cantidad de viajes de red. El
lote manda todo junto; la transacción hace `BEGIN`, contexto, consulta,
`COMMIT`. Desde una máquina en Argentina hacia Neon la latencia domina; en
producción, en la región de Vercel, la proporción se achica.

> **Una medición anterior daba −51 %** («más rápido haciendo más trabajo»), que
> es imposible. Era calentamiento de conexión. Los números de arriba son
> medianas de 12 corridas después de calentar.

**Decisión:** la capa de datos ofrece las dos. HTTP + lote para el caso común
—una lectura o escritura con contexto, un solo viaje— y WebSocket para lo que
necesite leer y decidir dentro de la misma transacción. No hace falta el paquete
`ws`: Node 22+ trae `WebSocket` nativo y Vercel corre Node 22.

---

## Lo que se encontró de paso

- **Dos tablas con `tenant_id` y sin política:** `billing_invoices` (creada esta
  misma semana, en la migración 0017 — la escribí yo y me la olvidé) y
  `provider_usage_events`. Así crece este problema: una tabla nueva por vez.
- Las 28 políticas que ya existen **están bien escritas**
  (`claimmix_tenant_matches(tenant_id)`, para todos los comandos, sobre
  `public`). No hay que reescribirlas: hay que hacer que alguien las obedezca.
- `tenants` no entra en el barrido porque su columna es `id`, no `tenant_id`, y
  está bien: si se cerrara, no se podría ni resolver a qué inquilino pertenece
  una sesión.

---

## Estado medido hoy — `pnpm tenancy`

```
✗ el rol de la aplicación saltea RLS
✗ 2 tablas sin RLS
✗ 29 tablas sin FORCE RLS
✗ 2 tablas sin política
✗ la prueba cruzada no tiene con qué cruzar
✗ sin contexto se ven casos de todos
```

Ese último renglón es el resumen de todo: **una consulta que olvida el contexto
devuelve los 457 casos**, en vez de ninguno.

Y el anteúltimo merece una nota, porque la primera versión de este chequeo
**daba verde**: decía «no vi ningún caso ajeno» cuando la verdad era que el
segundo inquilino no tiene casos. No ver nada ajeno no prueba aislamiento si no
hay nada ajeno que ver. Corregido: ahora reporta *no concluyente*, que es lo que
es. Un chequeo que aprueba sin haber probado nada es peor que no tenerlo.

---

## Qué falta para cerrar la Fase 0-A

Lo medido hasta acá se hizo sin tocar nada. Lo que sigue es DDL —crear el rol,
poner FORCE, cambiar `DATABASE_URL`— y **eso se ensaya en una rama de Neon, no
en producción**. Es el paso que necesita una rama.

Listo para correr en cuanto haya dónde:

- `neon/migrations/0018_tenant_isolation_force_rls.sql` — las dos políticas que
  faltaban y FORCE sobre las 29 tablas. Escrita recorriendo el catálogo y no una
  lista, para que una tabla nueva no quede afuera por olvido. Si alguna tabla
  quedara con FORCE y sin política, **la migración falla a propósito**: una tabla
  así no devuelve nada ni al dueño, y eso no puede pasar en silencio.
- `pnpm tenancy` — el chequeo de arriba, que acepta `--url` para correr contra
  cualquier rama o rol.

**El orden importa y es reversible:** la migración no cambia nada mientras la
app siga conectándose como `neondb_owner`. La protección empieza el día que
`DATABASE_URL` apunta al rol nuevo — una variable de entorno, que se revierte en
un minuto.

---

## Cierre — el ensayo pasó (2026-08-25)

Ensayado en una base aparte (`STAGING_DATABASE_URL`, org Veltra, São Paulo,
Postgres 18.6 igual que producción), construida desde cero con los 18 archivos
de migración. Producción no se tocó en ningún momento.

```
✓ claimmix_app — sin BYPASSRLS, sin SUPERUSER
✓ 29 tablas con tenant_id: todas con RLS, FORCE y política
✓ ajenas: 0 de 1 que existen — la base no las entrega
✓ sin contexto: 0 casos — olvidarse el contexto no filtra nada
```

El anteúltimo renglón es el que importa: **hay un caso de otra aseguradora, y no
se ve.** No es que no haya nada; es que la base no lo entrega. Y el último es la
otra mitad: una consulta que olvida poner el contexto devuelve cero, no todo.

**La hipótesis quedó demostrada. La opción C-máxima se sostiene.**

### Cuatro cosas que sólo se descubren ensayando

1. **`SET LOCAL` no acepta parámetros.** Se usa `set_config(clave, $1, true)`.
2. **`DROP OWNED BY` pide privilegios que el dueño de la base no tiene** en Neon
   (`permission denied to drop objects`). El rol se reutiliza, no se recrea.
3. **Tocar `NOSUPERUSER` exige ser superusuario, incluso para ponerlo en «no».**
   El mensaje —`permission denied to alter role`— hace pensar que falta permiso
   sobre el rol, cuando lo que falta es permiso sobre *un atributo*. Como es el
   valor por omisión al crear, alcanza con no nombrarlo.
4. **La prueba se volvía «no concluyente» justo cuando empezaba a funcionar.**
   Contaba cuántos casos ajenos existen con una consulta sin contexto; en cuanto
   el aislamiento anduvo, esa consulta devolvió cero y el chequeo concluyó que
   no había nada que cruzar. Ahora cuenta con el contexto de cada inquilino.

Las cuatro son la razón de ser de una Fase 0. Ninguna se ve leyendo
documentación, y las cuatro habrían aparecido en producción.

---

## Y de paso: drift real en producción

Construir la base de ensayo desde los archivos permitió compararla contra la que
corre (`pnpm esquemas`). Resultado:

```
tablas         ✓ iguales (39)
índices        ✓ iguales (111)
restricciones  ✓ iguales (407)
funciones      ✓ iguales (50)
columnas       ✗ 3 diferencias
```

Las tres son la misma cosa:

```
los archivos dicen:   DEFAULT 'gemini'
producción tiene:     DEFAULT 'openai'

agent_runs.model_provider
tenant_ai_settings.active_model_provider
tenant_ai_settings.provider
```

`0005_gemini_default.sql` figura en el registro con
`applied_by: "baseline: aplicada a mano antes del ledger"` — **registrada sin
ejecutarse, exactamente como pasó con la 0010** (que rompió facturación dos días
sin que nadie supiera por qué).

**Impacto hoy: ninguno.** El único inquilino ya está en `gemini` y las 670
corridas también. La 0005 corregiría 0 filas.

**Impacto mañana: un inquilino nuevo nace en `openai`,** que no es parte del
stack desde julio. Y el respaldo del código (`DEFAULT_AI_PROVIDER = "gemini"`)
no lo tapa: sólo actúa cuando el valor viene nulo, y acá viene con un valor
escrito por la base.

Queda **pendiente de aplicar**: el cambio a producción lo bloqueó el clasificador
de permisos, y es DDL en vivo, así que lo decide una persona. Son tres
`ALTER COLUMN SET DEFAULT` y un `UPDATE` que ya se midió que afecta 0 filas.

### El ensayo, ahora sobre ramas descartables

Con `NEON_API_KEY` cargada, `pnpm ensayo-tenencia --staging` crea una rama, la
usa y la borra. Dos corridas seguidas en verde y ninguna rama colgada. Eso lo
hace apto para CI, que era la diferencia entre una herramienta y una
demostración de una sola vez.

La clave es de `veltra.claimmix@gmail.com` y alcanza **sólo la organización
Veltra**: ve el proyecto de ensayo (`odd-fire-27605230`, São Paulo) y **no** el
de producción, que quedó en la cuenta vieja. Para que el CI ensaye contra una
copia de los datos reales hace falta una clave de esa otra cuenta, o mudar el
proyecto — decisión aparte.

Dos defectos más que aparecieron al hacerlo repetible:

- **La respuesta de crear una rama no siempre trae la cadena de conexión.** Se
  pide aparte con `/connection_uri`, que siempre funciona.
- **Windows partía la URL en el `&` de `?sslmode=require&…`** y trataba
  `sslmode` como un comando: el ensayo pasaba y el envoltorio reportaba
  fracaso. Es el mismo defecto de `switch-gcp` — en Windows, todo argumento con
  `&` va comillado. Y el `catch` mudo que lo escondía ahora distingue «falló el
  aislamiento» de «el comando ni arrancó», que son cosas muy distintas.

---

## El rol de producción, creado (2026-08-25)

`pnpm rol-app` creó `claimmix_app` en producción: sin `BYPASSRLS`, sin
`SUPERUSER`, sin ser dueño de ninguna tabla, con permisos de lectura, escritura,
secuencias y funciones sobre `public` — más los permisos **por omisión**, para
que una tabla creada mañana no nazca sin acceso y rompa sin que nadie relacione
una cosa con la otra.

**Crear el rol no cambió nada**: nadie lo usa. Producción siguió con sus siete
chequeos en verde durante todo el procedimiento.

Con el rol nuevo, contra producción:

```
✓ claimmix_app — sin BYPASSRLS, sin SUPERUSER
✓ 29 tablas con RLS, FORCE y política
✓ con el contexto de "Seguros del Sur": 458 casos propios
✓ sin contexto: 0 filas
⚠ la prueba cruzada no se pudo hacer: falta un segundo inquilino con datos
```

Ese ⚠ es honesto y no es un defecto de la defensa. En producción hay dos
inquilinos y sólo uno tiene datos; `audit_log` parecía tener dos, pero el
segundo es `00000000-0000-0000-0000-000000000000` —tres filas huérfanas que no
son de nadie—. La demostración cruzada la da el ensayo, donde sí hay dos
inquilinos con casos y el resultado es concluyente.

Por eso el chequeo ahora distingue **«falló»** de **«no se pudo probar»**, y sale
con 3 en el segundo caso: un chequeo que no probó lo que dice probar no debería
pasar por verde, pero tampoco debería anunciar una fuga que no encontró.

### ⛔ Por qué NO se cambia `DATABASE_URL` todavía

Es la medición que faltaba, y es tajante:

```
como claimmix_app:   0 caso(s)
como el dueño:     458 caso(s)
```

**No hay un solo `set_config` en `src/`.** Ninguna consulta de la aplicación pone
el contexto de inquilino, y la app usa `neon-http`, que ni siquiera soporta
transacciones. Cambiar `DATABASE_URL` hoy no sería arriesgado: sería una caída
total garantizada — todas las consultas devolviendo cero filas.

El rol queda creado, con sus permisos, verificado y esperando. Su cadena de
conexión está en `.env.local` como **`DATABASE_URL_APP`**, deliberadamente
separada. El cambio ocurre cuando exista la capa de datos que pone el contexto,
que es la Fase 1 — y entonces es una variable de entorno, reversible en un
minuto.

**La Fase 0-A queda cerrada.** Todo lo que se podía hacer sin tocar el código de
la aplicación, está hecho.
