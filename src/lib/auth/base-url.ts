import { RUTA_DE_VUELTA_SSO } from "@/core/sso";

/** La URL pública del sitio, tal como la ve el navegador. */
export function resolveBaseURL(): string {
  if (process.env.NEXT_PUBLIC_SITE_URL) return process.env.NEXT_PUBLIC_SITE_URL;
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return "http://localhost:3000";
}

/**
 * La dirección de vuelta que cada aseguradora registra en su IdP: la misma que
 * el plugin del SSO manda como `redirect_uri`. Better Auth cuelga sus rutas de
 * `/api/auth`, y las dos cuentas tienen que coincidir letra por letra.
 */
export function urlDeVueltaDelSso(): string {
  return `${resolveBaseURL()}/api/auth${RUTA_DE_VUELTA_SSO}`;
}
