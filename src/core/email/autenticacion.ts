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
 * Verdadero con un `spf=fail`, `spf=softfail` o `dkim=fail` (sin un
 * `dkim=pass` al lado) en `Authentication-Results`. Sin cabecera, o con
 * none/neutral/temperror, no falló: el simulado y WhatsApp no la traen.
 * WhatsApp guarda `{}` en vez de una lista: tampoco falló.
 *
 * El formulario web es el otro caso, y el opuesto: no hay servidor de correo
 * que diga nada, y la dirección es lo que alguien escribió en un campo. Su
 * ingreso deja `X-ClaimMix-Origen: web` y eso alcanza para que la memoria del
 * remitente no se herede ni se escriba a nombre de esa dirección.
 */
export function autenticacionFallida(headers: unknown): boolean {
  if (!Array.isArray(headers)) return false;
  const valor = (headers as readonly Cabecera[])
    .filter((h) => (h.name ?? "").toLowerCase() === "authentication-results")
    .map((h) => (h.value ?? "").toLowerCase())
    .join(" ");

  const delFormularioWeb = (headers as readonly Cabecera[]).some(
    (h) =>
      (h.name ?? "").toLowerCase() === ORIGEN_WEB.name.toLowerCase() &&
      (h.value ?? "").toLowerCase() === ORIGEN_WEB.value
  );
  if (delFormularioWeb) return true;

  const spfFallo = /\bspf=(fail|softfail)\b/.test(valor);
  const dkimFallo = /\bdkim=fail\b/.test(valor) && !/\bdkim=pass\b/.test(valor);
  return spfFallo || dkimFallo;
}
