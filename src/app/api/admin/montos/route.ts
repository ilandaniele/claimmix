/**
 * PATCH /api/admin/montos — la tabla propia de montos orientativos por tipo y
 * gravedad (B23). `null` vuelve a la de por defecto.
 *
 * Sin GET: la tabla inicial llega a /configuracion como prop del servidor. Los
 * montos son para el equipo; no salen al asegurado.
 */

import { NextRequest } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";

import { RangosDeMontoSchema } from "@/core/case/monto-estimado";
import { enTenant } from "@/data/scope";
import { ok, err } from "@/lib/api/respond";
import { writeAuditLog, AuditEvent } from "@/lib/audit/log";
import { requireAdmin } from "@/lib/auth/require-admin";
import { tenants } from "@/lib/db/schema";
import { AppError } from "@/lib/errors";
import { faltaLa0040 } from "@/server/core-sync/config";

const PatchSchema = z.object({ rangos: RangosDeMontoSchema.nullable() }).strict();

export async function PATCH(request: NextRequest) {
  try {
    const { user, userRow } = await requireAdmin();
    const parsed = PatchSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) throw new AppError("VALIDATION_FAILED", undefined, parsed.error.flatten());

    const rangos = parsed.data.rangos;
    const tenantId = userRow.tenant_id; // nunca del body
    await enTenant({ tenantId }, (db) =>
      db.update(tenants).set({ rangos_de_monto: rangos }).where(eq(tenants.id, tenantId))
    ).catch(faltaLa0040);

    await writeAuditLog({
      tenant_id: tenantId,
      actor_id: user.id,
      event_type: AuditEvent.AMOUNT_RANGES_CHANGED,
      target_type: "tenant",
      target_id: tenantId,
      payload: { por_defecto: rangos === null },
    });

    return ok({ rangos });
  } catch (e) {
    return err(e);
  }
}
