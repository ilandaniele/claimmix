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
 *   3. envuelve la consulta en `enTenant(tenantCtx, (db) => …)`
 *   4. declara `tenantCtx` justo donde nace el inquilino, y agrega el import
 *
 * Se niega, y lo reporta, cuando:
 *   · hay un `or(` — puede ser el caso de las filas globales con tenant_id nulo,
 *     que bajo RLS desaparecen
 *   · hay un join — el filtro puede estar acotando la tabla del otro lado
 *   · el filtro está en una rama de un ternario, o sacarlo deja la condición
 *     vacía
 *   · no encuentra los límites de la consulta
 *
 * Y una regla que no se negocia: **si no puede envolver la consulta, tampoco le
 * saca el filtro.** Sacarlo sin envolver deja una consulta que, con el rol
 * viejo, devuelve datos de todos: peor que no haber hecho nada.
 *
 * Tres defectos que costó encontrar, anotados para que no vuelvan:
 *   · la primera versión contaba paréntesis y cerraba el envoltorio en el primer
 *     cierre, o sea justo después de `.select({...})`, partiendo la cadena
 *   · dejaba el `;` o la `,` del final adentro del envoltorio: lo primero no
 *     compila, lo segundo pega dos elementos de un `Promise.all([...])`
 *   · buscaba la función que contiene la consulta para declarar el contexto, y
 *     encontraba un bloque anidado: la declaración quedaba fuera de alcance
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
/** De dónde sale el inquilino: es el segundo argumento del filtro que se quita. */
const FILTRO_VALOR = /\beq\(\s*[\w.]*tenant_?[iI]d\s*,\s*([^()]+?)\s*\)/;
/** La línea que abre la cadena: termina en `db` (con o sin `await`). */
const ABRE = /^(\s*)(.*?)(await\s+)?db\s*$/;

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

/**
 * Dónde declarar el contexto: justo después de donde nace el inquilino.
 *
 * Si el filtro decía `eq(x.tenant_id, tenantId)`, en algún lado hay un
 * `const tenantId = ...`; si decía `userRow.tenant_id`, hay un `userRow`.
 * Declarar el contexto ahí garantiza que el valor ya existe y que el alcance es
 * el mismo donde se lo va a usar.
 */
