/**
 * Lo que pasa cuando alguien termina de restablecer su contraseña.
 *
 * Dos cosas, y el orden importa: primero se cierran todas las sesiones
 * abiertas, después se anota.
 *
 * ── Por qué cerrar las sesiones ─────────────────────────────────────────────
 *
 * Es el motivo por el que alguien restablece: cree que le entraron. Hasta acá
 * la contraseña cambiaba y la sesión del que entró seguía viva —hasta treinta
 * días, que es lo que duran— así que el gesto que la persona hace para echar a
 * un intruso no lo echaba.
 *
 * Se puede borrar TODO sin dejar a nadie afuera de su propia cuenta porque este
 * flujo no loguea después de restablecer: `/restablecer` devuelve «listo» y
 * manda a iniciar sesión con la contraseña nueva.
 *
 * ── Por qué vive acá y no adentro de la configuración ───────────────────────
 *
 * Estaba escrito inline en el objeto que se le pasa a Better Auth, y ahí no se
 * puede probar sin levantar la librería entera. Lo que hace —cerrar sesiones,
 * anotar el evento, no romperse si algo de eso falla— es exactamente lo que un
 * test tiene que poder ejercer.
 */

import "server-only";

import { eq } from "drizzle-orm";

import { writeAuditLog, AuditEvent } from "@/lib/audit/log";
import { db } from "@/lib/db";
import { sessions, users } from "@/lib/db/schema";

/**
 * Cierra las sesiones de un usuario y devuelve cuántas eran.
 *
 * Nunca tira: que no se puedan cerrar es grave y se grita, pero no puede
 * impedirle a la persona volver a entrar con su contraseña nueva.
 */
async function cerrarSesionesDe(userId: string): Promise<number> {
  try {
    // sin-inquilino: la tabla de sesiones de Better Auth no tiene columna de
    // inquilino; la clave es el usuario, que ya vino identificado por el token
    // de recuperación.
    const borradas = await db
      .delete(sessions)
      .where(eq(sessions.userId, userId))
      .returning({ id: sessions.id });
    return borradas.length;
  } catch {
    console.error(
      JSON.stringify({
        level: "error",
        service: "claimmix",
        msg: "auth.reset.no_se_pudieron_cerrar_las_sesiones",
        user_id: userId,
      })
    );
    return 0;
  }
}

export async function onPasswordReset(user: { id: string }): Promise<void> {
  const sesionesCerradas = await cerrarSesionesDe(user.id);

  try {
    // sin-inquilino: se AVERIGUA de quién es la cuenta, igual que en el login.
    const [perfil] = await db
      .select({ tenant_id: users.tenant_id })
      .from(users)
      .where(eq(users.id, user.id))
      .limit(1);
    if (!perfil) return;

    await writeAuditLog({
      tenant_id: perfil.tenant_id,
      actor_id: user.id,
      event_type: AuditEvent.PASSWORD_RESET_COMPLETED,
      target_type: "user",
      target_id: user.id,
      /*
       * Cuántas sesiones se cerraron.
       *
       * Sin esto, en el registro no se distingue una recuperación de un cambio
       * hecho por un admin. Con esto, además, si alguien pregunta «¿me sacaron
       * al que me había entrado?», la respuesta está en el historial.
       */
      payload: { sesiones_cerradas: sesionesCerradas },
    });
  } catch {
    // Que no se pueda anotar no puede impedirle a alguien volver a entrar.
  }
}
