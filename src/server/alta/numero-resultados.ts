/**
 * Cómo le cuenta /configuracion al admin lo que pasó con su número de WhatsApp.
 *
 * Las acciones del panel terminan en una redirección a `/configuracion?wa=<resultado>`
 * y la página pinta el texto de ese resultado, igual que con el SSO
 * (`sso-resultados.ts`). El resultado es un nombre de una lista cerrada, nunca
 * un texto ni un mensaje de Graph: lo que vuelve en la URL no puede meter nada
 * en la pantalla.
 *
 * Sin imports a propósito: la usan la página y las acciones sin arrastrar nada.
 */

export const RESULTADOS_DEL_NUMERO = [
  "codigo_enviado",
  "conectado",
  "codigo_invalido",
  "codigo_incorrecto",
  "pedi_primero",
  "esperar",
  "meta",
  "revision",
] as const;

export type ResultadoDelNumero = (typeof RESULTADOS_DEL_NUMERO)[number];

export function esResultadoDelNumero(valor: unknown): valor is ResultadoDelNumero {
  return typeof valor === "string" && (RESULTADOS_DEL_NUMERO as readonly string[]).includes(valor);
}

/** Lo que salió bien: el código salió, o el número quedó conectado. Todo lo demás pide algo o avisa. */
export function esExitoDelNumero(resultado: ResultadoDelNumero): boolean {
  return resultado === "codigo_enviado" || resultado === "conectado";
}
