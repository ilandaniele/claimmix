/**
 * «Cuenta pendiente» — E20.
 *
 * Un alta por contraseña fuera de la lista permitida no deja fila en `users`.
 * Antes eso hacía loop: /bandeja mandaba a /login, el proxy veía SOLO_ANONIMOS
 * y devolvía a /bandeja. Esta pantalla corta el loop: se lo dice, y ofrece
 * cerrar sesión. Sin mails.
 *
 * Vive fuera de `(app)`: sin shell, sin LocaleProvider. El castellano va a
 * mano, como en /login.
 *
 * No está en SOLO_ANONIMOS ni en PUBLIC_PREFIXES de `src/proxy.ts`: el proxy
 * manda a un visitante anónimo a /login, así que `proxy.ts` no cambia.
 */

import { redirect } from "next/navigation";
import { getSessionContext } from "@/lib/auth/session";
import { getUserRowOrThrow } from "@/lib/auth/user-row";
import { signOut } from "@/app/login/actions";

export const metadata = { title: "Cuenta pendiente — ClaimMix" };

export default async function PendientePage() {
  const session = await getSessionContext();
  if (!session?.user) redirect("/login");
  // Una falla de la base tira, y eso muestra la pantalla de error: nunca
  // etiqueta a alguien de "pendiente" por un problema de red.
  const fila = await getUserRowOrThrow(session.user.id);
  if (fila) redirect("/bandeja");
  return (
    <main className="flex min-h-dvh items-center justify-center bg-slate-50 px-4 py-10">
      <div className="w-full max-w-[26rem] rounded-2xl border border-slate-200 bg-white p-7 shadow-sm">
        <h1 className="mb-3 text-[15px] font-semibold tracking-tight text-slate-900">Cuenta pendiente</h1>
        <p className="mb-5 text-sm text-slate-600">
          Tu cuenta está creada; un administrador tiene que darte acceso.
        </p>
        <form action={signOut}>
          <button type="submit" className="rounded-xl bg-violet-600 px-4 py-2 text-[13.5px] font-semibold text-white hover:bg-violet-700">
            Cerrar sesión
          </button>
        </form>
      </div>
    </main>
  );
}
