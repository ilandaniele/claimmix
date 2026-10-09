/**
 * Recordatorios de lo que falta (B4).
 *
 * Un caso en `info_faltante` esperaba callado hasta que el barrido de
 * abandonados lo cerraba. Si la aseguradora prendió `recordatorio_horas`, a
 * esas horas del primer pedido sin respuesta se repite el pedido, con las
 * mismas claves abiertas que usa el reenvío manual.
 *
 * Nunca toca `cases`: el reloj del abandono sigue corriendo desde el último
 * movimiento real del caso. Y cada etapa se reserva antes de mandar, así que
 * sale a lo sumo una vez aunque el barrido corra dos veces a la par.
 *
 * Acá vive también el aviso de cierre: la misma reserva, el mismo destinatario
 * que el reenvío.
 */

import "server-only";

import { and, eq, notExists, notInArray, sql, type AnyColumn } from "drizzle-orm";
import { db as dbDueno, type DbDueno } from "@/lib/db";
import { enTenant, enTenantVarias } from "@/data/scope";
import { caseRecordatorios, cases, tenants } from "@/lib/db/schema";
import { AuditEvent, writeAuditLog } from "@/lib/audit/log";
import { errorCode } from "@/lib/observability/error-code";
import { logger } from "@/lib/observability/logger";
import {
  ANCLA_DEL_CIERRE,
  ETAPA_AVISO_DE_CIERRE,
  etapaVencida,
  pedidoReciente,
} from "@/core/case/recordatorios";
import {
  consultasDelReenvio,
  decidirConPlantilla,
  deFilasDelReenvio,
  enviarPedido,
} from "@/server/confirmations/reenvio";
import { reservarEtapa } from "@/server/confirmations/reservar-etapa";
import { dispatchOutboundEmail, seEntrego } from "@/server/email/dispatch";
import { leLlegoLaPregunta, ultimoEntranteDe } from "@/server/intake/close-abandoned";
import { cerradoPorSilencio } from "@/server/cases/para-responder";

const TOPE_DEL_BARRIDO = 20;
const CANALES_SIMULADOS = ["email_sim", "whatsapp_sim"];
/** Un cierre más viejo ya no se avisa: prender los recordatorios no despierta casos de hace meses. */
const DIAS_PARA_AVISAR_EL_CIERRE = 3;

/**
 * El primer mensaje que salió después del último entrante: la ancla del ciclo.
 * Un recordatorio no la mueve (es posterior), y un entrante nuevo arranca un
 * ciclo con otra. Cuenta también el acuse sin pedido: el caso sigue esperando
 * lo que se pidió antes.
 */
function anclaDe(caseId: string | AnyColumn) {
  return sql<string | null>`(select min(o.created_at) from outbound_messages o
    where o.case_id = ${caseId} and o.status in ('sent', 'skipped_simulated')
      and o.created_at > ${ultimoEntranteDe(caseId)})`;
}

export type ResultadoDelRecordatorio = "enviado" | "salteado" | null;

/**
 * Recuerda un caso si le toca. `horas` y `ahora` sólo los inyecta el ensayo,
 * sobre su propio caso; el barrido usa las del inquilino y el reloj.
 */
