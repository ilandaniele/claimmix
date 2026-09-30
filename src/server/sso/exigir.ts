import "server-only";

import { APIError } from "better-auth/api";

import { esAltaDeAdmin, ingresoPorSso } from "@/lib/auth/registro-permitido";

import { correoExigeSso, dominioExigeSso, inquilinoDelUsuario } from "./usuarios";

/** Los códigos que el callback del SSO sabe llevar a /login. Cualquier otro se dice «falló». */
export const CODIGO_SSO_REQUERIDO = "sso_requerido";
export const CODIGO_SSO_OTRO_INQUILINO = "sso_otro_inquilino";

/** Endpoints que reemplazan la sesión de quien ya la tenía. */
const RUTAS_QUE_RENUEVAN_LA_SESION = new Set(["/change-password"]);

/**
 * El gancho `session.create.before`: cada sesión pasa por acá, venga de la
 * contraseña, de Google o del SSO.
 *
 * - Dentro de un ingreso por SSO: la cuenta tiene que ser del inquilino del
 *   `state`. Cubre el camino en que la cuenta se reconoce por su `sub` y no por
 *   el mail, donde el control previo por mail no llega.
 * - Fuera de uno: si el dominio del mail exige SSO, no hay sesión. Es el modo
 *   «Exigir SSO»; el que entra por contraseña después de pedir un reseteo
 *   también se frena acá, sin que el reseteo se bloquee.
 * - Dos cosas no son un ingreso y pasan sin consulta: el alta de un usuario por
 *   un admin (`enAltaDeAdmin`, que crea la sesión de la cuenta recién hecha) y el
 *   cambio de contraseña, que rota las sesiones de quien ya estaba adentro
 *   (`revokeOtherSessions`). Sin esto, con «exigir» el admin deja una cuenta a
 *   medio crear y quien cambia su contraseña queda afuera de su propia sesión.
 *
 * Una sola consulta por sesión en cualquiera de los casos.
 *
 * @param ruta la ruta del endpoint de Better Auth que la crea, si hay uno.
 */
export async function revisarSesionNueva(userId: string, ruta?: string): Promise<void> {
  const ingreso = ingresoPorSso();
  if (ingreso) {
    if ((await inquilinoDelUsuario(userId)) !== ingreso.tenantId) {
      throw new APIError("FORBIDDEN", {
        code: CODIGO_SSO_OTRO_INQUILINO,
        message: "Esta cuenta pertenece a otra organización.",
      });
    }
    return;
  }

  if (esAltaDeAdmin() || (ruta !== undefined && RUTAS_QUE_RENUEVAN_LA_SESION.has(ruta))) return;

  if (await dominioExigeSso(userId)) {
    throw new APIError("FORBIDDEN", {
      code: CODIGO_SSO_REQUERIDO,
      message: "Tu organización exige entrar con el SSO de la empresa.",
    });
  }
}

/**
 * El gancho `user.create.before`: ¿este alta hay que frenarla porque el dominio
 * exige SSO? Crear la cuenta para negarle la sesión enseguida la deja a medio
 * hacer —usuario y cuenta sin perfil, y el reintento dice «ya existe»—. Sólo entran
 * el SSO del propio inquilino y el alta de un admin.
 *
 * @param tenantId el inquilino donde aterriza un alta pública (el por defecto).
 *   «Exigir» de otro inquilino no frena esa alta: la cuenta no sería suya. Sin
 *   inquilino por defecto no hay perfil que crear y no hay qué frenar.
 */
export async function altaBloqueadaPorSso(email: string, tenantId: string | null): Promise<boolean> {
  if (esAltaDeAdmin() || ingresoPorSso() || !tenantId) return false;
  return correoExigeSso(email, tenantId);
}
