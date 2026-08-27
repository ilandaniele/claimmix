/**
 * `pnpm arquitectura` — que la arquitectura no se degrade sola.
 *
 * Una arquitectura escrita en un documento se degrada en seis meses; una
 * comprobada en cada `pnpm check`, no. Esto es lo segundo.
 *
 * Comprueba seis invariantes, en orden de importancia:
 *
 *   1. `src/core/` no toca infraestructura. Recibe datos y devuelve decisiones;
 *      si importa la base, la red o el entorno, deja de poder probarse sin
 *      montar media aplicación — que es el problema que la capa vino a resolver.
 *   2. Ninguna consulta queda fuera de la capa de datos sin decir por qué. Las
 *      que se quedan afuera existen y son legítimas —el limitador de tráfico
 *      cuenta por IP antes de saber quién llama, las de login averiguan de qué
 *      inquilino es la sesión— pero cada una lleva su motivo escrito al lado.
 *      Una consulta suelta sin explicación devuelve los datos de todos los
 *      inquilinos y no da ningún error.
 *   3. Los filtros por inquilino escritos a mano no crecen. No se exige cero
 *      todavía —quedan los que piden criterio— pero sí que el número baje o se
 *      quede igual. Un tope que sube solo no es un tope.
 *   4. La capa de datos no cae al rol viejo. `src/data/` no puede leer
 *      `DATABASE_URL`: sus consultas no llevan filtro por inquilino, y el rol
 *      viejo saltea RLS, así que usarlo devolvería los datos de todos.
 *
 * Sale distinto de cero si alguna se viola. No mira estilo ni formato: sólo
 * cosas que, de romperse, no se notan hasta que es tarde.
 */
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const TOPE_FILTROS = 14;

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

/**
 * El archivo sin sus comentarios ni sus cadenas.
 *
 * Un archivo del núcleo puede —y suele— nombrar `process.env` en un comentario
 * que explica por qué NO lo lee. Buscar sobre el texto crudo convierte esa
 * explicación en una infracción, y entonces la manera de que el chequeo pase es
 * borrar el comentario: se pierde el porqué y se conserva el chequeo, que es
 * exactamente al revés de lo que conviene.
 */
function sinComentarios(s) {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"' || c === "'" || c === "`") {
      const q = c;
      out += c;
      for (i++; i < s.length && s[i] !== q; i++) {
        if (s[i] === "\\") i++;
      }
      out += q;
    } else if (c === "/" && s[i + 1] === "/") {
      while (i < s.length && s[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && s[i + 1] === "*") {
      const fin = s.indexOf("*/", i + 2);
      i = fin === -1 ? s.length : fin + 1;
    } else {
      out += c;
    }
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
    const s = sinComentarios(readFileSync(f, "utf8"));
    const encontrados = PROHIBIDO.filter((p) => s.includes(p));
    if (encontrados.length) {
      mal(`${f} importa ${encontrados.join(", ")}`);
      sucios++;
    }
  }
  if (sucios === 0) bien(`${core.length} archivo(s), ninguno toca infraestructura`);
}

