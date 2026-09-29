/**
 * GET /api/v1/cases/:id — un caso real con sus campos extraídos y documentos
 * faltantes, con la forma de export-to-core (B5).
 *
 * Un id de otro inquilino, o de un caso simulado o de prueba, no se distingue
 * de uno que no existe: da 404.
 *
 * Auth: la clave de la aseguradora (ver `../../_auth.ts`), no la sesión.
 */

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { enTenantVarias } from "@/data/scope";
import { err } from "@/lib/api/respond";
import { AppError } from "@/lib/errors";
import { consultasDelCaso, esCasoReal, type DelCaso } from "@/server/core-sync/lectura";
import { autenticarClave, SIN_CACHE } from "../../_auth";

export const dynamic = "force-dynamic";

const IdSchema = z.string().uuid("ID de caso inválido.");

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
): Promise<Response> {
  const ctx = await autenticarClave(request);
  if (ctx instanceof Response) return ctx;

  const id = IdSchema.safeParse((await context.params).id);
  if (!id.success) {
    return err(new AppError("VALIDATION_FAILED", id.error.issues[0]?.message), undefined, SIN_CACHE);
  }

  const [[caso], campos, docs] = await enTenantVarias<DelCaso>(ctx, (db) =>
    consultasDelCaso(db, id.data, esCasoReal)
  );
  if (!caso) return err(new AppError("NOT_FOUND"), undefined, SIN_CACHE);

  return NextResponse.json(
    { ...caso, extracted_fields: campos, missing_docs: docs, exported_at: new Date().toISOString() },
    { headers: SIN_CACHE }
  );
}
