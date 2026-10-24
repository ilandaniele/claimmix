/**
 * Sumar un número a la WABA de la plataforma, paso por paso, hablando con Graph:
 * agregarlo, pedir el código, verificarlo, registrarlo y ponerle su webhook propio.
 *
 * Es sólo el cliente de Graph. No decide nada (qué espacio puede, cuánto cupo le
 * queda y qué se guarda lo resuelve `numero-automatico.ts`), no toca la base y no
 * lee el .env: el token y la WABA los pasa quien llama, que los saca de
 * `numeros.ts`. Todo lo que devuelve es un `RespuestaDeAlta`:
 *
 *   - `esperar`: Meta pidió aflojar; reintentar más tarde sirve;
 *   - `meta`: Meta no contestó o contestó algo que no se entiende; no se interpreta;
 *   - `rechazo`: Meta dijo que no (o el pedido ni salió, por un id con forma rara).
 *
 * Lo que Graph dice no sale crudo: de un error queda el `code` numérico y nada
 * más. Ni el token, ni el PIN, ni el código de seis dígitos, ni el número, ni el
 * cuerpo de la respuesta se anotan.
 *
 * Nada de acá toca el número de la plataforma ni borra números de la WABA: las
 * funciones que reciben un id lo rechazan si es el de `idDeLaPlataforma()`, y no
 * hay ninguna que llame a deregister.
 */

import "server-only";
import { randomInt } from "node:crypto";
import type { Locale } from "@/lib/i18n";
import { E164 } from "@/server/alta/validar";
import { clienteDeGraph, SIN_PEDIDO, type Pedido, type RespuestaDeAlta } from "@/server/whatsapp/graph";
import { idDeLaPlataforma, type WebhookDelEntorno } from "@/server/whatsapp/numeros";
import { ID_DE_GRAPH } from "@/server/whatsapp/verificar-en-meta";

export { clasificar, type FallaDeGraph, type RespuestaDeAlta } from "@/server/whatsapp/graph";

export type MetodoDeCodigo = "SMS" | "VOICE";

export interface CredencialDeAlta {
  accessToken: string;
  wabaId: string;
  /** El `appsecret_proof` del token: sólo con la app propia de un cliente. Con Embedded Signup y con la plataforma no se manda. */
  prueba?: string;
}

/** Un número como lo pide Graph: el código de país y el resto, tal cual (sin sacarle ningún 0: en Italia es parte del número). */
export interface PartesDelNumero {
  cc: string;
  numero: string;
}

/** Cómo le pide Meta el idioma del SMS o de la llamada a cada idioma de la cuenta. */
const IDIOMA_DEL_CODIGO = { "es-AR": "es", "en-US": "en" } as const satisfies Record<Locale, string>;

/** El código de verificación del número y el PIN de registro: seis dígitos, ni más ni menos. */
export const CODIGO_DE_SEIS = /^\d{6}$/;

/**
 * Los códigos de país de la UIT. Se asignan sin prefijos (ninguno empieza como otro): a lo sumo uno coincide.
 * Sin los no geográficos (+800, +870, +881…): no reciben el código de Meta y van a revisión antes de gastar cupos.
 */
export const CODIGOS_DE_PAIS: ReadonlySet<string> = new Set(
  `
  1 7
  20 211 212 213 216 218 220 221 222 223 224 225 226 227 228 229 230 231 232 233 234 235 236 237 238 239 240 241 242 243 244 245 246 247 248 249 250 251 252 253 254 255 256 257 258 260 261 262 263 264 265 266 267 268 269 27 290 291 297 298 299
  30 31 32 33 34 350 351 352 353 354 355 356 357 358 359 36 370 371 372 373 374 375 376 377 378 379 380 381 382 383 385 386 387 389 39
  40 41 420 421 423 43 44 45 46 47 48 49
  500 501 502 503 504 505 506 507 508 509 51 52 53 54 55 56 57 58 590 591 592 593 594 595 596 597 598 599
  60 61 62 63 64 65 66 670 672 673 674 675 676 677 678 679 680 681 682 683 685 686 687 688 689 690 691 692
  81 82 84 850 852 853 855 856 86 880 886
  90 91 92 93 94 95 960 961 962 963 964 965 966 967 968 970 971 972 973 974 975 976 977 98 992 993 994 995 996 998
  `
    .trim()
    .split(/\s+/)
);

/** El código de país de un E.164, o null si no tiene forma de número o el código no está en la tabla. */
export function codigoDePais(e164: string): string | null {
  if (!E164.test(e164)) return null;
  return [1, 2, 3].map((n) => e164.slice(1, 1 + n)).find((cc) => CODIGOS_DE_PAIS.has(cc)) ?? null;
}

