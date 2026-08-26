/**
 * `pnpm tenancy` — probar que la base separa a las aseguradoras, no el código.
 *
 * No mira migraciones ni código: le pregunta a la base. Las migraciones dicen
 * qué se pidió; `pg_class.relforcerowsecurity` y una consulta cruzada dicen qué
 * pasa. Esa distinción no es teórica: durante meses hubo 28 políticas escritas
 * y ninguna corría.
 *
 * Prueba, en orden de importancia:
 *
 *   1. El rol con el que se conecta la app, y si tiene BYPASSRLS. Un rol con
 *      BYPASSRLS ignora toda política: es el agujero más grande y el menos
 *      visible, porque no se ve en ninguna migración.
 *   2. Cobertura: cuántas tablas con tenant_id tienen RLS, FORCE y política.
 *   3. La prueba de verdad: con el contexto de una aseguradora, ¿se pueden ver
 *      filas de otra? Y sin contexto, ¿se ve algo?
 *
 * Sólo lee. No escribe, no borra, no cambia configuración.
 *
 * **Contra qué rol.** Por omisión audita `DATABASE_URL_APP`, que es el rol con
 * el que la aplicación consulta de verdad. Auditar `DATABASE_URL` no sirve:
 * `neondb_owner` es dueño de las tablas y tiene BYPASSRLS por diseño —corre las
 * migraciones—, así que este chequeo siempre daría rojo y el rojo no querría
 * decir nada. La pregunta "¿la base separa?" es sobre el rol restringido.
 *
 * Uso:
 *   pnpm tenancy                    contra DATABASE_URL_APP
 *   pnpm tenancy --url "postgres://..."   contra una rama o un rol distinto
 *   pnpm tenancy --esperado-abierto       sale 0 aunque NO aísle (para medir
 *                                          el estado actual sin romper el CI)
 */
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { Pool, neonConfig } from "@neondatabase/serverless";

// Node 22+ trae WebSocket nativo. Se usa el driver WebSocket y no el HTTP
// porque hace falta una transacción de verdad para poner el contexto y leer
// dentro de ella.
neonConfig.webSocketConstructor = globalThis.WebSocket as never;

const args = process.argv.slice(2);
const urlArg = args.indexOf("--url");
const url = (
  urlArg >= 0
    ? args[urlArg + 1]
    : // El rol restringido primero. Se cae a DATABASE_URL sólo para que el
      // script siga sirviendo en una base que todavía no tiene rol propio.
      (process.env.DATABASE_URL_APP ?? process.env.DATABASE_URL)
)?.trim();
const esperadoAbierto = args.includes("--esperado-abierto");

if (!url) {
  console.error("Falta DATABASE_URL_APP (o pasá --url).");
    process.exit(2);
}

const titulo = (t: string) => console.log(`\n▸ ${t}`);
const bien = (t: string) => console.log(`   ✓ ${t}`);
const mal = (t: string) => console.log(`   ✗ ${t}`);
const nota = (t: string) => console.log(`     ${t}`);

const pool = new Pool({ connectionString: url });
const problemas: string[] = [];
// Separado a propósito de `problemas`: «no se pudo probar» no es lo mismo que
// «falló». Meterlos en la misma bolsa hace que el chequeo anuncie «la base no
// separa» cuando en realidad todo lo verificable pasó y lo que faltaron fueron
// datos con qué cruzar. Esa confusión es la que convierte un chequeo en ruido,
// y un chequeo que se vuelve ruido se deja de mirar.
const sinProbar: string[] = [];

