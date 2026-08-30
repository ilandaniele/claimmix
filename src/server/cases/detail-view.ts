/**
 * Todo lo que la pantalla de detalle necesita para pintar un caso.
 *
 * ── Qué problema resuelve ───────────────────────────────────────────────────
 *
 * Abrir un caso costaba hasta once viajes a la base, y —lo que se paga de
 * verdad— CINCO esperas encadenadas: la fila del caso, después tres
 * relacionadas, después dos de correo, después el respaldo del parser, y
 * después el acordeón, que era otro componente de servidor que consultaba solo.
 * Cada tanda esperaba a que terminara la anterior aunque no necesitara nada de
 * ella.
 *
 * Ahora son dos: la fila del caso —que hace falta antes de cualquier cosa,
 * porque si no existe hay que devolver 404 y porque su canal decide qué más
 * pedir— y después TODO lo demás junto.
 *
 * ── Por qué no es un solo `enTenantVarias` ──────────────────────────────────
 *
 * Porque un lote es UNA transacción. Hoy cada consulta degrada por su cuenta:
 * si falla el historial de auditoría, la pantalla abre igual y muestra el
 * resto. Con un lote, un hipo leyendo la auditoría se llevaría puestos los
 * campos extraídos, la documentación faltante, las confirmaciones, los adjuntos
 * y el acordeón, todos juntos — y encima el respaldo del parser cambiaría de
 * resultado, porque hoy la regex rellena la tabla cuando la consulta de campos
 * falla, y con un catch afuera recibiría texto vacío.
 *
 * `Promise.all` sobre promesas con su propio `.catch` da la concurrencia sin la
 * transacción: mismo ahorro de esperas, mismos dominios de falla.
 * `tests/unit/cases-get.test.ts` y `tests/unit/case-detail-view.test.ts` lo
 * fijan, así que si alguien las junta se pone rojo y explica por qué.
 */

import "server-only";

import { asc, eq } from "drizzle-orm";

import { enTenant, type TenantContext } from "@/data/scope";
import { claimAttachments, claimFieldConfirmations } from "@/lib/db/schema";
import type { CaseRow, ExtractedFieldRow, MissingDocRow } from "@/lib/db/types";
import {
  fetchAuditLog,
  fetchCaseRow,
  fetchExtractedFields,
  fetchMissingDocs,
  type AuditLogEntry,
} from "@/server/cases/get";
import {
  mensajesEntrantes,
  ultimoMensajeEntrante,
  type MensajeEntrante,
} from "@/server/cases/inbound-messages";

/** Cuántos mensajes muestra el acordeón del original. */
const MENSAJES_A_MOSTRAR = 5;

export interface ConfirmacionEnPantalla {
  id: string;
  field_key: string;
  proposed_value: string | null;
  conflict_with_value: string | null;
  confidence: number;
  status: "pending" | "confirmed" | "rejected" | "corrected";
  resolved_at: string | null;
}

export interface AdjuntoEnPantalla {
  id: string;
  filename: string;
  content_type: string;
  size_bytes: number;
  external_url: string;
  uploaded_at: string | null;
}

export interface DetalleDeCaso {
  case: CaseRow;
  extracted_fields: ExtractedFieldRow[];
  missing_docs: MissingDocRow[];
  audit_log: AuditLogEntry[];
  confirmations: ConfirmacionEnPantalla[];
  attachments: AdjuntoEnPantalla[];
  /** Los primeros mensajes del asegurado, para el acordeón del original. */
  messages: MensajeEntrante[];
  /** `true` si `messages` puede no incluir el más nuevo — ver `ultimoParaReleer`. */
  hayMasMensajes: boolean;
}

/**
 * En la base el estado es texto libre; en la pantalla es una de cuatro.
 *
 * Cualquier otra cosa se lee como pendiente: es lo único seguro de mostrar,
 * porque muestra el campo como todavía sin resolver en vez de darlo por bueno.
 */
function aEstadoDeConfirmacion(
  valor: string
): ConfirmacionEnPantalla["status"] {
  return valor === "confirmed" || valor === "rejected" || valor === "corrected"
    ? valor
    : "pending";
}