/**
 * Un E.164 con un código de país de la tabla; un +54 sólo si es celular (`+549` y diez dígitos más).
 * Si no, null. El largo fino lo valida Meta.
 */
export function partirNumero(e164: string): PartesDelNumero | null {
  const cc = codigoDePais(e164);
  if (!cc) return null;
  const numero = e164.slice(1 + cc.length);
  // Sin el 9 Meta registra un fijo, y `mismoNumero` y el índice de 0048 dan +549 y +54 por el mismo número.
  return cc !== "54" || /^9\d{10}$/.test(numero) ? { cc, numero } : null;
}

type Paso =
  | "agregar"
  | "pedir_codigo"
  | "verificar"
  | "estado_codigo"
  | "estado_registro"
  | "registrar"
  | "fijar_webhook"
  | "leer_webhook";

const { respuestaRara, pedirObjeto, confirmada: confirmar } = clienteDeGraph<Paso>("whatsapp.alta_numero.graph");

type Credencial = Pick<CredencialDeAlta, "accessToken" | "prueba">;

/** Con `cuerpo` es un POST; sin él, un GET. El token va en la cabecera y en ningún otro lado; la prueba, en el cuerpo del POST y en la consulta del GET. */
const pedido = ({ accessToken, prueba }: Credencial, cuerpo?: Record<string, unknown>): Pedido => ({
  autorizacion: `Bearer ${accessToken}`,
  json: cuerpo,
  prueba,
});

const llamar = (paso: Paso, ruta: string, cred: Credencial, cuerpo?: Record<string, unknown>) =>
  pedirObjeto(paso, ruta, pedido(cred, cuerpo));

/** Un POST que Meta confirma con `success: true`. */
const confirmada = (paso: Paso, ruta: string, cred: Credencial, cuerpo: Record<string, unknown>) =>
  confirmar(paso, ruta, pedido(cred, cuerpo));

/** Un id que va en la URL: sólo dígitos, y nunca el del número de la plataforma. */
function idDeNumeroValido(id: string): boolean {
  return ID_DE_GRAPH.test(id) && id !== idDeLaPlataforma();
}

/**
 * Suma el número a la WABA, sin verificar ni registrar. Devuelve el id que Graph le dio:
 * sólo dígitos, pero quien lo guarda tiene que pasarlo por `ID_DE_META` (`@/lib/meta-ids`, lo que exige la 0049; `ID_DE_GRAPH` es más ancho porque sólo cuida la URL).
 * `nombre` es el nombre verificado de la plataforma, nunca algo que tipeó un cliente.
 */
export async function agregarNumero(cred: CredencialDeAlta, partes: PartesDelNumero, nombre: string): Promise<RespuestaDeAlta<string>> {
  if (!ID_DE_GRAPH.test(cred.wabaId) || !nombre.trim()) return SIN_PEDIDO;
  const r = await llamar("agregar", `${cred.wabaId}/phone_numbers`, cred, {
    cc: partes.cc,
    phone_number: partes.numero,
    verified_name: nombre,
  });
  if (!r.ok) return r;
  const id = r.valor.id;
  return typeof id === "string" && ID_DE_GRAPH.test(id) ? { ok: true, valor: id } : respuestaRara("agregar");
}

/** Le pide a Meta que mande el código por SMS o por llamada. */
export async function pedirCodigoAMeta(
  cred: CredencialDeAlta,
  phoneNumberId: string,
  metodo: MetodoDeCodigo,
  idioma: Locale
): Promise<RespuestaDeAlta<true>> {
  if (!idDeNumeroValido(phoneNumberId)) return SIN_PEDIDO;
  return confirmada("pedir_codigo", `${phoneNumberId}/request_code`, cred, {
    code_method: metodo,
    language: IDIOMA_DEL_CODIGO[idioma],
  });
}

/** Le entrega a Meta el código de seis dígitos que le llegó al número. */
export async function verificarCodigoEnMeta(cred: CredencialDeAlta, phoneNumberId: string, codigo: string): Promise<RespuestaDeAlta<true>> {
  if (!idDeNumeroValido(phoneNumberId) || !CODIGO_DE_SEIS.test(codigo)) return SIN_PEDIDO;
  return confirmada("verificar", `${phoneNumberId}/verify_code`, cred, { code: codigo });
}

/** ¿Meta ya tiene verificado el código del número? Para cuando `verify_code` rechaza un código que ya se aceptó. */
export async function codigoYaVerificado(cred: CredencialDeAlta, phoneNumberId: string): Promise<RespuestaDeAlta<boolean>> {
  if (!idDeNumeroValido(phoneNumberId)) return SIN_PEDIDO;
  const r = await llamar("estado_codigo", `${phoneNumberId}?fields=code_verification_status`, cred);
  if (!r.ok) return r;
  const estado = r.valor.code_verification_status;
  return typeof estado === "string" ? { ok: true, valor: estado === "VERIFIED" } : respuestaRara("estado_codigo");
}

