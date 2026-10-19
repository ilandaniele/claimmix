/**
 * Qué pide el mensaje que llegó a un caso en «Para responder» (B3).
 *
 * El agente no lo contesta: lo atiende una persona. Esto lo clasifica para que
 * la bandeja diga de qué se trata sin abrirlo, y avisa a los especialistas.
 *
 * El texto del mensaje no sale de acá: ni a la auditoría, ni a los registros,
 * ni al aviso, ni a la pantalla. Sólo la clase y un resumen que pasó el filtro.
 *
 * Un WhatsApp que cuenta otro siniestro no queda acá: abre un caso nuevo
 * (`siniestro-nuevo`) y se devuelve para que el worker lo atienda.
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
import { checkBudget, registrarConsumoDelModelo, soltarReserva } from "@/server/ai/budget";
import { callGemini } from "@/server/ai/gemini-extractor";
import { avisarMensajeTardio } from "@/server/notify/specialist-alert";
import { admiteParaResponder, ultimaRespuesta } from "@/server/cases/para-responder";
import { abrirCasoPorSiniestroNuevo } from "@/server/cases/siniestro-nuevo";

type Encabezados = Array<{ name?: string | null; value?: string | null }>;

const ENTRANTES_DEL_EPISODIO = 10;

/**
 * Toma el último entrante del caso, si el caso sigue en «Para responder» y ese
 * mensaje no tiene clase todavía. Es la reserva: dos corridas sobre el mismo
 * mensaje, ya clasificado o clasificándose, no clasifican ni avisan dos veces.
 * Con WhatsApp devuelve además el episodio: lo que mandó la persona desde la
 * última respuesta, en orden.
 */
async function reservar(tenantId: string, caseId: string) {
  const ctx = { tenantId };
  const filas = await enTenant(ctx, (db) =>
    db
      .select({
        id: claimMessages.id,
        body: claimMessages.body_text,
        headers: claimMessages.headers,
        // Posterior a la última respuesta del caso; null si nunca hubo una.
        sinContestar: sql<boolean | null>`${claimMessages.received_at} > ${ultimaRespuesta(sql`${caseId}::uuid`)}`,
      })
      .from(claimMessages)
      .where(and(eq(claimMessages.case_id, caseId), eq(claimMessages.direction, "inbound")))
      .orderBy(desc(claimMessages.received_at))
      .limit(ENTRANTES_DEL_EPISODIO)
  );
  const [ultimo] = filas;
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
      .returning({ id: cases.id, canal: cases.channel })
  );
  const episodio = filas
    .filter((f, i) => i === 0 || f.sinContestar)
    .reverse()
    .map((f) => stripQuotedReply(f.body ?? "").trim())
    .filter(Boolean)
    .join("\n\n");
  return reservado.length ? { id: ultimo.id, body: ultimo.body, episodio, canal: reservado[0].canal } : null;
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
  const presupuesto = await checkBudget(tenantId);
  if (presupuesto.exceeded) return nada;
  // Sin cupo, o sin poder contarlo, se avisa igual pero sin clase.
  const cupo = await rateLimit(
    claveDeCupo("clasificacion-tardia", tenantId, caseId),
    RATE_LIMIT_CONFIGS.CLASIFICACION_TARDIA_POR_CASO
  ).catch(() => null);
  if (!cupo?.allowed) {
    // No se llamó al modelo: la prueba no gasta del cupo diario.
    await soltarReserva(presupuesto.reserva);
    return nada;
  }

  const { sistema, usuario } = promptDelMensajeTardio(texto);
  let respuesta: string | null;
  try {
    const r = await callGemini(sistema, usuario);
    await registrarConsumoDelModelo(tenantId, r.model, r.usage);
    respuesta = r.text;
  } catch (err) {
    logger.warn({ case_id: caseId, error_code: errorCode(err) }, "mensaje_tardio.clasificacion_fallida");
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

const NADA = { casoNuevo: null };

export async function atenderMensajeTardio({
  tenantId,
  caseId,
}: {
  tenantId: string;
  caseId: string;
}): Promise<{ casoNuevo: string | null }> {
  try {
    const mensaje = await reservar(tenantId, caseId);
    if (!mensaje) return NADA;

    const porWhatsApp = mensaje.canal === "whatsapp" || mensaje.canal === "whatsapp_sim";
    const texto = porWhatsApp ? mensaje.episodio : stripQuotedReply(mensaje.body ?? "");
    const { tipo, resumen } = await clasificar(tenantId, caseId, texto);

    if (tipo === "siniestro_nuevo" && porWhatsApp) {
      const corte = await abrirCasoPorSiniestroNuevo({ tenantId, caseId, messageId: mensaje.id });
      // El caso nuevo lo atiende el agente: ni clase ni aviso al equipo.
      if (corte.tipo === "abierto") return { casoNuevo: corte.casoNuevo };
      if (corte.tipo === "ya_movido") return NADA;
    }

    // Si entró otro mensaje en el medio, la reserva es suya y esto no la pisa.
    const guardado = await enTenant({ tenantId }, (db) =>
      db
        .update(cases)
        .set({ mensaje_tardio_tipo: tipo, mensaje_tardio_resumen: resumen })
        .where(and(eq(cases.id, caseId), eq(cases.mensaje_tardio_de, mensaje.id)))
        .returning({ id: cases.id })
    );

    // Si otra corrida lo mudó a un caso nuevo mientras clasificaba, ya no es de este caso.
    if (porWhatsApp && guardado.length === 0) {
      const [donde] = await enTenant({ tenantId }, (db) =>
        db
          .select({ case_id: claimMessages.case_id })
          .from(claimMessages)
          .where(eq(claimMessages.id, mensaje.id))
          .limit(1)
      );
      if (donde && donde.case_id !== caseId) {
        logger.info({ case_id: caseId, message_id: mensaje.id }, "mensaje_tardio.se_mudo");
        return NADA;
      }
    }

    await writeAuditLog({
      tenant_id: tenantId,
      actor_id: null,
      event_type: AuditEvent.LATE_MESSAGE_CLASSIFIED,
      target_type: "case",
      target_id: caseId,
      payload: { message_id: mensaje.id, tipo },
    });

    await avisarMensajeTardio({ tenantId, caseId, messageId: mensaje.id, tipo, resumen });
    return NADA;
  } catch (err) {
    logger.error({ case_id: caseId, error_code: errorCode(err) }, "mensaje_tardio.error");
    return NADA;
  }
}
