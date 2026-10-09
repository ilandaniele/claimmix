/**
 * Qué hosts son de ClaimMix y a cuáles no se les ataca ni se les escribe.
 *
 * Una sola lista para los workflows, los guiones y los tests. ESM puro y sin
 * dependencias: la importan .mjs y .mts, y los workflows la llaman por CLI:
 *
 *   node scripts/lib/hosts-vetados.mjs --veto <url>       sale 1 si está vetado
 *   node scripts/lib/hosts-vetados.mjs --conocido <url>   sale 0 si es de ClaimMix
 *
 * Se compara el HOSTNAME normalizado y no el texto de la URL: una barra final,
 * una mayúscula o un punto al final del host (`claimmix.vercel.app.`) son el
 * mismo sitio y antes se colaban por el `===` contra un literal.
 */
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Los tres alias con datos reales, más el host de `PRD_URL` si hay. Si la URL no
 * se lee, también cuenta como vetada.
 */
export const HOSTS_WEB = new Set(
  ["claimmix.vercel.app", "claimmix-dev.vercel.app", "claimmix-prd.vercel.app", hostDePrd()].filter(Boolean),
);

// QA es de ClaimMix pero no está vetado: ahí sí se ataca y se escribe.
const HOST_QA = "claimmix-qa.vercel.app";

/**
 * Endpoint de la base de control de claimmix-prd (proyecto Neon `claimmix-prd`).
 * Mientras sea `null`, los scripts de bases se niegan a correr contra prd: se
 * completa al crear el proyecto, con el prefijo del host sin el sufijo ni
 * `-pooler`.
 */
export const HOST_DE_BASE_PRD = "ep-sweet-salad";

/**
 * Endpoints de Neon con datos reales. Se busca como subcadena del host: el real
 * lleva un sufijo (`-acbz9jqu`) y a veces `-pooler`.
 */
export const HOSTS_DE_BASE_REALES = new Set(["ep-proud-resonance", HOST_DE_BASE_PRD].filter(Boolean));

// Dev (la base viva) y QA: ningún script de bases de prd ni del ensayo los toca.
const HOSTS_DE_OTROS_AMBIENTES = ["ep-proud-resonance", "ep-wispy-flower"];

// Si alguna está en el entorno, su endpoint también cuenta como de otro ambiente: staging no tiene host fijo en el repo.
const VARIABLES_DE_OTROS_AMBIENTES = [
  "STAGING_DATABASE_URL",
  "STAGING_DATABASE_URL_APP",
  "QA_DATABASE_URL",
  "QA_DATABASE_URL_APP",
];

/**
 * Host en minúsculas y sin punto final. "" si la URL no se lee o no es una URL
 * con esquema.
 *
 * @param {string} url
 * @returns {string}
 */
export function hostNormalizado(url) {
  try {
    return new URL(String(url ?? "").trim()).hostname.toLowerCase().replace(/\.+$/, "");
  } catch {
    return "";
  }
}

function hostDePrd() {
  return process.env.PRD_URL ? hostNormalizado(process.env.PRD_URL) : "";
}

// Se vuelve a leer al preguntar: los guiones cargan .env.local después de sus
// `import`, y para entonces `HOSTS_WEB` ya se armó sin `PRD_URL`.
function hostsWeb() {
  const propio = hostDePrd();
  return propio ? new Set([...HOSTS_WEB, propio]) : HOSTS_WEB;
}

/**
 * ¿Atacar o escribir contra esta URL tocaría datos reales? Si no se lee, sí:
 * ante la duda se trata como producción.
 *
 * @param {string} url
 * @returns {boolean}
 */
export function vetadoWeb(url) {
  const host = hostNormalizado(url);
  return host === "" || hostsWeb().has(host);
}

/**
 * ¿Es un host de ClaimMix (los vetados más QA)? Sin credenciales ni puerto: esas
 * URLs no son el origen que dicen ser. La ruta la rechazan los workflows antes.
 *
 * @param {string} url
 * @returns {boolean}
 */