try {
  const cx = await pool.connect();
  try {
    console.log("═".repeat(70));
    console.log("TENENCIA — ¿separa la base, o sólo el código?");
    console.log("═".repeat(70));

    // ── 1. El rol ───────────────────────────────────────────────────────────
    titulo("El rol con el que se conecta la aplicación");
    const rol = (
      await cx.query(`
        SELECT current_user::text AS nombre, rolbypassrls, rolsuper
        FROM pg_roles WHERE rolname = current_user`)
    ).rows[0];

    if (rol.rolbypassrls || rol.rolsuper) {
      mal(`${rol.nombre} — ${rol.rolsuper ? "SUPERUSER" : "BYPASSRLS"}`);
      nota("Este rol pasa por encima de toda política de seguridad, siempre.");
      nota("Mientras la app se conecte así, el RLS es decorativo.");
      problemas.push("el rol de la aplicación saltea RLS");
    } else {
      bien(`${rol.nombre} — sin BYPASSRLS, sin SUPERUSER`);
    }

    // ── 2. Cobertura ────────────────────────────────────────────────────────
    titulo("Cobertura sobre las tablas con datos de aseguradoras");
    const cob = (
      await cx.query(`
        SELECT c.relname::text AS tabla,
               c.relrowsecurity  AS rls,
               c.relforcerowsecurity AS forzado,
               (SELECT count(*) FROM pg_policies p
                 WHERE p.schemaname='public' AND p.tablename=c.relname)::int AS politicas
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname='public' AND c.relkind='r'
          AND EXISTS (SELECT 1 FROM information_schema.columns col
                       WHERE col.table_schema='public' AND col.table_name=c.relname
                         AND col.column_name='tenant_id')
        ORDER BY c.relname`)
    ).rows;

    const sinRls = cob.filter((t) => !t.rls).map((t) => t.tabla);
    const sinForce = cob.filter((t) => !t.forzado).map((t) => t.tabla);
    const sinPol = cob.filter((t) => t.politicas === 0).map((t) => t.tabla);

    console.log(`   ${cob.length} tablas con tenant_id`);
    if (sinRls.length) {
      mal(`${sinRls.length} sin RLS: ${sinRls.slice(0, 4).join(", ")}${sinRls.length > 4 ? "…" : ""}`);
      problemas.push(`${sinRls.length} tablas sin RLS`);
    } else bien("todas con RLS activado");

    if (sinForce.length) {
      mal(`${sinForce.length} sin FORCE: el dueño de la tabla las ve enteras`);
      nota(sinForce.slice(0, 4).join(", ") + (sinForce.length > 4 ? "…" : ""));
      problemas.push(`${sinForce.length} tablas sin FORCE RLS`);
    } else bien("todas con FORCE RLS");

    if (sinPol.length) {
      mal(`${sinPol.length} sin política: ${sinPol.join(", ")}`);
      problemas.push(`${sinPol.length} tablas sin política`);
    } else bien("todas con política");

    // ── 3. La prueba de verdad ──────────────────────────────────────────────
    titulo("La prueba cruzada: dos aseguradoras, una consulta");

    // Con qué tabla se cruza.
    //
    // `cases` es la que más significa, pero sólo sirve si dos inquilinos tienen
    // casos. En producción hay uno solo con casos, y entonces "no vi nada
    // ajeno" no prueba nada. Antes de resignarse a un "no concluyente" —o peor,
    // de escribir datos falsos en producción para que la prueba pase— se busca
    // alguna tabla que YA tenga filas de más de un inquilino.
    //
    // Esto se hace con el rol que esté probándose. Si ese rol obedece RLS y no
    // hay contexto puesto, no verá nada y el recuento dará uno: por eso la
    // búsqueda corre con el contexto de cada inquilino, más abajo.
    const inquilinos = (
      await cx.query(`SELECT id::text AS id, name FROM tenants ORDER BY created_at LIMIT 2`)
    ).rows;

    if (inquilinos.length < 2) {
      nota("Hay menos de dos inquilinos: no se puede cruzar nada. Se salta.");
    } else {
      const [a, b] = inquilinos;

      const enContexto = async <T,>(tenant: string, hacer: () => Promise<T>): Promise<T> => {
        await cx.query("BEGIN");
        try {
          await cx.query("SELECT set_config('claimmix.tenant_id', $1, true)", [tenant]);
          return await hacer();
        } finally {
          await cx.query("ROLLBACK");
        }
      };

      const cuantasDe = (tabla: string, tenant: string) =>
        enContexto(tenant, async () => {
          const r = await cx.query(
            `SELECT count(*)::int AS n FROM "${tabla}" WHERE tenant_id = $1`,
            [tenant]
          );
          return r.rows[0].n as number;
        });

      // Elegir la tabla con la que cruzar.
      //
      // `cases` es la que más significa, pero en producción hay un solo
      // inquilino con casos y entonces "no vi nada ajeno" no prueba nada. Antes
      // de resignarse a un "no concluyente" —o de escribir datos falsos en
      // producción para que la prueba pase, que sería mucho peor— se busca una
      // tabla que YA tenga filas de los dos.
      let tabla = "cases";
      let hayAjenas = await cuantasDe(tabla, b.id);

      if (hayAjenas === 0) {
        const candidatas = (
          await cx.query(`
            SELECT c.table_name::text AS t
            FROM information_schema.columns c
            JOIN information_schema.tables tb
              ON tb.table_schema = c.table_schema AND tb.table_name = c.table_name
            WHERE c.table_schema = 'public' AND c.column_name = 'tenant_id'
              AND tb.table_type = 'BASE TABLE' AND c.table_name <> 'cases'
            ORDER BY 1`)
        ).rows as Array<{ t: string }>;

        for (const { t } of candidatas) {
          try {
            const n = await cuantasDe(t, b.id);
            if (n > 0) {
              tabla = t;
              hayAjenas = n;
              nota(`\`cases\` no alcanza (el otro inquilino no tiene): se cruza con \`${t}\``);
              break;
            }
          } catch {
            // Una tabla sin permiso o con forma rara no invalida la prueba.
          }
        }
      }

      const verConContexto = (ctx: string) =>
        enContexto(ctx, async () => {
          const r = await cx.query(
            `SELECT tenant_id::text AS t, count(*)::int AS n
             FROM "${tabla}" GROUP BY tenant_id`
          );
          return r.rows as Array<{ t: string; n: number }>;
        });

      // El recuento de lo ajeno va con el contexto puesto Y filtrando por
      // dueño. El filtro no sobra: si el rol saltea RLS, la consulta sin filtro
      // devuelve todo, y el recuento informaría cientos de filas "ajenas" que
      // en realidad son las propias vistas de más — un dato falso justo en el
      // escenario que este chequeo existe para denunciar.
      const desdeA = await verConContexto(a.id);
      const ajenas = desdeA.filter((f) => f.t !== a.id);
      const propias = desdeA.find((f) => f.t === a.id)?.n ?? 0;

      console.log(`   con el contexto de "${a.name}" sobre \`${tabla}\`:`);
      nota(`propias: ${propias} fila(s)`);
      if (ajenas.length) {
        mal(`ajenas: ${ajenas.reduce((s, f) => s + f.n, 0)} fila(s) de ${ajenas.length} inquilino(s) más`);
        nota(`"${b.name}" es visible desde "${a.name}". Esto es la fuga.`);
        problemas.push("una aseguradora puede ver los datos de otra");
      } else if (hayAjenas === 0) {
        mal("no concluyente: ninguna tabla tiene filas de un segundo inquilino");
        nota("No ver nada ajeno no prueba aislamiento si no hay nada ajeno que ver.");
        sinProbar.push("la prueba cruzada: falta un segundo inquilino con datos");
      } else {
        bien(`ajenas: 0 de ${hayAjenas} que existen — la base no las entrega`);
      }

      // Sin contexto: no debería verse nada.
      await cx.query("BEGIN");
      const sinCtx = await cx.query(`SELECT count(*)::int AS n FROM "${tabla}"`);
      await cx.query("ROLLBACK");
      const n = sinCtx.rows[0].n as number;
      if (n > 0) {
        mal(`sin contexto se ven ${n} fila(s) de \`${tabla}\``);
        nota("Una consulta que olvida poner el contexto devuelve datos de todos.");
        problemas.push("sin contexto se ven casos de todos");
      } else {
        bien(`sin contexto: 0 filas — olvidarse el contexto no filtra nada`);
      }
    }
  } finally {
    cx.release();
  }
} catch (e) {
  console.error(`\n✗ no se pudo verificar: ${(e as Error).message.slice(0, 200)}`);
  await pool.end();
  process.exit(2);
}

