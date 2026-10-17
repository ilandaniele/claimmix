/**
 * ¿Aprende el agente de lo que el equipo confirma en la conversación?
 *
 * Es la bandera `AGENTE_APRENDIDO_EN_CONVERSACION`, apagada por omisión: sin ella
 * las indicaciones del equipo no llegan a deliberate ni a compose. Vive sola y
 * sin imports a propósito, igual que `numeroAutomatico`: la leen varios pasos del
 * agente y sus tests no tienen que mockear `server-only` ni la base.
 */
export function aprendidoEnConversacion(): boolean {
  return process.env.AGENTE_APRENDIDO_EN_CONVERSACION === "1";
}
