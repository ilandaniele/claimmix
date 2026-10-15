/**
 * Poner la contraseña nueva, con el token del mail.
 *
 * El token viaja en la URL y ES la credencial mientras dura: quien lea ese
 * enlace entra. Por eso no se registra en ningún lado, ni siquiera recortado —
 * media credencial en un log sigue siendo más de lo que corresponde.
 */

"use server";

import { headers } from "next/headers";
import { z } from "zod";

import { auth } from "@/lib/auth";
import {
  RATE_LIMIT_CONFIGS,
  clientIpFromHeaders,
  rateLimit,
  topePorIp,
} from "@/lib/rate-limit/index";
import { claveDeCupo } from "@/lib/rate-limit/clave";
import { getT } from "@/lib/i18n";
import { getServerLocale } from "@/lib/i18n/locale";

/** Largos de la contraseña que acepta Better Auth. */
const CLAVE_MINIMA = 8;
const CLAVE_MAXIMA = 128;

/*
 * Entre ocho y ciento veintiocho caracteres, los largos de Better Auth. Sin el
 * tope, una clave más larga pasaba este esquema y caía en el `catch` de abajo,
 * que dice «el enlace ya no sirve»: un enlace bueno se tiraba por un error de
 * la clave.
 *
 * No se pide mayúscula-número-símbolo a propósito. Esas reglas producen
 * `Verano2026!` —la contraseña que un atacante prueba primero— y empujan a
 * escribirla en un papel. Lo que de verdad frena el rociado de contraseñas es
 * el techo de intentos, que ya está puesto en el login y en este mismo flujo.
 *
 * Los textos son los de /alta/correo y /invitacion, en el idioma del
 * dispositivo, así que el esquema se arma en cada pedido.
 */
const esquema = (t: ReturnType<typeof getT>) =>
  z
    .object({
      token: z.string().min(1),
      password: z
        .string()
        .min(CLAVE_MINIMA, t("alta.correo.error.clave"))
        .max(CLAVE_MAXIMA, t("alta.correo.error.clave")),
      repetir: z.string(),
    })
    .refine((d) => d.password === d.repetir, {
      message: t("alta.correo.error.distintas"),
      path: ["repetir"],
    });

export type EstadoRestablecer = {
  error?: string;
  fieldErrors?: Record<string, string[]>;
  listo?: boolean;
};

export async function restablecer(
  _prev: EstadoRestablecer,
  formData: FormData
): Promise<EstadoRestablecer> {
  const parsed = esquema(getT(await getServerLocale())).safeParse({
    token: formData.get("token"),
    password: formData.get("password"),
    repetir: formData.get("repetir"),
  });

  if (!parsed.success) {
    const fieldErrors = parsed.error.flatten().fieldErrors as Record<string, string[]>;
    // Un token vacío no es un error de formulario: es un enlace mal copiado.
    if (fieldErrors.token) {
      return { error: "El enlace está incompleto. Pedí uno nuevo." };
    }
    return { fieldErrors };
  }

  /*
   * El mismo techo que `/api/auth/reset-password`, y en el mismo balde: el
   * formulario entra por acá y `auth.api.*` no pasa por el limitador de la ruta
   * HTTP. Ver recuperar/actions.ts.
   */
  const headerStore = await headers();
  const ip = clientIpFromHeaders(headerStore);
  const rl = await rateLimit(claveDeCupo("auth:reset", ip), RATE_LIMIT_CONFIGS.AUTH_SIGN_IN);
  const porIp = await topePorIp(ip);
  if (!rl.allowed || !porIp.allowed) {
    const espera = (!porIp.allowed ? porIp : rl).retryAfterSeconds ?? 60;
    return { error: `Demasiados intentos. Probá de nuevo en ${espera} segundos.` };
  }

  try {
    await auth.api.resetPassword({
      body: { newPassword: parsed.data.password, token: parsed.data.token },
      headers: headerStore,
    });
  } catch {
    /*
     * Un solo mensaje para todos los motivos, y es el correcto.
     *
     * Better Auth falla igual si el token venció, si ya se usó o si nunca
     * existió, y distinguirlos no ayudaría a quien tiene que entrar: en los tres
     * casos lo que hay que hacer es pedir otro enlace. Lo que sí haría
     * distinguirlos es confirmarle a un tercero que un token que encontró en
     * algún lado alguna vez fue válido.
     */
    return {
      error:
        "Ese enlace ya no sirve: pudo haber vencido o haberse usado. Pedí uno nuevo.",
    };
  }

  return { listo: true };
}
