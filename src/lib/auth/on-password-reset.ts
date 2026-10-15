/**
 * Lo que pasa cuando alguien termina de restablecer su contraseña.
 *
 * Las sesiones abiertas ya no están cuando esto corre: Better Auth las borra
 * antes de guardar la contraseña nueva (`revokeSessionsOnPasswordReset`, en
 * `src/lib/auth/index.ts`) y, si no puede, el restablecimiento falla antes de
 * llegar acá. Lo que queda es marcar el correo como verificado y anotar el
 * cambio. Nunca da perfil: eso lo hace /alta.
 *
 * Vive acá y no adentro de la configuración de Better Auth para poder probarlo
 * sin levantar la librería entera.
 */

import "server-only";

import { eq } from "drizzle-orm";

import { writeAuditLog, AuditEvent } from "@/lib/audit/log";
import { db } from "@/lib/db";
import { authUsers, users } from "@/lib/db/schema";
import { logger } from "@/lib/observability/logger";
import { espejarSinFallar } from "@/server/bases/espejar-sin-fallar";
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

export async function onPasswordReset(user: { id: string; email?: string; name?: string }): Promise<void> {
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

    // La marca del correo se escribió en control; la copia del cliente se pone al día acá, que es donde ya hay inquilino.
    await espejarSinFallar(perfil.tenant_id);

    await writeAuditLog({
      tenant_id: perfil.tenant_id,
      actor_id: user.id,
      event_type: AuditEvent.PASSWORD_RESET_COMPLETED,
      target_type: "user",
      target_id: user.id,
      /*
       * Sin esto, en el registro no se distingue una recuperación de un cambio
       * hecho por un admin. Y si alguien pregunta «¿me sacaron al que me había
       * entrado?», la respuesta está en el historial: las cerró todas Better
       * Auth antes de guardar la contraseña nueva.
       */
      payload: { sesiones_cerradas: "todas" },
    });
  } catch {
    // Que no se pueda anotar no puede impedirle a alguien volver a entrar.
  }
}
