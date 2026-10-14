/**
 * Antes de conectar un número a un inquilino, preguntarle a Meta si es lo que
 * el operador dice que es.
 *
 * El operador copia a mano un `phone_number_id` y una WABA desde el panel de
 * Meta. Un dedo corrido y el número de otro cliente queda conectado a este
 * espacio: lo que le escribe uno aparece en la bandeja del otro. Por eso la
 * conexión no se arma con lo tipeado sino con lo que Graph contesta:
 *
 *   1. el id existe y su `display_phone_number` es el número que pidió el
 *      cliente (`mismoNumero`: «+549…» y «+54…» son el mismo);
 *   2. el id figura entre los números de la WABA indicada;
 *   3. y la WABA es la de WHATSAPP_BUSINESS_ACCOUNT_ID. Esta es la conexión del
 *      operador, que sigue siendo sobre la WABA de la plataforma; el cliente que
 *      trae la suya entra por el popup de Meta (`embedded-signup.ts`) y no pasa
 *      por acá.
 *
 * Usa el token de la plataforma (numeros.ts es el único que lee el .env). Una
 * respuesta rara de Graph no se interpreta: es `meta_no_responde` y no se conecta.
 */

import "server-only";
import { mismoNumero } from "@/server/alta/validar";
import { urlDeGraph } from "@/server/whatsapp/cloud-api";
import { armarFalla, errorDeGraph, PLAZO_GRAPH_MS, type Falla, type RespuestaDeAlta } from "@/server/whatsapp/graph";
import { credencialDelEntorno } from "@/server/whatsapp/numeros";

export type MotivoDeMeta =
  | "sin_credencial"
  | "waba_distinta"
  | "meta_no_responde"
  | "id_inexistente"
  | "numero_distinto"
  | "fuera_de_la_waba";

export type ResultadoDeMeta =
  | { ok: true; nombreVerificado: string | null }
  | { ok: false; motivo: MotivoDeMeta };

/** La WABA tiene decenas de números, no miles; el tope corta un `paging` que nunca termina. */
const PAGINAS_MAXIMAS = 10;

/** Solo ids de Graph: dígitos. Lo tipeado va en la URL y no puede traer `/`, `?` ni `..`. */
export const ID_DE_GRAPH = /^\d{5,30}$/;

/** `falla` lleva el `code` de Graph: quien necesita saber por qué no contestó lo clasifica con él. */
type RespuestaDeGraph = { ok: true; cuerpo: unknown } | { ok: false; inexistente: boolean; falla: Falla };

async function pedir(url: string, accessToken: string): Promise<RespuestaDeGraph> {
  let status: number | null = null;
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(PLAZO_GRAPH_MS),
    });
    status = res.status;
    if (!res.ok) {
      const { codigo, subcodigo } = errorDeGraph(await res.json().catch(() => null));
      // Un 4xx del id es "no existe o no es tuyo"; un 429 o 5xx es Meta, no el id.
      return { ok: false, inexistente: status >= 400 && status < 500 && status !== 429, falla: armarFalla(status, codigo, subcodigo) };
    }
    return { ok: true, cuerpo: await res.json() };
  } catch {
    return { ok: false, inexistente: false, falla: armarFalla(status, null) };
  }
}

