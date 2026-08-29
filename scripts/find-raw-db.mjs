/**
 * Consultas que todavía tocan el `db` del módulo, y no el de la capa de datos.
 *
 * La distinción importa porque son dos roles distintos de Postgres. El `db` del
 * módulo entra con el dueño de las tablas y RLS no lo mira; el que reparte
 * `enTenant` entra con `claimmix_app`, que obedece las políticas. Una consulta
 * que se quedó afuera de la capa no da error: devuelve los datos de todos los
 * inquilinos, en silencio.
 *
 * Cómo distingue una de otra: `enTenant(ctx, (db) => …)` le pone al armador un
 * parámetro que se llama igual y tapa al del módulo. Así que un `db.` no es
 * crudo por cómo se escribe sino por DÓNDE está — adentro o afuera de esos
 * paréntesis. Por eso esto empareja paréntesis en vez de mirar línea por línea.
 */
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";

const SALTO = String.fromCharCode(10);

/**
 * Los tramos de la capa de datos de un archivo, como pares [inicio, fin).
 *
 * `paginarEnTenant` cuenta igual que `enTenant`: es un envoltorio que arma las
 * dos consultas de una página y las manda por `enTenantVarias`. Sin nombrarlo
 * acá, cada listado paginado salía reportado como consulta cruda, que es
 * exactamente al revés de lo que es.
 */
function tramosDeLaCapa(s) {
  const tramos = [];
  // El `(?:<[^(]*>)?` es por `enTenantVarias<[A, B]>(…)`: cuando la llamada
  // lleva un argumento de tipo, el paréntesis no viene pegado al nombre, y sin
  // esto el tramo entero quedaba sin reconocer y sus consultas salían como
  // crudas cuando no lo son.
  const re = /\b(?:paginarEnTenant|enTenant(?:Varias)?)\s*(?:<[^(]*>)?\s*\(/g;
  let m;
  while ((m = re.exec(s))) {
    let i = s.indexOf("(", m.index);
    let prof = 0;
    for (; i < s.length; i++) {
      const c = s[i];
      if (c === "(") prof++;
      else if (c === ")") {
        if (--prof === 0) break;
      } else if (c === '"' || c === "'" || c === "`") {
        const q = c;
        for (i++; i < s.length && s[i] !== q; i++) if (s[i] === "\\") i++;
      }
    }
    tramos.push([m.index, i]);
  }
  return tramos;
}

// `--others --exclude-standard` suma los archivos nuevos que todavía no
// entraron al índice. Sin eso, un módulo recién escrito era invisible para esta
// comprobación hasta después del commit — o sea, justo en el momento en que
// servía. Pasó: dos listados nuevos pasaron el chequeo en verde y aparecieron
// como rotos recién en el commit siguiente.
const archivos = execSync(
  'git ls-files --cached --others --exclude-standard "src/**/*.ts" "src/**/*.tsx"',
  { encoding: "utf8" }
)
  .split("\n")
  .filter(Boolean)
  .filter((f) => !f.startsWith("src/data/"));

/**
 * Los tramos de comentario de un archivo, como pares [inicio, fin).
 *
 * Recorre carácter por carácter en vez de usar una expresión regular, porque
 * hay que saltear también las cadenas: una regex encuentra un "comentario"
 * adentro de `"https://ejemplo"` y a partir de ahí desalinea todo el archivo.
 */
function comentarios(s) {
  const tramos = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"' || c === "'" || c === "`") {
      for (i++; i < s.length && s[i] !== c; i++) if (s[i] === "\\") i++;
    } else if (c === "/" && s[i + 1] === "/") {
      const ini = i;
      while (i < s.length && s[i] !== SALTO) i++;
      tramos.push([ini, i]);
    } else if (c === "/" && s[i + 1] === "*") {
      const ini = i;
      i = s.indexOf("*/", i + 2);
      if (i === -1) i = s.length;
      tramos.push([ini, i + 2]);
      i += 1;
    }
  }
  return tramos;
}

