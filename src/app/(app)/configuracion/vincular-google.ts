/**
 * Vincular Google a una cuenta que ya existe, desde adentro.
 *
 * ── Por qué hace falta esto y no alcanza con «Continuar con Google» ─────────
 *
 * Better Auth se niega a fusionar un ingreso de Google con una cuenta local
 * cuyo correo nunca se verificó, y tiene razón: `/registro` está abierto, así
 * que cualquiera puede crear una cuenta con la dirección de otro. Si el ingreso
 * por Google se fusionara con esa cuenta, la persona real entraría a la cuenta
 * del que se le adelantó — que además sigue sabiendo la contraseña.
 *
 * La regla vive en `link-account.mjs` de Better Auth y es una condición aparte
 * de `trustedProviders`:
 *
 *     const requireLocalEmailVerified = accountLinking?.requireLocalEmailVerified ?? true;
 *     if (… || requireLocalEmailVerified && !dbUser.user.emailVerified || …)
 *       return { error: "account not linked" };
 *
 * Apagar esa bandera arreglaría el síntoma y abriría exactamente el ataque de
 * arriba. Así que no se apaga.
 *
 * ── Lo que sí es seguro ─────────────────────────────────────────────────────
 *
 * El problema es que un ingreso por Google prueba UNA mitad: que quien entra
 * controla ese correo. Lo que no prueba es que la cuenta local con la
 * contraseña sea de la misma persona.
 *
 * Acá se prueban las dos. Quien pide vincular ya entró con su contraseña —hay
 * sesión— y después vuelve de Google. Un okupa no tiene la primera mitad y la
 * persona real tiene las dos. Por eso Better Auth acepta este camino aunque el
 * correo local siga sin verificar: `/link-social` sólo mira `trustedProviders`,
 * no `requireLocalEmailVerified`, porque la sesión ya es la prueba que falta.
 *
 * `redirect()` NO puede ir adentro del try: tira un error interno de Next para
 * disparar la redirección y el catch se lo comería.
 */

"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { auth } from "@/lib/auth";
import { getSessionContext } from "@/lib/auth/session";

export async function vincularGoogle(): Promise<void> {
  const sesion = await getSessionContext();
  if (!sesion?.user) redirect("/login");

  let url: string | undefined;
  try {
    const resultado = await auth.api.linkSocialAccount({
      body: {
        provider: "google",
        callbackURL: "/configuracion?vinculo=ok",
        errorCallbackURL: "/configuracion?vinculo=error",
      },
      headers: await headers(),
    });
    url = resultado.url ?? undefined;
  } catch (e) {
    console.error(
      JSON.stringify({
        level: "error",
        service: "claimmix",
        msg: "auth.google.link_start_failed",
        detalle: e instanceof Error ? e.message : String(e),
      })
    );
    url = undefined;
  }

  if (!url) redirect("/configuracion?vinculo=error");
  redirect(url);
}
