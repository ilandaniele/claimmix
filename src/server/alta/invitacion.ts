/**
 * La invitación de un admin a su espacio: el enlace del mail, la cookie
 * `cm_invitacion` de quien acepta con Google y las dos consultas que la usan.
 *
 * Invitar no escribe ninguna cuenta ni ningún perfil: el enlace lleva sellado todo
 * lo que hace falta (espacio, dirección, rol, nombre y quién invita) y recién al
 * aceptar se crea la cuenta, si no existía, y el perfil. Quien tipea direcciones
 * ajenas no deja filas, y la respuesta de quien invita no depende de si la
 * dirección ya tiene cuenta.
 *
 * Va SELLADO con AES-256-GCM (ver sellado.ts) y no sólo firmado: lleva el correo, y
 * el enlace pasa por historiales y reenvíos. La clave sale de BETTER_AUTH_SECRET
 * por HKDF con su propio `info`. Dura 72 horas y no se gasta: abrirlo dos veces da
 * lo mismo, y que el segundo uso no cree nada lo resuelve el perfil, que ya existe.
 *
 * **El enlace sólo prueba que la casilla es de quien lo abre.** Aceptar vuelve a
 * mirar en la base que quien invitó siga siendo admin del espacio (el owner, si el
 * rol invitado es owner) y que el espacio siga activo: el permiso de invitar se
 * pierde con el rol, no con la fecha del mail.
 *
 * La cookie guarda el mismo valor del enlace mientras la persona va y vuelve de
 * Google. Es `Path=/` y no `/invitacion` porque la lee el gancho de alta en la
 * vuelta de Google (`/api/auth/callback/google`), donde decide si esa cuenta
 * nueva entra por la invitación. Sólo vale para la dirección invitada.
 */

import "server-only";

import { sql } from "drizzle-orm";
import { cookies } from "next/headers";

import { enControl } from "@/data/scope";
import { AuditEvent } from "@/lib/audit/log";
import { ALL_ROLES, type UserRole } from "@/lib/auth/roles";
import { filasDe } from "@/lib/db/filas";
import { SignUpSchema } from "@/lib/schemas/auth";
import { abrir, sellar } from "@/server/alta/sellado";
import { espejarSinFallar } from "@/server/bases/espejar-sin-fallar";
import { correoExigeSso } from "@/server/sso/usuarios";

export const COOKIE_DE_INVITACION = "cm_invitacion";
export const DURACION_DE_LA_INVITACION_MS = 72 * 60 * 60 * 1000;
/** Lo que tarda ir a Google y volver: la cookie no necesita durar como el enlace. */
export const DURACION_DE_LA_COOKIE_MS = 60 * 60 * 1000;

const INFO = "invitacion";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface DatosDeInvitacion {
  /** El espacio al que se invita. */
  t: string;
  /** La dirección invitada, ya en minúsculas. */
  e: string;
  /** El rol con que entra. */
  r: UserRole;
  /** El nombre que le puso quien invita. */
  n: string;
  /** Quién invita. */
  i: string;
  /** Epoch ms en que deja de valer. */
  exp: number;
}

/** El valor del parámetro `t`: `v1.iv.tag.cifrado` en base64url. Lanza si falta BETTER_AUTH_SECRET. */
export function sellarInvitacion(datos: Omit<DatosDeInvitacion, "exp">, ahora = Date.now()): string {
  const completos: DatosDeInvitacion = { ...datos, exp: ahora + DURACION_DE_LA_INVITACION_MS };
  return sellar(INFO, completos);
}

/** Los datos, o null si falta, no abre, venció o no tiene la forma que sellamos. */
export function abrirInvitacion(valor: unknown, ahora = Date.now()): DatosDeInvitacion | null {
  if (typeof valor !== "string") return null;
  const d = abrir(INFO, valor) as Partial<DatosDeInvitacion> | null;
  if (!d || typeof d !== "object") return null;
  if (typeof d.exp !== "number" || d.exp <= ahora) return null;
  if (typeof d.t !== "string" || !UUID.test(d.t) || typeof d.i !== "string" || !UUID.test(d.i)) return null;

  const rol = ALL_ROLES.find((r) => r === d.r);
  const cuenta = SignUpSchema.safeParse({ full_name: d.n, email: d.e });
  if (!rol || !cuenta.success) return null;

  return { t: d.t, e: cuenta.data.email, r: rol, n: cuenta.data.full_name, i: d.i, exp: d.exp };
}

/** La deja en el navegador. Sólo para una acción de servidor o una ruta: ahí se pueden escribir cookies. */
export async function ponerCookieDeInvitacion(token: string): Promise<void> {
  (await cookies()).set(COOKIE_DE_INVITACION, token, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: DURACION_DE_LA_COOKIE_MS / 1000,
  });
}

/** El valor de la cookie tal cual, sin abrir; quien lo usa lo abre con `abrirInvitacion`. */
export async function leerCookieDeInvitacion(): Promise<string | undefined> {
  return (await cookies()).get(COOKIE_DE_INVITACION)?.value;
}

export async function borrarCookieDeInvitacion(): Promise<void> {
  (await cookies()).delete({ name: COOKIE_DE_INVITACION, path: "/" });
}

