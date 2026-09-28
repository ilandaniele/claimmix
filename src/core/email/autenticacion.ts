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

/**
 * ¿El servidor de correo dijo que el remitente NO es quien dice ser?
 *
 * Verdadero sólo con un `spf=fail`, `spf=softfail` o `dkim=fail` (sin un
 * `dkim=pass` al lado) en `Authentication-Results`. Sin cabecera, o con
 * none/neutral/temperror, no falló: el simulado y WhatsApp no la traen.
 * WhatsApp guarda `{}` en vez de una lista: tampoco falló.
 */
export function autenticacionFallida(headers: unknown): boolean {
  if (!Array.isArray(headers)) return false;
  const valor = (headers as readonly Cabecera[])
    .filter((h) => (h.name ?? "").toLowerCase() === "authentication-results")
    .map((h) => (h.value ?? "").toLowerCase())
    .join(" ");

  const spfFallo = /\bspf=(fail|softfail)\b/.test(valor);
  const dkimFallo = /\bdkim=fail\b/.test(valor) && !/\bdkim=pass\b/.test(valor);
  return spfFallo || dkimFallo;
}
