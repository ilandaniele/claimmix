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
 * Falla cerrado: sin ADMIN_EMAILS configurado no hay operador, y la pantalla no
 * la ve nadie. Una lista de clientes que se abre sola cuando falta una variable
 * es exactamente la clase de error que nadie mira hasta que ya pasó.
 */

import "server-only";
import { requireAdmin, type AdminContext } from "@/lib/auth/require-admin";
import { AppError } from "@/lib/errors";

/** Las direcciones que operan el producto, normalizadas. */
export function operatorEmails(): string[] {
  return (process.env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

export function isOperatorEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  const allowed = operatorEmails();
  if (allowed.length === 0) return false;
  return allowed.includes(email.trim().toLowerCase());
}

/**
 * Sesión de admin Y dirección de operador.
 *
 * @throws AppError('MISSING_SESSION') — sin sesión
 * @throws AppError('FORBIDDEN_ROLE')  — con sesión, sin ser operador
 */
export async function requireOperator(): Promise<AdminContext> {
  const ctx = await requireAdmin();
  if (!isOperatorEmail(ctx.user.email)) {
    throw new AppError("FORBIDDEN_ROLE");
  }
  return ctx;
}