function dondeNace(valor, desde) {
  const raiz = valor.trim().split(/[.[\s]/)[0];
  if (!raiz) return -1;
  const declara = new RegExp(
    "^\\s*(const|let|var)\\s+((\\{|\\[)[^}\\]]*\\b" +
      raiz +
      "\\b[^}\\]]*(\\}|\\])|" +
      raiz +
      ")\\s*[=:]"
  );
  // Hacia ARRIBA desde la consulta, no desde el principio del archivo.
  //
  // Un archivo con GET y POST declara `userRow` dos veces, una por función.
  // Buscando desde arriba, las consultas del POST apuntaban a la declaración del
  // GET —fuera de su alcance— y el contexto quedaba sin declarar en la segunda.
  for (let k = desde; k >= 0; k--) {
    if (declara.test(lineas[k])) return k;
  }
  return -1;
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

  const valor = texto.match(FILTRO_VALOR)?.[1];
  if (!valor) {
    saltados.push({ linea: i + 1, motivo: "no pude leer de dónde sale el inquilino" });
    continue;
  }

  // 1. Sacar el filtro y colapsar el and() si queda solo.
  let cuerpo = texto.replace(FILTRO_QUITAR, "");
  cuerpo = cuerpo.replace(/\band\(\s*(eq\([^()]*\))\s*,?\s*\)/g, "$1");
  cuerpo = cuerpo.replace(/\band\(\s*(\r?\n\s*)(eq\([^()]*\))\s*,?\s*(\r?\n\s*)\)/g, "$2");
  if (cuerpo === texto) {
    saltados.push({ linea: i + 1, motivo: "no pude sacar el filtro sin romper la condición" });
    continue;
  }

  // Si el filtro era la única condición, el `.where()` queda vacío. Borrarlo es
  // lo correcto y no un parche: sin WHERE, la política de la tabla decide sola,
  // que es exactamente lo que esta migración busca.
  cuerpo = cuerpo
    .split(nl)
    .filter((l) => l.trim() !== ".where()")
    .join(nl);
  cuerpo = cuerpo.replace(/\.where\(\s*\)/g, "");

  // El filtro puede estar en una rama de un ternario:
  //     isAdmin ? eq(t.tenant_id, x) : and(eq(t.tenant_id, x), eq(...))
  // Sacarlo deja `isAdmin ?: and(...)`, que no compila. Y aunque compilara,
  // decidir qué hacer con cada rama no es mecánico: va a mano.
  const compacto = cuerpo.replace(/\s+/g, "");
  if (compacto.includes("?:") || compacto.includes("and()") || compacto.includes("(,")) {
    saltados.push({ linea: i + 1, motivo: "el filtro está en un ternario o deja la condición vacía" });
    continue;
  }

  // 2. Envolver. El `await` queda AFUERA, y el signo del final —`;` o `,`—
  // también: adentro, lo primero no compila y lo segundo pega dos elementos de
  // un `Promise.all([...])` sin separador.
  const resto = cuerpo.split(nl).slice(1);
  const ultimo = resto.length - 1;
  const cierre = resto[ultimo]?.trimEnd().match(/([;,])$/)?.[1] ?? "";
  if (cierre) resto[ultimo] = resto[ultimo].replace(/[;,]\s*$/, "");

  const envuelto = [
    `${sangria}${antes}${esperar ?? ""}enTenant(tenantCtx, (db) =>`,
    `${sangria}  db`,
    ...resto.map((l) => "  " + l),
    `${sangria})${cierre}`,
  ];

  const nace = dondeNace(valor, s.inicio);
  lineas = [...lineas.slice(0, s.inicio), ...envuelto, ...lineas.slice(s.fin + 1)];
  migrados++;

  // La declaración se inserta AHORA y no al final: el recorrido va de abajo
  // hacia arriba, así que un índice anotado antes ya quedó viejo.
  if (nace === -1) {
    saltados.push({
      linea: i + 1,
      motivo: `migrada, pero declarar tenantCtx a mano: no encontré dónde nace ${valor}`,
    });
    continue;
  }
  if (lineas.some((l) => /const tenantCtx\b/.test(l))) continue;

  // Después de que TERMINE la sentencia que declara el valor, no después de su
  // primera línea: `const [userRow] = await db` sigue tres líneas más, y meter
  // la declaración en el medio parte la consulta.
  let fin = nace;
  while (fin < lineas.length - 1 && !lineas[fin].trimEnd().endsWith(";")) fin++;

  const sangriaDecl = lineas[nace].match(/^\s*/)[0];
  lineas.splice(
    fin + 1,
    0,
    `${sangriaDecl}// Las consultas de acá ya no llevan filtro por inquilino: lo pone la base.`,
    `${sangriaDecl}// Este contexto es lo único que le dice de quién son los datos.`,
    `${sangriaDecl}const tenantCtx: TenantContext = { tenantId: ${valor} };`
  );
}

// ── El import ──────────────────────────────────────────────────────────────
if (migrados > 0 && !lineas.some((l) => l.includes('from "@/data/scope"'))) {
  const linea = 'import { enTenant, type TenantContext } from "@/data/scope";';
  const i = lineas.findIndex((l) => /^import .* from "@\/lib\/db";/.test(l));
  if (i !== -1) {
    lineas.splice(i + 1, 0, linea);
  } else {
    const ultimo = lineas.reduce((acc, l, k) => (/^import /.test(l) ? k : acc), -1);
    if (ultimo !== -1) lineas.splice(ultimo + 1, 0, linea);
    else saltados.push({ linea: 0, motivo: "agregá el import de @/data/scope a mano" });
  }
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
