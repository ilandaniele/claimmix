import { ingresoPorSso } from "./registro-permitido";
import "server-only";

import { eq } from "drizzle-orm";

import { dominioDelMail } from "@/core/sso";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { enControl } from "@/data/scope";
import { logger } from "@/lib/observability/logger";
import { espejarSinFallar } from "@/server/bases/espejar-sin-fallar";

interface NewAuthUser {
  id: string;
  name: string;
  email: string;
  emailVerified?: boolean;
}

/**
 * Emails that are provisioned as admins on first sign-in (comma-separated in
 * ADMIN_EMAILS). Case-insensitive. Son las direcciones del operador del producto.
 *
 * Aplica a `users.role`, que es el rol de la aplicación y el único que hay.
 * Antes se escribía además el rol paralelo de Better Auth para que el plugin
 * admin coincidiera; ese plugin ya no se monta.
 */
function esDireccionDeOperador(email: string | null | undefined): boolean {
  const raw = process.env.ADMIN_EMAILS;
  if (!raw || !email) return false;
  const allowed = raw
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return allowed.includes(email.trim().toLowerCase());
}

/**
 * SECURITY: requires a VERIFIED email. email/password signup runs with
 * requireEmailVerification=false, so `user.email` on that path is attacker-
 * controlled and unproven. Without the emailVerified gate, anyone could
 * pre-register an allowlisted address that has no account yet and be granted
 * admin. Google sign-in sets emailVerified=true (Google proves ownership), so
 * the intended admins still auto-promote.
 */
function isAllowlistedAdmin(email: string | null | undefined, emailVerified: boolean | undefined): boolean {
  return emailVerified === true && esDireccionDeOperador(email);
}

export function resolveDefaultTenantId(): string | null {
  return (
    process.env.GOOGLE_DEFAULT_TENANT_ID ??
    process.env.DEFAULT_TENANT_ID ??
    process.env.GMAIL_TENANT_ID ??
    null
  );
}

/**
 * Creates the public.users profile row for a freshly created Better Auth user,
 * but only for the two people who already belong somewhere: the member who
 * arrives by their company's SSO, and the product operator. Runs as a
 * databaseHooks user.create.after hook. The existence guard keeps it idempotent.
 *
 * Todos los demás (Google nuevo, alta por correo, invitación) quedan SIN perfil
 * y siguen a `/alta`, que crea su propio espacio. Ninguna cuenta nueva cae en el
 * inquilino por omisión: ese es el espacio de producción, con casos reales.
 *
 * Membership in the tenant is the profile row: an account without one resolves
 * no tenant, so every page redirects and every API returns 401. That makes
 * withholding it the fail-safe way to refuse an unapproved signup.
 */
export async function provisionUserProfile(user: NewAuthUser): Promise<void> {
  // sin-inquilino: Pregunta si el perfil ya existe, antes de que haya inquilino alguno.
  // Es el alta: el contexto todavía no existe.
  const existing = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, user.id))
    .limit(1);
  if (existing.length > 0) return;

  /*
   * Alta por el SSO de un inquilino: entra al inquilino del `state`, como
   * `viewer`, y nunca como admin aunque el mail esté en ADMIN_EMAILS. Quien
   * necesite más rol lo recibe de un admin desde /admin/users. Sin el dominio
   * verificado por el IdP no hay perfil, que es la forma segura de negarse.
   *
   * Una dirección de operador tampoco queda en el espacio de una aseguradora:
   * el operador vive en la plataforma, y si apareciera como miembro de otra
   * organización su dirección dejaría de ser sólo nuestra.
   */
  const sso = ingresoPorSso();
  if (sso) {
    if (!user.emailVerified || dominioDelMail(user.email) !== sso.dominio) return;
    if (esDireccionDeOperador(user.email)) {
      logger.warn({ email_domain: user.email.slice(user.email.indexOf("@")) }, "auth.signup.operador_en_sso");
      return;
    }
    await enControl({ tenantId: sso.tenantId }, (db) =>
      db.insert(users).values({
        id: user.id,
        tenant_id: sso.tenantId,
        full_name: user.name || user.email,
        role: "viewer",
      })
    );
    await espejarSinFallar(sso.tenantId);
    return;
  }

  // Sin perfil: la persona sigue a /alta o a su invitación. No es un error.
  if (!isAllowlistedAdmin(user.email, user.emailVerified)) return;

  const tenantId = resolveDefaultTenantId();
  if (!tenantId) {
    throw new Error(
      "GOOGLE_DEFAULT_TENANT_ID (or DEFAULT_TENANT_ID / GMAIL_TENANT_ID) is required to provision the operator",
    );
  }

  await enControl({ tenantId }, (db) =>
    db.insert(users).values({
      id: user.id,
      tenant_id: tenantId,
      full_name: user.name || user.email || "Operador",
      role: "admin",
    })
  );
  await espejarSinFallar(tenantId);

  /*
   * Acá se escribía además `authUsers.role = "admin"`, para que el plugin admin
   * de Better Auth coincidiera con `requireAdmin`.
   *
   * Ese plugin ya no se monta —montaba quince endpoints que cruzan
   * aseguradoras, incluido `impersonate-user`; ver `src/lib/auth/index.ts`— así
   * que la columna no la lee nadie. Seguir escribiéndola dejaría en la base un
   * segundo modelo de rol sin dueño, que es exactamente la trampa que se sacó:
   * el día que alguien vuelva a montar el plugin, esas filas ya estarían
   * marcadas.
   *
   * El rol de la aplicación es `users.role`, la fila que se acaba de insertar.
   */
}
