import "server-only";

import { eq } from "drizzle-orm";
import { headers } from "next/headers";

import { writeAuditLog, AuditEvent } from "@/lib/audit/log";
import { auth } from "@/lib/auth";
import { getSessionContext } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";

/**
 * Revoca la sesión de Better Auth y deja la entrada de auditoría. No redirige: quien
 * llama decide cómo sale la persona (la action de la barra con `redirect`, la tarjeta de
 * antes del panel con una navegación de documento, ver /api/auth/salir).
 */
export async function cerrarSesion(): Promise<void> {
  const session = await getSessionContext();
  if (!session?.user) return;

  // sin-inquilino: ésta es la consulta que AVERIGUA de qué inquilino es quien sale, para dejar
  // la auditoría en su espacio; antes de leerla la sesión no trae ese dato.
  const [userRow] = await db
    .select({ tenant_id: users.tenant_id })
    .from(users)
    .where(eq(users.id, session.user.id))
    .limit(1);

  await writeAuditLog({
    tenant_id: userRow?.tenant_id ?? "00000000-0000-0000-0000-000000000000",
    actor_id: session.user.id,
    event_type: AuditEvent.AUTH_SIGN_OUT,
    target_type: "user",
    target_id: session.user.id,
    payload: {},
  });

  await auth.api.signOut({ headers: await headers() });
}
