/**
 * GET  /api/admin/users  — list analysts in the current tenant (role=admin only)
 * POST /api/admin/users  — create a new user via Better Auth (role=admin only)
 *
 * NOTE: POST creates the auth user then updates the profile to the correct tenant/role.
 * The user receives a confirmation email from Better Auth (if email is configured).
 */

import { and, eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { z } from "zod";

import { requireAdmin } from "@/lib/auth/require-admin";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { enTenant, type TenantContext } from "@/data/scope";
import { authUsers, users } from "@/lib/db/schema";
import { ok, err } from "@/lib/api/respond";
import { AppError } from "@/lib/errors";

// ── GET /api/admin/users ──────────────────────────────────────────────────────

export async function GET() {
  try {
    const { userRow } = await requireAdmin();
    // Las consultas de acá ya no llevan filtro por inquilino: lo pone la base.
    // Este contexto es lo único que le dice de quién son los datos.
    const tenantCtx: TenantContext = { tenantId: userRow.tenant_id };

    const rows = await enTenant(tenantCtx, (db) =>
      db
        .select({
          id: users.id,
          full_name: users.full_name,
          role: users.role,
          created_at: users.created_at,
          email: authUsers.email,
        })
        .from(users)
        .leftJoin(authUsers, eq(users.id, authUsers.id))
        .orderBy(users.created_at)
    );

    return ok({
      users: rows.map((r) => ({
        id: r.id,
        full_name: r.full_name,
        email: r.email ?? "",
        role: r.role,
        created_at: r.created_at,
      })),
    });
  } catch (e) {
    return err(e);
  }
}

// ── POST /api/admin/users ─────────────────────────────────────────────────────

const CreateUserSchema = z.object({
  full_name: z.string().min(2).max(100),
  email: z.string().email(),
  role: z.enum(["owner", "admin", "specialist", "analyst", "viewer"]),
  password: z.string().min(8).optional(),
});

export async function POST(request: NextRequest) {
  try {
    const { userRow: adminRow } = await requireAdmin();

    const body = await request.json();
    const parsed = CreateUserSchema.safeParse(body);
    if (!parsed.success) {
      throw new AppError("VALIDATION_FAILED", undefined, parsed.error.flatten());
    }

    const { full_name, email, role } = parsed.data;
    if (role === "owner" && adminRow.role !== "owner") {
      throw new AppError(
        "FORBIDDEN_ROLE",
        "Solo un owner puede crear usuarios owner."
      );
    }

    // Generate a temporary password if none provided
    const password = parsed.data.password ?? crypto.randomUUID().replace(/-/g, "");

    // Create auth user via Better Auth
    const result = await auth.api.signUpEmail({
      body: { name: full_name, email, password },
      // No request headers — server-side creation skips cookie setting
      headers: new Headers(),
    });

    const newUserId = result.user.id;

    // Update the provisioned profile to the admin's tenant and the requested role
    // sin-inquilino: Ésta es justamente la operación que CRUZA el borde: toma un usuario
    // recién dado de alta —que todavía no es de ningún inquilino— y lo mete
    // en el del admin. Adentro de `enTenant` no vería la fila que va a mover.
    await db
      .update(users)
      .set({ tenant_id: adminRow.tenant_id, full_name, role })
      .where(and(eq(users.id, newUserId)));

    return ok(
      {
        id: newUserId,
        email,
        full_name,
        role,
        message: "Usuario creado. La contraseña temporal debe ser cambiada en el primer inicio de sesión.",
      },
      201
    );
  } catch (e) {
    if (e instanceof AppError) return err(e);
    console.error("[admin/users POST]", e instanceof Error ? e.message : "unknown");
    return err(new AppError("INTERNAL_ERROR", "No se pudo crear el usuario."));
  }
}
