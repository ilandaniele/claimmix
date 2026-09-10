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

/**
 * Cuántos filtros por inquilino escritos a mano se admiten.
 *
 * No es un límite de calidad: es un trinquete. Cada uno de estos vive en código
 * de sistema que es cross-tenant por diseño —los barridos, la salud, la
 * facturación, el alta de casillas— y ya se auditaron uno por uno. El tope
 * existe para que agregar el número once sea un acto deliberado y no un
 * descuido que nadie ve.
 *
 * El once es `retomarExtraccionesPendientes`: un barrido de sistema que recorre
 * los casos de todos los inquilinos y acepta acotarse a uno cuando lo llama el
 * `after()` de un webhook, que sí sabe de quién es el mensaje. Misma forma
 * exacta que `reapStuckProcessingCases`, que es el diez.
 */
const TOPE_FILTROS = 11;

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

/**
 * ¿Hay un `enTenant` adentro de otro?
 *
 * Esto era una expresión regular y no veía el estilo del repo. `[^)]*?` no
 * puede cruzar el `)` que cierra `(db)`, así que
 *
 *     enTenant(ctx, (db) => enTenant(ctx, (db) => …))   ← el que causó el bug
 *
 * no matcheaba, y el repo escribe `(db) =>` en los doscientos lugares. Tampoco
 * veía `async (db) =>`, ni un `enTenant` adentro de la lista de
 * `enTenantVarias`. Lo único que agarraba era `db =>` sin paréntesis, que acá
 * no lo usa nadie.
 *
 * O sea que imprimía «ninguno anidado» sin vigilar nada — la misma clase de
 * verde que el commit que la agregó vino a arreglar en otro lado.
 *
 * Ahora se emparejan los paréntesis: desde el `(` de la llamada hasta el que lo
 * cierra, y si adentro aparece otro `enTenant(`, está anidado. Es lo mismo que
 * hace `find-raw-db.mjs` para delimitar los tramos de la capa.
 */
