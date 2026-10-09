import "server-only";

import { and, eq, inArray, isNotNull, ne, sql } from "drizzle-orm";

import { dominioDelMail, proveedorDeSso } from "@/core/sso";
import { enControl } from "@/data/scope";
import { db } from "@/lib/db";
import { accounts, authUsers, sessions, ssoSettings, users } from "@/lib/db/schema";

import { esFaltaDe0045 } from "./config";

/**
 * A quién pertenece un mail: a nadie, a un inquilino, o a una cuenta sin perfil
 * (sin inquilino). `huerfanaDeSso` es la sin perfil que sólo entró por el SSO de
 * `tenantId`: el resto de un primer ingreso que creó la cuenta y no llegó al perfil.
 */
export type DuenoDelMail =
  | { existe: false }
  | { existe: true; userId: string; tenantId: string | null; huerfanaDeSso: boolean };

/**
 * Una consulta por ingreso. El SSO necesita saber, ANTES de crear o vincular
 * nada, si el mail ya es de otra aseguradora: sin esto, el dominio verificado
 * de un inquilino le alcanzaría para tocar la cuenta de otro.
 *
 * `huerfanaDeSso` pide que TODAS las cuentas de ese usuario sean la del SSO de
 * este inquilino. Una cuenta sin perfil con contraseña o con Google puede ser de
 * cualquiera: darle perfil porque el IdP dice el mismo mail sería regalarle un
 * perfil a quien se registró antes con el mail de otro.
 */
export async function duenoDelMail(email: string, tenantId: string): Promise<DuenoDelMail> {
  // sin-inquilino: el mail identifica a la persona antes de que haya inquilino;
  // justamente se busca a cuál pertenece.
  const [fila] = await db
    .select({
      id: authUsers.id,
      tenant_id: users.tenant_id,
      huerfana_de_sso: sql<boolean>`coalesce((select bool_and(${accounts.providerId} = ${proveedorDeSso(tenantId)}) from ${accounts} where ${accounts.userId} = ${authUsers.id}), false)`,
    })
    .from(authUsers)
    .leftJoin(users, eq(users.id, authUsers.id))
    .where(eq(authUsers.email, email))
    .limit(1);
  if (!fila) return { existe: false };
  const tenantDelPerfil = fila.tenant_id ?? null;
  return {
    existe: true,
    userId: fila.id,
    tenantId: tenantDelPerfil,
    huerfanaDeSso: tenantDelPerfil === null && fila.huerfana_de_sso === true,
  };
}

/** El inquilino del perfil de una cuenta, o null si no tiene perfil. */
export async function inquilinoDelUsuario(userId: string): Promise<string | null> {
  // sin-inquilino: se pregunta a qué inquilino pertenece la cuenta que está
  // entrando; antes de esta consulta no hay inquilino.
  const [fila] = await db
    .select({ tenant_id: users.tenant_id })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return fila?.tenant_id ?? null;
}

/** Un dominio exige SSO sólo con el SSO prendido, el dominio probado y «exigir» puesto. */
const EXIGE_SSO = and(
  eq(ssoSettings.exigir, true),
  eq(ssoSettings.activo, true),
  isNotNull(ssoSettings.dominio_verificado_en)
);

/**
 * Falta la tabla o una columna (la 0045 se aplica a mano y el código puede
 * llegar antes): deja pasar, porque sin tabla no hay SSO que exigir. Cualquier
 * otro error se relanza: ante una falla de la base, no se abre la puerta.
 */
async function sinSsoQueExigir(consulta: () => Promise<boolean>): Promise<boolean> {
  try {
    return await consulta();
  } catch (e) {
    if (esFaltaDe0045(e)) return false;
    throw e;
  }
}

/**
 * ¿El dominio del mail de esta cuenta exige SSO? Una sola consulta.
 *
 * Exige el SSO de SU inquilino: el dominio verificado es único por inquilino, pero
 * el mismo dominio puede tener cuentas en otro (contratistas, un estudio que
 * atiende a dos aseguradoras). Sin comparar el inquilino de la cuenta con el de la
 * configuración, exigir en uno dejaría sin poder entrar a los del otro.
 */
