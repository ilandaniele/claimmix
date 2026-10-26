/**
 * «Pedir acceso» de /alta: avisarle a quienes administran un espacio que una persona
 * de su mismo dominio quiere entrar.
 *
 * Lo dispara la Server Action `pedirAcceso`, que contesta lo mismo a todo el mundo y
 * agenda esto con `after()`. Todo lo que hace falta mirar (cupos, base, envío) pasa acá,
 * ya respondida la persona: ni la respuesta ni la pantalla pueden decir si hay un espacio
 * con ese dominio, porque /alta no revela qué empresas son clientes. Queda el canal de
 * tiempos teórico que describe docs/SEGURIDAD.md §11.12.
 *
 * El mail es de texto fijo y sale por el remitente del sistema. Lleva la dirección
 * verificada de quien pide, sola en su línea, y nuestro enlace a la pantalla de usuarios:
 * ni el nombre del espacio ni el de nadie. No guarda nada y no hay migración.
 *
 * Tres topes, todos por día (24 h) y con falla cerrada:
 *  - una persona, un pedido (`alta:acceso-persona`, contado sobre la dirección canónica
 *    para que los alias `+` y los puntos de Gmail no estrenen cupo);
 *  - cinco pedidos por espacio (`alta:acceso-espacio`), que es también lo máximo que recibe cada
 *    administrador, porque es de un solo espacio: el remitente no le suma un tope por dirección;
 *  - el global del tipo `acceso`, que cuenta el remitente.
 *
 * Nunca lanza, por lo mismo que `enviarCorreoDelSistema`. Y no registra ni la dirección,
 * ni el dominio, ni el espacio: sólo cuántos administradores había y a cuántos les salió.
 */

import "server-only";

import { and, eq, inArray, isNull, notExists, notInArray, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { cookies } from "next/headers";

import { dominioDeEmpresa } from "@/core/sso";
import { resolveBaseURL } from "@/lib/auth/base-url";
import { operatorEmails } from "@/lib/auth/operator-emails";
import { ADMIN_ROLES } from "@/lib/auth/roles";
import { type BillingStatus, SIN_SERVICIO } from "@/lib/billing/plans";
import { db } from "@/lib/db";
import { authUsers, tenants, users } from "@/lib/db/schema";
import { getT, type Locale } from "@/lib/i18n";
import { DEFAULT_LOCALE, SUPPORTED_LOCALES } from "@/lib/i18n/locale-shared";
import { logger } from "@/lib/observability/logger";
import { liberarCupo, rateLimit } from "@/lib/rate-limit";
import { claveDeCupo } from "@/lib/rate-limit/clave";
import { correoDePedidoDeAcceso } from "@/server/notify/correos-de-alta";
import {
  enviarCorreoDelSistema,
  huellaDeLaDireccion,
  remitenteDelSistema,
} from "@/server/notify/remitente-sistema";

const DIA_MS = 24 * 60 * 60_000;
const PEDIDOS_POR_ESPACIO_Y_DIA = 5;
/** Tope de administradores a los que sale un pedido: con más, el dominio no es de una sola empresa. */
const ADMINISTRADORES_MAXIMOS = 20;
const RUTA_DE_USUARIOS = "/admin/users";

export const COOKIE_DE_PEDIDO = "cm_pedido";
const DURACION_DE_LA_COOKIE_S = 2 * 60;

/**
 * Deja en el navegador que la persona ya pidió acceso, para que /alta muestre el estado en
 * lugar del botón. Vale el id de la sesión. Dura 2 minutos porque la página no puede borrarla
 * (un Server Component sólo lee cookies) y sólo la escribe la acción, así que un enlace no la
 * falsifica. Sólo para una acción de servidor o una ruta: ahí se pueden escribir cookies.
 */
export async function ponerCookieDePedido(userId: string): Promise<void> {
  (await cookies()).set(COOKIE_DE_PEDIDO, userId, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/alta",
    maxAge: DURACION_DE_LA_COOKIE_S,
  });
}

/** ¿Pidió acceso esta sesión hace poco? Lee sólo la cookie, sin base: vale únicamente si trae exactamente este id. */
export async function pedidoDeLaSesion(userId: string): Promise<boolean> {
  return (await cookies()).get(COOKIE_DE_PEDIDO)?.value === userId;
}

/**
 * Los administradores activos del dominio, uno por fila, de todos los espacios que lo usan.
 * Se devuelve el builder sin esperarlo para que el test mire el SQL.
 *
 * Quedan afuera las direcciones de operación (`ADMIN_EMAILS`: no son clientes), la de quien
 * pide, las cuentas dadas de baja o bloqueadas o sin verificar, los espacios sin servicio
 * (suspendidos o dados de baja: su invitación no se puede aceptar, y no ocupan lugar entre los
 * veinte) y todo el que no tenga el dominio EXACTO: un subdominio o un dominio parecido no es
 * el mismo espacio. Y la consulta sólo devuelve algo si quien pide todavía no tiene perfil.
 */
