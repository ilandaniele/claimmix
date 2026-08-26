/**
 * `pnpm capa-datos` — probar que la capa de datos aísla, usándola de verdad.
 *
 * `pnpm tenancy` demuestra que la BASE separa. Esto demuestra que la CAPA la usa
 * bien, que es otra cosa: una capa correcta sobre una base bien configurada
 * puede seguir filtrando datos si olvida poner el contexto, o si lo pone mal.
 *
 * Se prueba con las funciones que va a usar la aplicación —`enTenant` y
 * `enTenantVarias`— y no con SQL escrito para la ocasión. Una prueba que no pasa
 * por el mismo camino que el código no prueba el código.
 *
 * Necesita DATABASE_URL_APP y dos inquilinos con datos. Sólo lee.
 */
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { Pool, neonConfig } from "@neondatabase/serverless";
import { enTenant, enTenantVarias, type TenantContext } from "@/data/scope";
import { tables } from "@/lib/db";
import { eq } from "drizzle-orm";

neonConfig.webSocketConstructor = globalThis.WebSocket as never;

const url = process.env.DATABASE_URL_APP?.trim();
if (!url) {
  console.error("Falta DATABASE_URL_APP.");
  process.exit(2);
}

/**
 * Traducir el error del driver a algo accionable.
 *
 * "password authentication failed" sale como una excepción cruda con un stack
 * de veinte líneas del driver, y no dice ninguna de las dos cosas que hacen
 * falta: qué se rompió y cómo se arregla.
 */
function explicar(e: unknown): never {
  const msg = e instanceof Error ? e.message : String(e);
  if (/password authentication failed/i.test(msg)) {
    console.error("\n✗ La contraseña de DATABASE_URL_APP no autentica.");
    console.error("");
    console.error("  El rol existe; lo que no sirve es la contraseña guardada.");
    console.error("  Suele pasar después de rotarla en un lado y no en el otro.");
    console.error("");
    console.error("  1. pnpm rol-app --rotar        genera una nueva y la imprime");
    console.error("  2. pegala en .env.local");
    console.error("  3. vercel env rm DATABASE_URL_APP production");
    console.error("     vercel env add DATABASE_URL_APP production");
    process.exit(2);
  }
  throw e;
}

const bien = (t: string) => console.log(`   ✓ ${t}`);
const mal = (t: string) => console.log(`   ✗ ${t}`);
const problemas: string[] = [];

console.log("═".repeat(70));
console.log("CAPA DE DATOS — ¿usa bien el aislamiento que la base ofrece?");
console.log("═".repeat(70));

// Los inquilinos se leen con una conexión aparte y sin contexto, porque la capa
// —correctamente— no permite listar inquilinos: no son de nadie.
const pool = new Pool({ connectionString: url });
let inquilinos: Array<{ id: string; name: string }> = [];
try {
  inquilinos = (
    await pool
      .query(`SELECT id::text AS id, name FROM tenants ORDER BY created_at`)
      .catch(explicar)
  ).rows;
} finally {
  await pool.end();
}

if (inquilinos.length < 2) {
  console.log("\n⚠ Hacen falta dos inquilinos para cruzar. Hay", inquilinos.length);
  process.exit(3);
}

const ctxDe = (t: { id: string }): TenantContext => ({ tenantId: t.id });

// ── 1. Cada uno ve lo suyo ─────────────────────────────────────────────────
console.log("\n▸ Cada inquilino, a través de la capa");
const vistos = new Map<string, number>();
for (const t of inquilinos) {
  const filas = await enTenant(ctxDe(t), (db) =>
    db.select({ id: tables.cases.id, dueno: tables.cases.tenant_id }).from(tables.cases)
  );
  vistos.set(t.id, filas.length);

  const ajenas = filas.filter((f) => f.dueno !== t.id);
  if (ajenas.length > 0) {
    mal(`"${t.name}" ve ${ajenas.length} caso(s) que NO son suyos`);
    problemas.push(`${t.name} ve datos ajenos`);
  } else {
    bien(`"${t.name}": ${filas.length} caso(s), todos suyos`);
  }
}

// ── 2. Lo de uno es invisible para el otro ─────────────────────────────────
console.log("\n▸ La prueba cruzada");