function texto(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/** Una fila de `/phone_numbers`: lo que Graph no trajo, o no era un texto, queda en `null`. */
export interface FilaDeLaWaba {
  id: string | null;
  display: string | null;
  nombre: string | null;
}

/**
 * Los números de la WABA, página por página, con los campos que se pidan.
 *
 * Si Graph no contestó (una página que no es 2xx, la red caída o un `data` que
 * no es una lista) es la falla, con el `code` de Graph cuando lo dio, y
 * `recorrerLaWaba` la deja en `null`. `completa: false` si se cortó sin ver todo, porque
 * se agotaron las páginas o el `paging` anunció otra sin cursor para pedirla;
 * quien cuenta filas (el tope de la WABA) tiene que tratarlo como «no sé».
 * Si `parar` da true para una fila, se corta ahí y la lista llega hasta ella.
 * `prueba` es el `appsecret_proof` del token, sólo con la app propia de un cliente.
 */
export async function recorrerLaWabaOFalla(
  wabaId: string,
  campos: "id" | "id,display_phone_number" | "id,display_phone_number,verified_name",
  accessToken: string,
  parar?: (fila: FilaDeLaWaba) => boolean,
  prueba?: string
): Promise<RespuestaDeAlta<{ filas: FilaDeLaWaba[]; completa: boolean }>> {
  const filas: FilaDeLaWaba[] = [];
  let despues: string | null = null;
  for (let pagina = 0; pagina < PAGINAS_MAXIMAS; pagina++) {
    const sufijo: string = despues ? `&after=${encodeURIComponent(despues)}` : "";
    const r = await pedir(urlDeGraph(`${wabaId}/phone_numbers?fields=${campos}&limit=100${sufijo}`, prueba), accessToken);
    if (!r.ok) return r.falla;
    const cuerpo = r.cuerpo as {
      data?: Array<{ id?: unknown; display_phone_number?: unknown; verified_name?: unknown }>;
      paging?: { cursors?: { after?: unknown }; next?: unknown };
    };
    if (!Array.isArray(cuerpo.data)) return armarFalla(200, null);
    for (const n of cuerpo.data) {
      const fila = { id: texto(n?.id), display: texto(n?.display_phone_number), nombre: texto(n?.verified_name) };
      filas.push(fila);
      if (parar?.(fila)) return { ok: true, valor: { filas, completa: true } };
    }
    if (!cuerpo.paging?.next) return { ok: true, valor: { filas, completa: true } };
    despues = texto(cuerpo.paging.cursors?.after);
    if (!despues) return { ok: true, valor: { filas, completa: false } };
  }
  return { ok: true, valor: { filas, completa: false } };
}

/** Lo mismo sin la falla: `null` si Graph no contestó. */
export async function recorrerLaWaba(
  wabaId: string,
  campos: "id" | "id,display_phone_number" | "id,display_phone_number,verified_name",
  accessToken: string,
  parar?: (fila: FilaDeLaWaba) => boolean,
  prueba?: string
): Promise<{ filas: FilaDeLaWaba[]; completa: boolean } | null> {
  const r = await recorrerLaWabaOFalla(wabaId, campos, accessToken, parar, prueba);
  return r.ok ? r.valor : null;
}

/** ¿Figura `phoneNumberId` entre los números de la WABA? `null` si Graph no contestó. */
export async function estaEnLaWaba(
  wabaId: string,
  phoneNumberId: string,
  accessToken: string,
  prueba?: string
): Promise<boolean | null> {
  const r = await recorrerLaWaba(wabaId, "id", accessToken, (f) => f.id === phoneNumberId, prueba);
  return r && r.filas.some((f) => f.id === phoneNumberId);
}

export async function verificarEnMeta(pedido: {
  phoneNumberId: string;
  wabaId: string;
  numeroE164: string;
}): Promise<ResultadoDeMeta> {
  const { phoneNumberId, wabaId, numeroE164 } = pedido;
  const entorno = credencialDelEntorno();
  if (!entorno?.wabaId) return { ok: false, motivo: "sin_credencial" };
  // Antes de pedirle nada a Meta: ni un id ni una WABA con forma rara llegan a la URL.
  if (!ID_DE_GRAPH.test(phoneNumberId) || !ID_DE_GRAPH.test(wabaId)) return { ok: false, motivo: "id_inexistente" };
  if (wabaId !== entorno.wabaId) return { ok: false, motivo: "waba_distinta" };

  const numero = await pedir(urlDeGraph(`${phoneNumberId}?fields=display_phone_number,verified_name`), entorno.accessToken);
  if (!numero.ok) return { ok: false, motivo: numero.inexistente ? "id_inexistente" : "meta_no_responde" };
  const datos = numero.cuerpo as { display_phone_number?: unknown; verified_name?: unknown };
  const display = texto(datos.display_phone_number);
  if (!display) return { ok: false, motivo: "meta_no_responde" };
  if (!mismoNumero(display, numeroE164)) return { ok: false, motivo: "numero_distinto" };

  const figura = await estaEnLaWaba(wabaId, phoneNumberId, entorno.accessToken);
  if (figura === null) return { ok: false, motivo: "meta_no_responde" };
  if (!figura) return { ok: false, motivo: "fuera_de_la_waba" };

  return { ok: true, nombreVerificado: texto(datos.verified_name) };
}
