/**
 * requireOperator — la guarda de "esto es nuestro, no del cliente".
 *
 * Casi todo en /admin es del asegurador: sus usuarios, sus casos, su factura.
 * Hay una pantalla que no lo es —la lista de clientes, que cruza tenants— y
 * mostrársela a un admin de un asegurador sería contarle quiénes son los otros
 * y cuánto pagan. Eso no es un permiso más fino del mismo rol: es otro papel.
 *
 * El papel ya existía sin nombre, en `ADMIN_EMAILS`: la variable que dice qué
 * direcciones se promueven a admin al entrar, y que en producción tiene una
 * sola, la nuestra. Se reutiliza como identidad del operador en vez de inventar
 * un rol nuevo en la base — un rol nuevo hay que administrarlo, y lo primero
 * que pasa con un rol que nadie administra es que alguien lo tiene de más.
 *
 * Dos condiciones, no una: sesión de admin Y dirección del operador. Si mañana
 * alguien agrega su casilla a ADMIN_EMAILS para entrar a probar algo, entra
 * como admin de su tenant y no como dueño de la lista de clientes.
 *
 * Y la dirección tiene que estar verificada: un admin de un asegurador puede
 * crear un usuario con cualquier mail, así que el texto solo no prueba nada.
 *
 * Y el espacio tiene que ser el de la casa. Con el alta automática cualquiera
 * abre un espacio propio y queda como dueño; si esa persona tiene una dirección
 * de ADMIN_EMAILS (porque alguien la agregó para probar), la sesión de admin y
 * la dirección alcanzaban para ver y tocar los espacios de todos. Las altas
 * cruzan inquilinos y escriben con el rol dueño: sólo las abre quien es
 * operador DESDE el inquilino por defecto.
 *
 * Falla cerrado: sin ADMIN_EMAILS configurado no hay operador, y la pantalla no
 * la ve nadie. Una lista de clientes que se abre sola cuando falta una variable
 * es exactamente la clase de error que nadie mira hasta que ya pasó.
 */

import "server-only";
import { requireAdmin, type AdminContext } from "@/lib/auth/require-admin";
import { resolveDefaultTenantId } from "@/lib/auth/provision";
import { AppError } from "@/lib/errors";
import { operatorEmails } from "@/lib/auth/operator-emails";

export { operatorEmails };

export function isOperatorEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  const allowed = operatorEmails();
  if (allowed.length === 0) return false;
  return allowed.includes(email.trim().toLowerCase());
}

/**
 * Las tres condiciones de operador que no necesitan leer la base: dirección
 * verificada, dirección de `ADMIN_EMAILS` y espacio de la casa.
 *
 * Es la regla de `requireOperator` sin la sesión, para que la barra lateral
 * ofrezca «Cartera» y «Altas» con el mismo criterio con que las pantallas las
 * abren: un enlace que la guarda va a rechazar no se muestra.
 */
export function esOperadorDe(
  user: { email?: string | null; emailVerified?: boolean | null },
  tenantId: string | null | undefined
): boolean {
  // La dirección tiene que estar probada, no sólo tipeada: mismo criterio que provision.ts.
  if (user.emailVerified !== true || !isOperatorEmail(user.email)) return false;
  // Sin inquilino por defecto configurado no hay casa: falla cerrado, como ADMIN_EMAILS.
  const casa = resolveDefaultTenantId()?.trim().toLowerCase();
  return !!casa && !!tenantId && tenantId.trim().toLowerCase() === casa;
}

/**
 * Sesión de admin Y dirección de operador verificada Y espacio por defecto.
 *
 * @throws AppError('MISSING_SESSION') — sin sesión
 * @throws AppError('FORBIDDEN_ROLE')  — con sesión, sin ser operador, o sin mail verificado
 */
export async function requireOperator(): Promise<AdminContext> {
  const ctx = await requireAdmin();
  if (!esOperadorDe(ctx.user, ctx.userRow.tenant_id)) {
    throw new AppError("FORBIDDEN_ROLE");
  }
  return ctx;
}
