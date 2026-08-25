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
