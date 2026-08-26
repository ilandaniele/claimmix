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

/** Los tramos `enTenant(…)` de un archivo, como pares [inicio, fin). */
function tramosDeLaCapa(s) {
  const tramos = [];
  // El `(?:<[^(]*>)?` es por `enTenantVarias<[A, B]>(…)`: cuando la llamada
  // lleva un argumento de tipo, el paréntesis no viene pegado al nombre, y sin
  // esto el tramo entero quedaba sin reconocer y sus consultas salían como
  // crudas cuando no lo son.
  const re = /\benTenant(?:Varias)?\s*(?:<[^(]*>)?\s*\(/g;
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

const archivos = execSync(
  'git ls-files "src/**/*.ts" "src/**/*.tsx"',
  { encoding: "utf8" }
)
  .split("\n")
  .filter(Boolean)
  .filter((f) => !f.startsWith("src/data/"));

const crudas = [];
for (const f of archivos) {
  const s = readFileSync(f, "utf8");
  const tramos = tramosDeLaCapa(s);
  // El \s* del medio no es adorno: las consultas largas se escriben con
  // `await db` y el `.select(` en la línea siguiente, y sin eso la regla
  // dejaba pasar justo las más grandes.
  const re = /(?:^|[^.\w])(db)\s*\.\s*(select|insert|update|delete|\$count|execute)\b/g;
  let m;
  while ((m = re.exec(s))) {
    const pos = m.index;
    if (tramos.some(([a, b]) => pos > a && pos < b)) continue;
    // Qué tabla toca, para poder separar las de inquilino de las globales.
    const cerca = s.slice(pos, pos + 400);
    const t =
      /\.(?:from|into)\(\s*([\w.]+)/.exec(cerca) ||
      /\b(?:insert|update|delete|\$count)\(\s*([\w.]+)/.exec(cerca);
    crudas.push({
      f,
      linea: s.slice(0, pos).split("\n").length,
      op: m[2],
      tabla: t ? t[1].replace(/^tables\./, "") : "?",
    });
  }
}

for (const c of crudas) console.log(`${c.f}:${c.linea}	${c.tabla}	db.${c.op}`);
console.log(`\n${crudas.length} consulta(s) fuera de la capa de datos`);
