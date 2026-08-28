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

/*
 * Ocho caracteres, que es el mínimo de Better Auth.
 *
 * No se pide mayúscula-número-símbolo a propósito. Esas reglas producen
 * `Verano2026!` —la contraseña que un atacante prueba primero— y empujan a
 * escribirla en un papel. Lo que de verdad frena el rociado de contraseñas es
 * el techo de intentos, que ya está puesto en el login y en este mismo flujo.
 */
const Schema = z
  .object({
    token: z.string().min(1),
    password: z.string().min(8, "Tiene que tener al menos 8 caracteres."),
    repetir: z.string(),
  })
  .refine((d) => d.password === d.repetir, {
    message: "Las dos contraseñas no coinciden.",
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
  const parsed = Schema.safeParse({
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

  try {
    await auth.api.resetPassword({
      body: { newPassword: parsed.data.password, token: parsed.data.token },
      headers: await headers(),
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
