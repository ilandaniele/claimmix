/**
 * `pnpm arquitectura` — que la arquitectura no se degrade sola.
 *
 * Una arquitectura escrita en un documento se degrada en seis meses; una
 * comprobada en cada `pnpm check`, no. Esto es lo segundo.
 *
 * Comprueba tres invariantes, en orden de importancia:
 *
 *   1. `src/core/` no toca infraestructura. Recibe datos y devuelve decisiones;
 *      si importa la base, la red o el entorno, deja de poder probarse sin
 *      montar media aplicación — que es el problema que la capa vino a resolver.
 *   2. Los filtros por inquilino escritos a mano no crecen. No se exige cero
 *      todavía —quedan los que piden criterio— pero sí que el número baje o se
 *      quede igual. Un tope que sube solo no es un tope.
 *   3. La capa de datos no cae al rol viejo. `src/data/` no puede leer
 *      `DATABASE_URL`: sus consultas no llevan filtro por inquilino, y el rol
 *      viejo saltea RLS, así que usarlo devolvería los datos de todos.
 *
 * Sale distinto de cero si alguna se viola. No mira estilo ni formato: sólo
 * cosas que, de romperse, no se notan hasta que es tarde.
 */
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";

const TOPE_FILTROS = 44;

function archivos(dir, ext = [".ts", ".tsx"]) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e).replace(/\\/g, "/");
    if (statSync(p).isDirectory()) out.push(...archivos(p, ext));
    else if (ext.some((x) => p.endsWith(x))) out.push(p);
  }
  return out;
}

const problemas = [];
const bien = (t) => console.log(`   ✓ ${t}`);
const mal = (t) => {
  console.log(`   ✗ ${t}`);
  problemas.push(t);
};

console.log("═".repeat(66));
console.log("ARQUITECTURA — las invariantes que no se ven al leer un diff");
console.log("═".repeat(66));

// ── 1. El núcleo no habla con nadie ────────────────────────────────────────
console.log("\n▸ src/core/ no toca infraestructura");
const PROHIBIDO = [
  "@/lib/db",
  "@/data/",
  "@/adapters/",
  "drizzle-orm",
  "@neondatabase",
  "googleapis",
  "next/",
  "process.env",
];
const core = archivos("src/core");
if (core.length === 0) {
  console.log("     (todavía no existe src/core: nada que comprobar)");
} else {
  let sucios = 0;
  for (const f of core) {
    const s = readFileSync(f, "utf8");
    const encontrados = PROHIBIDO.filter((p) => s.includes(p));
    if (encontrados.length) {
      mal(`${f} importa ${encontrados.join(", ")}`);
      sucios++;
    }
  }
  if (sucios === 0) bien(`${core.length} archivo(s), ninguno toca infraestructura`);
}

// ── 2. Los filtros a mano no crecen ────────────────────────────────────────
console.log("\n▸ Filtros por inquilino escritos a mano");
const FILTRO = /\beq\(\s*[\w.]*tenant_?[iI]d\b/;
let filtros = 0;
for (const f of archivos("src")) {
  if (f.startsWith("src/data")) continue;
  for (const l of readFileSync(f, "utf8").split(/\r?\n/)) {
    const t = l.trim();
    if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) continue;
    if (FILTRO.test(l)) filtros++;
  }
}
if (filtros > TOPE_FILTROS) {
  mal(`${filtros}, y el tope es ${TOPE_FILTROS}. Alguien agregó uno nuevo.`);
  console.log("     Usá la capa de datos: enTenant(tenantCtx, (db) => consulta).");
} else {
  bien(`${filtros} de ${TOPE_FILTROS} permitidos`);
  if (filtros < TOPE_FILTROS) {
    console.log(`     Bajó. Actualizá TOPE_FILTROS a ${filtros} para que no vuelva a subir.`);
  }
}

// ── 3. La capa de datos no cae al rol viejo ────────────────────────────────
console.log("\n▸ src/data/ usa sólo el rol restringido");
const scope = "src/data/scope.ts";
if (!existsSync(scope)) {
  mal("no encuentro src/data/scope.ts");
} else {
  const s = readFileSync(scope, "utf8");
  // Se permite nombrarlo en comentarios —el archivo explica por qué NO se usa—
  // pero no leerlo.
  const lee = s
    .split(/\r?\n/)
    .some((l) => {
      const t = l.trim();
      if (t.startsWith("//") || t.startsWith("*")) return false;
      return /process\.env\.DATABASE_URL\b/.test(l);
    });
  if (lee) {
    mal("lee DATABASE_URL: con el rol viejo, sus consultas devuelven datos de todos");
  } else {
    bien("no hay forma de que caiga al rol que saltea RLS");
  }
}

// ── Veredicto ──────────────────────────────────────────────────────────────
console.log("\n" + "─".repeat(66));
if (problemas.length === 0) {
  console.log("✓ Las invariantes se sostienen.");
  process.exit(0);
}
console.log(`✗ ${problemas.length} invariante(s) rota(s).`);
process.exit(1);
