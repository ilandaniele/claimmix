/**
 * /api/admin/formulario-web — el formulario público de denuncias (B17).
 *
 * GET devuelve el enlace y si está encendido. PUT lo crea (con el `slug` que
 * elija el admin, o uno al azar) o lo enciende y apaga: el enlace no cambia una
 * vez creado. El inquilino sale de la sesión, nunca del pedido.
 */

import { NextRequest } from "next/server";
import { z } from "zod";

import { slugAlAzar, slugValido } from "@/core/web/formulario";
import { enTenant } from "@/data/scope";
import { ok, err } from "@/lib/api/respond";
import { writeAuditLog, AuditEvent } from "@/lib/audit/log";
import { requireAdmin } from "@/lib/auth/require-admin";
import { firstRow } from "@/lib/db/helpers";
import { AppError } from "@/lib/errors";
import { codigoPg, faltaLa0044 } from "@/server/core-sync/config";
import {
  consultaFormularioWeb,
  consultaGuardarFormularioWeb,
} from "@/server/web/formulario-del-inquilino";

export const dynamic = "force-dynamic";

const FormularioSchema = z
  .object({
    activo: z.boolean(),
    slug: z.string().trim().refine(slugValido).optional(),
  })
  .strict();

export async function GET() {
  try {
    const { userRow } = await requireAdmin();
    const formulario = firstRow(
      await enTenant({ tenantId: userRow.tenant_id }, (db) => consultaFormularioWeb(db)).catch(faltaLa0044)
    );
    return ok({ formulario: formulario ?? null });
  } catch (e) {
    return err(e);
  }
}

export async function PUT(request: NextRequest) {
  try {
    const { user, userRow } = await requireAdmin();
    const parsed = FormularioSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) throw new AppError("VALIDATION_FAILED", undefined, parsed.error.flatten());

    const tenantId = userRow.tenant_id;
    const slug = parsed.data.slug ?? slugAlAzar();
    let guardado;
    try {
      guardado = firstRow(
        await enTenant({ tenantId }, (db) =>
          consultaGuardarFormularioWeb(db, tenantId, { slug, activo: parsed.data.activo, userId: user.id })
        ).catch(faltaLa0044)
      );
    } catch (e) {
      // El único índice único que puede saltar sin ser el propio inquilino es el del enlace.
      if (codigoPg(e) === "23505") throw new AppError("VALIDATION_FAILED", "Ese enlace ya está en uso.");
      throw e;
    }
    if (!guardado) throw new AppError("INTERNAL_ERROR");

    await writeAuditLog({
      tenant_id: tenantId,
      actor_id: user.id,
      event_type: AuditEvent.FORMULARIO_WEB_CAMBIADO,
      target_type: "formulario_web",
      payload: { activo: guardado.activo },
    });

    return ok({ formulario: guardado });
  } catch (e) {
    return err(e);
  }
}
