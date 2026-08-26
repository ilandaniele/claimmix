/**
 * `pnpm filtros:migrar <archivo>` — pasar un archivo a la capa de datos.
 *
 * Migrar 200 filtros a mano cuesta semanas. Aplicar un codemod ciego sobre una
 * aplicación que procesa siniestros reales es otra clase de problema. Esto es el
 * punto medio: hace lo mecánico, **avisa de lo que no supo hacer**, y deja el
 * archivo listo para que una persona mire el diff antes de commitear.
 *
 * Por cada consulta que lleve un filtro por inquilino:
 *   1. saca el `eq(X.tenant_id, …)` del `and(...)`
 *   2. si queda una sola condición, colapsa `and(x)` a `x`
 *   3. envuelve la consulta en `enTenant(tenantCtx, (db) => …)`, dejando el `await`
 *      afuera
 *
 * **No toca** las consultas con `or(` ni con joins. Un `or` puede ser el caso de
 * las filas globales con `tenant_id` nulo, que bajo RLS desaparecen; un join
 * puede estar apoyándose en el filtro para acotar la tabla del otro lado, y ahí
 * la política sola no alcanza.
 *
 * Y una regla que no se negocia: **si no puede envolver la consulta, tampoco le
 * saca el filtro.** Sacar el filtro sin envolver deja una consulta que, con el
 * rol viejo, devuelve datos de todos: peor que no haber hecho nada.
 *
 * Sobre cómo encuentra el final de la consulta: la primera versión contaba
 * paréntesis y cerraba el envoltorio en el primer cierre — o sea justo después
 * de `.select({...})`, partiendo la cadena al medio. Una cadena de drizzle sigue
 * mientras la línea empiece con `.` o estemos dentro de paréntesis abiertos; eso
 * es lo que se usa ahora.
 *
 * Uso:
 *   pnpm filtros:migrar src/app/api/foo/route.ts          aplica
 *   pnpm filtros:migrar src/app/api/foo/route.ts --ver    sólo dice qué haría
 */
import { readFileSync, writeFileSync } from "node:fs";

const archivo = process.argv[2];
const soloVer = process.argv.includes("--ver");

if (!archivo) {
  console.error("Falta el archivo. Uso: pnpm filtros:migrar <archivo> [--ver]");
  process.exit(2);
}

const FILTRO_LINEA = /\beq\(\s*[\w.]*tenant_?[iI]d\b/;
/** El filtro con su coma, para poder sacarlo de una lista de condiciones. */
const FILTRO_QUITAR = /\s*eq\(\s*[\w.]*tenant_?[iI]d\s*,\s*[^()]*\)\s*,?/;

const original = readFileSync(archivo, "utf8");
const nl = original.includes("\r\n") ? "\r\n" : "\n";
let lineas = original.split(/\r?\n/);

const esComentario = (l) => {
  const t = l.trim();
  return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*");
};

const profundidad = (linea) => {
  let d = 0;
  for (const c of linea) {
    if (c === "(") d++;
    else if (c === ")") d--;
  }
  return d;
};

/** La línea que abre la cadena: termina en `db` (con o sin `await`). */
const ABRE = /^(\s*)(.*?)(await\s+)?db\s*$/;

function span(i) {
  let inicio = -1;
  for (let k = i; k >= Math.max(0, i - 30); k--) {
    if (ABRE.test(lineas[k])) {
      inicio = k;
      break;
    }
  }
  if (inicio === -1) return null;

  // La cadena sigue mientras la línea empiece con `.` (otro método) o estemos
  // dentro de paréntesis abiertos por líneas anteriores de la misma cadena.
  let d = 0;
  let fin = inicio;
  for (let k = inicio + 1; k < Math.min(lineas.length, inicio + 80); k++) {
    const t = lineas[k].trim();
    if (d <= 0 && !t.startsWith(".")) break;
    d += profundidad(lineas[k]);
    fin = k;
  }
  if (fin === inicio) return null;
  return { inicio, fin };
}

const saltados = [];
let migrados = 0;

for (let i = lineas.length - 1; i >= 0; i--) {
  if (esComentario(lineas[i]) || !FILTRO_LINEA.test(lineas[i])) continue;

  const s = span(i);
  if (!s) {
    saltados.push({ linea: i + 1, motivo: "no encuentro los límites de la consulta" });
    continue;
  }

  const bloque = lineas.slice(s.inicio, s.fin + 1);
  const texto = bloque.join(nl);

  if (/\bor\(/.test(texto)) {
    saltados.push({ linea: i + 1, motivo: "tiene un or() — puede ser el caso de las filas globales" });
    continue;
  }
  if (/\.(leftJoin|innerJoin|rightJoin|fullJoin)\(/.test(texto)) {
    saltados.push({ linea: i + 1, motivo: "tiene un join — el filtro puede estar acotando la otra tabla" });
    continue;
  }
  if (/enTenant\(/.test(texto)) {
    saltados.push({ linea: i + 1, motivo: "ya pasa por la capa" });
    continue;
  }

  const m = bloque[0].match(ABRE);
  if (!m) {
    saltados.push({ linea: i + 1, motivo: "la primera línea no termina en `db`" });
    continue;
  }
  const [, sangria, antes, esperar] = m;

  // 1. Sacar el filtro y colapsar el and() si queda solo.
  let cuerpo = texto.replace(FILTRO_QUITAR, "");
  cuerpo = cuerpo.replace(/\band\(\s*(eq\([^()]*\))\s*,?\s*\)/g, "$1");
  cuerpo = cuerpo.replace(/\band\(\s*(\r?\n\s*)(eq\([^()]*\))\s*,?\s*(\r?\n\s*)\)/g, "$2");
  if (cuerpo === texto) {
    saltados.push({ linea: i + 1, motivo: "no pude sacar el filtro sin romper la condición" });
    continue;
  }

  // 2. Envolver. El `await` queda AFUERA: se espera a la capa, no a la consulta.
  //
  // Y el `;` del final también sale afuera. Si se queda adentro, el resultado es
  // `.where(...);` seguido de `)`, que no compila — y es el tipo de rotura que
  // sólo se ve al compilar, no al leer el diff por encima.
  const resto = cuerpo.split(nl).slice(1);
  const ultimo = resto.length - 1;
  const terminaEnPuntoYComa = resto[ultimo]?.trimEnd().endsWith(";");
  if (terminaEnPuntoYComa) {
    resto[ultimo] = resto[ultimo].replace(/;\s*$/, "");
  }

  const envuelto = [
    `${sangria}${antes}${esperar ?? ""}enTenant(tenantCtx, (db) =>`,
    `${sangria}  db`,
    ...resto.map((l) => "  " + l),
    `${sangria})${terminaEnPuntoYComa ? ";" : ""}`,
  ];

  lineas = [...lineas.slice(0, s.inicio), ...envuelto, ...lineas.slice(s.fin + 1)];
  migrados++;
}

console.log(archivo);
console.log(`   ${migrados} consulta(s) migradas`);
if (saltados.length) {
  console.log(`   ${saltados.length} salteada(s), para mirar a mano:`);
  for (const s of saltados) console.log(`      L${s.linea}: ${s.motivo}`);
}

if (soloVer) {
  console.log("\n   (--ver: no se escribió nada)");
} else if (migrados > 0) {
  writeFileSync(archivo, lineas.join(nl), "utf8");
  console.log("\n   escrito. Revisá el diff y corré pnpm verify.");
}
