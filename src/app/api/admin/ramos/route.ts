/**
 * /api/admin/ramos — los tipos de siniestro propios de la aseguradora (B26).
 *
 * GET lista los ramos y el catálogo de documentos y datos que se pueden pedir;
 * PUT crea o cambia uno; DELETE (`?clave=`) lo borra. Los casos que ya lo usan
 * siguen mostrándolo con la clave humanizada: borrar un ramo no toca casos.
 * Con la clave de un ramo del código, la fila cambia sólo los documentos que se
 * piden. El inquilino sale de la sesión, nunca del pedido.
 */

import { NextRequest } from "next/server";
import { z } from "zod";

import { CATALOGO_DE_DOCUMENTOS } from "@/core/case/required-docs";
import { CATALOGO_DE_DATOS } from "@/core/case/required-fields";
import { TOPE_DE_RAMOS_PROPIOS, esRamoNativo, type RamoDelInquilino } from "@/core/case/ramos";
import { sinControlNiAngulares } from "@/core/text/sin-control";
import { enTenant } from "@/data/scope";
import { ok, err } from "@/lib/api/respond";
import { writeAuditLog, AuditEvent } from "@/lib/audit/log";
import { requireAdmin } from "@/lib/auth/require-admin";
import { firstRow } from "@/lib/db/helpers";
import { ClaveDeRamoSchema } from "@/lib/schemas/cases";
import { AppError } from "@/lib/errors";
import {
  consultaBorrarRamo,
  consultaGuardarRamo,
  consultaRamosDelInquilino,
} from "@/server/cases/ramos-del-inquilino";
import { faltaLa0044 } from "@/server/core-sync/config";

export const dynamic = "force-dynamic";

// Sin saltos ni `<`/`>`: el nombre viaja al prompt entre centinelas y a los mails.
const Nombre = z
  .string()
  .trim()
  .min(1)
  .max(60)
  .refine(sinControlNiAngulares, "caracteres no permitidos");

const elementosDe = (catalogo: readonly string[]) =>
  z
    .array(z.enum(catalogo as [string, ...string[]]))
    .max(20)
    .transform((xs) => [...new Set(xs)]);

const RamoSchema = z
  .object({
    clave: ClaveDeRamoSchema,
    nombre_es: Nombre,
    nombre_en: Nombre,
    documentos: elementosDe(CATALOGO_DE_DOCUMENTOS).default([]),
    datos: elementosDe(CATALOGO_DE_DATOS).default([]),
  })
  .strict()
  // Con la clave de un ramo del código la fila sólo cambia sus documentos (0044): nombre y datos son los del código.
  .transform((r) => (esRamoNativo(r.clave) ? { ...r, datos: [] } : r));

export async function GET() {
  try {
    const { userRow } = await requireAdmin();
    const ramos = await enTenant<RamoDelInquilino[]>({ tenantId: userRow.tenant_id }, (db) =>
      consultaRamosDelInquilino(db)
    ).catch(faltaLa0044);
    return ok({
      ramos,
      tope: TOPE_DE_RAMOS_PROPIOS,
      catalogo: { documentos: CATALOGO_DE_DOCUMENTOS, datos: CATALOGO_DE_DATOS },
    });
  } catch (e) {
    return err(e);
  }
}

export async function PUT(request: NextRequest) {
  try {
    const { user, userRow } = await requireAdmin();
    const parsed = RamoSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) throw new AppError("VALIDATION_FAILED", undefined, parsed.error.flatten());

    const tenantId = userRow.tenant_id;
    const guardado = firstRow(
      await enTenant({ tenantId }, (db) => consultaGuardarRamo(db, tenantId, parsed.data)).catch(
        faltaLa0044
      )
    );
    // Vacío: el inquilino ya tiene el tope y la clave es nueva.
    if (!guardado) {
      throw new AppError(
        "VALIDATION_FAILED",
        `Se alcanzó el máximo de ${TOPE_DE_RAMOS_PROPIOS} tipos propios.`
      );
    }

    await writeAuditLog({
      tenant_id: tenantId,
      actor_id: user.id,
      event_type: AuditEvent.RAMO_PROPIO_GUARDADO,
      target_type: "tenant_claim_type",
      payload: { clave: guardado.clave },
    });

    return ok({ ramo: parsed.data });
  } catch (e) {
    return err(e);
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const { user, userRow } = await requireAdmin();
    const parsed = ClaveDeRamoSchema.safeParse(request.nextUrl.searchParams.get("clave"));
    if (!parsed.success) throw new AppError("VALIDATION_FAILED");

    const tenantId = userRow.tenant_id;
    const borrado = firstRow(
      await enTenant({ tenantId }, (db) => consultaBorrarRamo(db, parsed.data)).catch(faltaLa0044)
    );
    if (!borrado) throw new AppError("NOT_FOUND");

    await writeAuditLog({
      tenant_id: tenantId,
      actor_id: user.id,
      event_type: AuditEvent.RAMO_PROPIO_BORRADO,
      target_type: "tenant_claim_type",
      payload: { clave: borrado.clave },
    });

    return ok({ clave: borrado.clave });
  } catch (e) {
    return err(e);
  }
}
