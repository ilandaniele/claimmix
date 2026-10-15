/**
 * POST /api/policies/:id/condiciones — sube el PDF de condiciones de una póliza
 * y lo lee una vez con el modelo: coberturas, sumas, franquicias y ámbito (B6).
 *
 * Multipart con un solo campo `archivo`, un PDF de hasta 4 MB. Con cupo de
 * subida, el PDF se guarda siempre y reemplaza al anterior; la lectura puede
 * no darse (sin cupo, sin presupuesto, el modelo no contestó) y entonces la
 * póliza queda «subida, sin leer», nunca con coberturas inventadas. Lo leído es sólo para el equipo: no sale al asegurado.
 *
 * Auth: los roles del padrón de clientes. El inquilino sale de la sesión.
 */

import { type NextRequest } from "next/server";
import { z } from "zod";
import { eq, sql } from "drizzle-orm";

import { CondicionesLeidasSchema, promptDeCondiciones } from "@/core/poliza/condiciones";
import { MAX_PAGINAS_PDF, normalizarMime, revisarAdjunto } from "@/core/adjuntos/firma";
import { enTenant } from "@/data/scope";
import { entrar } from "@/lib/api/entrada";
import { ok, err } from "@/lib/api/respond";
import { writeAuditLog, AuditEvent } from "@/lib/audit/log";
import { CUSTOMER_PII_ROLES } from "@/lib/auth/roles";
import { firstRow } from "@/lib/db/helpers";
import { policies } from "@/lib/db/schema";
import { AppError } from "@/lib/errors";
import { claveDeCupo } from "@/lib/rate-limit/clave";
import { rateLimit, RATE_LIMIT_CONFIGS } from "@/lib/rate-limit/index";
import { faltaLa0040 } from "@/server/core-sync/config";
import { leerDocumento } from "@/server/ai/leer-documento";
import { deleteAttachment, subirCondiciones } from "@/server/storage/claim-attachments-bucket";

export const maxDuration = 60;

// Vercel corta el cuerpo en 4,5 MB: más que esto no llega entero.
const TOPE_BYTES = 4 * 1024 * 1024;

const ParamsSchema = z.object({ id: z.guid("ID de póliza inválido.") });

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const params = ParamsSchema.safeParse(await context.params);
    if (!params.success) throw new AppError("VALIDATION_FAILED", params.error.issues[0]?.message);
    const policyId = params.data.id;

    const { ctx, rl } = await entrar("policy-conditions", RATE_LIMIT_CONFIGS.CASES_API, ...CUSTOMER_PII_ROLES);
    if (!rl.allowed) throw new AppError("RATE_LIMITED");
    const { userRow } = ctx;
    const tenantId = userRow.tenant_id; // nunca del cuerpo

    if (Number(request.headers.get("content-length") ?? 0) > TOPE_BYTES + 64 * 1024) {
      throw new AppError("ARCHIVO_DEMASIADO_GRANDE", "El PDF pesa más de 4 MB.");
    }
    const form = await request.formData().catch(() => null);
    const archivos = form?.getAll("archivo") ?? [];
    const archivo = archivos[0];
    if (archivos.length !== 1 || !(archivo instanceof File) || normalizarMime(archivo.type) !== "application/pdf") {
      throw new AppError("VALIDATION_FAILED", "Mandá un solo PDF en el campo «archivo».");
    }
    if (archivo.size > TOPE_BYTES) throw new AppError("ARCHIVO_DEMASIADO_GRANDE", "El PDF pesa más de 4 MB.");

    const bytes = Buffer.from(await archivo.arrayBuffer());
    const revision = revisarAdjunto(bytes, "application/pdf");
    if (!revision.ok) {
      throw new AppError(
        "ARCHIVO_NO_VALIDO",
        revision.reason === "too_many_pages"
          ? `El PDF tiene más de ${MAX_PAGINAS_PDF} páginas.`
          : "El archivo no es un PDF que se pueda leer."
      );
    }

    // Antes del modelo: no se gasta una lectura en una póliza de otro o que no existe.
    const poliza = firstRow(
      await enTenant({ tenantId }, (db) =>
        db
          .select({ policy_type: policies.policy_type, anterior: policies.condiciones_path })
          .from(policies)
          .where(eq(policies.id, policyId))
          .limit(1)
      ).catch(faltaLa0040)
    );
    if (!poliza) throw new AppError("NOT_FOUND", "La póliza no existe.");

    // El cupo de lectura se cuenta después de subir: éste frena el loop de
    // PDF distintos antes de que cada uno quede en el bucket.
    const cupo = await rateLimit(
      claveDeCupo("subida-condiciones", tenantId, policyId),
      RATE_LIMIT_CONFIGS.SUBIDA_CONDICIONES_POR_POLIZA
    ).catch(() => null);
    if (!cupo?.allowed) throw new AppError("RATE_LIMITED");

    const ruta = await subirCondiciones(tenantId, policyId, bytes);
    if (!ruta) throw new AppError("INTERNAL_ERROR", "No se pudo guardar el PDF.");

    const { sistema, usuario } = promptDeCondiciones(poliza.policy_type);
    const lectura = await leerDocumento({
      tenantId,
      userId: userRow.id,
      ambito: "condiciones-poliza",
      partesDeClave: [tenantId, policyId],
      sistema,
      usuario,
      media: [{ mimeType: "application/pdf", data: bytes.toString("base64") }],
      schema: CondicionesLeidasSchema,
    });

    // Sin lectura, lo leído de OTRO PDF no queda como si fuera de éste; el
    // mismo PDF subido de nuevo conserva su lectura.
    const mismoPdf = sql`${policies.condiciones_path} = ${ruta}`;
    const set =
      "ok" in lectura
        ? {
            coberturas: lectura.ok.coberturas,
            ambito_territorial: lectura.ok.ambito,
            condiciones_leidas_en: sql`now()`,
          }
        : {
            coberturas: sql`CASE WHEN ${mismoPdf} THEN ${policies.coberturas} END`,
            ambito_territorial: sql`CASE WHEN ${mismoPdf} THEN ${policies.ambito_territorial} END`,
            condiciones_leidas_en: sql`CASE WHEN ${mismoPdf} THEN ${policies.condiciones_leidas_en} END`,
          };

    const fila = firstRow(
      await enTenant({ tenantId }, (db) =>
        db
          .update(policies)
          .set({ ...set, condiciones_path: ruta, updated_at: sql`now()` })
          .where(eq(policies.id, policyId))
          .returning({ condiciones_leidas_en: policies.condiciones_leidas_en })
      ).catch(faltaLa0040)
    );
    if (!fila) throw new AppError("NOT_FOUND", "La póliza no existe.");
    // El PDF anterior ya no lo apunta nadie: la ruta lleva la póliza adentro.
    if (poliza.anterior && poliza.anterior !== ruta) await deleteAttachment(poliza.anterior);

    const motivo = "sinLeer" in lectura ? lectura.sinLeer : null;
    await writeAuditLog({
      tenant_id: tenantId,
      actor_id: userRow.id,
      event_type: AuditEvent.POLICY_CONDITIONS_UPLOADED,
      target_type: "policy",
      target_id: policyId,
      payload: { leido: motivo === null, motivo },
    });

    return ok({ subido: true, leido: motivo === null, motivo, condiciones_leidas_en: fila.condiciones_leidas_en });
  } catch (e) {
    return err(e);
  }
}
