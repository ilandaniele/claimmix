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
import { inquilinoDeAltaNueva } from "@/lib/auth/alta-nueva";
import { provisionUserProfile } from "@/lib/auth/provision";
import { cerrarSesiones } from "@/lib/auth/sesiones";
import { db } from "@/lib/db";
import { authUsers, users } from "@/lib/db/schema";
import { logger } from "@/lib/observability/logger";

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
 * Nunca tira: que no se pueda marcar no puede impedirle a alguien volver a
 * entrar con su contraseña nueva.
 */
async function marcarCorreoVerificado(userId: string): Promise<void> {
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

/**
 * Le da el perfil a quien se dio de alta sin contraseña y acaba de abrir el
 * enlace: la cuenta no tiene perfil porque su correo no estaba probado, y esto
 * es la prueba. Devuelve si quedó con perfil.
 *
 * Pasa por el mismo criterio que el gancho `user.create.before` (en la lista y
 * sin «Exigir SSO»), y `provisionUserProfile` vuelve a mirar la lista. Nunca
 * tira: que no se pueda crear no puede impedirle volver a entrar.
 */
async function darPerfil(user: { id: string; email?: string; name?: string }): Promise<boolean> {
  if (!user.email) return false;
  try {
    if (!(await inquilinoDeAltaNueva(user.email))) return false;
    await provisionUserProfile({
      id: user.id,
      name: user.name ?? "",
      email: user.email,
      emailVerified: true,
    });
    return true;
  } catch {
    logger.error({
        user_id: user.id,
      }, "auth.reset.no_se_pudo_dar_perfil");
    return false;
  }
}

export async function onPasswordReset(user: { id: string; email?: string; name?: string }): Promise<void> {
  const cerradas = await cerrarSesionesDe(user.id);
  const sesionesCerradas = cerradas ?? 0;
  await marcarCorreoVerificado(user.id);

  try {
    // sin-inquilino: se AVERIGUA de quién es la cuenta, igual que en el login.
    const buscarPerfil = () =>
      db
        .select({ tenant_id: users.tenant_id })
        .from(users)
        .where(eq(users.id, user.id))
        .limit(1);
    let [perfil] = await buscarPerfil();
    /*
     * El perfil sólo se da si la cuenta no tenía sesiones. Quien se dio de alta
     * sin contraseña nunca entró: la contraseña la puso la app y nadie la sabía.
     * Una cuenta sin perfil CON sesiones la abrió alguien que eligió la
     * contraseña antes que su dueño (un pre-registro), y el caché de cookie de
     * Better Auth (60 s) le seguiría valiendo ante el perfil recién creado. Sin
     * poder contarlas tampoco: ante la duda, un admin la adjunta a mano.
     */
    const puedeDarPerfil = cerradas === 0;
    if (!perfil && !puedeDarPerfil) {
      logger.warn({ user_id: user.id, sesiones_cerradas: cerradas }, "auth.reset.perfil_no_dado_con_sesiones");
    }
    const perfilCreado = !perfil && puedeDarPerfil && (await darPerfil(user));
    if (perfilCreado) [perfil] = await buscarPerfil();
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
      payload: perfilCreado
        ? { sesiones_cerradas: sesionesCerradas, perfil_creado: true }
        : { sesiones_cerradas: sesionesCerradas },
    });
  } catch {
    // Que no se pueda anotar no puede impedirle a alguien volver a entrar.
  }
}
