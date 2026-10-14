/**
 * Qué le pasa a la cuenta de un cliente según el código que Graph devolvió al enviar.
 *
 * El envío ya distingue «esperar», «meta» y «rechazo»; esto separa los rechazos
 * que no son del mensaje sino de la cuenta y que alguien tiene que arreglar: el
 * token que dejó de valer, el pago que falta, la WABA restringida o bloqueada.
 */

export type EfectoDeError = "token_vencido" | "pago_pendiente" | "waba_restringida" | "waba_bloqueada";

/** `OAuthException`: el token venció, se revocó o la persona cambió la contraseña. Es el código con que Graph dice «este token ya no sirve». */
export const TOKEN_INVALIDO = 190;
/** La WABA no tiene un medio de pago válido y Meta frena el envío. */
const PAGO_PENDIENTE = 131042;
/** Meta restringió la WABA por una política (368). */
const WABA_RESTRINGIDA = 368;
/**
 * «Cuenta bloqueada» (131031). Una causa es el PIN de verificación en dos pasos equivocado al
 * registrar, así que por sí solo no dice que la WABA esté bloqueada: ver `motivoDeAlta`.
 */
const CUENTA_BLOQUEADA = 131031;

/**
 * ¿Graph dice que este token ya no sirve para esta WABA? Muerto (190), o vivo pero sin ella:
 * si el cliente sacó la app o el permiso de esa WABA, el token sigue valiendo para las demás
 * y `debug_token` sólo deja de listarla. `r` es la respuesta de `revisarToken`.
 */
export function sinLaWaba(
  r: { ok: true; valor: { wabaIds: string[] } } | { ok: false; codigo: number | null },
  wabaId: string
): boolean {
  return r.ok ? !r.valor.wabaIds.includes(wabaId) : r.codigo === TOKEN_INVALIDO;
}

export function efectoDeError(codigo: number | null): EfectoDeError | null {
  if (codigo === TOKEN_INVALIDO) return "token_vencido";
  if (codigo === PAGO_PENDIENTE) return "pago_pendiente";
  if (codigo === WABA_RESTRINGIDA) return "waba_restringida";
  if (codigo === CUENTA_BLOQUEADA) return "waba_bloqueada";
  return null;
}

/**
 * El paso del alta que falló, tal como le importa a la clasificación:
 * - `revisar`: `debug_token` sobre el token del cliente;
 * - `waba`: cualquier pedido sobre el id de la WABA (números, suscripción, plantillas, salud);
 * - `numero`: cualquier pedido sobre el id de un número (código, datos);
 * - `registrar`: `register` sin que el cliente haya dado todavía su PIN;
 * - `pin`: `register` con el PIN que el cliente escribió.
 */
export type PasoDeAlta = "revisar" | "waba" | "numero" | "registrar" | "pin";

/**
 * Lo que un rechazo de Graph quiere decir para el alta. Dos casos no se cierran con el código:
 * - `confirmar_salud`: 131031 fuera del registro. Es `waba_bloqueada` sólo si `leerSalud` sobre la WABA da `BLOCKED`;
 * - `confirmar_app`: un rechazo de autenticación sin subcódigo de token vencido. Se confirma con `leerApp`: si el
 *   app token también falla es `secreto_invalido`, si no `token_vencido`.
 */
export type MotivoDeAlta =
  | "token_vencido"
  | "falta_permiso"
  | "waba_no_asignada"
  | "waba_invalida"
  | "esperar"
  | "pago_pendiente"
  | "waba_restringida"
  | "falta_pin"
  | "pin_incorrecto"
  | "confirmar_salud"
  | "confirmar_app"
  | "meta";

/**
 * Cuota o límite de ritmo: se espera y se reintenta. Es el de `CODIGOS_DE_ESPERA` de `alta-de-numero.ts`
 * más 17 (límite por usuario) y los dos de espera del PIN.
 */
const CODIGOS_DE_ESPERA: ReadonlySet<number> = new Set([4, 17, 80007, 130429, 133016, 133008, 133009]);
/** El PIN de verificación en dos pasos no coincide. */
const PIN_NO_COINCIDE = 133005;
/** 463 y 467: el token venció o se invalidó. Con 190 y sin ellos el motivo puede ser el `appsecret_proof`. */
const SUBCODIGOS_DE_TOKEN_VENCIDO: ReadonlySet<number> = new Set([463, 467]);
/** Sesión inválida (102): el mismo tipo de rechazo que 190, sin subcódigo de token. */
const SESION_INVALIDA = 102;
const PERMISO_DENEGADO = 10;
const FALTA_CAPACIDAD = 3;
/** Parámetro inválido (100): un id que no existe, y también un `appsecret_proof` o un `input_token` que Graph no acepta. */
export const PARAMETRO_INVALIDO = 100;
const NO_ASIGNADA = 200;

const esPermiso = (codigo: number) => codigo === PERMISO_DENEGADO || codigo === FALTA_CAPACIDAD || (codigo >= 200 && codigo <= 299);

/**
 * Qué le pasó al alta según el paso y el código de Graph.
 * Fuentes: https://developers.facebook.com/docs/graph-api/guides/error-handling y
 * https://developers.facebook.com/documentation/business-messaging/whatsapp/support/error-codes
 */
export function motivoDeAlta(paso: PasoDeAlta, codigo: number | null, subcodigo?: number | null): MotivoDeAlta {
  if (codigo === null) return "meta";
  if (codigo === TOKEN_INVALIDO && subcodigo != null && SUBCODIGOS_DE_TOKEN_VENCIDO.has(subcodigo)) return "token_vencido";
  if (codigo === TOKEN_INVALIDO || codigo === SESION_INVALIDA) return "confirmar_app";
  if (paso === "revisar" && esPermiso(codigo)) return "falta_permiso";
  if (paso === "waba" && codigo === NO_ASIGNADA) return "waba_no_asignada";
  if (paso === "waba" && codigo === PARAMETRO_INVALIDO) return "waba_invalida";
  if (CODIGOS_DE_ESPERA.has(codigo)) return "esperar";
  if (codigo === PAGO_PENDIENTE) return "pago_pendiente";
  if (codigo === WABA_RESTRINGIDA) return "waba_restringida";
  if (codigo === PIN_NO_COINCIDE || (codigo === CUENTA_BLOQUEADA && (paso === "registrar" || paso === "pin"))) {
    return paso === "pin" ? "pin_incorrecto" : "falta_pin";
  }
  if (codigo === CUENTA_BLOQUEADA) return "confirmar_salud";
  return "meta";
}
