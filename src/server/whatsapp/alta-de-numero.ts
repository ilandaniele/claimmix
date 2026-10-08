/**
 * Sumar un número a la WABA de la plataforma, paso por paso, hablando con Graph:
 * agregarlo, pedir el código, verificarlo y registrarlo.
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
import { logger } from "@/lib/observability/logger";
import { urlDeGraph } from "@/server/whatsapp/cloud-api";
import { idDeLaPlataforma } from "@/server/whatsapp/numeros";
import { ID_DE_GRAPH, PLAZO_GRAPH_MS } from "@/server/whatsapp/verificar-en-meta";

export type FallaDeGraph = "esperar" | "meta" | "rechazo";

export type RespuestaDeAlta<T> = { ok: true; valor: T } | { ok: false; falla: FallaDeGraph; codigo: number | null };

export type MetodoDeCodigo = "SMS" | "VOICE";

export interface CredencialDeAlta {
  accessToken: string;
  wabaId: string;
}

/** Un móvil argentino como lo pide Graph: el código de país y el resto, con el 9 adelante. */
export interface PartesDelNumero {
  cc: "54";
  numero: string;
}

/**
 * El id que se guarda: lo mismo que exige la 0049. `ID_DE_GRAPH` es más ancho porque
 * sólo cuida la URL; quien guarda el id de `agregarNumero` pasa también por acá.
 */
export const ID_GUARDABLE = /^\d{6,20}$/;

/** Cómo le pide Meta el idioma del SMS o de la llamada a cada idioma de la cuenta. */
const IDIOMA_DEL_CODIGO = { "es-AR": "es", "en-US": "en" } as const satisfies Record<Locale, string>;

/** Meta pide aflojar con estos códigos, venga el status que venga. */
const CODIGOS_DE_ESPERA = new Set([4, 80007, 130429, 133016]);

const MOVIL_ARGENTINO = /^\+54(9\d{10})$/;
const CODIGO_DE_SEIS = /^\d{6}$/;

/** Sólo móviles argentinos: `+549` y diez dígitos más. Cualquier otra cosa, null. */
export function partirNumero(e164: string): PartesDelNumero | null {
  const m = MOVIL_ARGENTINO.exec(e164);
  return m ? { cc: "54", numero: m[1] } : null;
}

/** Qué hacer con lo que Meta contestó, venga o no con un `code`. `status` es null si ni hubo respuesta. */
export function clasificar(status: number | null, codigo: number | null): FallaDeGraph {
  if (status === 429 || (codigo !== null && CODIGOS_DE_ESPERA.has(codigo))) return "esperar";
  if (status === null || status >= 500) return "meta";
  return status >= 400 ? "rechazo" : "meta";
}

type Paso = "agregar" | "pedir_codigo" | "verificar" | "estado_codigo" | "estado_registro" | "registrar";

/** El pedido que ni salió: un id con forma rara, o el de la plataforma. No es culpa de Meta. */
const SIN_PEDIDO: RespuestaDeAlta<never> = { ok: false, falla: "rechazo", codigo: null };

function falla(paso: Paso, status: number | null, codigo: number | null): RespuestaDeAlta<never> {
  logger.warn({ paso, status, codigo }, "whatsapp.alta_numero.graph");
  return { ok: false, falla: clasificar(status, codigo), codigo };
}

/** Un 2xx que no trae lo esperado: se anota y no se interpreta. */
const respuestaRara = (paso: Paso) => falla(paso, 200, null);

function codigoDeError(cuerpo: unknown): number | null {
  const codigo = (cuerpo as { error?: { code?: unknown } } | null)?.error?.code;
  return typeof codigo === "number" ? codigo : null;
}

