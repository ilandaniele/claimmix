/**
 * Pedir el enlace para volver a entrar.
 *
 * La respuesta es SIEMPRE la misma, exista o no la dirección. Decir «no
 * encontramos esa cuenta» convierte este formulario en un buscador de quién
 * trabaja en una aseguradora: se prueban direcciones y las que existen se
 * delatan solas. Better Auth ya responde igual para los dos casos; acá se
 * mantiene esa simetría también cuando el que falla somos nosotros.
 *
 * El techo se aplica ACÁ y también en la ruta HTTP, y no es duplicación por
 * descuido. Son dos puertas al mismo cuarto: el formulario entra por la Server
 * Action y quien escribe un script entra por `/api/auth/request-password-reset`.
 * Este proyecto ya tuvo el techo en una sola de las dos —la del formulario, o
 * sea la de una persona y no la de quien automatiza— y eso es tenerlo donde no
 * hace falta.
 */

"use server";

import { headers } from "next/headers";
import { z } from "zod";

import { auth } from "@/lib/auth";
import { rateLimit, RATE_LIMIT_CONFIGS } from "@/lib/rate-limit/index";
import { writeAuditLog, AuditEvent } from "@/lib/audit/log";

const Schema = z.object({
  email: z.string().email("Escribí un correo válido."),
});

export type EstadoRecuperar = {
  error?: string;
  fieldErrors?: Record<string, string[]>;
  listo?: boolean;
};

/** Lo que se le dice a cualquiera, haya o no cuenta con esa dirección. */
const SIEMPRE_LO_MISMO =
  "Si esa dirección tiene una cuenta, te llega un correo con el enlace. Revisá también el correo no deseado.";

export async function pedirEnlace(
  _prev: EstadoRecuperar,
  formData: FormData
): Promise<EstadoRecuperar> {
  const parsed = Schema.safeParse({ email: formData.get("email") });
  if (!parsed.success) {
    return {
      fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    };
  }
  const email = parsed.data.email.trim().toLowerCase();

  const headerStore = await headers();
  const xff = headerStore.get("x-forwarded-for");
  const ip = xff ? xff.split(",")[0].trim() : "anonymous";

  const rl = await rateLimit(`reset:${ip}:${email}`, RATE_LIMIT_CONFIGS.AUTH_RESET);
  if (!rl.allowed) {
    await writeAuditLog({
      tenant_id: "00000000-0000-0000-0000-000000000000",
      actor_id: null,
      event_type: AuditEvent.AUTH_RATE_LIMITED,
      target_type: "auth",
      target_id: null,
      // El prefijo de la IP y no la dirección: esto es un registro.
      payload: { ip_prefix: ip.split(".").slice(0, 3).join("."), que: "reset" },
      ip,
      ua: headerStore.get("user-agent") ?? null,
    });
    return {
      error: `Demasiados intentos. Probá de nuevo en ${rl.retryAfterSeconds ?? 60} segundos.`,
    };
  }

  try {
    await auth.api.requestPasswordReset({
      body: { email, redirectTo: "/restablecer" },
      headers: headerStore,
    });
  } catch {
    /*
     * Se traga el error a propósito, y con incomodidad.
     *
     * Si acá se devolviera un error, el formulario respondería distinto según
     * qué salió mal, y «qué salió mal» depende de si la cuenta existe: buscar
     * el perfil, encontrar la casilla, mandar. Esa diferencia es la que hay que
     * no tener.
     *
     * Lo que sí queda: el envío anota del lado nuestro si no pudo salir, con el
     * motivo. Ver src/server/notify/password-reset.ts.
     */
  }

  return { listo: true };
}

export { SIEMPRE_LO_MISMO };