await pool.end();

// ── Veredicto ───────────────────────────────────────────────────────────────
console.log("\n" + "─".repeat(70));
if (problemas.length === 0 && sinProbar.length === 0) {
  console.log("✓ La base separa a las aseguradoras por sí misma.");
  console.log("  Un WHERE olvidado deja de ser una fuga.");
  process.exit(0);
}

if (problemas.length === 0) {
  console.log("⚠ Todo lo verificable pasó, pero algo no se pudo probar:");
  for (const p of sinProbar) console.log(`   · ${p}`);
  console.log("");
  console.log("  El rol no saltea RLS, las tablas tienen FORCE y política, y sin");
  console.log("  contexto no se ve nada. Lo que falta no es una defensa: son datos");
  console.log("  con qué demostrarla.");
  console.log("");
  console.log("  Sale con 3 y no con 0: un chequeo que no probó lo que dice probar");
  console.log("  no debería pasar por verde.");
  process.exit(esperadoAbierto ? 0 : 3);
}

console.log(`✗ La base NO separa. ${problemas.length} motivo(s):`);
for (const p of problemas) console.log(`   · ${p}`);
console.log("");
console.log("  Hoy lo único que separa son los filtros escritos a mano en el");
console.log("  código. Funcionan hasta que alguien escriba una consulta sin uno.");

if (esperadoAbierto) {
  console.log("\n  (--esperado-abierto: se sale con 0 igual, esto es una medición)");
  process.exit(0);
}
process.exit(1);
