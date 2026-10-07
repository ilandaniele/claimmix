/**
 * Cerrar las sesiones de un usuario.
 *
 * La usan el restablecimiento de contraseña y el panel de admin. Tira ante un
 * error a propósito: la ruta de admin no puede auditar «0 sesiones cerradas»
 * como un éxito. Quien necesite seguir pase lo que pase (el restablecimiento)
 * envuelve la llamada en su propio try/catch.
 *
 * No invalida el caché de cookie de Better Auth (`cookieCache`, 60 s): es de la
 * librería y vence solo, así que una sesión borrada puede seguir valiendo hasta
 * un minuto en la pestaña de quien la tenía abierta.
 */

import "server-only";

import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { sessions } from "@/lib/db/schema";

/** Borra las sesiones del usuario y devuelve cuántas eran. */
export async function cerrarSesiones(userId: string): Promise<number> {
  // sin-inquilino: la tabla de sesiones de Better Auth no tiene columna de
  // inquilino; la clave es el usuario, que ya vino identificado por quien llama.
  const borradas = await db
    .delete(sessions)
    .where(eq(sessions.userId, userId))
    .returning({ id: sessions.id });
  return borradas.length;
}