export function consultaDeAdministradores(dominio: string, userId: string, pedidor: string) {
  const pedidorConPerfil = alias(users, "pedidor_con_perfil");
  // sin-inquilino: se busca a qué espacios pertenece el dominio de quien pide acceso;
  // la persona todavía no tiene perfil y por lo tanto ningún inquilino al que acotar.
  return db
    .select({ tenant_id: users.tenant_id, email: authUsers.email, locale: users.locale })
    .from(users)
    .innerJoin(authUsers, eq(authUsers.id, users.id))
    .innerJoin(tenants, eq(tenants.id, users.tenant_id))
    .where(
      and(
        inArray(users.role, ADMIN_ROLES),
        isNull(users.dado_de_baja_en),
        eq(authUsers.emailVerified, true),
        sql`coalesce(${authUsers.banned}, false) = false`,
        sql`lower(split_part(${authUsers.email}, '@', 2)) = ${dominio}`,
        notInArray(sql`lower(${authUsers.email})`, [...operatorEmails(), pedidor.toLowerCase()]),
        notInArray(tenants.billing_status, [...SIN_SERVICIO] as BillingStatus[]),
        notExists(
          // sin-inquilino: ídem; sólo pregunta si quien pide ya tiene perfil en algún espacio.
          db.select({ uno: sql`1` }).from(pedidorConPerfil).where(eq(pedidorConPerfil.id, userId))
        )
      )
    )
    .orderBy(users.tenant_id, authUsers.email)
    .limit(ADMINISTRADORES_MAXIMOS);
}

/** El idioma del administrador, nunca el de quien pide: el texto sale en el de quien lo lee. */
function idiomaDe(locale: string | null): Locale {
  return SUPPORTED_LOCALES.find((l) => l === locale) ?? DEFAULT_LOCALE;
}

export async function pedirAccesoAlEspacio({ userId, email }: { userId: string; email: string }): Promise<void> {
  try {
    if (!remitenteDelSistema()) return;
    const dominio = dominioDeEmpresa(email);
    if (!dominio) return;
    const huella = huellaDeLaDireccion(email);
    if (!huella) return;

    // Cuenta pedidos y no envíos: sin espacio para el dominio tampoco se devuelve, o la respuesta
    // de la segunda vez ya contaría si hay uno. Sólo vuelve el intento que el contador rechazó.
    const clavePersona = claveDeCupo("alta:acceso-persona", huella);
    const persona = await rateLimit(clavePersona, { limit: 1, windowMs: DIA_MS, fallaCerrada: true });
    if (!persona.allowed) {
      await liberarCupo(clavePersona, DIA_MS, persona.ventana);
      return;
    }

    const administradores = await consultaDeAdministradores(dominio, userId, email);
    if (administradores.length === 0) return;

    const porEspacio = new Map<string, typeof administradores>();
    for (const admin of administradores) {
      porEspacio.set(admin.tenant_id, [...(porEspacio.get(admin.tenant_id) ?? []), admin]);
    }

    const url = `${resolveBaseURL()}${RUTA_DE_USUARIOS}`;
    let enviados = 0;
    for (const [tenantId, grupo] of porEspacio) {
      const claveEspacio = claveDeCupo("alta:acceso-espacio", tenantId);
      const espacio = await rateLimit(claveEspacio, {
        limit: PEDIDOS_POR_ESPACIO_Y_DIA,
        windowMs: DIA_MS,
        fallaCerrada: true,
      });
      if (!espacio.allowed) {
        await liberarCupo(claveEspacio, DIA_MS, espacio.ventana);
        continue;
      }

      const resultados = await Promise.all(
        grupo.map((admin) =>
          enviarCorreoDelSistema(
            { to: admin.email, ...correoDePedidoDeAcceso(getT(idiomaDe(admin.locale)), email, url) },
            { tipo: "acceso" }
          )
        )
      );
      const salieron = resultados.filter((r) => r.enviado).length;
      // Si no salió ninguno el pedido no se dio: no le gasta el cupo al espacio.
      if (salieron === 0) await liberarCupo(claveEspacio, DIA_MS, espacio.ventana);
      enviados += salieron;
    }

    logger.info({ administradores: administradores.length, enviados }, "alta.pedir_acceso");
  } catch (e) {
    logger.error({ error: e instanceof Error ? e.name : "UnknownError" }, "alta.pedir_acceso_fallo");
  }
}