export function conocido(url) {
  try {
    const u = new URL(String(url ?? "").trim());
    if (u.protocol !== "https:" || u.username || u.password || u.port) return false;
  } catch {
    return false;
  }
  const host = hostNormalizado(url);
  return host === HOST_QA || hostsWeb().has(host);
}

/**
 * ¿La cadena de Postgres apunta a una base con datos reales? Mira el host y el
 * `?host=` que el driver de Neon prefiere, nunca la contraseña. Una cadena que
 * no se lee se busca entera: así sirve también con un host suelto.
 *
 * @param {string | undefined} cadena
 * @returns {boolean}
 */
export function vetadoBase(cadena) {
  const texto = String(cadena ?? "").trim().toLowerCase();
  let hosts = texto;
  try {
    const u = new URL(texto.replace(/^postgres(ql)?:/, "https:"));
    hosts = [u.host, u.searchParams.get("host") ?? ""].join(" ");
  } catch {
    // Se queda con el texto entero.
  }
  return [...HOSTS_DE_BASE_REALES].some((h) => hosts.includes(h));
}

// El host y el `?host=` de una cadena, en minúsculas. "" si no se lee.
function hostsDe(cadena) {
  try {
    const u = new URL(String(cadena ?? "").trim().toLowerCase().replace(/^postgres(ql)?:/, "https:"));
    return [u.host, u.searchParams.get("host") ?? ""].join(" ").trim();
  } catch {
    return "";
  }
}

// El endpoint de Neon: la primera etiqueta del host, sin `-pooler`.
function endpointDe(cadena) {
  return hostsDe(cadena).split(" ")[0].split(".")[0].replace(/-pooler$/, "");
}

/**
 * Por qué un script de bases NO puede correr contra esta cadena, o `null` si puede.
 *
 * - `ensayo`: la rama `ensayo` del proyecto `claimmix-prd`. Rechaza todo lo que sea de datos reales,
 *   QA o staging.
 * - `prd`: la base de control de `claimmix-prd`. Exige su endpoint (`HOST_DE_BASE_PRD`)
 *   y rechaza los de otros ambientes. No usa `vetadoBase`: ese veta justamente prd.
 *
 * Nunca devuelve la cadena ni su contraseña: el motivo se imprime tal cual.
 *
 * @param {"prd" | "ensayo" | string} ambiente
 * @param {string | undefined} cadena
 * @param {Record<string, string | undefined>} [entorno]
 * @returns {string | null}
 */
export function motivoDeVetoDeBases(ambiente, cadena, entorno = process.env) {
  const hosts = hostsDe(cadena);
  if (hosts === "") return "la cadena de conexión no se lee";

  const ajenos = VARIABLES_DE_OTROS_AMBIENTES.map((n) => endpointDe(entorno[n])).filter(Boolean);
  if (HOSTS_DE_OTROS_AMBIENTES.some((h) => hosts.includes(h)) || ajenos.includes(endpointDe(cadena))) {
    return "es la base de otro ambiente (dev, QA o staging)";
  }

  if (ambiente === "ensayo") return vetadoBase(cadena) ? "es una base con datos reales" : null;
  if (ambiente !== "prd") return `ambiente desconocido: ${ambiente}`;
  if (!HOST_DE_BASE_PRD) return "falta el endpoint de prd (HOST_DE_BASE_PRD en scripts/lib/hosts-vetados.mjs)";
  return hosts.includes(HOST_DE_BASE_PRD) ? null : "no es el endpoint de claimmix-prd";
}

const [, archivo, modo, destino] = process.argv;
if (archivo && import.meta.url === pathToFileURL(resolve(archivo)).href) {
  if ((modo === "--veto" || modo === "--conocido") && destino) {
    const sale = modo === "--veto" ? vetadoWeb(destino) : !conocido(destino);
    process.exitCode = sale ? 1 : 0;
  } else {
    console.error("Uso: node scripts/lib/hosts-vetados.mjs --veto|--conocido <url>");
    process.exitCode = 2;
  }
}
