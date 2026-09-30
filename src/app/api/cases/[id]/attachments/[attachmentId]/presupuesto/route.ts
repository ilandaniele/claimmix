/**
 * POST /api/cases/:id/attachments/:attachmentId/presupuesto — lee el
 * presupuesto del taller de un adjunto y lo coteja con las fotos y el relato
 * (B21). Con la lectura ajusta el monto estimado del caso (B23).
 *
 * Lo pide una persona del equipo: el modelo no lee presupuestos solo. Sin cupo,
 * sin presupuesto de IA o sin respuesta del modelo no se escribe nada y la
 * pantalla dice «sin leer». Nada de esto sale al asegurado.
 *
 * Auth: los que editan casos; un analista, sólo en un caso suyo o sin asignar.
 */

import { type NextRequest } from "next/server";
import { z } from "zod";
import { and, asc, desc, eq, inArray, isNotNull, isNull, like, ne, sql } from "drizzle-orm";

import { normalizarMime, seMira } from "@/core/adjuntos/firma";
import { ajustarConPresupuesto, estimarMonto, rangoPara, type MontoEstimado } from "@/core/case/monto-estimado";
import { camposDelPuntaje, puntajeDelCaso } from "@/core/case/puntaje-complejidad";
import {
  esCandidatoAPresupuesto,
  LecturaPresupuestoSchema,
  limpiarLectura,
  promptDelPresupuesto,
  revisarPresupuesto,
  type LecturaGuardada,
} from "@/core/case/presupuesto-taller";
import { enTenantVarias } from "@/data/scope";
import { entrar } from "@/lib/api/entrada";
import { ok, err } from "@/lib/api/respond";
import { writeAuditLog, AuditEvent } from "@/lib/audit/log";
import { CASE_EDITOR_ROLES, puedeCambiarEstado } from "@/lib/auth/roles";
import { cases, claimAttachments, extractedFields, tenants } from "@/lib/db/schema";
import { AppError } from "@/lib/errors";
import { RATE_LIMIT_CONFIGS } from "@/lib/rate-limit/index";
import { faltaLaMigracion } from "@/server/core-sync/config";
import { leerDocumento, type Lectura } from "@/server/ai/leer-documento";
import type { InlineMedia } from "@/server/ai/gemini-extractor";
import { readAttachment } from "@/server/storage/claim-attachments-bucket";
import { MAX_BYTES } from "@/server/worker/adjuntos";

export const maxDuration = 60;

const MAX_FOTOS = 3;

const ParamsSchema = z.object({
  id: z.string().uuid("ID de caso inválido."),
  attachmentId: z.string().uuid("ID de adjunto inválido."),
});

const sinDescarte = sql`coalesce(${claimAttachments.metadatos}->>'descarte', '') = ''`;

type Filas = [
  Array<{
    claim_type: string | null;
    severity: string | null;
    fraud_risk_level: string | null;
    injury_severity: string | null;
    assigned_to: string | null;
  }>,
  Array<{ field_value: string }>,
  Array<{
    content_type: string;
    file_name: string;
    storage_path: string | null;
    content_hash: string | null;
    resumen: string | null;
    datos: unknown;
    descartado: boolean;
  }>,
  Array<{ storage_path: string | null; content_type: string; size_bytes: number }>,
  Array<{ rangos: unknown; pesos: unknown }>,
  Array<{ field_key: string; field_value: string | null }>,
];

/** Como en el worker, el tope es de lo que va al modelo junto, no de cada archivo. */
async function aMedia(
  archivo: { storage_path: string | null; content_type: string },
  lugar: { bytes: number }
): Promise<InlineMedia | null> {
  const bytes = archivo.storage_path ? await readAttachment(archivo.storage_path) : null;
  if (!bytes || bytes.length > lugar.bytes) return null;
  lugar.bytes -= bytes.length;
  return { mimeType: normalizarMime(archivo.content_type), data: bytes.toString("base64") };
}