/**
 * ¿El número ya está registrado en Cloud API? `register` pone un PIN nuevo cada vez y
 * Meta rechaza un segundo con otro PIN, así que no se vuelve a llamar si ya está.
 */
export async function numeroYaRegistrado(cred: CredencialDeAlta, phoneNumberId: string): Promise<RespuestaDeAlta<boolean>> {
  if (!idDeNumeroValido(phoneNumberId)) return SIN_PEDIDO;
  const r = await llamar("estado_registro", `${phoneNumberId}?fields=status,platform_type`, cred);
  if (!r.ok) return r;
  const { status, platform_type: plataforma } = r.valor;
  if (typeof status !== "string" && typeof plataforma !== "string") return respuestaRara("estado_registro");
  return { ok: true, valor: plataforma === "CLOUD_API" || status === "CONNECTED" };
}

/**
 * Registra el número en Cloud API. Sin `pin`, con uno de seis dígitos al azar que no se
 * devuelve, no se guarda y no se anota: el número queda con un PIN que nadie conoce, y
 * este módulo no tiene cómo cambiarlo (si hace falta, se cambia en WhatsApp Manager).
 * Con `pin`, el que quien llama ya guardó, para volver a registrar un número que ya
 * tenía el suyo (el segundo factor de WhatsApp lo exige idéntico). Nunca se anota.
 */
export async function registrarNumero(cred: CredencialDeAlta, phoneNumberId: string, pin?: string): Promise<RespuestaDeAlta<true>> {
  if (!idDeNumeroValido(phoneNumberId)) return SIN_PEDIDO;
  if (pin !== undefined && !CODIGO_DE_SEIS.test(pin)) return SIN_PEDIDO;
  const elegido = pin ?? String(randomInt(0, 1_000_000)).padStart(6, "0");
  return confirmada("registrar", `${phoneNumberId}/register`, cred, { messaging_product: "whatsapp", pin: elegido });
}

/**
 * Le pone al número su propio webhook. Sin él lo que le escriben cae en el de la WABA,
 * que con dos ambientes en la misma app de Meta puede ser el del otro. El token del
 * apretón de manos viaja en el cuerpo y no se anota.
 */
export async function fijarWebhookDelNumero(
  cred: CredencialDeAlta,
  phoneNumberId: string,
  webhook: WebhookDelEntorno
): Promise<RespuestaDeAlta<true>> {
  if (!idDeNumeroValido(phoneNumberId)) return SIN_PEDIDO;
  return confirmada("fijar_webhook", phoneNumberId, cred, {
    webhook_configuration: { override_callback_uri: webhook.url, verify_token: webhook.verifyToken },
  });
}

/** Los webhooks propios del número que Graph devuelve: `phone_number` y `override_callback_uri`, los que son texto. */
function webhooksDelNumero(conf: unknown): string[] {
  if (typeof conf !== "object" || conf === null || Array.isArray(conf)) return [];
  const { phone_number: propio, override_callback_uri: puesto } = conf as Record<string, unknown>;
  return [propio, puesto].filter((visto): visto is string => typeof visto === "string");
}

const esLaUrl = (visto: string, url: string) => visto === url || visto === `${url}/`;

/**
 * ¿El webhook propio del número es `url`? Cuenta lo que Graph devuelve, no lo que se
 * mandó: la `application` y la de la WABA no valen, porque son las que se quiere evitar.
 */
export async function webhookPropioEs(cred: CredencialDeAlta, phoneNumberId: string, url: string): Promise<RespuestaDeAlta<boolean>> {
  if (!idDeNumeroValido(phoneNumberId)) return SIN_PEDIDO;
  const r = await llamar("leer_webhook", `${phoneNumberId}?fields=webhook_configuration`, cred);
  if (!r.ok) return r;
  return { ok: true, valor: webhooksDelNumero(r.valor.webhook_configuration).some((visto) => esLaUrl(visto, url)) };
}

/**
 * ¿El número tiene un webhook propio que no es `url`, el de otro ambiente? Sin override,
 * o con el nuestro, no: el número cae en el de la app y no hay nada ajeno que pisar.
 */
export async function webhookAjenoEs(cred: CredencialDeAlta, phoneNumberId: string, url: string): Promise<RespuestaDeAlta<boolean>> {
  if (!idDeNumeroValido(phoneNumberId)) return SIN_PEDIDO;
  const r = await llamar("leer_webhook", `${phoneNumberId}?fields=webhook_configuration`, cred);
  if (!r.ok) return r;
  const propios = webhooksDelNumero(r.valor.webhook_configuration);
  return { ok: true, valor: propios.length > 0 && !propios.some((visto) => esLaUrl(visto, url)) };
}
