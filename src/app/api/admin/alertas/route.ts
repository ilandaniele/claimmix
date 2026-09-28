/**
 * PATCH /api/admin/alertas — la lista de direcciones que avisa a un especialista.
 *
 * Sin GET: la lista inicial llega a /configuracion como prop del servidor
 * (`listaDelTenant`), así que no hace falta pedirla por acá.
 */

import { NextRequest } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { requireAdmin } from "@/lib/auth/require-admin";
import { enTenant } from "@/data/scope";
import { tenants } from "@/lib/db/schema";
import { ok, err } from "@/lib/api/respond";
import { AppError } from "@/lib/errors";
import { writeAuditLog, AuditEvent } from "@/lib/audit/log";
import { vedadaParaAlertas } from "@/lib/email/reserved";

export const dynamic = "force-dynamic";

const PatchSchema = z.object({
  emails: z.array(z.string().trim().toLowerCase().email().max(254)).max(10),
});

export async function PATCH(request: NextRequest) {
  try {
    const { user, userRow } = await requireAdmin();
    const body = await request.json().catch(() => null);
    const parsed = PatchSchema.safeParse(body);
    if (!parsed.success) throw new AppError("VALIDATION_FAILED", undefined, parsed.error.flatten());

    const lista = [...new Set(parsed.data.emails)];
    if (lista.some(vedadaParaAlertas)) {
      throw new AppError("VALIDATION_FAILED", "Esa dirección no puede recibir avisos.");
    }

    const tenantId = userRow.tenant_id; // nunca del body
    try {
      await enTenant({ tenantId }, (db) =>
        db.update(tenants)
          .set({ specialist_alert_emails: lista })
          .where(eq(tenants.id, tenantId))
      );
    } catch (e) {
      const code = (e as { code?: string })?.code;
      if (code === "42703" || code === "42P01") {
        throw new AppError("VALIDATION_FAILED", "Falta aplicar la migración 0034 (avisos por aseguradora).");
      }
      throw e;
    }

    await writeAuditLog({
      tenant_id: tenantId,
      actor_id: user.id,
      event_type: AuditEvent.SPECIALIST_ALERT_RECIPIENTS_CHANGED,
      target_type: "tenant",
      target_id: tenantId,
      payload: { count: lista.length }, // conteo, nunca las direcciones
    });

    return ok({ emails: lista });
  } catch (e) {
    return err(e);
  }
}
