/**
 * El texto de la plantilla de Meta para reabrir un pedido después de las 24 h.
 *
 * Fuera de la ventana de servicio, Meta sólo deja mandar una plantilla
 * aprobada — texto libre lo rechaza. Esta es la única plantilla que el código
 * usa hoy, y vive separada de `cloud-api.ts` porque es pura: nada de
 * `process.env`, nada de red, sólo el cuerpo exacto que aprobó Meta.
 */

export const PLANTILLA_REABRIR = { nombre: "reabrir_denuncia", idioma: "es_AR" } as const;

export const CUERPO_REABRIR =
  "Hola. Te escribimos por tu denuncia con número de referencia {{1}}. Para poder seguir, todavía necesitamos: {{2}}. Podés responder a este mensaje; las fotos o archivos mandalos por este mismo chat.";

export function textoDeReabrir(p: readonly [string, string]): string {
  return CUERPO_REABRIR.replace("{{1}}", () => p[0]).replace("{{2}}", () => p[1]);
}
