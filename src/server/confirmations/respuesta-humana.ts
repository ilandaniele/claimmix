/**
 * Una persona responde un caso por WhatsApp, sin pasar por el agente.
 *
 * Sólo dentro de la ventana de 24 h de Meta, con el agente ya terminado y en
 * Plan Pro — `estadoDeRespuesta` decide, acá se vuelve a exigir del lado del
 * servidor lo que el GET ya mostró.
 */
import "server-only";

import { and, desc, eq } from "drizzle-orm";
import { enTenant, enTenantVarias, type TenantContext } from "@/data/scope";
import { cases, claimMessages, outboundMessages } from "@/lib/db/schema";
import { firstRow } from "@/lib/db/helpers";
import type { RoleContext } from "@/lib/auth/require-role";
import { puedeCambiarEstado } from "@/lib/auth/roles";
import { estadoDeRespuesta, type MotivoSinRespuesta } from "@/core/whatsapp/puede-responder";
import { PLANTILLA_RESPUESTA_HUMANA } from "@/core/whatsapp/plantillas";
import { sendWhatsAppText } from "@/server/whatsapp/cloud-api";
import { avisarSinNumero, credencialesWhatsApp } from "@/server/whatsapp/numeros";
import { isReservedTestNumber } from "@/core/phone/reserved";
import { AuditEvent, writeAuditLog } from "@/lib/audit/log";

// Re-exportada para no romper a quien ya la importa desde acá.
export { PLANTILLA_RESPUESTA_HUMANA };

export type ResultadoRespuesta =
  | { ok: true; id: string; estado: "sent" | "skipped_simulated" }
  | { ok: false; motivo: MotivoSinRespuesta | "no_encontrado" | "envio_fallido" };

export async function responderPorWhatsApp(
  ctx: RoleContext,
  caseId: string,
  texto: string,
  meta?: { ip?: string | null; ua?: string | null }
): Promise<ResultadoRespuesta> {
  const tenantCtx: TenantContext = { tenantId: ctx.userRow.tenant_id };

  const [filaCaso, filaEntrante] = await enTenantVarias<
    [
      Array<{
        id: string;
        status: string;
        channel: string;
        email_thread_id: string | null;
        assigned_to: string | null;
      }>,
      Array<{ received_at: string }>,
    ]
  >(tenantCtx, (db) => [
    db
      .select({
        id: cases.id,
        status: cases.status,
        channel: cases.channel,
        email_thread_id: cases.email_thread_id,
        assigned_to: cases.assigned_to,
      })
      .from(cases)
      .where(eq(cases.id, caseId))
      .limit(1),
    db
      .select({ received_at: claimMessages.received_at })
      .from(claimMessages)
      .where(
        and(
          eq(claimMessages.case_id, caseId),
          eq(claimMessages.direction, "inbound"),
          eq(claimMessages.provider, "whatsapp")
        )
      )
      .orderBy(desc(claimMessages.received_at))
      .limit(1),
  ]);

  const caso = firstRow(filaCaso);
  if (!caso) return { ok: false, motivo: "no_encontrado" };

  // Misma respuesta que el PATCH: un analista no distingue «no existe» de «es de otro».
  if (!puedeCambiarEstado(ctx.userRow, caso.assigned_to)) {
    return { ok: false, motivo: "no_encontrado" };
  }

  const estado = estadoDeRespuesta({
    plan: ctx.userRow.plan,
    role: ctx.userRow.role,
    channel: caso.channel,
    status: caso.status,
    ultimoEntrante: firstRow(filaEntrante)?.received_at ?? null,
    ahora: new Date(),
  });
  if (!estado.habilitada) return { ok: false, motivo: estado.motivo! };

  const to = caso.email_thread_id;
  const simulado = caso.channel === "whatsapp_sim" || isReservedTestNumber(to);

  /*
   * Primero la fila, "queued", después Meta (J): si el envío se corta la
   * entrega queda anotada igual, y si el proceso se cae entre las dos nadie
   * la reintenta creyendo que nunca salió — antes era al revés, y un fallo de
   * base justo después de mandar dejaba una respuesta real sin ningún rastro.
   */
  const filaInsert = firstRow(
    await enTenant(tenantCtx, (db) =>
      db
        .insert(outboundMessages)
        .values({
          case_id: caseId,
          tenant_id: tenantCtx.tenantId,
          channel: "whatsapp",
          template: PLANTILLA_RESPUESTA_HUMANA,
          rendered_body: texto,
          status: "queued",
        })
        .returning({ id: outboundMessages.id })
    )
  );
  const outboundId = filaInsert!.id;

  let status: "sent" | "failed" | "skipped_simulated";
  if (simulado) {
    status = "skipped_simulated";
  } else if (!to) {
    status = "failed";
  } else {
    const cred = await credencialesWhatsApp(tenantCtx.tenantId);
    if (cred) {
      const res = await sendWhatsAppText(to, texto, cred);
      status = res.ok ? "sent" : "failed";
    } else {
      avisarSinNumero(tenantCtx.tenantId, "respuesta_humana");
      status = "failed";
    }
  }

  if (status === "failed") {
    await enTenant(tenantCtx, (db) =>
      db.update(outboundMessages).set({ status }).where(eq(outboundMessages.id, outboundId))
    );
  } else {
    await enTenantVarias<[unknown, unknown]>(tenantCtx, (db) => [
      db.update(outboundMessages).set({ status }).where(eq(outboundMessages.id, outboundId)),
      db.update(cases).set({ para_responder_desde: null }).where(eq(cases.id, caseId)),
    ]);
  }

  await writeAuditLog({
    tenant_id: tenantCtx.tenantId,
    actor_id: ctx.userRow.id,
    event_type: AuditEvent.CASE_HUMAN_REPLY,
    target_type: "case",
    target_id: caseId,
    payload: { outbound_id: outboundId, estado: status },
    ip: meta?.ip,
    ua: meta?.ua,
  });

  if (status === "failed") return { ok: false, motivo: "envio_fallido" };
  return { ok: true, id: outboundId, estado: status };
}
