/**
 * Qué pide el mensaje que llegó a un caso en «Para responder» (B3).
 *
 * El agente no lo contesta: lo atiende una persona. Esto lo clasifica para que
 * la bandeja diga de qué se trata sin abrirlo, y avisa a los especialistas.
 *
 * El texto del mensaje no sale de acá: ni a la auditoría, ni a los registros,
 * ni al aviso, ni a la pantalla. Sólo la clase y un resumen que pasó el filtro.
 *
 * Nunca tira: el mensaje ya está guardado y el caso ya está marcado.
 */

import "server-only";

import { and, desc, eq, isNotNull, sql } from "drizzle-orm";

import { enTenant } from "@/data/scope";
import { cases, claimMessages } from "@/lib/db/schema";
import { writeAuditLog, AuditEvent } from "@/lib/audit/log";
import { logger } from "@/lib/observability/logger";
import { errorCode } from "@/lib/observability/error-code";
import {
  ClasificacionTardiaSchema,
  esResumenTardioSeguro,
  promptDelMensajeTardio,
  type TipoMensajeTardio,
} from "@/core/case/mensaje-tardio";
import { rateLimit, RATE_LIMIT_CONFIGS } from "@/lib/rate-limit/index";
import { claveDeCupo } from "@/lib/rate-limit/clave";
import { RESERVA_DE_EXTRACCION_MS } from "@/core/case/reserva-de-extraccion";
import { stripQuotedReply } from "@/core/email/conversation";
import { isBulkHeader } from "@/server/email/relevance-prefilter";
import { resolveExtractionEngine } from "@/server/ai/provider";
import { checkBudget, registrarConsumoDelModelo } from "@/server/ai/budget";
import { callGemini } from "@/server/ai/gemini-extractor";
import { avisarMensajeTardio } from "@/server/notify/specialist-alert";
import { admiteParaResponder } from "@/server/cases/para-responder";

type Encabezados = Array<{ name?: string | null; value?: string | null }>;

/**
 * Toma el último entrante del caso, si el caso sigue en «Para responder» y ese
 * mensaje no tiene clase todavía. Es la reserva: dos corridas sobre el mismo
 * mensaje, ya clasificado o clasificándose, no clasifican ni avisan dos veces.
 */
async function reservar(tenantId: string, caseId: string) {
  const ctx = { tenantId };
  const [ultimo] = await enTenant(ctx, (db) =>
    db
      .select({ id: claimMessages.id, body: claimMessages.body_text, headers: claimMessages.headers })
      .from(claimMessages)
      .where(and(eq(claimMessages.case_id, caseId), eq(claimMessages.direction, "inbound")))
      .orderBy(desc(claimMessages.received_at))
      .limit(1)
  );
  // Un masivo no lo escribió una persona: no se reserva, así no le borra la
  // clase al mensaje que sí. WhatsApp guarda `{}`: no trae encabezados de correo.
  if (!ultimo || (Array.isArray(ultimo.headers) && isBulkHeader(ultimo.headers as Encabezados))) return null;

  const reservado = await enTenant(ctx, (db) =>
    db
      .update(cases)
      .set({
        mensaje_tardio_de: ultimo.id,
        mensaje_tardio_tipo: null,
        mensaje_tardio_resumen: null,
        mensaje_tardio_reservado_en: sql`now()`,
      })
      .where(
        and(
          eq(cases.id, caseId),
          admiteParaResponder(),
          isNotNull(cases.para_responder_desde),
          // Sin clase y con la reserva vencida es una corrida que murió o un
          // modelo que falló: se reintenta. Viva, es otra corrida clasificando.
          // El aviso sale una vez por mensaje igual.
          sql`(${cases.mensaje_tardio_de} is distinct from ${ultimo.id}
            or (${cases.mensaje_tardio_tipo} is null
              and ${cases.mensaje_tardio_reservado_en} < now() - interval '${sql.raw(String(RESERVA_DE_EXTRACCION_MS))} milliseconds'))`
        )
      )
      .returning({ id: cases.id })
  );
  return reservado.length ? ultimo : null;
}

/**
 * La clase y el resumen, o null si no se pudo: sin clasificar, nunca «otro».
 * Una falla del modelo no es una respuesta del modelo.
 */
async function clasificar(
  tenantId: string,
  caseId: string,
  texto: string
): Promise<{ tipo: TipoMensajeTardio | null; resumen: string | null }> {
  const nada = { tipo: null, resumen: null };
  if (!texto.trim()) return nada;
  if ((await resolveExtractionEngine(tenantId)) === "mock") return nada;
  if ((await checkBudget(tenantId)).exceeded) return nada;
  // Sin cupo, o sin poder contarlo, se avisa igual pero sin clase.
  const cupo = await rateLimit(
    claveDeCupo("clasificacion-tardia", tenantId, caseId),
    RATE_LIMIT_CONFIGS.CLASIFICACION_TARDIA_POR_CASO
  ).catch(() => null);
  if (!cupo?.allowed) return nada;

  const { sistema, usuario } = promptDelMensajeTardio(texto);
  let respuesta: string | null;
  try {
    const r = await callGemini(sistema, usuario);
    await registrarConsumoDelModelo(tenantId, r.model, r.usage);
    respuesta = r.text;
  } catch {
    return nada;
  }
  if (!respuesta) return nada;

  let datos: unknown;
  try {
    datos = JSON.parse(respuesta);
  } catch {
    return nada;
  }
  const parsed = ClasificacionTardiaSchema.safeParse(datos);
  if (!parsed.success) return nada;

  const resumen = parsed.data.resumen.trim();
  return {
    tipo: parsed.data.tipo,
    resumen: resumen && esResumenTardioSeguro(resumen) ? resumen : null,
  };
}

export async function atenderMensajeTardio({
  tenantId,
  caseId,
}: {
  tenantId: string;
  caseId: string;
}): Promise<void> {
  try {
    const mensaje = await reservar(tenantId, caseId);
    if (!mensaje) return;

    const { tipo, resumen } = await clasificar(tenantId, caseId, stripQuotedReply(mensaje.body ?? ""));

    // Si entró otro mensaje en el medio, la reserva es suya y esto no la pisa.
    await enTenant({ tenantId }, (db) =>
      db
        .update(cases)
        .set({ mensaje_tardio_tipo: tipo, mensaje_tardio_resumen: resumen })
        .where(and(eq(cases.id, caseId), eq(cases.mensaje_tardio_de, mensaje.id)))
    );

    await writeAuditLog({
      tenant_id: tenantId,
      actor_id: null,
      event_type: AuditEvent.LATE_MESSAGE_CLASSIFIED,
      target_type: "case",
      target_id: caseId,
      payload: { message_id: mensaje.id, tipo },
    });

    await avisarMensajeTardio({ tenantId, caseId, messageId: mensaje.id, tipo, resumen });
  } catch (err) {
    logger.error({ case_id: caseId, error_code: errorCode(err) }, "mensaje_tardio.error");
  }
}
