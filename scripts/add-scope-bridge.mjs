/**
 * `pnpm puente <archivo-de-test>` — que un test que simula `db` siga andando.
 *
 * Cuando una función se migra a la capa de datos deja de hablar con `db` y pide
 * `enTenant(tenantCtx, (db) => consulta)`. Los tests que simulaban la cadena de
 * drizzle siguen siendo válidos —lo que verifican es la consulta, y eso no
 * cambió— si la capa les entrega el `db` que ya tenían simulado.
 *
 * Esto agrega ese puente.
 *
 * **Qué prueba y qué no.** Prueba la consulta: qué tabla, qué filtros de
 * negocio, qué columnas. NO prueba que el contexto de inquilino llegue a la
 * base, porque eso no se puede simular sin mentir. Eso se verifica en
 * `tests/unit/data-scope-sin-rol.test.ts` y, contra bases de verdad, en
 * `pnpm capa-datos` y `pnpm tenancy`.
 *
 * Es un puente de la migración: cuando los tests se reescriban para hablar de
 * comportamiento en vez de la forma de la consulta, va a dejar de hacer falta.
 */
import { readFileSync, writeFileSync } from "node:fs";

const archivo = process.argv[2];
if (!archivo) {
  console.error("Falta el archivo. Uso: pnpm puente <archivo-de-test>");
  process.exit(2);
}

const BLOQUE = [
  "// La capa de datos, corriendo contra el db que este test ya simula.",
  "//",
  "// Se lee `mod.db` en CADA llamada y no se desestructura: el mock de @/lib/db",
  "// suele exponer `db` con un getter para que los tests puedan intercambiar la",
  "// base simulada entre corridas, y un `const { db } = ...` congelaría el valor",
  "// de la primera llamada.",
  "//",
  "// Lo que NO se prueba acá es que el contexto de inquilino llegue a la base:",
  "// eso se verifica en tests/unit/data-scope-sin-rol.test.ts y, contra bases de",
  "// verdad, en `pnpm capa-datos` y `pnpm tenancy`.",
  'vi.mock("@/data/scope", async () => {',
  '  const mod = await import("@/lib/db");',
  "  return {",
  "    enTenant: (_ctx: unknown, armar: (d: unknown) => unknown) =>",
  "      Promise.resolve(armar(mod.db)),",
  "    enTenantVarias: (_ctx: unknown, armar: (d: unknown) => unknown[]) =>",
  "      Promise.all(armar(mod.db)),",
  "  };",
  "});",
  "",
];

const s = readFileSync(archivo, "utf8");
const nl = s.includes("\r\n") ? "\r\n" : "\n";

if (s.includes('vi.mock("@/data/scope"') || s.includes('vi.doMock("@/data/scope"')) {
  console.log(`· ${archivo} ya lo tiene`);
  process.exit(0);
}

const lineas = s.split(/\r?\n/);
// La primera línea que EMPIEZA con vi.mock( — no una mención dentro de un
// comentario. Buscarlo con indexOf sobre todo el texto cae dentro de
// "// vi.mock() calls are hoisted...", parte el comentario y rompe el archivo.
const i = lineas.findIndex((l) => l.trimStart().startsWith("vi.mock("));
if (i === -1) {
  console.log(`· ${archivo}: no tiene vi.mock al inicio de línea.`);
  console.log("  Si usa vi.doMock dentro de una función, el puente va ahí, a mano.");
  process.exit(1);
}

lineas.splice(i, 0, ...BLOQUE);
writeFileSync(archivo, lineas.join(nl), "utf8");
console.log(`✓ ${archivo}`);