function anidaEnTenant(txt) {
  const re = /\benTenant(?:Varias)?\s*(?:<[^(]*>)?\s*\(/g;
  let m;
  while ((m = re.exec(txt))) {
    const abre = txt.indexOf("(", m.index);
    let prof = 0;
    let i = abre;
    for (; i < txt.length; i++) {
      const c = txt[i];
      if (c === "(") prof++;
      else if (c === ")") {
        if (--prof === 0) break;
      }
    }
    // El cuerpo de la llamada, sin contar su propio nombre.
    const adentro = txt.slice(abre + 1, i);
    if (/\benTenant(?:Varias)?\s*(?:<[^(]*>)?\s*\(/.test(adentro)) return true;
  }
  return false;
}

// ── enTenant no se anida ────────────────────────────────────
//
// `enTenant(ctx, (db) => enTenant(ctx, (db) => ...))` compila: la firma de
// `armar` es `(db) => Promise<T>` y el enTenant de adentro devuelve
// exactamente eso. Pero en tiempo de ejecucion la capa lo rechaza —
// `exigirConsulta` tira si le llega una promesa en vez de una consulta — asi
// que el handler contesta 500 SIEMPRE.
//
// Estuvo asi en PATCH y DELETE de /api/admin/gmail-accounts: un admin no podia
// apagar ni borrar una casilla conectada, o sea no podia revocar el refresh
// token de una casilla comprometida. Y peor: la mutacion de adentro arrancaba
// sin que nadie la esperara, asi que a veces se aplicaba y la respuesta era 500
// igual.
//
// TypeScript no lo ve y ningun test lo cubria. Es un grep de una linea y cubre
// la clase entera.
console.log("\n▸ enTenant no se anida");
{
  const anidados = [];
  for (const ruta of archivos("src")) {
    const txt = sinComentarios(readFileSync(ruta, "utf8"));
    if (anidaEnTenant(txt)) anidados.push(ruta);
  }
  if (anidados.length === 0) {
    bien("ninguno anidado");
  } else {
    mal(`${anidados.length} archivo(s) anidan enTenant`);
    for (const c of anidados) console.log(`     ${c}`);
    console.log("     Uno solo alcanza: el de adentro devuelve una promesa y la capa la rechaza.");
  }
}

// ── 9. El inquilino no entra por el cuerpo del pedido ──────────────────────
//
// El webhook de WhatsApp aceptaba un `tenant_id` en el cuerpo y le ganaba a la
// configuración. Su credencial es `WHATSAPP_WEBHOOK_SECRET`: UNA sola, global, y
// que un adaptador BSP tiene por definición. O sea que quien la tuviera escribía
// una denuncia —con su teléfono y sus fotos— en la bandeja de cualquier
// aseguradora del sistema, incluida una que nunca habilitó WhatsApp. Ninguno de
// los llamadores lo mandaba: era una puerta abierta que nadie usaba.
//
// Las dos rutas que SÍ lo reciben son internas y las llama el propio deploy con
// `CRON_SECRET`. Ahí el cuerpo no puede alcanzar un inquilino que el llamador no
// controle ya, y el id hace falta porque no hay sesión de la que sacarlo.
//
// La regla, entonces, no es «nunca»: es que si el inquilino entra por el cuerpo,
// la ruta tiene que estar cerrada con `isInternalRequest`.
console.log("\n▸ El inquilino no entra por el cuerpo");
{
  const sospechosos = [];
  for (const f of archivos("src/app/api").filter((x) => x.endsWith("/route.ts"))) {
    const s = sinComentarios(readFileSync(f, "utf8"));
    if (!/\btenant_?[Ii]d:\s*z\./.test(s)) continue;
    if (/\bisInternalRequest\s*\(/.test(s)) continue;
    sospechosos.push(f);
  }
  if (sospechosos.length === 0) {
    bien("las rutas que reciben el inquilino en el cuerpo son internas");
  } else {
    mal(`${sospechosos.length} ruta(s) toman el inquilino del cuerpo sin ser internas`);
    for (const x of sospechosos) console.log(`     ${x}`);
    console.log("     El que llama elige en qué aseguradora escribe. Si la ruta no");
    console.log("     está cerrada con CRON_SECRET, el inquilino sale de la sesión");
    console.log("     o de la configuración, nunca del cuerpo.");
  }
}

// ── 10. Todo lo que se anota se puede filtrar ──────────────────────────────
//
// Había 198 líneas de `console.error("[modulo] algo pasó:", code)` contra 124
// de JSON estructurado. El 44 % de lo que el servidor anotaba no se podía
// filtrar por evento ni agrupar por caso: para saber por qué 115 personas se
// quedaron sin respuesta entre el 24 y el 28 de junio hubo que leer el código y
// adivinar, porque los 115 fallos tenían el mismo texto.
//
// Y el logger estructurado existía desde el principio, con su nivel, su reloj y
// su ruteo a stdout/stderr. No lo importaba NADIE: cero archivos.
//
// Ahora es el único camino. `console.*` en `src/` vuelve a partir el registro en
// dos formatos, que es como estaba.
console.log("\n▸ Nada anota por fuera del logger");
{
  const sueltos = [];
  for (const f of archivos("src", [".ts", ".tsx"])) {
    // El logger es el que llama a console, obviamente.
    if (f.endsWith("src/lib/observability/logger.ts")) continue;
    const s = sinComentarios(readFileSync(f, "utf8"));
    const re = /console\.(error|warn|info|log|debug)\s*\(/g;
    let m;
    while ((m = re.exec(s))) {
      sueltos.push(`${f}:${s.slice(0, m.index).split("\n").length}`);
    }
  }
  if (sueltos.length === 0) {
    bien("todo pasa por `logger`, con su evento y sus campos");
  } else {
    mal(`${sueltos.length} llamada(s) a console.* fuera del logger`);
    for (const x of sueltos.slice(0, 15)) console.log(`     ${x}`);
    if (sueltos.length > 15) console.log(`     … y ${sueltos.length - 15} más`);
    console.log("     `logger.error({ campos }, \"modulo.evento\")` — se filtra por");
    console.log("     evento y se agrupa por caso. Un texto libre, no.");
  }
}

// ── 11. Ningún carácter de control invisible en el código ─────────────────
//
// Un `\\b` y un retroceso literal (0x08) se ven IGUAL en un diff, en el
// editor y en GitHub. El segundo no matchea NUNCA, así que
// la expresión que lo lleva deja de mirar lo que decía mirar.
//
// Pasó tres veces en este repo, y las tres llegaron a `main`:
//
//   · `pen-test.mts` y `seguridad.spec.ts` (26/08): la sonda del motor de
//     flujos. El del e2e es una aserción NEGATIVA —`.not.toMatch()`— o sea un
//     test que no podía fallar.
//   · `check-architecture.mjs` (10/09): la invariante «el inquilino no entra
//     por el cuerpo» pasaba en verde sobre un archivo que la violaba.
//
// El origen es siempre el mismo: una herramienta que se come el `chr(92)` al
// escribir el archivo, y el resultado no se distingue al releer.
console.log("\n▸ Ningún carácter de control invisible");
{
  // Tab, salto y retorno son legítimos; el resto no tiene por qué estar.
  const PROHIBIDOS = [7, 8, 11, 12, 27];
  const sucios = [];
  for (const f of [
    ...archivos("src", [".ts", ".tsx"]),
    ...archivos("scripts", [".ts", ".mts", ".mjs", ".js"]),
    ...archivos("tests", [".ts", ".tsx"]),
  ]) {
    const s = readFileSync(f, "utf8");
    for (const codigo of PROHIBIDOS) {
      const i = s.indexOf(String.fromCharCode(codigo));
      if (i === -1) continue;
      sucios.push(`${f}:${s.slice(0, i).split("\n").length} — 0x${codigo.toString(16).padStart(2, "0")}`);
    }
  }
  if (sucios.length === 0) {
    bien("ninguno: una frontera de palabra se lee como lo que es");
  } else {
    mal(`${sucios.length} carácter(es) de control adentro del código`);
    for (const x of sucios) console.log(`     ${x}`);
    console.log("     Casi siempre es una frontera de palabra que perdió su barra al");
    console.log("     escribir el archivo. La expresión que lo lleva no matchea nada.");
  }
}

// ── 12. Un preview no hace cola con producción ────────────────────────────
//
// `post-deploy` corre contra la base de PRODUCCIÓN, así que se serializa con
// un grupo de concurrencia y `cancel-in-progress: false`. Eso está bien. Lo
// que no estaba bien era que el grupo fuera una constante.
//
// `deployment_status` llega también por cada preview y por cada estado
// intermedio. Esas corridas saltean todo —`smoke` tiene la guarda y las demás
// cuelgan de él— y terminan en `skipped`. Parecen gratis. Reservan el turno
// igual, y GitHub guarda UNA sola corrida esperando: la siguiente que llega
// cancela a la que estaba en la cola.
//
// Medido el 10/09 sobre las últimas 100 corridas: DIEZ commits de `main`
// quedaron con su post-deploy en `cancelled` y ninguno tuvo otra corrida que
// terminara. Un preview cualquiera echaba de la cola al merge.
//
// Y no deja rastro: `cancelled` no es rojo. Un CI verde no distingue «pasó»
// de «no llegó a correr», que es la peor forma de fallar que tiene una
// comprobación.
console.log("\n▸ Un preview no hace cola con producción");
{
  const flujos = existsSync(".github/workflows")
    ? readdirSync(".github/workflows").filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
    : [];
  const fijos = [];

  for (const nombre of flujos) {
    const texto = readFileSync(join(".github/workflows", nombre), "utf8");
    // Sólo los que reaccionan a un deploy reciben el evento de los previews.
    if (!/^\s+deployment_status:/m.test(texto)) continue;

    const lineas = texto.split(/\r?\n/);
    const i = lineas.findIndex((l) => l.trim() === "concurrency:" && !/^\s/.test(l));
    if (i === -1) continue;

    // El bloque son las líneas sangradas que siguen, salteando las vacías.
    let bloque = "";
    for (let j = i + 1; j < lineas.length; j++) {
      if (lineas[j].trim() === "") continue;
      if (!/^\s/.test(lineas[j])) break;
      bloque += lineas[j];
    }

    if (!bloque.includes("${{")) fijos.push(nombre);
  }

  if (fijos.length === 0) {
    bien("el grupo depende del evento: lo que saltea no espera ni echa a nadie");
  } else {
    mal(`${fijos.length} workflow(s) de deploy con grupo de concurrencia fijo`);
    for (const f of fijos) console.log(`     .github/workflows/${f}`);
    console.log("     Un preview que saltea todos sus jobs igual ocupa el turno, y");
    console.log("     desaloja de la cola al post-deploy del merge a main.");
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
