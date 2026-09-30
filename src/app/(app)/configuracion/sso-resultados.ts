/**
 * Cómo le cuenta /configuracion al admin lo que pasó con el SSO.
 *
 * Las acciones del panel terminan en una redirección a `/configuracion?sso=<resultado>`
 * y la página pinta el texto de ese resultado. El panel no lleva JavaScript de
 * cliente (el presupuesto de `pnpm peso` no da para un componente más): el
 * formulario manda, el servidor contesta y la página se vuelve a armar.
 *
 * El resultado es un nombre de una lista cerrada, nunca un texto: lo que vuelve
 * en la URL no puede meter nada en la pantalla.
 */

export const RESULTADOS_SSO = [
  "guardado",
  "verificado",
  "activado",
  "apagado",
  "exigido",
  "exigidoSinCerrar",
  "noExigido",
  "probado",
  "pruebaFallo",
  "idpIssuer",
  "idpRespuesta",
  "dominioInvalido",
  "dominioPublico",
  "datosInvalidos",
  "dominioEnUso",
  "ssoIncompleto",
  "ssoSinPrueba",
  "dnsSinRegistro",
  "dnsSinRespuesta",
  "dnsNoCoincide",
  "limite",
  "migracion",
  "fallo",
] as const;

export type ResultadoSso = (typeof RESULTADOS_SSO)[number];

const EXITOS = new Set<ResultadoSso>([
  "guardado",
  "verificado",
  "activado",
  "apagado",
  "exigido",
  "noExigido",
  "probado",
]);

export function esResultadoSso(valor: unknown): valor is ResultadoSso {
  return typeof valor === "string" && (RESULTADOS_SSO as readonly string[]).includes(valor);
}

/** Lo que salió bien. «exigidoSinCerrar» no: hay algo que el admin tiene que hacer. */
export function esExito(resultado: ResultadoSso): boolean {
  return EXITOS.has(resultado);
}

/** El `motivo` que manda /api/admin/sso, y el resultado que le toca. */
const POR_MOTIVO = new Map<string, ResultadoSso>([
  ["issuer_invalido", "idpIssuer"],
  ["issuer_no_coincide", "idpIssuer"],
  ["endpoint_rechazado", "idpIssuer"],
  ["sin_respuesta", "idpRespuesta"],
  ["documento_ilegible", "idpRespuesta"],
  ["dominio_invalido", "dominioInvalido"],
  ["dominio_publico", "dominioPublico"],
  ["dominio_en_uso", "dominioEnUso"],
  ["sso_incompleto", "ssoIncompleto"],
  ["sso_sin_prueba", "ssoSinPrueba"],
]);

const POR_CODIGO = new Map<string, ResultadoSso>([
  ["RATE_LIMITED", "limite"],
  ["MIGRACION_PENDIENTE", "migracion"],
]);

type Rechazo = { error?: { code?: unknown; details?: { motivo?: unknown } } } | null;

/** De la respuesta de error de la API al resultado que se muestra. */
export function resultadoDeRechazo(cuerpo: unknown): ResultadoSso {
  const error = (cuerpo as Rechazo)?.error;
  const codigo = typeof error?.code === "string" ? error.code : "";
  const motivo = typeof error?.details?.motivo === "string" ? error.details.motivo : "";
  return (
    POR_CODIGO.get(codigo) ??
    POR_MOTIVO.get(motivo) ??
    // Cualquier otro campo del formulario que no pasó el esquema: client_id, secreto, cuerpo.
    (motivo.endsWith("_invalido") ? "datosInvalidos" : "fallo")
  );
}

/** El resultado de «Verificar dominio»: lo que dijo el DNS, no un error de la API. */
export function resultadoDeLaVerificacion(cuerpo: unknown): ResultadoSso {
  const { verificado, motivo } = (cuerpo ?? {}) as { verificado?: unknown; motivo?: unknown };
  if (verificado === true) return "verificado";
  if (motivo === "sin_registro") return "dnsSinRegistro";
  if (motivo === "sin_respuesta") return "dnsSinRespuesta";
  if (motivo === "no_coincide") return "dnsNoCoincide";
  return "fallo";
}
