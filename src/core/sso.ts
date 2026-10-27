/**
 * Reglas del SSO por inquilino, sin red ni base: qué dominio vale y cuándo un
 * token del IdP alcanza para dejar entrar. Todo falla cerrado: ante la duda, no.
 */

export function normalizarDominio(valor: string): string {
  return valor.trim().toLowerCase().replace(/^@/, "").replace(/\.$/, "");
}

const PATRON_DE_DOMINIO = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** Un nombre de dominio con forma de tal: minúsculas, al menos dos etiquetas, sin `@` ni espacios. */
export function dominioValido(dominio: string): boolean {
  return PATRON_DE_DOMINIO.test(dominio);
}

/**
 * El dominio de un mail, o null si no es una dirección con un solo `@`.
 *
 * Coincidencia EXACTA: `ana@sub.empresa.com` es de `sub.empresa.com`, no de
 * `empresa.com`. Un subdominio lo puede registrar cualquiera que controle esa
 * zona, y acá el dominio es lo único que liga a una persona con su inquilino.
 */
export function dominioDelMail(email: string): string | null {
  if (typeof email !== "string" || /\s/.test(email)) return null;
  const partes = email.trim().toLowerCase().split("@");
  if (partes.length !== 2 || !partes[0]) return null;
  const dominio = normalizarDominio(partes[1]);
  return dominioValido(dominio) ? dominio : null;
}

const PROVEEDORES_PUBLICOS = new Set([
  "gmail", "googlemail", "hotmail", "outlook", "live", "msn", "yahoo", "ymail", "icloud",
  "me", "mac", "proton", "protonmail", "pm", "aol", "gmx", "zoho", "mail", "fastmail",
  "yandex", "hey", "tutanota", "tuta",
]);
// Casillas de los proveedores de internet argentinos: las usan las PyMEs y son de todos sus clientes.
// Van como dominios completos y por igualdad exacta: una etiqueta sola atraparía, por ejemplo, ciudad.gob.ar.
// La lista es una sola: también cierra el SSO (`/api/admin/sso`) y la invitación de un espacio en prueba (`/api/admin/users`).
const DOMINIOS_PUBLICOS = new Set([
  "fibertel.com.ar", "speedy.com.ar", "arnet.com.ar", "ciudad.com.ar", "uolsinectis.com.ar",
  "sinectis.com.ar", "telecentro.com.ar", "telecentro.net.ar", "infovia.com.ar",
]);
const SEGUNDO_NIVEL = new Set(["com", "co", "net", "org", "gob", "gov", "edu"]);

/**
 * Un proveedor de correo abierto a cualquiera (gmail.com, hotmail.com.ar, …).
 * Un inquilino no puede reclamarlo: con «@gmail.com» verificado, cualquier
 * persona con una cuenta de Gmail entraría a su aseguradora.
 */
export function esDominioPublico(dominio: string): boolean {
  const normalizado = normalizarDominio(dominio);
  const etiquetas = normalizado.split(".");
  const tieneForma =
    etiquetas.length === 2 || (etiquetas.length === 3 && SEGUNDO_NIVEL.has(etiquetas[1]));
  return DOMINIOS_PUBLICOS.has(normalizado) || (tieneForma && PROVEEDORES_PUBLICOS.has(etiquetas[0]));
}

/** El dominio de una dirección que puede ser de la empresa de un espacio, o null si no es una dirección o es de un proveedor abierto. */
export function dominioDeEmpresa(email: string): string | null {
  const dominio = dominioDelMail(email);
  return dominio && !esDominioPublico(dominio) ? dominio : null;
}

export type MotivoSso =
  | "sin_email"
  | "sin_sub"
  | "email_no_verificado"
  | "dominio_ajeno";

export type ReclamosSso = {
  sub?: unknown;
  email?: unknown;
  email_verified?: unknown;
  name?: unknown;
};

export type RevisionDeReclamos =
  | { ok: true; email: string; sub: string; nombre: string | null }
  | { ok: false; motivo: MotivoSso };

/**
 * Lo que el IdP afirma alcanza sólo si el mail está verificado y es del dominio
 * que el inquilino probó que controla. `email_verified` tiene que ser el booleano
 * `true`: un IdP que manda «true» como texto o no lo manda queda afuera.
 */
export function revisarReclamos(
  reclamos: ReclamosSso,
  { dominio }: { dominio: string }
): RevisionDeReclamos {
  if (typeof reclamos.email !== "string" || !reclamos.email) return { ok: false, motivo: "sin_email" };
  if (typeof reclamos.sub !== "string" || !reclamos.sub) return { ok: false, motivo: "sin_sub" };
  if (reclamos.email_verified !== true) return { ok: false, motivo: "email_no_verificado" };

  const email = reclamos.email.trim().toLowerCase();
  if (dominioDelMail(email) !== normalizarDominio(dominio)) return { ok: false, motivo: "dominio_ajeno" };

  const nombre = typeof reclamos.name === "string" && reclamos.name.trim() ? reclamos.name.trim().slice(0, 120) : null;
  return { ok: true, email, sub: reclamos.sub, nombre };
}

/** Dónde vuelve el IdP, colgando de `/api/auth`. Es lo que el admin registra del lado de su IdP. */
export const RUTA_DE_VUELTA_SSO = "/sso-inquilino/callback";

/**
 * El `providerId` de la cuenta que deja el SSO de un inquilino. Lleva el
 * inquilino: el mismo `sub` de dos IdP distintos nunca se confunde.
 */
export function proveedorDeSso(tenantId: string): string {
  return `sso:${tenantId}`;
}