/**
 * La invitación que trae la cookie de este navegador, si es para la dirección con
 * la que la persona entró; si no, null. Lee sólo la cookie: no consulta la base ni
 * dice nada de ninguna empresa, así que no sirve para averiguar cuáles existen.
 */
export async function invitacionDeLaSesion(email: string): Promise<DatosDeInvitacion | null> {
  const invitacion = abrirInvitacion(await leerCookieDeInvitacion());
  return invitacion?.e === email.trim().toLowerCase() ? invitacion : null;
}

/**
 * ¿Puede quien tiene este rol invitar con aquel? Un admin invita a todos menos a
 * un owner. La misma regla está escrita en SQL en `aceptarInvitacion`.
 */
export function puedeInvitar(rolDeQuienInvita: string | null | undefined, rolInvitado: UserRole): boolean {
  if (rolDeQuienInvita === "owner") return true;
  return rolDeQuienInvita === "admin" && rolInvitado !== "owner";
}

export interface ResumenDeInvitacion {
  espacio: string;
  quien: string;
  /**
   * El espacio exige el SSO para el dominio de la dirección invitada. Ni Google ni
   * una contraseña sirven: la cuenta nacería y el gancho de sesión le negaría la entrada.
   */
  exigeSso: boolean;
}

/**
 * Lo que la pantalla de la invitación muestra: el nombre del espacio y de quien
 * invita. Null si la invitación ya no sirve: el espacio se suspendió o dio de
 * baja, o quien invitó dejó de poder hacerlo o fue dado de baja. La consulta de la invitación es una
 * sola, con el espacio del enlace como contexto: la base devuelve su fila de
 * `tenants` y nada de otro. Con una invitación que sirve, una segunda mira si ese
 * espacio exige el SSO para el dominio invitado.
 */
export async function resumenDeInvitacion(d: DatosDeInvitacion): Promise<ResumenDeInvitacion | null> {
  const filas = await enControl({ tenantId: d.t }, (db) =>
    db.execute(sql`
      select x.name as espacio, x.billing_status as estado, i.full_name as quien, i.role as rol_de_quien
      from public.tenants x
      left join public.users i on i.id = ${d.i}::uuid and i.tenant_id = x.id and i.dado_de_baja_en is null
      where x.id = ${d.t}::uuid
    `)
  );
  const fila = filasDe<{ espacio?: string; estado?: string; quien?: string | null; rol_de_quien?: string | null }>(
    filas
  )[0];
  if (!fila?.espacio || !fila.quien) return null;
  if (fila.estado === "suspended" || fila.estado === "churned") return null;
  if (!puedeInvitar(fila.rol_de_quien, d.r)) return null;
  return { espacio: fila.espacio, quien: fila.quien, exigeSso: await correoExigeSso(d.e, d.t) };
}

/**
 * Crea el perfil de quien acepta, en el espacio del enlace. Devuelve true si
 * quedó creado; false si ya no se puede: quien invitó perdió el rol o fue dado de
 * baja, el espacio está suspendido o dado de baja, o la persona ya tenía perfil.
 *
 * Una sola sentencia con el espacio del enlace como contexto. Las comprobaciones
 * viajan dentro del INSERT, así que no hay un hueco entre mirar y escribir. Con
 * el contexto de otro espacio nada de esto se ve —ni quien invita ni el espacio—
 * y no se inserta nada. El asiento de auditoría sale de la fila insertada: sin
 * perfil nuevo no hay asiento. Con el perfil creado en control se lo espeja a la
 * base del cliente: si la copia falla queda pendiente y la invitación igual vale.
 */
export async function aceptarInvitacion(
  d: DatosDeInvitacion,
  quien: { userId: string; ip: string | null; ua: string | null }
): Promise<boolean> {
  const payload = JSON.stringify({ rol: d.r });
  const filas = await enControl({ tenantId: d.t }, (db) =>
    db.execute(sql`
      with nuevo as (
        insert into public.users (id, tenant_id, full_name, role)
        select ${quien.userId}::uuid, ${d.t}::uuid, ${d.n}::text, ${d.r}::text
        where exists (
            select 1 from public.users i
            where i.id = ${d.i}::uuid and i.tenant_id = ${d.t}::uuid and i.dado_de_baja_en is null
              and (i.role = 'owner' or (i.role = 'admin' and ${d.r}::text <> 'owner'))
          )
          and exists (
            select 1 from public.tenants x
            where x.id = ${d.t}::uuid and x.billing_status not in ('suspended', 'churned')
          )
        on conflict (id) do nothing
        returning id
      ), auditoria as (
        insert into public.audit_log (tenant_id, actor_id, event_type, target_type, target_id, payload, ip, ua)
        select ${d.t}::uuid, id, ${AuditEvent.INVITATION_ACCEPTED}::text, 'user', id::text, ${payload}::jsonb,
               ${quien.ip}::inet, ${quien.ua}::text
        from nuevo
      )
      select id from nuevo
    `)
  );
  const creado = filasDe(filas).length > 0;
  if (creado) await espejarSinFallar(d.t);
  return creado;
}