export async function recordarCaso(
  caseId: string,
  o: { tenantId: string; ahora?: Date; hasta?: number; horas?: readonly number[] }
): Promise<ResultadoDelRecordatorio> {
  const ahora = o.ahora ?? new Date();
  const ctx = { tenantId: o.tenantId };

  const filas = await enTenantVarias<readonly unknown[]>(ctx, (db) => [
    ...consultasDelReenvio(db, caseId),
    db.select({ horas: tenants.recordatorio_horas }).from(tenants).where(eq(tenants.id, o.tenantId)).limit(1),
    db.select({ ancla: anclaDe(caseId) }).from(cases).where(eq(cases.id, caseId)),
  ]);
  const datos = deFilasDelReenvio(filas.slice(0, 8));
  const horas = o.horas ?? (filas[8] as Array<{ horas: number[] }>)[0]?.horas ?? [];
  const ancla = (filas[9] as Array<{ ancla: string | null }>)[0]?.ancla ?? null;

  const caso = datos.caso;
  if (!caso || caso.status !== "info_faltante" || !ancla) return null;
  const etapa = etapaVencida(horas, ancla, ahora);
  // Un pedido de menos de 24 h (el reenvío manual) no se repite, y la etapa
  // queda libre para la corrida siguiente.
  if (etapa === null || pedidoReciente(datos.pedido.enviado, ahora)) return null;

  const decision = await decidirConPlantilla(datos, ahora, false, o.tenantId);
  const motivo = decision.ok ? null : decision.motivo;
  // Meta no contestó: es pasajero, la etapa queda para la corrida siguiente.
  if (motivo === "plantilla_sin_respuesta") {
    logger.warn({ case_id: caseId }, "recordatorio.plantilla_sin_respuesta");
    return null;
  }

  if (o.hasta !== undefined && Date.now() > o.hasta) return null;

  const reservadas = await enTenant(ctx, (db) =>
    reservarEtapa(db, {
      caseId,
      tenantId: o.tenantId,
      ancla,
      desde: 1,
      etapa,
      resultado: motivo ?? "enviar",
      sigue: sql`${cases.status} = 'info_faltante' and ${cases.updated_at} is not distinct from ${caso.updated_at}::timestamptz`,
    })
  );
  // Sin fila: otra corrida ganó la etapa o el caso cambió después de leerlo.
  if (!reservadas.some((r) => r.etapa === etapa)) return null;

  const auditoria = { tenant_id: o.tenantId, actor_id: null, target_type: "case", target_id: caseId };

  if (!decision.ok) {
    await writeAuditLog({
      ...auditoria,
      event_type: AuditEvent.CLAIM_REMINDER_SKIPPED,
      payload: { etapa, reason: motivo },
    });
    return "salteado";
  }

  if (!(await enviarPedido(caso, o.tenantId, decision))) {
    // La etapa ya está gastada y no se reintenta: la cubre la siguiente o el
    // reenvío manual.
    logger.error({ case_id: caseId, canal: caso.channel }, "recordatorio.envio_fallo");
    await writeAuditLog({
      ...auditoria,
      event_type: AuditEvent.CLAIM_REMINDER_FAILED,
      payload: { etapa, canal: caso.channel },
    });
    return null;
  }

  await writeAuditLog({
    ...auditoria,
    event_type: AuditEvent.CLAIM_REMINDER_SENT,
    payload: {
      etapa,
      horas: horas[etapa - 1],
      canal: caso.channel,
      via: decision.porPlantilla ? "plantilla" : "texto",
    },
  });
  return "enviado";
}

/**
 * El barrido nocturno: hasta 20 casos de los inquilinos que prendieron los
 * recordatorios, de a uno, hasta `hasta`. Sólo entra un caso con una etapa
 * vencida y sin reservar en su ciclo, y sin un pedido de las últimas 24 h: los
 * que hoy no tienen nada que mandar no les tapan el lugar a los que sí.
 */
export async function recordarPendientes(
  o: { hasta: number },
  db: DbDueno = dbDueno
): Promise<{ enviados: number; salteados: number }> {
  const resultado = { enviados: 0, salteados: 0 };

  // sin-inquilino: barrido de sistema sobre los casos de todos los inquilinos
  // con recordatorios prendidos; cada caso se atiende después en su inquilino.
  const candidatos = await db
    .select({ id: cases.id, tenant_id: cases.tenant_id })
    .from(cases)
    .innerJoin(tenants, eq(tenants.id, cases.tenant_id))
    .where(
      and(
        sql`cardinality(${tenants.recordatorio_horas}) > 0`,
        eq(cases.status, "info_faltante"),
        notInArray(cases.channel, CANALES_SIMULADOS),
        leLlegoLaPregunta,
        // La misma cuenta que `etapaVencida` y la misma clave que la reserva.
        sql`exists (
          select 1 from (select ${anclaDe(cases.id)} as a) x, generate_subscripts(${tenants.recordatorio_horas}, 1) k
           where x.a + ${tenants.recordatorio_horas}[k] * interval '1 hour' <= now()
             and not exists (select 1 from ${caseRecordatorios} r
                              where r.case_id = ${cases.id} and r.ancla = x.a and r.etapa >= k))`,
        // `pedidoReciente`: un pedido de menos de 24 h no se repite.
        sql`not exists (select 1 from outbound_messages o
              where o.case_id = ${cases.id} and o.asked_keys is not null
                and o.status in ('sent', 'skipped_simulated')
                and o.created_at > now() - interval '24 hours')`
      )
    )
    .orderBy(cases.updated_at)
    .limit(TOPE_DEL_BARRIDO);

  for (const c of candidatos) {
    if (Date.now() > o.hasta) break;
    try {
      const r = await recordarCaso(c.id, { tenantId: c.tenant_id, hasta: o.hasta });
      if (r === "enviado") resultado.enviados++;
      if (r === "salteado") resultado.salteados++;
    } catch (err) {
      logger.error({ case_id: c.id, code: errorCode(err) }, "recordatorio.fallo");
    }
  }

  return resultado;
}