// ── 2. Ninguna consulta suelta sin explicación ─────────────────────────────
console.log("\n▸ Consultas fuera de la capa de datos");
{
  let salida = "";
  let codigo = 0;
  try {
    salida = execFileSync("node", ["scripts/find-raw-db.mjs"], { encoding: "utf8" });
  } catch (e) {
    salida = (e.stdout ?? "") + (e.stderr ?? "");
    codigo = e.status ?? 1;
  }
  const lineas = salida.split(/\r?\n/);
  const sueltas = lineas.filter((l) => /\tdb\.\w/.test(l)).map((l) => l.split("\t")[0]);
  // Dos fallas distintas, con dos arreglos distintos. Reportarlas juntas daba
  // el consejo equivocado: "0 consultas sin declarar" seguido de las
  // instrucciones para declarar una.
  const anticipadas = lineas
    .filter((l) => /adentro del armador/.test(l))
    .map((l) => l.split("\t")[0]);

  if (sueltas.length > 0) {
    mal(`${sueltas.length} consulta(s) sin declarar`);
    for (const s of sueltas.slice(0, 10)) console.log(`     ${s}`);
    if (sueltas.length > 10) console.log(`     …y ${sueltas.length - 10} más`);
    console.log("     O va por enTenant(ctx, (db) => …), o lleva arriba un");
    console.log("     comentario `// sin-inquilino: <por qué>` que lo justifique.");
  }

  if (anticipadas.length > 0) {
    mal(`${anticipadas.length} consulta(s) resueltas antes de tiempo`);
    for (const s of anticipadas.slice(0, 10)) console.log(`     ${s}`);
    console.log("     Un .catch/.then adentro del armador resuelve la cadena, y");
    console.log("     drizzle tira `query._prepare is not a function`. Va afuera:");
    console.log("     enTenant(ctx, (db) => db.select()...).catch(() => [])");
  }

  if (sueltas.length === 0 && anticipadas.length === 0) {
    if (codigo !== 0) {
      mal("find-raw-db.mjs falló sin decir por qué");
      console.log(lineas.slice(-6).join("\n"));
    } else {
      const m = /(\d+) declarada/.exec(salida);
      bien(`todas por la capa, salvo ${m ? m[1] : "0"} declaradas con su motivo`);
    }
  }
}

// ── 3. Los filtros a mano no crecen ────────────────────────────────────────
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

// ── 4. La capa de datos no cae al rol viejo ────────────────────────────────
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

// ── 5. El agente no elige a quién le escribe ───────────────────────────────
//
// El destinatario de todo mensaje saliente sale del remitente del propio caso
// —`senderEmail`, `senderPhone`— y nunca del texto que devuelve el modelo. Esa
// es la razón por la que una inyección de instrucciones no puede convertirse en
// una fuga: aunque alguien logre que el agente diga algo que no debía, se lo
// dice a la misma persona que escribió.
//
// El día que un `to:` salga de un campo del plan, esa propiedad se pierde en
// silencio: el código compila, los tests pasan, y el agente le contesta a quien
// el atacante haya puesto en el cuerpo de un WhatsApp.
console.log("\n▸ El destinatario no sale del modelo");
{
  const FUENTES_OK = /^(opts\.|input\.|caso\.|row\.)?(sender(Email|Phone)|to|from|fromAddr|from_addr|toAddr|to_addr|email|phone|destinatario)$/i;
  const sospechosos = [];
  for (const f of archivos("src/server")) {
    const s = sinComentarios(readFileSync(f, "utf8"));
    const re = /\bto:\s*([^,\n]+)/g;
    let m;
    while ((m = re.exec(s))) {
      const valor = m[1].trim().replace(/,$/, "");
      // Sólo interesan los `to:` que arman un mensaje, no los de un objeto
      // cualquiera. Se mira que cerca haya un envío.
      const cerca = s.slice(Math.max(0, m.index - 400), m.index + 200);
      if (!/messenger\.send|dispatchOutbound|sendWhatsApp/.test(cerca)) continue;
      if (FUENTES_OK.test(valor)) continue;
      // Un campo que sale del plan del modelo: `plan.x`, `decision.x`, `claim.x`.
      if (/\b(plan|decision|decisión|respuesta|reply|extracted|claim|fields)\b/i.test(valor)) {
        sospechosos.push(`${f}: to: ${valor}`);
      }
    }
  }
  if (sospechosos.length === 0) {
    bien("todo `to:` sale del remitente del caso, no del plan del modelo");
  } else {
    mal(`${sospechosos.length} destinatario(s) que podrían salir del modelo`);
    for (const x of sospechosos) console.log(`     ${x}`);
    console.log("     Una inyección de instrucciones se vuelve una fuga si el");
    console.log("     agente puede elegir a quién le escribe.");
  }
}

