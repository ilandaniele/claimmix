/**
 * GET /api/cases/:id/attachments/:attachmentId — abre un adjunto guardado.
 *
 * Streamea los bytes con `abrirAdjunto`: un Buffer entero choca contra el
 * tope de 4.5 MB de una función de Vercel, y un adjunto llega a pesar 10 MB.
 *
 * Auth: sólo los roles que editan el caso. `pii.ts` enmascara la conversación
 * para viewer, y los bytes de un archivo no se pueden enmascarar.
 *
 * Un id mal formado, un adjunto de otro caso, de otro inquilino, o uno sin
 * `storage_path` dan el mismo 404 — distinguirlos sería un oráculo. No hay
 * una consulta separada de «el caso es del inquilino»: RLS más `case_id`
 * alcanza, y una consulta de más no suma nada.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { CASE_EDITOR_ROLES } from "@/lib/auth/require-role";
import { entrar } from "@/lib/api/entrada";
import { enTenant, type TenantContext } from "@/data/scope";
import { firstRow } from "@/lib/db/helpers";
import { claimAttachments } from "@/lib/db/schema";
import { err } from "@/lib/api/respond";
import { AppError } from "@/lib/errors";
import { RATE_LIMIT_CONFIGS } from "@/lib/rate-limit/index";
import { validateContentType } from "@/server/email/attachment-validator";
import { abrirAdjunto } from "@/server/storage/claim-attachments-bucket";

export const dynamic = "force-dynamic";

const Params = z.object({ id: z.string().uuid(), attachmentId: z.string().uuid() });

/** Tipos que el navegador puede mostrar sin bajarlos. */
const INLINE = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "application/pdf",
]);

/**
 * El nombre para `Content-Disposition`, en las dos formas que pide la RFC:
 * `filename` con un ascii seguro de respaldo, y `filename*` con el nombre de
 * verdad. `encodeURIComponent` deja el segundo sin CR, LF ni comillas —son
 * justo los caracteres con los que se inyectaría un header nuevo—, así que la
 * seguridad no depende de que el primero los cubra a mano; igual los reemplaza,
 * porque un visor viejo que sólo lee `filename` no decodifica nada.
 */
function nombreParaDisposition(fileName: string): string {
  const ascii = fileName.replace(/[\x00-\x1F\x7F"\\]|[^\x20-\x7E]/g, "_");
  return `filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

export async function GET(
  _req: NextRequest,
  context: { params: Promise<{ id: string; attachmentId: string }> }
) {
  try {
    const { ctx, rl } = await entrar(
      "attachment-download",
      RATE_LIMIT_CONFIGS.CASES_API,
      ...CASE_EDITOR_ROLES
    );
    if (!rl.allowed) return err(new AppError("RATE_LIMITED"));

    const parsed = Params.safeParse(await context.params);
    if (!parsed.success) return err(new AppError("NOT_FOUND"));
    const { id: caseId, attachmentId } = parsed.data;

    const tenantCtx: TenantContext = { tenantId: ctx.userRow.tenant_id };

    const fila = firstRow(
      await enTenant(tenantCtx, (db) =>
        db
          .select({
            storage_path: claimAttachments.storage_path,
            content_type: claimAttachments.content_type,
            file_name: claimAttachments.file_name,
          })
          .from(claimAttachments)
          .where(
            and(
              eq(claimAttachments.id, attachmentId),
              eq(claimAttachments.case_id, caseId),
              isNotNull(claimAttachments.storage_path),
              isNull(claimAttachments.rejected_reason)
            )
          )
          .limit(1)
      )
    );
    if (!fila || !fila.storage_path) return err(new AppError("NOT_FOUND"));

    const objeto = await abrirAdjunto(fila.storage_path);
    if (!objeto) return err(new AppError("NOT_FOUND"));

    const tipo = validateContentType(fila.content_type).allowed
      ? fila.content_type
      : "application/octet-stream";
    const inline = INLINE.has(tipo);

    const headers: Record<string, string> = {
      "Content-Type": tipo,
      "Content-Disposition": `${inline ? "inline" : "attachment"}; ${nombreParaDisposition(fila.file_name)}`,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
    };
    if (objeto.largo !== undefined) headers["Content-Length"] = String(objeto.largo);

    // El PDF va sin `sandbox`: Chromium no renderiza un PDF adentro de un
    // documento sandboxeado. El resto sí lo lleva.
    if (tipo !== "application/pdf") {
      headers["Content-Security-Policy"] =
        "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox";
    }

    return new NextResponse(objeto.cuerpo, { status: 200, headers });
  } catch (e) {
    return err(e);
  }
}