/**
 * Le avisa al denunciante que su caso se cerró por abandono (B4), sólo en los
 * inquilinos que prendieron los recordatorios.
 *
 * Busca los cierres de los últimos días sin la etapa 9, no los de esta
 * corrida: uno que quedó afuera por el tope, el reloj o un error sale en la
 * siguiente. Por mail, un texto fijo, sin redactor ni modelo. Por WhatsApp no
 * sale nada: a los catorce días de silencio la ventana de 24 h está cerrada y
 * no hay plantilla para esto.
 */
export async function avisarCierres(o: { hasta: number }, db: DbDueno = dbDueno): Promise<number> {
  // sin-inquilino: barrido de sistema sobre los cierres de todos los
  // inquilinos; cada caso se atiende después en el suyo.
  const cerrados = await db
    .select({ id: cases.id, tenant_id: cases.tenant_id, channel: cases.channel })
    .from(cases)
    .innerJoin(tenants, eq(tenants.id, cases.tenant_id))
    .where(
      and(
        sql`cardinality(${tenants.recordatorio_horas}) > 0`,
        cerradoPorSilencio(),
        notInArray(cases.channel, CANALES_SIMULADOS),
        sql`${cases.closed_at} > now() - interval '${sql.raw(String(DIAS_PARA_AVISAR_EL_CIERRE))} days'`,
        notExists(
          // sin-inquilino: subconsulta del mismo barrido; no se ejecuta sola.
          db
            .select({ uno: sql`1` })
            .from(caseRecordatorios)
            .where(and(eq(caseRecordatorios.case_id, cases.id), eq(caseRecordatorios.etapa, ETAPA_AVISO_DE_CIERRE)))
        )
      )
    )
    .orderBy(cases.closed_at)
    .limit(TOPE_DEL_BARRIDO);

  let avisos = 0;
  for (const c of cerrados) {
    if (Date.now() > o.hasta) break;
    try {
      if (await avisarCierre(c)) avisos++;
    } catch (err) {
      logger.error({ case_id: c.id, code: errorCode(err) }, "aviso_de_cierre.fallo");
    }
  }
  return avisos;
}

async function avisarCierre(c: { id: string; tenant_id: string; channel: string }): Promise<boolean> {
  const ctx = { tenantId: c.tenant_id };
  const { destinatario } = deFilasDelReenvio(
    await enTenantVarias<readonly unknown[]>(ctx, (db) => consultasDelReenvio(db, c.id))
  );
  const motivo = c.channel === "whatsapp" ? "ventana_cerrada" : destinatario ? null : "sin_destinatario";

  const reservadas = await enTenant(ctx, (db) =>
    reservarEtapa(db, {
      caseId: c.id,
      tenantId: c.tenant_id,
      ancla: ANCLA_DEL_CIERRE,
      desde: ETAPA_AVISO_DE_CIERRE,
      etapa: ETAPA_AVISO_DE_CIERRE,
      resultado: motivo ?? "enviar",
      sigue: sql`${cases.status} = 'cerrado'`,
    })
  );
  if (reservadas.length === 0) return false;

  const auditoria = { tenant_id: c.tenant_id, actor_id: null, target_type: "case", target_id: c.id };
  if (motivo || !destinatario) {
    await writeAuditLog({ ...auditoria, event_type: AuditEvent.CASE_CLOSURE_NOTICE_SKIPPED, payload: { reason: motivo } });
    return false;
  }

  const r = await dispatchOutboundEmail({
    caseId: c.id,
    tenantId: c.tenant_id,
    to: destinatario,
    template: "case_closure_notice",
    data: { caseId: c.id },
  });
  // Como el recordatorio: la etapa queda gastada y el fallo, a la vista.
  if (!seEntrego(r)) {
    logger.error({ case_id: c.id, code: r.error }, "aviso_de_cierre.envio_fallo");
    await writeAuditLog({ ...auditoria, event_type: AuditEvent.CASE_CLOSURE_NOTICE_FAILED, payload: { code: r.error } });
    return false;
  }

  await writeAuditLog({ ...auditoria, event_type: AuditEvent.CASE_CLOSURE_NOTICE_SENT, payload: { canal: c.channel } });
  return true;
}