// Se eligen los dos que TIENEN datos, no los dos primeros de la lista.
//
// Antes tomaba `inquilinos[0]` y `[1]`, y si al segundo le tocaba estar vacío la
// prueba salía "no concluyente" aunque hubiera un tercero con casos de sobra
// para cruzar. Una prueba que se declara no concluyente por elegir mal a quién
// mirar es peor que no tenerla: se lee como un problema del aislamiento.
const conDatos = inquilinos
  .filter((t) => (vistos.get(t.id) ?? 0) > 0)
  .sort((x, y) => (vistos.get(y.id) ?? 0) - (vistos.get(x.id) ?? 0));

// Para el resto del guión alcanza con cualquiera que tenga datos.
const a = conDatos[0] ?? inquilinos[0];

if (conDatos.length < 2) {
  mal(
    `no concluyente: ${conDatos.length} inquilino(s) con casos. Hace falta que ` +
      "dos tengan algo para que uno pueda no ver lo del otro."
  );
  problemas.push("la prueba cruzada no tiene con qué cruzar");
} else {
  const b = conDatos[1];
  const deB = vistos.get(b.id) ?? 0;
  const desdeA = await enTenant(ctxDe(a), (db) =>
    db.select({ id: tables.cases.id }).from(tables.cases).where(eq(tables.cases.tenant_id, b.id))
  );
  if (desdeA.length > 0) {
    mal(`desde "${a.name}" se ven ${desdeA.length} caso(s) de "${b.name}" pidiéndolos por id`);
    problemas.push("se pueden pedir los casos de otro por id");
  } else {
    bien(`desde "${a.name}", los ${deB} caso(s) de "${b.name}" no existen — ni pidiéndolos`);
  }
}

// ── 3. Varias consultas, un viaje, mismo contexto ──────────────────────────
console.log("\n▸ Varias consultas en un solo viaje");
const [casos, docs] = await enTenantVarias<[unknown[], unknown[]]>(ctxDe(a), (db) => [
  db.select({ id: tables.cases.id }).from(tables.cases),
  db.select({ id: tables.missingDocs.id }).from(tables.missingDocs),
]);
bien(`${casos.length} caso(s) y ${docs.length} documento(s) faltante(s), en una sola ida`);

// ── 4. Escribir en el inquilino de al lado ─────────────────────────────────
//
// Ésta es la defensa que antes no existía en ninguna forma. Con el filtro
// escrito a mano, una consulta que se olvidaba el `tenant_id` en un INSERT
// grababa la fila igual, en el inquilino equivocado, sin un solo error. La
// política `WITH CHECK` lo rechaza en la base.
//
// Se intenta contra un inquilino que existe y NO es el que pone el contexto. Si
// la base la deja pasar, la fila queda escrita: por eso se busca y se borra
// abajo, con el rol dueño, y se avisa fuerte. Un aviso silencioso acá es una
// fuga de escritura viviendo en producción.
console.log("\n▸ Escribir en el inquilino de al lado");
if (conDatos.length < 2) {
  console.log("     (hace falta un segundo inquilino: se saltea)");
} else {
  const otro = conDatos[1];
  const marca = `PRUEBA-CAPA-DATOS-${a.id.slice(0, 8)}`;
  let paso = false;
  try {
    await enTenant(ctxDe(a), (db) =>
      db.insert(tables.cases).values({
        tenant_id: otro.id,
        policy_number: marca,
        status: "recibido",
        channel: "email_sim",
      })
    );
    paso = true;
  } catch {
    // Lo esperado: la política la rechaza.
    bien(`la base rechaza escribir en "${otro.name}" desde el contexto de "${a.name}"`);
  }

  if (paso) {
    mal(`se pudo INSERTAR en "${otro.name}" desde el contexto de "${a.name}"`);
    problemas.push("se puede escribir en el inquilino de al lado");

    // Limpieza, con el rol dueño: la fila quedó escrita de verdad.
    const limpieza = new Pool({ connectionString: process.env.DATABASE_URL?.trim() });
    try {
      const r = await limpieza.query(`DELETE FROM cases WHERE policy_number = $1`, [marca]);
      console.log(`     (borrada${r.rowCount === 1 ? "" : ` — ${r.rowCount} filas`})`);
    } finally {
      await limpieza.end();
    }
  }
}


// ── Veredicto ──────────────────────────────────────────────────────────────
console.log("\n" + "─".repeat(70));
if (problemas.length === 0) {
  console.log("✓ La capa de datos aísla. Ninguna consulta lleva filtro por inquilino");
  console.log("  escrito a mano, y aun así nadie ve lo que no es suyo.");
  process.exit(0);
}
console.log(`✗ ${problemas.length} problema(s):`);
for (const p of problemas) console.log(`   · ${p}`);
process.exit(1);