const crudas = [];
let declaradas = 0;
for (const f of archivos) {
  const s = readFileSync(f, "utf8");
  const tramos = tramosDeLaCapa(s);
  // Un `db.$count` nombrado en un comentario no es una consulta. Sin esto la
  // regla reportaba trabajo inexistente, que es la manera más rápida de que
  // alguien deje de mirarla.
  const dichos = comentarios(s);
  // El \s* del medio no es adorno: las consultas largas se escriben con
  // `await db` y el `.select(` en la línea siguiente, y sin eso la regla
  // dejaba pasar justo las más grandes.
  const re = /(?:^|[^.\w])(db)\s*\.\s*(select|insert|update|delete|\$count|execute)\b/g;
  let m;
  while ((m = re.exec(s))) {
    const pos = s.indexOf("db", m.index);
    if (dichos.some(([a, b]) => pos > a && pos < b)) continue;
    if (tramos.some(([a, b]) => pos > a && pos < b)) continue;
    // Qué tabla toca, para poder separar las de inquilino de las globales.
    const cerca = s.slice(pos, pos + 400);
    const t =
      /\.(?:from|into)\(\s*([\w.]+)/.exec(cerca) ||
      /\b(?:insert|update|delete|\$count)\(\s*([\w.]+)/.exec(cerca);
    // Una consulta puede quedar afuera de la capa, pero tiene que decir por qué.
    // El motivo va pegado a la consulta y no en una lista en otro archivo: la
    // lista se desactualiza y nadie la lee; el comentario lo ve el que edita.
    const arriba = s.slice(0, pos).split(SALTO).slice(-4).join(SALTO);
    if (/sin-inquilino:/.test(arriba)) {
      declaradas++;
      continue;
    }

    crudas.push({
      f,
      linea: s.slice(0, pos).split("\n").length,
      op: m[2],
      tabla: t ? t[1].replace(/^tables\./, "") : "?",
    });
  }
}

// ── Consultas resueltas antes de tiempo ─────────────────────────────────────
//
// `batch` necesita el constructor de consulta de drizzle, no una promesa: le
// llama a `_prepare()`. Un `.catch(...)` o un `.then(...)` al final de la
// cadena, ADENTRO del armador, la resuelve antes y drizzle revienta con
// `query._prepare is not a function` — quince líneas de stack de node_modules
// sin mencionar ni el `.catch` ni la capa.
//
// Pasó de verdad: el codemod que migró las consultas envolvió también el
// `.catch` que ya estaba, y quedaron quince rutas rotas. Ningún test lo agarró
// porque el puente de los tests hace `Promise.resolve(armar(db))`, que con una
// promesa funciona igual.
//
// Hay un guardia en tiempo de ejecución en `enTenant`, pero sólo salta cuando
// ese código corre. Esto lo encuentra sin correrlo.
const anticipadas = [];
for (const f of archivos) {
  const s = readFileSync(f, "utf8");
  for (const [a, b] of tramosDeLaCapa(s)) {
    const tramo = s.slice(a, b);
    for (const met of [".catch(", ".then(", ".finally("]) {
      if (tramo.includes(met)) {
        anticipadas.push(`${f}:${s.slice(0, a).split(SALTO).length}	${met.slice(0, -1)} adentro del armador`);
        break;
      }
    }
  }
}
for (const x of anticipadas) console.log(x);
if (anticipadas.length > 0) {
  console.log(
    `${SALTO}${anticipadas.length} consulta(s) resueltas antes de tiempo` +
      ` — el .catch/.then va AFUERA: enTenant(ctx, (db) => …).catch(…)`
  );
  process.exitCode = 1;
}

for (const c of crudas) console.log(`${c.f}:${c.linea}	${c.tabla}	db.${c.op}`);
console.log(
  `${SALTO}${crudas.length} consulta(s) fuera de la capa sin declarar` +
    ` · ${declaradas} declarada(s) sin inquilino`
);
if (crudas.length > 0) process.exitCode = 1;