export async function POST(
  _request: NextRequest,
  context: { params: Promise<{ id: string; attachmentId: string }> }
): Promise<Response> {
  try {
    const params = ParamsSchema.safeParse(await context.params);
    if (!params.success) throw new AppError("VALIDATION_FAILED", params.error.issues[0]?.message);
    const { id: caseId, attachmentId } = params.data;

    const { ctx, rl } = await entrar("workshop-estimate", RATE_LIMIT_CONFIGS.CASES_API, ...CASE_EDITOR_ROLES);
    if (!rl.allowed) throw new AppError("RATE_LIMITED");
    const { userRow } = ctx;
    const tenantId = userRow.tenant_id;

    const [[caso], [relato], [adjunto], fotos, [tenant], campos] = await enTenantVarias<Filas>({ tenantId }, (db) => [
      db
        .select({
          claim_type: cases.claim_type,
          severity: cases.severity,
          fraud_risk_level: cases.fraud_risk_level,
          injury_severity: cases.injury_severity,
          assigned_to: cases.assigned_to,
        })
        .from(cases)
        .where(eq(cases.id, caseId))
        .limit(1),
      db
        .select({ field_value: extractedFields.field_value })
        .from(extractedFields)
        .where(
          and(
            eq(extractedFields.case_id, caseId),
            inArray(extractedFields.field_key, ["accident_description", "descripcion_hecho"])
          )
        )
        .orderBy(desc(extractedFields.extracted_at))
        .limit(1),
      db
        .select({
          content_type: claimAttachments.content_type,
          file_name: claimAttachments.file_name,
          storage_path: claimAttachments.storage_path,
          content_hash: claimAttachments.content_hash,
          resumen: claimAttachments.resumen,
          datos: claimAttachments.datos,
          descartado: sql<boolean>`not (${sinDescarte})`,
        })
        .from(claimAttachments)
        .where(and(eq(claimAttachments.id, attachmentId), eq(claimAttachments.case_id, caseId)))
        .limit(1),
      db
        .select({
          storage_path: claimAttachments.storage_path,
          content_type: claimAttachments.content_type,
          size_bytes: claimAttachments.size_bytes,
        })
        .from(claimAttachments)
        .where(
          and(
            eq(claimAttachments.case_id, caseId),
            eq(claimAttachments.util, true),
            like(claimAttachments.content_type, "image/%"),
            ne(claimAttachments.id, attachmentId),
            isNotNull(claimAttachments.storage_path),
            isNull(claimAttachments.rejected_reason),
            sinDescarte
          )
        )
        .orderBy(asc(claimAttachments.created_at))
        .limit(MAX_FOTOS),
      db
        .select({ rangos: tenants.rangos_de_monto, pesos: tenants.pesos_puntaje })
        .from(tenants)
        .where(eq(tenants.id, tenantId))
        .limit(1),
      // El puntaje cuenta el monto y los campos que la aseguradora pondera: se leen junto con el resto.
      db
        .select({ field_key: extractedFields.field_key, field_value: extractedFields.field_value })
        .from(extractedFields)
        .where(eq(extractedFields.case_id, caseId)),
    ]).catch(faltaLaMigracion("0040", "0042"));

    // Un caso ajeno o de otro analista no se distingue de uno que no existe.
    if (!caso || !puedeCambiarEstado(userRow, caso.assigned_to)) throw new AppError("NOT_FOUND");
    if (!adjunto) throw new AppError("NOT_FOUND", "El adjunto no existe.");
    if (!esCandidatoAPresupuesto(adjunto)) {
      throw new AppError("ARCHIVO_NO_VALIDO", "El adjunto no parece un presupuesto.");
    }

    const rangos = tenant?.rangos ?? null;
    let resultado: Lectura<LecturaGuardada["lectura"]> = { sinLeer: "archivo" };
    const lugar = { bytes: MAX_BYTES };
    const presupuesto = adjunto.descartado ? null : await aMedia(adjunto, lugar);
    if (presupuesto) {
      const imagenes: InlineMedia[] = [];
      for (const f of fotos) {
        if (!seMira(f.content_type) || f.size_bytes > lugar.bytes) continue;
        const foto = await aMedia(f, lugar);
        if (foto) imagenes.push(foto);
      }
      const { sistema, usuario } = promptDelPresupuesto({
        relato: relato?.field_value ?? null,
        resumenDelPresupuesto: adjunto.resumen,
        fotos: imagenes.length,
      });
      resultado = await leerDocumento({
        tenantId,
        userId: userRow.id,
        ambito: "lectura-presupuesto",
        partesDeClave: [tenantId, caseId],
        sistema,
        usuario,
        media: [presupuesto, ...imagenes],
        schema: LecturaPresupuestoSchema,
        limpiar: limpiarLectura,
      });
    }

    let guardada: LecturaGuardada | null = null;
    let monto: MontoEstimado | null = null;
    let motivo = "sinLeer" in resultado ? resultado.sinLeer : null;
    if ("ok" in resultado) {
      const nueva: LecturaGuardada = {
        lectura: resultado.ok,
        alertas: revisarPresupuesto(resultado.ok, rangoPara(caso.claim_type, caso.severity, rangos)),
        leido_en: new Date().toISOString(),
      };
      // La base sale de la tabla, no de lo guardado: un presupuesto anterior
      // no es la vara con la que se mide éste. Sólo un presupuesto razonable
      // toca el monto: la tabla ya la pone el worker, y pisar con ella borraría
      // uno anterior que sí lo era.
      const ajustado = ajustarConPresupuesto(estimarMonto(caso.claim_type, caso.severity, rangos), resultado.ok);
      const nuevoMonto = ajustado?.origen === "presupuesto" ? ajustado : null;
      const esteArchivo = and(
        eq(claimAttachments.id, attachmentId),
        eq(claimAttachments.case_id, caseId),
        sql`${claimAttachments.content_hash} IS NOT DISTINCT FROM ${adjunto.content_hash}`
      );
      const [actualizados, conMonto = []] = await enTenantVarias<[Array<{ id: string }>, Array<{ id: string }>?]>(
        { tenantId },
        (db) => [
          db
            .update(claimAttachments)
            .set({ lectura_presupuesto: nueva })
            .where(esteArchivo)
            .returning({ id: claimAttachments.id }),
          // Si mientras se leía cambió el tipo, la gravedad o el archivo, el
          // rango con que se midió ya no es el del caso; con el fraude o las
          // lesiones, el puntaje calculado tampoco.
          ...(nuevoMonto
            ? [
                db
                  .update(cases)
                  .set({
                    monto_estimado: nuevoMonto,
                    puntaje_complejidad: puntajeDelCaso(
                      { ...caso, monto_estimado: nuevoMonto },
                      camposDelPuntaje(tenant?.pesos, campos),
                      tenant?.pesos
                    ),
                  })
                  .where(
                    and(
                      eq(cases.id, caseId),
                      sql`${cases.claim_type} IS NOT DISTINCT FROM ${caso.claim_type}`,
                      sql`${cases.severity} IS NOT DISTINCT FROM ${caso.severity}`,
                      sql`${cases.fraud_risk_level} IS NOT DISTINCT FROM ${caso.fraud_risk_level}`,
                      sql`${cases.injury_severity} IS NOT DISTINCT FROM ${caso.injury_severity}`,
                      sql`exists (select 1 from ${claimAttachments} where ${esteArchivo})`
                    )
                  )
                  .returning({ id: cases.id }),
              ]
            : []),
        ]
      );
      if (actualizados.length > 0) {
        guardada = nueva;
        // Sólo el monto que de verdad quedó en el caso.
        monto = conMonto.length > 0 ? nuevoMonto : null;
      } else motivo = "archivo";
    }

    await writeAuditLog({
      tenant_id: tenantId,
      actor_id: userRow.id,
      event_type: AuditEvent.WORKSHOP_ESTIMATE_READ,
      target_type: "case",
      target_id: caseId,
      payload: { attachment_id: attachmentId, leido: motivo === null, motivo, alertas: guardada?.alertas.length ?? 0 },
    });

    return ok(
      guardada ? { leido: true, lectura_presupuesto: guardada, monto_estimado: monto } : { leido: false, motivo }
    );
  } catch (e) {
    return err(e);
  }
}
