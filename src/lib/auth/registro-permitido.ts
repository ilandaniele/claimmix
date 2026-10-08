// Who may create an account: SIGNUP_ALLOWED_EMAILS + ADMIN_EMAILS.
// Entry starting with "@" = whole domain; anything else = exact address.
// No list → nobody. Las invitaciones y el SSO entran por sus propias puertas.
import { AsyncLocalStorage } from "node:async_hooks";

import { dominioDelMail } from "@/core/sso";

export type Permiso =
  | { tipo: "dominio"; valor: string }
  | { tipo: "direccion"; valor: string };

export function parsearPermitidos(crudo: string | undefined): Permiso[] {
  if (!crudo) return [];
  return crudo
    .split(",")
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean)
    .map((entrada) =>
      entrada.startsWith("@")
        ? ({ tipo: "dominio", valor: entrada.slice(1) } as const)
        : ({ tipo: "direccion", valor: entrada } as const)
    )
    .filter((p) => p.valor.length > 0);
}

export function puedeRegistrarse(email: string, permitidos: Permiso[]): boolean {
  if (permitidos.length === 0) return false;

  const dir = email.trim().toLowerCase();
  const arroba = dir.lastIndexOf("@");
  if (arroba <= 0 || arroba === dir.length - 1) return false;
  const dominio = dir.slice(arroba + 1);

  return permitidos.some((p) =>
    p.tipo === "direccion" ? p.valor === dir : p.valor === dominio
  );
}

export function permitidosConfigurados(): Permiso[] {
  return parsearPermitidos(
    [process.env.SIGNUP_ALLOWED_EMAILS, process.env.ADMIN_EMAILS]
      .filter(Boolean)
      .join(",")
  );
}

/**
 * ¿Puede esta dirección crear su cuenta (y su espacio) por la puerta pública?
 * Con `ALTA_AUTOMATICA=1` cualquiera; apagada, sólo las de la lista. Es la única
 * copia de la regla: la usan el gancho de alta de Google y la pantalla `/alta`.
 */
export function altaAbierta(email: string): boolean {
  return process.env.ALTA_AUTOMATICA === "1" || puedeRegistrarse(email, permitidosConfigurados());
}

/**
 * Un ingreso por el SSO de un inquilino, en curso. Lo abre el callback del SSO
 * (`src/lib/auth/sso-inquilino.ts`) sólo después de verificar el token del IdP,
 * y dura lo que dura `handleOAuthUserInfo`: adentro corren los ganchos de alta
 * y de sesión, que así saben de qué inquilino se trata sin leerlo de ninguna
 * entrada del pedido.
 */
export type IngresoPorSso = { tenantId: string; dominio: string };

const ingresoSso = new AsyncLocalStorage<IngresoPorSso>();

export function enIngresoPorSso<T>(ingreso: IngresoPorSso, fn: () => Promise<T>): Promise<T> {
  return ingresoSso.run(ingreso, fn);
}

export function ingresoPorSso(): IngresoPorSso | undefined {
  return ingresoSso.getStore();
}

/**
 * Un alta por la puerta del servidor (el formulario de /registro o una invitación
 * ya canjeada), en curso. La abre el código que llama a `signUpEmail` después de
 * decidir que esa persona puede; el gancho de alta lo lee para saber que el pedido
 * no viene de la puerta abierta de Google. Nunca sale de una entrada del pedido.
 */
export type CaminoDeAltaEnCurso = "correo" | "invitacion";

const altaEnCurso = new AsyncLocalStorage<CaminoDeAltaEnCurso>();

export function enAlta<T>(camino: CaminoDeAltaEnCurso, fn: () => Promise<T>): Promise<T> {
  return altaEnCurso.run(camino, fn);
}

export function altaEnCursoPorServidor(): CaminoDeAltaEnCurso | undefined {
  return altaEnCurso.getStore();
}

export function altaHabilitada(email: string): boolean {
  // El dominio verificado del inquilino hace de allowlist, y nada más que esa.
  const sso = ingresoPorSso();
  if (sso) return dominioDelMail(email) === sso.dominio;
  return puedeRegistrarse(email, permitidosConfigurados());
}
