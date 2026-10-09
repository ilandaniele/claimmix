/**
 * Cómo le cuenta /configuracion al admin lo que pasó al conectar su Gmail.
 *
 * El callback de `/api/admin/gmail-accounts/callback` (y la guarda de `connect`)
 * terminan en una redirección a `/configuracion?gmail=<resultado>`. El resultado
 * es un nombre de una lista cerrada, nunca un texto: lo que vuelve en la URL no
 * puede meter nada en la pantalla. Uno que no esté en la lista no pinta nada.
 *
 * Sin imports a propósito: la usan la página y sus tests sin arrastrar nada.
 */

export const RESULTADOS_GMAIL = [
  "connected",
  "missing_code",
  "invalid_state",
  "missing_google_config",
  "missing_refresh_token",
  "missing_email",
  "otro_ambiente",
  "mailbox_taken",
  "save_failed",
  "connect_failed",
] as const;

export type ResultadoGmail = (typeof RESULTADOS_GMAIL)[number];

export function esResultadoGmail(valor: unknown): valor is ResultadoGmail {
  return typeof valor === "string" && (RESULTADOS_GMAIL as readonly string[]).includes(valor);
}

/** Lo único que salió bien. Todo lo demás dice cómo seguir. */
export function esExitoDeGmail(resultado: ResultadoGmail): boolean {
  return resultado === "connected";
}
