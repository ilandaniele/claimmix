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
 * Endpoints de Neon con datos reales. Se busca como subcadena del host: el real
 * lleva un sufijo (`-acbz9jqu`) y a veces `-pooler`.
 */
export const HOSTS_DE_BASE_REALES = new Set(["ep-proud-resonance"]);

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