async function fetchConfirmaciones(
  ctx: TenantContext,
  caseId: string
): Promise<ConfirmacionEnPantalla[]> {
  try {
    const filas = await enTenant(ctx, (db) =>
      db
        .select({
          id: claimFieldConfirmations.id,
          field_key: claimFieldConfirmations.field_name,
          proposed_value: claimFieldConfirmations.suggested_value,
          conflict_with_value: claimFieldConfirmations.conflict_with_value,
          confidence: claimFieldConfirmations.confidence,
          status: claimFieldConfirmations.status,
          resolved_at: claimFieldConfirmations.confirmed_at,
        })
        .from(claimFieldConfirmations)
        .where(eq(claimFieldConfirmations.case_id, caseId))
        .orderBy(asc(claimFieldConfirmations.created_at))
    );

    // `confidence` es numeric y drizzle lo entrega como texto: se normaliza acá,
    // en el borde, y no en tres lugares distintos de la pantalla.
    return filas.map((f) => ({
      ...f,
      confidence: Number(f.confidence),
      status: aEstadoDeConfirmacion(f.status),
    }));
  } catch {
    return [];
  }
}

async function fetchAdjuntos(
  ctx: TenantContext,
  caseId: string
): Promise<AdjuntoEnPantalla[]> {
  try {
    const filas = await enTenant(ctx, (db) =>
      db
        .select({
          id: claimAttachments.id,
          filename: claimAttachments.file_name,
          content_type: claimAttachments.content_type,
          size_bytes: claimAttachments.size_bytes,
          external_url: claimAttachments.external_url,
          uploaded_at: claimAttachments.created_at,
        })
        .from(claimAttachments)
        .where(eq(claimAttachments.case_id, caseId))
        .orderBy(asc(claimAttachments.created_at))
    );

    return filas.map((f) => ({ ...f, external_url: f.external_url ?? "" }));
  } catch {
    return [];
  }
}

/**
 * Trae el caso y, si existe, todo lo demás en una sola tanda.
 *
 * Devuelve `null` cuando el caso no existe o es de otra aseguradora — nunca
 * por un error de lectura de lo relacionado, que degrada a vacío. Confundir las
 * dos cosas le mostraría al analista que un caso suyo no existe.
 */
export async function cargarDetalleDeCaso(
  ctx: TenantContext,
  caseId: string
): Promise<DetalleDeCaso | null> {
  const caseRow = await fetchCaseRow(ctx, caseId);
  if (!caseRow) return null;

  /*
   * Los adjuntos y las confirmaciones sólo existen para los casos que entraron
   * por correo: pedirlos para uno de WhatsApp sería pagar dos consultas para
   * recibir vacío.
   *
   * Los MENSAJES no: van siempre. `raw_messages` la escribe también la ingesta
   * real de WhatsApp —`intake-agent.ts`, justo después de escribir el hilo—,
   * así que condicionarlos al correo dejaría al acordeón de un caso de WhatsApp
   * diciendo «sin texto original» sobre un caso que sí lo tiene.
   */
  const esDeCorreo = caseRow.channel === "email" || caseRow.channel === "email_sim";

  const [extracted_fields, missing_docs, audit_log, confirmations, attachments, messages] =
    await Promise.all([
      fetchExtractedFields(ctx, caseId),
      fetchMissingDocs(ctx, caseId),
      fetchAuditLog(ctx, caseId),
      esDeCorreo ? fetchConfirmaciones(ctx, caseId) : Promise.resolve([]),
      esDeCorreo ? fetchAdjuntos(ctx, caseId) : Promise.resolve([]),
      mensajesEntrantes(ctx, caseId, { orden: "viejos", tope: MENSAJES_A_MOSTRAR }),
    ]);

  return {
    case: caseRow,
    extracted_fields,
    missing_docs,
    audit_log,
    confirmations,
    attachments,
    messages,
    hayMasMensajes: messages.length >= MENSAJES_A_MOSTRAR,
  };
}

/**
 * El mensaje que hay que releer con el parser cuando la extracción no dejó
 * campos.
 *
 * Casi siempre sale de los mensajes que ya se trajeron para el acordeón, sin
 * pagar otra consulta. La excepción es real y por eso está escrita: el acordeón
 * pide los CINCO PRIMEROS, así que si hay cinco puede haber más nuevos que no
 * vinieron, y ahí sí hace falta preguntar de nuevo.
 *
 * En la práctica la excepción casi no se da: esto corre sólo cuando la
 * extracción no dejó ningún campo, que es un caso recién llegado y con un
 * mensaje o dos.
 */
export async function ultimoParaReleer(
  ctx: TenantContext,
  caseId: string,
  detalle: Pick<DetalleDeCaso, "messages" | "hayMasMensajes">
): Promise<{ subject: string; body: string; senderEmail: string }> {
  if (detalle.hayMasMensajes) {
    return ultimoMensajeEntrante(ctx, caseId);
  }

  const ultimo = detalle.messages[detalle.messages.length - 1];
  return {
    subject: ultimo?.subject ?? "",
    body: ultimo?.body ?? "",
    senderEmail: ultimo?.from_addr ?? "",
  };
}
