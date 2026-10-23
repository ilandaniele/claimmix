/**
 * Server Action de /alta/correo: crea la cuenta de quien volvió del enlace del
 * mail de «Activar tu cuenta» y lo manda a /alta, ya con sesión, a decir qué
 * vino a hacer.
 *
 * La lógica vive en `crearCuentaDelEnlace` (un módulo de servidor, no una
 * acción: un archivo con "use server" publica todos sus exports). Acá sólo se
 * leen los campos y se redirige.
 *
 * NOTE: redirect() must NOT be wrapped in try/catch — it throws a special
 * Next.js internal error to trigger the redirect.
 */

"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { crearCuentaDelEnlace } from "@/server/alta/cuenta-del-enlace";

export async function crearCuentaDesdeCorreo(formData: FormData): Promise<void> {
  redirect(
    await crearCuentaDelEnlace({
      token: formData.get("t"),
      clave: formData.get("password"),
      repetida: formData.get("repetir"),
      headerStore: await headers(),
    })
  );
}
