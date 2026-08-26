/**
 * GET   /api/auth/me — current analyst's profile.
 *         { id, email, full_name, role, tenant_id, locale }
 * PATCH /api/auth/me — update own preferences. Body: { locale: "es-AR" | "en-US" }.
 *
 * Returns 401 if there is no active session.
 */

import { eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { getSessionContext } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";

const PatchMeSchema = z.object({
  locale: z.enum(["es-AR", "en-US"]),
});

export async function GET() {
  const session = await getSessionContext();
  if (!session?.user) {
    return NextResponse.json(
      { error: { code: "MISSING_SESSION", message: "Se requiere autenticación." } },
      { status: 401 }
    );
  }

  // sin-inquilino: Ésta es la consulta que AVERIGUA de qué inquilino es la sesión.
  // No puede pasar por una capa que necesita el dato que ella busca.
  const [userRow] = await db
    .select({
      id: users.id,
      tenant_id: users.tenant_id,
      full_name: users.full_name,
      role: users.role,
      locale: users.locale,
    })
    .from(users)
    .where(eq(users.id, session.user.id))
    .limit(1);

  if (!userRow) {
    return NextResponse.json(
      { error: { code: "NOT_FOUND", message: "El perfil del analista no fue encontrado." } },
      { status: 404 }
    );
  }

  return NextResponse.json({
    id: userRow.id,
    email: session.user.email,
    full_name: userRow.full_name,
    role: userRow.role,
    tenant_id: userRow.tenant_id,
    locale: userRow.locale ?? null,
  });
}

export async function PATCH(request: NextRequest) {
  const session = await getSessionContext();
  if (!session?.user) {
    return NextResponse.json(
      { error: { code: "MISSING_SESSION", message: "Se requiere autenticación." } },
      { status: 401 }
    );
  }

  const body = await request.json().catch(() => null);
  const parsed = PatchMeSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: {
          code: "VALIDATION_FAILED",
          message: "Parámetros inválidos.",
          details: parsed.error.flatten(),
        },
      },
      { status: 400 }
    );
  }

  // sin-inquilino: Mismo caso que arriba: la clave es el id de sesión, que es único
  // en toda la base, no dentro de un inquilino.
  await db
    .update(users)
    .set({ locale: parsed.data.locale })
    .where(eq(users.id, session.user.id));

  return NextResponse.json({ ok: true, persisted: true });
}
