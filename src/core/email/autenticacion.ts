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
  const deGmail = resultados[0] ?? "";
  if (/^\s*mx\.google\.com\s*;/.test(deGmail) && /;\s*dmarc=pass\b/.test(deGmail)) return false;

  const spfFallo = /\bspf=(fail|softfail)\b/.test(valor);
  const dkimFallo = /\bdkim=fail\b/.test(valor) && !/\bdkim=pass\b/.test(valor);
  return spfFallo || dkimFallo;
}
