/**
 * `pnpm filtros` — cuántos filtros por inquilino quedan escritos a mano.
 *
 * Es la medida de avance de la Fase 1. Mientras haya filtros escritos a mano,
 * hay lugares donde olvidarse uno; cuando no queden, el aislamiento lo hace la
 * base y olvidarse deja de ser posible.
 *
 * Se cuenta con un poco de cuidado porque la primera versión —un `grep` de
 * `eq(` y `tenant_id` en la misma línea— contaba **los comentarios que dicen
 * que ahí ya no va un filtro**. O sea que al migrar un archivo el número subía.
 * Una métrica que empeora cuando el código mejora es peor que no tener métrica.
 *
 * Se ignoran:
 *   · líneas de comentario (`//`, `*`, `/*`)
 *   · los tests, que arman datos y no consultan de verdad
 *   · `src/data/`, que es la capa que reemplaza a los filtros
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const RAIZ = "src";
const IGNORAR = ["src/data"];
const EXT = [".ts", ".tsx"];

/** `eq(algo.tenant_id, …)` o `eq(algoTenantId, …)`, en cualquiera de sus formas. */
const FILTRO = /\beq\(\s*[\w.]*tenant_?[iI]d\b/;

function archivos(dir) {
  const salida = [];
  for (const entrada of readdirSync(dir)) {
    const ruta = join(dir, entrada).replace(/\\/g, "/");
    if (IGNORAR.some((i) => ruta.startsWith(i))) continue;
    if (statSync(ruta).isDirectory()) salida.push(...archivos(ruta));
    else if (EXT.some((e) => ruta.endsWith(e))) salida.push(ruta);
  }
  return salida;
}

const porArchivo = new Map();
let total = 0;

for (const f of archivos(RAIZ)) {
  const lineas = readFileSync(f, "utf8").split(/\r?\n/);
  let n = 0;
  for (const linea of lineas) {
    const limpia = linea.trim();
    // Un comentario que menciona un filtro no es un filtro.
    if (limpia.startsWith("//") || limpia.startsWith("*") || limpia.startsWith("/*")) continue;
    if (FILTRO.test(linea)) n++;
  }
  if (n > 0) {
    porArchivo.set(f, n);
    total += n;
  }
}

const orden = [...porArchivo.entries()].sort((a, b) => b[1] - a[1]);

console.log(`Filtros por inquilino escritos a mano: ${total}`);
console.log(`Repartidos en ${porArchivo.size} archivo(s).\n`);
console.log("Los diez que más tienen:");
for (const [f, n] of orden.slice(0, 10)) {
  console.log(`   ${String(n).padStart(3)}  ${f}`);
}
if (orden.length > 10) {
  console.log(`   ... y ${orden.length - 10} archivo(s) más`);
}

if (total === 0) {
  console.log("\n✓ No queda ninguno: el aislamiento lo hace la base.");
}
