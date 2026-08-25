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
    await pool.query(`SELECT id::text AS id, name FROM tenants ORDER BY created_at`)
  ).rows;
} finally {
  await pool.end();
}

if (inquilinos.length < 2) {
  console.log("\n⚠ Hacen falta dos inquilinos para cruzar. Hay", inquilinos.length);
  process.exit(3);
}

const ctxDe = (t: { id: string }): TenantContext => ({ tenantId: t.id, userId: "prueba" });

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
const [a, b] = inquilinos;
const deB = vistos.get(b.id) ?? 0;
if (deB === 0) {
  mal(`no concluyente: "${b.name}" no tiene casos, no hay nada ajeno que ocultar`);
  problemas.push("la prueba cruzada no tiene con qué cruzar");
} else {
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
