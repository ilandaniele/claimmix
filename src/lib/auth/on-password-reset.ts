/**
 * Lo que pasa cuando alguien termina de restablecer su contraseña.
 *
 * Dos cosas, y el orden importa: primero se cierran todas las sesiones
 * abiertas, después se anota. Nunca da perfil: eso lo hace /alta.
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
import { cerrarSesiones } from "@/lib/auth/sesiones";
import { db } from "@/lib/db";
import { authUsers, users } from "@/lib/db/schema";
import { logger } from "@/lib/observability/logger";
import { remitenteDelSistema } from "@/server/notify/remitente-sistema";

/**
 * Marcar el correo como verificado.
 *
 * Terminar un restablecimiento es exactamente la prueba que `emailVerified`
 * dice tener: el enlace llegó a esa casilla y quien lo abrió lo usó. Hasta
 * ahora la bandera quedaba en `false` para siempre, porque el alta no pide
 * verificar (`requireEmailVerification: false`) y nada más la tocaba.
 *
 * No es cosmético. Better Auth se niega a vincular una cuenta de Google a un
 * usuario local con el correo sin verificar —`requireLocalEmailVerified`, que
 * por omisión es `true`— así que quien se dio de alta con contraseña no podía
 * usar «Continuar con Google» nunca. Con esto, restablecer también destraba
 * ese camino, y lo destraba con la única prueba que sirve.
 *
 * **Sólo con el remitente del sistema.** Sin él, el enlace puede haber salido
 * por la casilla conectada de una aseguradora, que quien la administra puede
 * leer: abrirlo ya no prueba que la casilla sea de la persona. Mientras no esté
 * configurado, nada se marca.
 *
 * Nunca tira: que no se pueda marcar no puede impedirle a alguien volver a
 * entrar con su contraseña nueva.
 */
export async function marcarCorreoVerificado(userId: string): Promise<void> {
  if (!remitenteDelSistema()) {
    logger.warn({
        user_id: userId,
      }, "auth.reset.correo_sin_verificar_por_falta_de_remitente");
    return;
  }
  try {
    // sin-inquilino: la tabla de usuarios de Better Auth no tiene columna de
    // inquilino; la clave es el usuario, ya identificado por el token.
    await db
      .update(authUsers)
      .set({ emailVerified: true })
      .where(eq(authUsers.id, userId));
  } catch {
    logger.error({
        user_id: userId,
      }, "auth.reset.no_se_pudo_marcar_verificado");
  }
}

/**
 * Cierra las sesiones de un usuario y devuelve cuántas eran, o null si no se
 * pudieron cerrar.
 *
 * Nunca tira: que no se puedan cerrar es grave y se grita, pero no puede
 * impedirle a la persona volver a entrar con su contraseña nueva.
 */
async function cerrarSesionesDe(userId: string): Promise<number | null> {
  try {
    return await cerrarSesiones(userId);
  } catch {
    logger.error({
        user_id: userId,
      }, "auth.reset.no_se_pudieron_cerrar_las_sesiones");
    return null;
  }
}

export async function onPasswordReset(user: { id: string; email?: string; name?: string }): Promise<void> {
  const cerradas = await cerrarSesionesDe(user.id);
  const sesionesCerradas = cerradas ?? 0;
  await marcarCorreoVerificado(user.id);

  try {
    // sin-inquilino: se AVERIGUA de quién es la cuenta, igual que en el login.
    const [perfil] = await db
      .select({ tenant_id: users.tenant_id })
      .from(users)
      .where(eq(users.id, user.id))
      .limit(1);
    // Sin perfil no hay inquilino donde anotar. Restablecer nunca da perfil: eso
    // lo hace /alta, y sólo a quien eligió él mismo el espacio.
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