export function dominioExigeSso(userId: string): Promise<boolean> {
  return sinSsoQueExigir(async () => {
    // sin-inquilino: el dominio del mail y el inquilino del perfil deciden qué
    // configuración rige, y el login es previo al inquilino.
    const filas = await db
      .select({ uno: sql<number>`1` })
      .from(authUsers)
      .innerJoin(users, eq(users.id, authUsers.id))
      .innerJoin(
        ssoSettings,
        and(
          eq(ssoSettings.tenant_id, users.tenant_id),
          eq(ssoSettings.dominio, sql`lower(split_part(${authUsers.email}, '@', 2))`)
        )
      )
      .where(and(eq(authUsers.id, userId), EXIGE_SSO))
      .limit(1);
    return filas.length > 0;
  });
}

/**
 * ¿Este mail, todavía sin cuenta, es de un dominio que exige SSO en `tenantId`,
 * el inquilino donde esa cuenta aterrizaría? Una sola consulta. La usa /invitacion
 * para no crear por contraseña (o por Google) una cuenta a la que el gancho de
 * sesión después le negaría la sesión: quedaría creada y sin uso.
 */
export function correoExigeSso(email: string, tenantId: string): Promise<boolean> {
  const dominio = dominioDelMail(email);
  if (!dominio) return Promise.resolve(false);
  return sinSsoQueExigir(async () => {
    // Sin WHERE tenant_id: la fila del inquilino la elige RLS.
    const filas = await enControl({ tenantId }, (db) =>
      db
        .select({ uno: sql<number>`1` })
        .from(ssoSettings)
        .where(and(eq(ssoSettings.dominio, dominio), EXIGE_SSO))
        .limit(1)
    );
    return filas.length > 0;
  });
}

/**
 * ¿Algún inquilino exige SSO para el dominio de este mail? Una sola consulta, sin
 * inquilino. Es lo que impide crear por contraseña o por Google una cuenta a la que
 * el gancho de sesión después le negaría la entrada: el alta nueva no cae en ningún
 * inquilino, así que no hay uno a quien preguntarle.
 */
export function dominioExigeSsoEnAlgunInquilino(email: string): Promise<boolean> {
  const dominio = dominioDelMail(email);
  if (!dominio) return Promise.resolve(false);
  return sinSsoQueExigir(async () => {
    // sin-inquilino: el alta precede a todo inquilino; se pregunta si el dominio
    // está reservado por el SSO de alguno.
    const filas = await db
      .select({ uno: sql<number>`1` })
      .from(ssoSettings)
      .where(and(eq(ssoSettings.dominio, dominio), EXIGE_SSO))
      .limit(1);
    return filas.length > 0;
  });
}

/**
 * Cierra las sesiones de las cuentas de `tenantId` cuyo mail es de `dominio`,
 * menos la del admin que acaba de exigir SSO, y devuelve cuántas eran. Sin esto,
 * exigir SSO sólo valdría para los próximos ingresos y una sesión por contraseña
 * ya abierta seguiría viva hasta 30 días. Las cuentas de otro inquilino con ese
 * mismo dominio no se tocan: no les rige este SSO.
 */
export async function cerrarSesionesDelDominio(
  tenantId: string,
  dominio: string,
  exceptoUserId: string
): Promise<number> {
  // sin-inquilino: las cuentas de Better Auth no tienen inquilino; el perfil y el
  // dominio verificado de esta aseguradora son lo que las recorta.
  const cuentasDelDominio = db
    .select({ id: authUsers.id })
    .from(authUsers)
    .innerJoin(users, eq(users.id, authUsers.id))
    .where(and(eq(users.tenant_id, tenantId), sql`lower(split_part(${authUsers.email}, '@', 2)) = ${dominio}`));

  // sin-inquilino: ídem para las sesiones, que tampoco lo tienen.
  const cerradas = await db
    .delete(sessions)
    .where(and(ne(sessions.userId, exceptoUserId), inArray(sessions.userId, cuentasDelDominio)))
    .returning({ id: sessions.id });
  return cerradas.length;
}
