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
import { enAltaDeAdmin } from "@/lib/auth/registro-permitido";
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

    /*
     * El alta de un admin no pasa por `SIGNUP_ALLOWED_EMAILS`.
     *
     * La lista existe para cerrar el AUTOREGISTRO: quien llega solo a
     * `/registro` o entra por Google por primera vez. Quien está acá ya pasó
     * por `requireAdmin`, y si además tuviera que estar en la lista, sumar a
     * alguien de afuera pediría un cambio de variable de entorno y un redeploy
     * para una operación que un admin tiene derecho a hacer.
     *
     * La marca viaja por `AsyncLocalStorage` y no por una variable de módulo:
     * el servidor atiende pedidos concurrentes y una bandera global la podría
     * leer el registro de un desconocido que llegó en el mismo instante.
     */
    const result = await enAltaDeAdmin(() =>
      auth.api.signUpEmail({
        body: { name: full_name, email, password },
        // No request headers — server-side creation skips cookie setting
        headers: new Headers(),
      })
    );

    const newUserId = result.user.id;

    /*
     * El perfil se INSERTA, no se actualiza.
     *
     * Antes esto era un UPDATE, y tocaba **cero filas**. El hook que crea el
     * perfil al dar de alta se saltea a quien no está en la lista blanca —y un
     * usuario recién creado por un admin nunca lo está—, así que no había fila
     * que actualizar. El resultado: el admin veía "usuario creado", la persona
     * podía entrar, y no llegaba a ningún dato. Sin un error en el medio, ni en
     * la pantalla ni en los registros.
     *
     * El admin ES la autoridad que aprueba a esta persona: eso es lo que
     * significa crearla desde acá. Por eso el perfil se crea en este punto, que
     * es exactamente el "un admin puede atacharla después" que describe
     * provision.ts.
     *
     * `onConflictDoUpdate` por si el hook SÍ corrió —si la dirección estaba en
     * la lista blanca— para que el rol y el inquilino que eligió el admin
     * ganen sobre los que puso el alta automática.
     *
     * Y cruza el borde entre inquilinos a propósito: toma a alguien que todavía
     * no es de ninguno y lo mete en el del admin.
     */
    // sin-inquilino: adentro de `enTenant` no vería la fila que va a crear —
    // el usuario nuevo todavía no pertenece a ningún inquilino.
    const perfil = await db
      .insert(users)
      .values({
        id: newUserId,
        tenant_id: adminRow.tenant_id,
        full_name,
        role,
      })
      .onConflictDoUpdate({
        target: users.id,
        set: { tenant_id: adminRow.tenant_id, full_name, role },
      })
      .returning({ id: users.id });

    // Que no vuelva a fallar en silencio. Si el perfil no quedó, la cuenta de
    // Better Auth existe y no sirve para nada: es peor que no haberla creado,
    // porque el admin cree que la persona ya tiene acceso.
    if (perfil.length === 0) {
      console.error("[admin/users POST] la cuenta se creó y el perfil no");
      return err(
        new AppError(
          "INTERNAL_ERROR",
          "La cuenta se creó pero no se le pudo asignar la aseguradora. " +
            "Avisá antes de que la persona intente entrar."
        )
      );
    }

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
