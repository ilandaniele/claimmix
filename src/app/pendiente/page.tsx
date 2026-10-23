/**
 * «Cuenta pendiente» — E20.
 *
 * Una sesión sin fila en `users` no tiene espacio ni perfil. Antes eso hacía
 * loop: /bandeja mandaba a /login, el proxy veía SOLO_ANONIMOS y devolvía a
 * /bandeja. Esta ruta lo corta: ya no muestra nada, manda a /alta, que es donde
 * la persona crea su espacio (o lee por qué todavía no puede).
 *
 * Se queda para los enlaces que apuntan acá: el layout de `(app)` y la bandeja
 * redirigen a /pendiente.
 *
 * Una excepción: quien aceptó una invitación con una cuenta que ya tenía y entró
 * a mano (la acción le dejó la cookie `cm_invitacion`) vuelve a /invitacion, a
 * terminar de aceptar, en lugar de crearse un espacio propio.
 *
 * No está en SOLO_ANONIMOS ni en PUBLIC_PREFIXES de `src/proxy.ts`: el proxy
 * manda a un visitante anónimo a /login, así que `proxy.ts` no cambia.
 */

import { redirect } from "next/navigation";
import { getSessionContext } from "@/lib/auth/session";
import { getUserRowOrThrow } from "@/lib/auth/user-row";
import { invitacionDeLaSesion, resumenDeInvitacion } from "@/server/alta/invitacion";

export default async function PendientePage() {
  const session = await getSessionContext();
  if (!session?.user) redirect("/login");
  // Una falla de la base tira, y eso muestra la pantalla de error: nunca
  // manda a alguien a crear un espacio por un problema de red.
  const fila = await getUserRowOrThrow(session.user.id);
  if (fila) redirect("/bandeja");

  const invitacion = await invitacionDeLaSesion(session.user.email);
  if (invitacion && (await resumenDeInvitacion(invitacion))) redirect("/invitacion");
  redirect("/alta");
}
