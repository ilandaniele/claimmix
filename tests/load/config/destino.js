/**
 * A dónde se le puede pegar la prueba de las aseguradoras, y a dónde nunca.
 *
 * Son setecientos usuarios con cuenta propia: contra producción no mide nada y
 * le tira encima la carga a quien la esté usando. Por eso acá NO hay llave de
 * escape: `PERMITIR_REMOTO` abre los perfiles de `base.js` y éste no la mira.
 *
 * Sin globales de k6 y sin `__ENV`: lo importan el escenario y el test de
 * vitest, así que la regla vive en un solo lugar y se puede probar.
 */

/** Los hosts de producción. Se vetan aunque alguien les agregue un `-qa` por delante o por detrás. */
const HOSTS_DE_PRD = ["claimmix.vercel.app", "claimmix-prd.vercel.app"];

/**
 * El host de una URL, en minúsculas y sin punto final. "" si no se lee.
 *
 * A mano y no con `URL`: k6 no la trae en todas las versiones. Una URL con
 * `usuario@` en la autoridad no es el sitio que dice ser —`https://claimmix-qa.x.com@claimmix.vercel.app`
 * va a producción— y se trata como ilegible.
 */
export function hostDe(url) {
  const m = /^https?:\/\/([^/?#]*)/i.exec(String(url ?? "").trim());
  if (!m || m[1].includes("@")) return "";
  return m[1].replace(/:\d*$/, "").toLowerCase().replace(/\.+$/, "");
}

/**
 * Por qué NO se puede correr contra esta URL, o `null` si se puede.
 *
 * Pasa localhost, 127.0.0.1 y un host cuya primera etiqueta lleva `-qa` o
 * `-dev` como palabra entera (`claimmix-qa`, `claimmix-qa-git-rama`; no
 * `claimmix-qatar`). Todo lo demás se rechaza, y `-prd` / `-prod` también aunque
 * venga con un `-dev` al lado.
 *
 * @param {string} baseUrl
 * @param {string[]} [prohibidos]  Hosts o URLs extra que nunca (el `PRD_URL` de quien corre).
 * @returns {string | null}
 */
export function motivoDeRechazo(baseUrl, prohibidos = []) {
  const host = hostDe(baseUrl);
  if (!host) return `la URL "${baseUrl}" no se lee (falta http:// o lleva usuario@)`;

  const extra = prohibidos.map((p) => (String(p).includes("://") ? hostDe(p) : String(p).toLowerCase()));
  const vetados = [...HOSTS_DE_PRD, ...extra].filter(Boolean);
  if (vetados.includes(host)) return `${host} es producción`;

  if (host === "localhost" || host === "127.0.0.1") return null;

  const etiqueta = host.split(".")[0];
  if (/-(prd|prod)($|[^a-z0-9])/.test(etiqueta)) return `${host} parece de producción`;
  if (/-(qa|dev)($|[^a-z0-9])/.test(etiqueta)) return null;
  return `${host} no es localhost ni un host -qa / -dev`;
}

/** Corta la corrida ANTES de que k6 levante un solo VU: se llama al cargar el módulo. */
export function exigirDestinoDePrueba(nombre, baseUrl, prohibidos = []) {
  const motivo = motivoDeRechazo(baseUrl, prohibidos);
  if (motivo === null) return;
  throw new Error(
    `El escenario "${nombre}" no corre contra ${baseUrl}: ${motivo}.\n` +
      `  Son cuentas propias de prueba y mucha carga: sólo localhost, 127.0.0.1 o un host\n` +
      `  con -qa / -dev. No hay forma de saltearlo; para otra cosa, otro escenario.`
  );
}
