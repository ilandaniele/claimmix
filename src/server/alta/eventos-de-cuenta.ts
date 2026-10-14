/**
 * Lo que Meta avisa de la cuenta de cada cliente: que sacó la app, que la cuenta se
 * restringió, que aprobaron o rechazaron el nombre del número.
 *
 * Llegan por el mismo webhook que los mensajes, firmados, pero hablan de la WABA y no
 * de un número: la fila de `whatsapp_wabas` dice de quién es. En el webhook de la
 * plataforma se busca por `waba_id` entre las de Embedded Signup; en el de la app de un
 * cliente la ruta ya dice de quién es y viene como `contexto`, sin otra lectura. Nada de acá puede romper
 * la entrega de mensajes ni hacer que Meta reintente, así que no tira nunca; lo que
 * falla se anota y el evento se pierde (la revisión nocturna, `waba-salud.ts`, vuelve a
 * mirar los tokens).
 *
 * El aviso de Meta no alcanza para revocar: se pregunta a Graph si el token sigue
 * sirviendo para esa WABA, y sólo si dice que no (contesta 190, o el token vive pero ya
 * no la lista) se da de baja la cuenta. Un aviso de restricción o de nombre que llega
 * tarde (el cliente ya volvió a conectar) no pisa nada: se descarta si es anterior al
 * último cambio de la fila. Con la revocación no hace falta: Graph se pregunta con el
 * token de ahora, y si éste sirve no se toca nada. En la app propia la pregunta es `revisar`
 * (`debug_token` con el App Secret del cliente) y sólo `token_vencido` da de baja.
 */

import "server-only";
import { sql } from "drizzle-orm";
import { nombreDelError } from "@/lib/observability/error-code";
import { logger } from "@/lib/observability/logger";
import { nombreAprobado } from "@/server/alta/app-propia";
import { avisarNumeroEnRevision } from "@/server/alta/aviso-operador";
import { nombreDelNumero, wabaEnFalla, wabaRevocada } from "@/server/alta/panel-operador";
import { leerWabasDelCliente, type WabaDelCliente } from "@/server/alta/wabas-del-cliente";
import { codigoPg } from "@/server/core-sync/config";
import type { EventoDeCuenta } from "@/server/whatsapp/cloud-api";
import type { RevisionDeToken } from "@/server/whatsapp/app-del-cliente";
import { revisarToken } from "@/server/whatsapp/embedded-signup";
import { sinLaWaba } from "@/server/whatsapp/errores-de-graph";

const REVOCACIONES: ReadonlySet<string> = new Set(["PARTNER_APP_UNINSTALLED", "PARTNER_REMOVED", "ACCOUNT_DELETED"]);
const RESTRICCIONES: ReadonlySet<string> = new Set(["DISABLED_UPDATE", "ACCOUNT_RESTRICTION", "ACCOUNT_VIOLATION"]);
/** Campos que la app propia no suscribe (M1): si llegan igual, se anotan y se dejan. */
const IGNORADOS: ReadonlySet<string> = new Set(["business_capability_update", "template_category_update", "message_template_quality_update"]);

/** De quién es el webhook cuando entra por la ruta de la app de un cliente. */
export interface ContextoDeApp {
  tenantId: string;
  wabaId: string;
  /** Epoch ms del último cambio de la fila, leído de nuevo para este pedido: un aviso anterior se descarta por viejo. */
  actualizadoEn: number | null;
  /** Pregunta a Graph si el token del cliente sigue sirviendo; se llama sólo ante un aviso de baja. */
  revisar: () => Promise<RevisionDeToken>;
}

const wabaDelContexto = (c: ContextoDeApp): WabaDelCliente => ({
  tenantId: c.tenantId,
  wabaId: c.wabaId,
  estado: "conectada",
  origen: "app_propia",
  actualizadoEn: c.actualizadoEn,
  plantillaEnviada: false,
  token: null,
  falla: null,
  appId: null,
  secreto: null,
  phoneNumberId: null,
});

/** Las WABAs vivas a las que se refieren los eventos, por id: una sola consulta por pedido. */
async function wabasDe(ids: string[]): Promise<Map<string, WabaDelCliente>> {
  const lista = sql.join(
    ids.map((id) => sql`${id}::text`),
    sql`, `
  );
  const filas = await leerWabasDelCliente(sql`b.waba_id in (${lista}) and b.origen = 'embedded_signup' and b.estado not in ('revocada', 'cancelada')`, ids.length);
  return new Map(filas.map((f) => [f.wabaId, f]));
}

