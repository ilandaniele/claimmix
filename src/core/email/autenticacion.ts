/**
 * ¿El remitente de un mensaje pasó SPF/DKIM?
 *
 * El poller de Gmail ya persiste todas las cabeceras (`claim_messages.headers`),
 * incluida `Authentication-Results`, pero nada la leía: la memoria del
 * remitente (E17) se heredaba por dirección aunque el servidor de correo
 * dijera que esa dirección era falsa.
 *
 * Puro: entra la lista de cabeceras, sale un booleano. `pnpm arquitectura`
 * exige que `src/core` no importe infraestructura.
 */

import { bareAddress } from "@/lib/email/reserved";

export interface Cabecera {
  name?: string | null;
  value?: string | null;
}

/** La cabecera con la que el ingreso del formulario web marca lo que guarda. */
export const ORIGEN_WEB = { name: "X-ClaimMix-Origen", value: "web" } as const;

/**
 * ¿El servidor de correo dijo que el remitente NO es quien dice ser?
 *
 * Verdadero con un `spf=fail`, `spf=softfail`, `dmarc=fail` o `dkim=fail`
 * (sin un `dkim=pass` al lado) en `Authentication-Results`. Sin cabecera, o con
 * none/neutral/temperror, no falló: el simulado y WhatsApp no la traen.
 * WhatsApp guarda `{}` en vez de una lista: tampoco falló.
 *
 * Un `dmarc=pass` de Gmail gana sobre un softfail del sobre o una firma rota:
 * el From ya se autenticó con SPF o DKIM alineados, que es lo que pasa con el
 * correo reenviado. Sólo cuenta en la cabecera de más arriba, la que agrega
 * `mx.google.com` al recibir; las de abajo las pudo escribir el remitente.
 *
 * El formulario web es el otro caso, y el opuesto: no hay servidor de correo
 * que diga nada, y la dirección es lo que alguien escribió en un campo. Su
 * ingreso deja `X-ClaimMix-Origen: web` y eso alcanza para que la memoria del
 * remitente no se herede ni se escriba a nombre de esa dirección.
 */
export function autenticacionFallida(headers: unknown): boolean {
  if (!Array.isArray(headers)) return false;
  const resultados = (headers as readonly Cabecera[])
    .filter((h) => (h.name ?? "").toLowerCase() === "authentication-results")
    .map((h) => (h.value ?? "").toLowerCase());
  const valor = resultados.join(" ");

  const delFormularioWeb = (headers as readonly Cabecera[]).some(
    (h) =>
      (h.name ?? "").toLowerCase() === ORIGEN_WEB.name.toLowerCase() &&
      (h.value ?? "").toLowerCase() === ORIGEN_WEB.value
  );
  if (delFormularioWeb) return true;

  // DMARC es el único veredicto alineado con el From, que es lo que se hereda.
  if (/\bdmarc=fail\b/.test(valor)) return true;
  if (veredictosDeGmail(resultados[0] ?? "")?.some(esDmarc("pass"))) return false;

  const spfFallo = /\bspf=(fail|softfail)\b/.test(valor);
  const dkimFallo = /\bdkim=fail\b/.test(valor) && !/\bdkim=pass\b/.test(valor);
  return spfFallo || dkimFallo;
}

const DE_GMAIL = /^\s*mx\.google\.com\s*;/;
const VEREDICTO = /^\s*([a-z0-9-]+)=([a-z]+)([\s\S]*)$/;
const PROPIEDAD = /\b(smtp\.mailfrom|header\.d|header\.i|header\.from)=((?:"(?:[^"\\]|\\.)*"|[^\s";])+)/g;
const ENTERO_CITADO = /^"((?:[^"\\]|\\.)*)"$/;
const PROPIEDADES_POR_METODO: Record<string, readonly string[]> = {
  spf: ["smtp.mailfrom"],
  dkim: ["header.d", "header.i"],
  dmarc: ["header.from"],
};

/**
 * Parte la cabecera en veredictos por los `;` que no están entre comillas ni
 * entre paréntesis, y saca los comentarios (ahí Gmail anota el ARC y el SPF del
 * salto anterior). Lo de adentro de unas comillas es de quien escribió el
 * mensaje —el sobre, la firma— y puede traer un `;` o un `dmarc=pass`: no
 * separa veredictos. Si queda una comilla o un paréntesis sin cerrar no se
 * sabe dónde empieza el veredicto que sigue, y devuelve null.
 */