/** Con `cuerpo` es un POST; sin él, un GET. El token va en la cabecera y en ningún otro lado. */
async function llamar(
  paso: Paso,
  ruta: string,
  accessToken: string,
  cuerpo?: Record<string, unknown>
): Promise<RespuestaDeAlta<Record<string, unknown>>> {
  let res: Response;
  try {
    res = await fetch(urlDeGraph(ruta), {
      method: cuerpo ? "POST" : "GET",
      headers: cuerpo
        ? { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" }
        : { Authorization: `Bearer ${accessToken}` },
      body: cuerpo ? JSON.stringify(cuerpo) : undefined,
      signal: AbortSignal.timeout(PLAZO_GRAPH_MS),
    });
  } catch {
    return falla(paso, null, null);
  }
  const json: unknown = await res.json().catch(() => null);
  if (!res.ok) return falla(paso, res.status, codigoDeError(json));
  if (typeof json !== "object" || json === null || Array.isArray(json)) return respuestaRara(paso);
  return { ok: true, valor: json as Record<string, unknown> };
}

/** Un POST que Meta confirma con `success: true`. */
async function confirmada(paso: Paso, ruta: string, accessToken: string, cuerpo: Record<string, unknown>): Promise<RespuestaDeAlta<true>> {
  const r = await llamar(paso, ruta, accessToken, cuerpo);
  if (!r.ok) return r;
  return r.valor.success === true ? { ok: true, valor: true } : respuestaRara(paso);
}

/** Un id que va en la URL: sólo dígitos, y nunca el del número de la plataforma. */
function idDeNumeroValido(id: string): boolean {
  return ID_DE_GRAPH.test(id) && id !== idDeLaPlataforma();
}

/**
 * Suma el número a la WABA, sin verificar ni registrar. Devuelve el id que Graph le dio:
 * sólo dígitos, pero quien lo guarda tiene que pasarlo por `ID_GUARDABLE`.
 * `nombre` es el nombre verificado de la plataforma, nunca algo que tipeó un cliente.
 */
export async function agregarNumero(cred: CredencialDeAlta, partes: PartesDelNumero, nombre: string): Promise<RespuestaDeAlta<string>> {
  if (!ID_DE_GRAPH.test(cred.wabaId) || !nombre.trim()) return SIN_PEDIDO;
  const r = await llamar("agregar", `${cred.wabaId}/phone_numbers`, cred.accessToken, {
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
  return confirmada("pedir_codigo", `${phoneNumberId}/request_code`, cred.accessToken, {
    code_method: metodo,
    language: IDIOMA_DEL_CODIGO[idioma],
  });
}

/** Le entrega a Meta el código de seis dígitos que le llegó al número. */
export async function verificarCodigoEnMeta(cred: CredencialDeAlta, phoneNumberId: string, codigo: string): Promise<RespuestaDeAlta<true>> {
  if (!idDeNumeroValido(phoneNumberId) || !CODIGO_DE_SEIS.test(codigo)) return SIN_PEDIDO;
  return confirmada("verificar", `${phoneNumberId}/verify_code`, cred.accessToken, { code: codigo });
}

/** ¿Meta ya tiene verificado el código del número? Para cuando `verify_code` rechaza un código que ya se aceptó. */
export async function codigoYaVerificado(cred: CredencialDeAlta, phoneNumberId: string): Promise<RespuestaDeAlta<boolean>> {
  if (!idDeNumeroValido(phoneNumberId)) return SIN_PEDIDO;
  const r = await llamar("estado_codigo", `${phoneNumberId}?fields=code_verification_status`, cred.accessToken);
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
  const r = await llamar("estado_registro", `${phoneNumberId}?fields=status,platform_type`, cred.accessToken);
  if (!r.ok) return r;
  const { status, platform_type: plataforma } = r.valor;
  if (typeof status !== "string" && typeof plataforma !== "string") return respuestaRara("estado_registro");
  return { ok: true, valor: plataforma === "CLOUD_API" || status === "CONNECTED" };
}

/**
 * Registra el número en Cloud API con un PIN de seis dígitos al azar. El PIN no se
 * devuelve, no se guarda y no se anota: se cambia después con el mismo token.
 */
export async function registrarNumero(cred: CredencialDeAlta, phoneNumberId: string): Promise<RespuestaDeAlta<true>> {
  if (!idDeNumeroValido(phoneNumberId)) return SIN_PEDIDO;
  const pin = String(randomInt(0, 1_000_000)).padStart(6, "0");
  return confirmada("registrar", `${phoneNumberId}/register`, cred.accessToken, { messaging_product: "whatsapp", pin });
}
