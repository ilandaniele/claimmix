import "server-only";

import { altaHabilitada } from "@/lib/auth/registro-permitido";
import { resolveDefaultTenantId } from "@/lib/auth/provision";
import { altaBloqueadaPorSso } from "@/server/sso/exigir";

export type RechazoDeAlta = "fuera_de_signup_allowed_emails" | "dominio_exige_sso";

/**
 * Por qué NO puede darse de alta este correo, o null si puede: tiene que estar
 * en la lista y su dominio no puede exigir SSO.
 *
 * Es la única copia de la regla. La usan el gancho `user.create.before`
 * (`index.ts`), que la aplica a cualquier alta, y `inquilinoDeAltaNueva`, que
 * sirve al alta sin contraseña y al restablecimiento. Dos copias de una regla
 * de acceso es donde la próxima corrección se aplica en una sola.
 */
export async function rechazoDeAlta(
  email: string,
  tenantId: string | null
): Promise<RechazoDeAlta | null> {
  if (!altaHabilitada(email)) return "fuera_de_signup_allowed_emails";
  return (await altaBloqueadaPorSso(email, tenantId)) ? "dominio_exige_sso" : null;
}

/**
 * El inquilino donde caería un alta pública de este correo, o null si no cae
 * en ninguno: lo rechaza `rechazoDeAlta` o no hay inquilino por omisión.
 *
 * El gancho, en cambio, deja crear sin inquilino por omisión (el alta de un
 * admin lleva el suyo); acá no hay dónde mandar el enlace ni dónde dar perfil.
 */
export async function inquilinoDeAltaNueva(email: string): Promise<string | null> {
  const tenantId = resolveDefaultTenantId();
  if (!tenantId || (await rechazoDeAlta(email, tenantId))) return null;
  return tenantId;
}
