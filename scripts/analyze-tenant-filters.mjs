/**
 * `pnpm filtros:analizar` — clasificar los filtros por inquilino que faltan migrar.
 *
 * Migrar 200 filtros a mano cuesta semanas; migrarlos con un codemod ciego sobre
 * una app que procesa siniestros de verdad es otra clase de problema. Antes de
 * elegir hace falta saber qué proporción es mecánica y qué proporción pide
 * criterio.
 *
 * Clasifica cada uno por la forma de la consulta que lo contiene:
 *
 *   simple      `and(eq(X.id, algo), eq(X.tenant_id, t))` — sacar el filtro y
 *               envolver. No hay decisión que tomar.
 *   multiple    el `and(...)` tiene más condiciones. Igual de mecánico, pero el
 *               filtro está en el medio de una lista.
 *   con-or      hay un `or(...)` cerca. Ojo: puede ser el caso de las filas
 *               globales con tenant_id nulo, que bajo RLS desaparecen.
 *   join        la consulta tiene un join. El filtro puede estar cubriendo la
 *               tabla del otro lado, y ahí la política sola no alcanza.
 *   raro        no encaja en nada de lo anterior: se mira a mano.
 *
 * Sólo lee archivos. No cambia nada.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const RAIZ = "src";
const IGNORAR = ["src/data"];
const FILTRO = /\beq\(\s*[\w.]*tenant_?[iI]d\b/;

function archivos(dir) {
  const out = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e).replace(/\\/g, "/");
    if (IGNORAR.some((i) => p.startsWith(i))) continue;
    if (statSync(p).isDirectory()) out.push(...archivos(p));
    else if (p.endsWith(".ts") || p.endsWith(".tsx")) out.push(p);
  }
  return out;
}

const esComentario = (l) => {
  const t = l.trim();
  return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*");
};

const clases = { simple: [], multiple: [], "con-or": [], join: [], raro: [] };

for (const f of archivos(RAIZ)) {
  const lineas = readFileSync(f, "utf8").split(/\r?\n/);
  lineas.forEach((linea, i) => {
    if (esComentario(linea) || !FILTRO.test(linea)) return;

    // La ventana alrededor: alcanza para ver la forma de la consulta.
    const desde = Math.max(0, i - 12);
    const hasta = Math.min(lineas.length, i + 6);
    const ventana = lineas.slice(desde, hasta).join("\n");

    const sitio = { archivo: f, linea: i + 1, texto: linea.trim().slice(0, 70) };

    if (/\.(leftJoin|innerJoin|rightJoin|fullJoin)\(/.test(ventana)) {
      clases.join.push(sitio);
    } else if (/\bor\(/.test(ventana)) {
      clases["con-or"].push(sitio);
    } else if (/and\(\s*eq\([^,]+,\s*\w+\),\s*eq\([\w.]*tenant_?[iI]d/.test(linea)) {
      clases.simple.push(sitio);
    } else if (/\band\(/.test(ventana)) {
      clases.multiple.push(sitio);
    } else {
      clases.raro.push(sitio);
    }
  });
}

const total = Object.values(clases).reduce((s, a) => s + a.length, 0);
console.log(`${total} filtros por inquilino, por forma de la consulta:\n`);

for (const [nombre, sitios] of Object.entries(clases)) {
  if (sitios.length === 0) continue;
  const pct = Math.round((sitios.length / total) * 100);
  console.log(`▸ ${nombre.padEnd(10)} ${String(sitios.length).padStart(3)}  (${pct}%)`);
  const porArchivo = new Map();
  for (const s of sitios) porArchivo.set(s.archivo, (porArchivo.get(s.archivo) ?? 0) + 1);
  const top = [...porArchivo.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
  for (const [a, n] of top) console.log(`     ${String(n).padStart(3)}  ${a}`);
  if (porArchivo.size > 4) console.log(`     ... y ${porArchivo.size - 4} archivo(s) más`);
  console.log("");
}

const mecanicos = clases.simple.length + clases.multiple.length;
console.log("─".repeat(64));
console.log(
  `${Math.round((mecanicos / total) * 100)}% es mecánico (simple + multiple).\n` +
    `El resto —join, or, raro: ${total - mecanicos}— pide mirar cada uno:\n` +
    `  · un \`or\` puede ser el caso de las filas globales, que bajo RLS se pierden\n` +
    `  · un join puede estar apoyándose en el filtro para acotar la OTRA tabla`
);