function partirVeredictos(valor: string): string[] | null {
  const partes: string[] = [];
  let actual = "";
  let anidados = 0;
  let citado = false;
  for (let i = 0; i < valor.length; i++) {
    const c = valor.charAt(i);
    if (c === "\\" && (citado || anidados > 0)) {
      if (citado) actual += c + valor.charAt(i + 1);
      i++;
    } else if (anidados > 0) {
      anidados += c === "(" ? 1 : c === ")" ? -1 : 0;
    } else if (citado) {
      actual += c;
      citado = c !== '"';
    } else if (c === '"') {
      actual += c;
      citado = true;
    } else if (c === "(") {
      actual += " ";
      anidados = 1;
    } else if (c === ";") {
      partes.push(actual);
      actual = "";
    } else {
      actual += c;
    }
  }
  if (citado || anidados > 0) return null;
  return [...partes, actual];
}

/** Los veredictos de la cabecera que escribió `mx.google.com`, o null si no es de Gmail o no se pudo leer. */
function veredictosDeGmail(valor: string): string[] | null {
  return DE_GMAIL.test(valor) ? (partirVeredictos(valor)?.slice(1) ?? null) : null;
}

function esDmarc(esperado: "pass" | "fail") {
  return (veredicto: string): boolean => {
    const [, metodo, resultado] = VEREDICTO.exec(veredicto) ?? [];
    return metodo === "dmarc" && resultado === esperado;
  };
}

/** `ana@example.com`, `"Ana" <ana@example.com>`, `@example.com` o `example.com` → `example.com`. */
function dominioDe(direccion: string): string {
  const pelada = bareAddress(direccion);
  return pelada.slice(pelada.lastIndexOf("@") + 1);
}

/** El valor de un `smtp.mailfrom` o un `header.*`, sin las comillas que lo envuelven entero (Gmail las pone si trae un `=`). */
function sinComillasEnvolventes(valor: string): string {
  const adentro = ENTERO_CITADO.exec(valor)?.[1];
  return adentro === undefined ? valor : adentro.replace(/\\(.)/g, "$1");
}

function alineado(dominio: string, delFrom: string): boolean {
  return delFrom !== "" && (dominio === delFrom || dominio.endsWith(`.${delFrom}`));
}

/**
 * ¿El From del mensaje es de quien lo mandó? Es la llave con la que un mail se
 * pega a un caso ajeno y hereda la memoria de una dirección.
 *
 * Por `email` hace falta una prueba a favor, no la ausencia de una en contra:
 * sin cabecera de Gmail, o con una que no alinea con el From, es falso. Alinea
 * un `spf=pass` cuyo `smtp.mailfrom` sea el dominio del From o un subdominio
 * suyo, un `dkim=pass` con `header.d`/`header.i` igual, o un `dmarc=pass` cuyo
 * `header.from` sea ese dominio, salvo que Gmail también anote un `dmarc=fail`.
 * El `dmarc=pass` también se alinea: Gmail evalúa el dominio de la dirección que
 * lee en el From, y `bareAddress` lee la misma: ignora los comentarios y los
 * nombres entre comillas, donde cabe un `<...>` que no es el remitente. Mira
 * sólo la `Authentication-Results` de más arriba, y sólo si es de
 * `mx.google.com`: las de abajo las pudo escribir el remitente.
 *
 * Los otros canales no pasan por un servidor de correo que opine (el simulado,
 * WhatsApp) o ya cargan su propia marca (el formulario web, `ORIGEN_WEB`):
 * valen lo que `autenticacionFallida`, o sea verdadero salvo falla explícita.
 */
export function remitenteVerificado(headers: unknown, fromAddr: string, channel: string): boolean {
  if (channel !== "email") return !autenticacionFallida(headers);
  if (!Array.isArray(headers)) return false;

  const primera = (headers as readonly Cabecera[]).find(
    (h) => (h.name ?? "").toLowerCase() === "authentication-results"
  );
  const valor = (primera?.value ?? "").toLowerCase();
  const veredictos = veredictosDeGmail(valor);
  if (!veredictos || veredictos.some(esDmarc("fail"))) return false;

  const delFrom = fromAddr.includes("@") ? dominioDe(fromAddr) : "";
  for (const veredicto of veredictos) {
    const [, metodo = "", resultado = "", resto = ""] = VEREDICTO.exec(veredicto) ?? [];
    if (resultado !== "pass") continue;
    const propiedades = PROPIEDADES_POR_METODO[metodo];
    if (!propiedades) continue;
    for (const [, nombre = "", dominio = ""] of resto.matchAll(PROPIEDAD)) {
      if (propiedades.includes(nombre) && alineado(dominioDe(sinComillasEnvolventes(dominio)), delFrom)) return true;
    }
  }
  return false;
}