// ── 6. Los jobs de CI conocen los dos roles ────────────────────────────────
//
// Desde que existe la capa de datos hay DOS credenciales, y un job que reciba
// sólo `DATABASE_URL` puede correr media tarea antes de romper: lo que va por
// el rol dueño anda, y lo que pasa por `enTenant` tira "falta DATABASE_URL_APP".
//
// El síntoma engaña. En el pen test se leyó como **"la pared entre inquilinos
// falló"** —porque la prueba de la pared pasa por `listCases`— cuando lo que
// faltaba era una variable de entorno. Un rojo que apunta al lugar equivocado
// cuesta más que uno que no aparece.
//
// Pasó dos veces el mismo día: primero en `ci.yml` y después en
// `post-deploy.yml`, porque agregar la variable en un archivo no la agrega en
// el otro.
console.log("\n▸ Los jobs de CI conocen los dos roles");
{
  const flujos = existsSync(".github/workflows")
    ? readdirSync(".github/workflows").filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
    : [];
  const cojos = [];
  for (const nombre of flujos) {
    const lineas = readFileSync(join(".github/workflows", nombre), "utf8").split(/\r?\n/);

    /*
     * Se mira BLOQUE por bloque, no el total del archivo.
     *
     * La primera versión contaba cuántos `DATABASE_URL:` y cuántos
     * `DATABASE_URL_APP:` había en todo el archivo y los comparaba. Daba verde
     * con una variable faltante, porque hay un job —`permisos`— que lleva el
     * rol de la app y NO lleva el del dueño: ese sobrante compensaba el que
     * faltaba en otro lado y la cuenta cerraba.
     *
     * Ahora, por cada `DATABASE_URL:` se busca su compañero entre las líneas de
     * la misma sangría, que es lo que delimita un bloque `env:` en YAML.
     */
    for (let i = 0; i < lineas.length; i++) {
      const m = /^(\s+)DATABASE_URL:/.exec(lineas[i]);
      if (!m) continue;
      const sangria = m[1];
      let tieneApp = false;
      // Hacia abajo y hacia arriba mientras siga el mismo bloque.
      for (const paso of [1, -1]) {
        for (let k = i + paso; k >= 0 && k < lineas.length; k += paso) {
          const l = lineas[k];
          if (l.trim() === "") continue;
          const propia = /^(\s*)/.exec(l)[1];
          if (propia.length !== sangria.length) break;
          if (l.trim().startsWith("DATABASE_URL_APP:")) tieneApp = true;
        }
      }
      if (!tieneApp) cojos.push(`${nombre}:${i + 1} — DATABASE_URL sin DATABASE_URL_APP al lado`);
    }
  }
  if (flujos.length === 0) {
    console.log("     (no hay workflows: nada que comprobar)");
  } else if (cojos.length === 0) {
    bien(`${flujos.length} workflow(s), todos los jobs con base reciben los dos roles`);
  } else {
    mal(`${cojos.length} workflow(s) con jobs que sólo conocen el rol dueño`);
    for (const c of cojos) console.log(`     ${c}`);
    console.log("     Al lado de cada `DATABASE_URL:` va `DATABASE_URL_APP:`.");
  }
}

// ── Nada que la capa no pueda armar ─────────────────────────
//
// `db.$count(tabla, where)` no devuelve una consulta: devuelve un objeto que
// se puede esperar. La capa manda todo por `batch()` para pegarle adelante el
// contexto del inquilino, y para eso necesita ARMAR la consulta.
//
// Estuvo roto en produccion: los contadores de la bandeja, el listado de
// clientes, el de polizas y la pantalla de metricas, todos con
// `TypeError: query._prepare is not a function`. La capa ahora lo rechaza en
// caliente con un mensaje claro, pero eso avisa cuando alguien abre la
// pantalla; esto avisa antes de desplegar.
console.log("\n▸ nadie usa db.$count (la capa no lo puede armar)");
{
  const conCount = [];
  for (const ruta of archivos("src")) {
    const txt = sinComentarios(readFileSync(ruta, "utf8"));
    if (txt.includes(".$count(")) conCount.push(ruta);
  }
  if (conCount.length === 0) {
    bien("ningun archivo lo usa");
  } else {
    mal(`${conCount.length} archivo(s) usan db.$count`);
    for (const c of conCount) console.log(`     ${c}`);
    console.log("     Va countRows(ctx, tabla, where), de @/lib/db/helpers.");
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
