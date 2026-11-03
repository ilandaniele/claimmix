/**
 * Admin — gestión de analistas.
 *
 * Server Component: fetches the user list and current analyst role.
 * Non-admin roles are redirected to /bandeja.
 */

import { eq } from "drizzle-orm";
import Link from "next/link";

import { rebotarSiNoEntra } from "@/lib/auth/rebotar-si-no-entra";
import { requireAdmin } from "@/lib/auth/require-admin";
import { esOperadorDe } from "@/lib/auth/require-operator";
import { enTenant, type TenantContext } from "@/data/scope";
import { authUsers, users } from "@/lib/db/schema";
import { AdminUsersClient } from "./AdminUsersClient";
import { getT } from "@/lib/i18n";
import { topeDeInvitacionesDelDia } from "@/server/alta/tope-de-invitaciones";
import { getAccountLocale } from "@/server/i18n/idioma-de-la-cuenta";
import { tituloDePantalla } from "@/app/(app)/_components/titulo-de-pantalla";

interface UserRow {
  id: string;
  full_name: string;
  email: string;
  role: UserRole;
  created_at: string;
  dado_de_baja_en: string | null;
}

type UserRole = "owner" | "admin" | "specialist" | "analyst" | "viewer";

export const generateMetadata = tituloDePantalla("admin.users.title");

export default async function AdminUsersPage() {
  const t = getT(await getAccountLocale());
  let ctx: Awaited<ReturnType<typeof requireAdmin>>;
  try {
    ctx = await requireAdmin();
  } catch (e) {
    rebotarSiNoEntra(e);
  }

  const { userRow } = ctx;
  // Las consultas de acá ya no llevan filtro por inquilino: lo pone la base.
  // Este contexto es lo único que le dice de quién son los datos.
  const tenantCtx: TenantContext = { tenantId: userRow.tenant_id };

  // Fetch all users in this tenant joined with auth_users for email
  const rows = await enTenant(tenantCtx, (db) =>
    db
      .select({
        id: users.id,
        full_name: users.full_name,
        role: users.role,
        created_at: users.created_at,
        dado_de_baja_en: users.dado_de_baja_en,
        email: authUsers.email,
        emailVerified: authUsers.emailVerified,
      })
      .from(users)
      .leftJoin(authUsers, eq(users.id, authUsers.id))
      .orderBy(users.created_at)
  );

  const initialUsers: UserRow[] = rows.map((r) => ({
    id: r.id,
    full_name: r.full_name,
    email: r.email ?? "",
    role: r.role as UserRole,
    created_at: r.created_at,
    dado_de_baja_en: r.dado_de_baja_en,
  }));

  // Sólo en el espacio de la casa y para quien opera: el cliente no tiene por qué ver quién nos opera ni dónde están los demás.
  const verOperacion = esOperadorDe(ctx.user, userRow.tenant_id);
  const [avisoAntes, avisoDespues] = t("usuarios.operacion.aviso").split("{altas}");
  const operacion = verOperacion
    ? {
        rotulo: t("usuarios.operacion.rotulo"),
        ids: rows.filter((r) => esOperadorDe(r, userRow.tenant_id)).map((r) => r.id),
      }
    : undefined;

  return (
    <div className="px-6 py-8 max-w-5xl">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">
            {t("usuarios.title")}
          </h1>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            {t("usuarios.subtitle")}
          </p>
        </div>
      </div>

      {verOperacion && (
        <p
          role="note"
          className="mb-6 rounded border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-900 dark:border-blue-900 dark:bg-blue-950/30 dark:text-blue-200"
        >
          {avisoAntes}
          <Link href="/admin/altas" className="font-medium underline">
            {t("nav.altas")}
          </Link>
          {avisoDespues}
        </p>
      )}

      <AdminUsersClient
        initialUsers={initialUsers}
        currentUserId={ctx.user.id}
        currentUserRole={userRow.role}
        emailAyuda={t("usuarios.form.emailAyuda")}
        textosEliminar={{
          boton: t("usuarios.eliminar.boton"),
          confirmar: t("usuarios.eliminar.confirmar"),
          hecho: t("usuarios.eliminar.hecho"),
          error: t("usuarios.eliminar.error"),
        }}
        topeDelLote={topeDeInvitacionesDelDia(userRow)}
        operacion={operacion}
      />
    </div>
  );
}
