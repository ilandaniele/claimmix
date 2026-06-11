/**
 * Zod schemas for authentication API routes.
 *
 * Validated at every API boundary — server-side only.
 * These schemas do NOT include rate-limit state (that's enforced separately).
 */

import { z } from "zod";

/** POST /api/auth/sign-in request body */
export const SignInSchema = z.object({
  email: z
    .string({ required_error: "El correo electrónico es requerido." })
    .trim()
    .toLowerCase()
    .max(254, "El correo electrónico es demasiado largo.")
    .email("El correo electrónico no es válido."),
  password: z
    .string({ required_error: "La contraseña es requerida." })
    .min(1, "La contraseña es requerida.")
    .max(128, "La contraseña es demasiado larga."),
});

export type SignInInput = z.infer<typeof SignInSchema>;

/** /registro sign-up form */
export const SignUpSchema = z.object({
  full_name: z
    .string({ required_error: "El nombre es requerido." })
    .trim()
    .min(2, "El nombre es demasiado corto.")
    .max(100, "El nombre es demasiado largo."),
  email: z
    .string({ required_error: "El correo electrónico es requerido." })
    .trim()
    .toLowerCase()
    .max(254, "El correo electrónico es demasiado largo.")
    .email("El correo electrónico no es válido."),
  password: z
    .string({ required_error: "La contraseña es requerida." })
    .min(8, "La contraseña debe tener al menos 8 caracteres.")
    .max(128, "La contraseña es demasiado larga."),
});

export type SignUpInput = z.infer<typeof SignUpSchema>;

/** GET /api/auth/me response shape */
export const MeResponseSchema = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  full_name: z.string(),
  role: z.enum(["owner", "admin", "specialist", "analyst", "viewer"]),
  tenant_id: z.string().uuid(),
});

export type MeResponse = z.infer<typeof MeResponseSchema>;
