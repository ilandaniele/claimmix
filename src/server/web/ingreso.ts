import "server-only";

import { createHash, randomUUID } from "node:crypto";

import { ORIGEN_WEB } from "@/core/email/autenticacion";
import { enTenantVarias } from "@/data/scope";
import { AuditEvent, filaDeAuditoria } from "@/lib/audit/log";
import { auditLog, cases, claimMessages } from "@/lib/db/schema";
import { codigoPg } from "@/server/core-sync/config";

export interface DenunciaWeb {
  tenantId: string;
  nombre: string;
  /** Ya validado como una dirección sola: va a ser el destinatario del seguimiento. */
  email: string;
  telefono: string | null;
  relato: string;
  /** El token que trajo la página: identifica ese formulario pintado, no a quien lo llena. */
  envio: string;
  ip: string | null;
}

export const ASUNTO_DE_LA_DENUNCIA_WEB = "Denuncia por formulario web";

/** Lo que el modelo lee como si fuera el cuerpo de un mail. */
export function cuerpoDeLaDenuncia(d: Pick<DenunciaWeb, "nombre" | "email" | "telefono" | "relato">): string {
  return [
    "Denuncia enviada por el formulario web de la aseguradora.",
    "",
    `Nombre: ${d.nombre}`,
    `Correo: ${d.email}`,
    ...(d.telefono ? [`Teléfono: ${d.telefono}`] : []),
    "",
    "Relato:",
    d.relato,
  ].join("\n");
}

/**
 * Lo que hace igual a dos pedidos del mismo envío. Va en `provider_message_id`,
 * que tiene índice único por inquilino: el segundo pedido rebota en la base, no
 * en una lectura previa que dos pedidos simultáneos pasarían los dos.
 */
export const huellaDelEnvio = (d: Pick<DenunciaWeb, "envio" | "email" | "relato">): string =>
  createHash("sha256").update(`${d.envio}
${d.email.toLowerCase()}
${d.relato}`).digest("hex");

/**
 * Abre el caso del formulario web: caso, mensaje y auditoría en un solo lote,
 * así que no queda un caso vacío si algo falla a mitad de camino. Devuelve
 * `null` si ese mismo envío ya había abierto el suyo (doble clic): no se abre
 * otro caso ni se manda otro correo.
 *
 * Nunca se cuelga de un caso existente ni mira hilos: cualquiera puede escribir
 * cualquier dirección en el formulario, y dejar que eso caiga en la
 * conversación de otra persona filtraría su caso. El remitente queda marcado
 * como no verificado (`ORIGEN_WEB`), así no hereda ni escribe memoria a nombre
 * de esa dirección.
 */
export async function ingresarDenunciaWeb(d: DenunciaWeb): Promise<{ caseId: string } | null> {
  const caseId = randomUUID();
  try {
    await enTenantVarias({ tenantId: d.tenantId }, (db) => [
      db.insert(cases).values({
        id: caseId,
        tenant_id: d.tenantId,
        channel: "web",
        status: "recibido",
        is_claim: null,
        claim_type: null,
      }),
      db.insert(claimMessages).values({
        case_id: caseId,
        tenant_id: d.tenantId,
        direction: "inbound",
        provider: "web",
        provider_message_id: `web:${huellaDelEnvio(d)}`,
        from_addr: d.email,
        to_addr: null,
        subject: ASUNTO_DE_LA_DENUNCIA_WEB,
        body_text: cuerpoDeLaDenuncia(d),
        headers: [ORIGEN_WEB],
        raw_payload: { origen: "web", profile_name: d.nombre },
        status: "received",
        received_at: new Date().toISOString(),
      }),
      db.insert(auditLog).values(
        filaDeAuditoria({
          tenant_id: d.tenantId,
          actor_id: null,
          event_type: AuditEvent.DENUNCIA_WEB_RECIBIDA,
          target_type: "case",
          target_id: caseId,
          payload: { canal: "web" },
          ip: d.ip,
        })
      ),
    ]);
  } catch (e) {
    // El lote es una transacción: si el envío ya estaba, no quedó ni el caso ni la auditoría.
    if (codigoPg(e) === "23505") return null;
    throw e;
  }
  return { caseId };
}