/** Da de baja la cuenta si Graph confirma que el token murió o que ya no autoriza esta WABA; si no, deja constancia y no toca nada. */
async function revocarSiGraphLoConfirma(
  waba: WabaDelCliente,
  evento: string | null,
  revisar?: ContextoDeApp["revisar"]
): Promise<boolean> {
  const base = { tenantId: waba.tenantId, wabaId: waba.wabaId, evento };
  if (waba.origen === "app_propia") {
    const r = revisar ? await revisar() : null;
    if (!r || r.ok || r.motivo !== "token_vencido") {
      logger.warn({ ...base, motivo: !r ? "sin_revision" : r.ok ? "token_vigente" : r.motivo }, "whatsapp.cuenta_sin_confirmar");
      return false;
    }
  } else {
    if (!waba.token) {
      logger.warn({ ...base, motivo: "sin_token" }, "whatsapp.cuenta_sin_confirmar");
      return false;
    }
    const r = await revisarToken(waba.token);
    if (!sinLaWaba(r, waba.wabaId)) {
      logger.warn({ ...base, motivo: r.ok ? "token_vigente" : r.falla }, "whatsapp.cuenta_sin_confirmar");
      return false;
    }
  }
  await wabaRevocada(waba.wabaId);
  await avisarNumeroEnRevision("revocada", waba.tenantId, { appPropia: waba.origen === "app_propia" });
  return true;
}

/** Una restricción de la cuenta: en la app propia es una falla del alta con su aviso; en Embedded Signup, sólo el aviso. */
async function cuentaRestringida(waba: WabaDelCliente, evento: string | null): Promise<void> {
  logger.warn({ tenantId: waba.tenantId, wabaId: waba.wabaId, evento }, "whatsapp.cuenta_restringida");
  if (waba.origen !== "app_propia") return avisarNumeroEnRevision("cuenta_restringida", waba.tenantId);
  await wabaEnFalla(waba.tenantId, "waba_restringida");
  await avisarNumeroEnRevision("waba_restringida", waba.tenantId);
}

/**
 * Atiende los eventos de cuenta de un pedido del webhook. No tira nunca: cada evento
 * va en su propio try, y un fallo de la consulta de arranque se anota y se deja ahí.
 * Con `contexto` (la ruta de la app de un cliente) no se lee nada: los eventos de otra WABA se descartan.
 */
export async function atenderEventosDeCuenta(eventos: EventoDeCuenta[], contexto?: ContextoDeApp): Promise<void> {
  const atendibles = eventos.filter((e) => {
    if (!IGNORADOS.has(e.campo)) return true;
    logger.info({ wabaId: e.wabaId, campo: e.campo }, "whatsapp.cuenta_campo_ignorado");
    return false;
  });
  if (atendibles.length === 0) return;
  try {
    const wabas = contexto
      ? new Map([[contexto.wabaId, wabaDelContexto(contexto)]])
      : await wabasDe([...new Set(atendibles.map((e) => e.wabaId))]);
    const revocadas = new Set<string>();

    for (const e of atendibles) {
      try {
        const waba = wabas.get(e.wabaId);
        if (!waba) {
          // También entran los de la WABA de la plataforma, que comparte la app: no son de nadie de acá.
          logger.info({ wabaId: e.wabaId, campo: e.campo, evento: e.evento }, "whatsapp.cuenta_desconocida");
          continue;
        }
        const esRevocacion = e.evento !== null && REVOCACIONES.has(e.evento);
        if (!esRevocacion && e.hora !== null && waba.actualizadoEn !== null && e.hora * 1000 < waba.actualizadoEn) {
          logger.info({ tenantId: waba.tenantId, campo: e.campo, evento: e.evento }, "whatsapp.cuenta_evento_viejo");
          continue;
        }
        if (revocadas.has(waba.wabaId)) continue;

        if (e.campo === "phone_number_name_update") {
          if (!e.nombreEstado) continue;
          await nombreDelNumero(waba.wabaId, e.nombreEstado);
          if (e.nombreEstado === "DECLINED") {
            await wabaEnFalla(waba.tenantId, "nombre_rechazado");
            await avisarNumeroEnRevision("nombre_rechazado", waba.tenantId);
          } else if (e.nombreEstado === "APPROVED" && waba.origen === "app_propia") {
            await nombreAprobado(waba.tenantId, waba.wabaId);
          }
        } else if (esRevocacion) {
          if (await revocarSiGraphLoConfirma(waba, e.evento, contexto?.revisar)) revocadas.add(waba.wabaId);
        } else if (e.campo === "account_review_update" ? e.evento === "REJECTED" : e.evento !== null && RESTRICCIONES.has(e.evento)) {
          await cuentaRestringida(waba, e.evento);
        } else {
          logger.info({ tenantId: waba.tenantId, campo: e.campo, evento: e.evento }, "whatsapp.cuenta_evento");
        }
      } catch (err) {
        logger.error({ error: nombreDelError(err), campo: e.campo, evento: e.evento }, "whatsapp.cuenta_evento_fallo");
      }
    }
  } catch (err) {
    // Sin la 0051 no hay WABAs propias: los eventos de la WABA de la plataforma (misma app) llegan igual y no son un fallo.
    if (codigoPg(err) === "42P01") return;
    logger.error({ error: nombreDelError(err) }, "whatsapp.cuenta_eventos_fallo");
  }
}
