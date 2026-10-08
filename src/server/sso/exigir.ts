import "server-only";

import { APIError } from "better-auth/api";

import { ingresoPorSso } from "@/lib/auth/registro-permitido";

import { dominioExigeSso, inquilinoDelUsuario } from "./usuarios";

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
 * - El cambio de contraseña no es un ingreso y pasa sin consulta: rota las
 *   sesiones de quien ya estaba adentro (`revokeOtherSessions`). Sin esto, con
 *   «exigir» quien cambia su contraseña queda afuera de su propia sesión.
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

  if (ruta !== undefined && RUTAS_QUE_RENUEVAN_LA_SESION.has(ruta)) return;

  if (await dominioExigeSso(userId)) {
    throw new APIError("FORBIDDEN", {
      code: CODIGO_SSO_REQUERIDO,
      message: "Tu organización exige entrar con el SSO de la empresa.",
    });
  }
}
