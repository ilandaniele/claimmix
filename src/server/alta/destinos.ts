/**
 * Adónde sigue quien terminó de pedir su espacio, venga de /alta (Google) o de
 * /alta/correo (el enlace del mail). Las dos acciones cierran igual; escribirlo
 * dos veces es dejar que un camino diga una cosa y el otro otra.
 */

import "server-only";

import { after } from "next/server";

import { avisarAlOperador, llegoAlAviso } from "@/server/alta/aviso-operador";
import type { AltaCreada, ResultadoDeAlta } from "@/server/alta/crear-inquilino";
import type { ErrorDeAlta } from "@/server/alta/validar";

export const conError = (e: ErrorDeAlta) => `/alta?e=${e}`;

/**
 * Adónde va quien no quedó con espacio. `no_verificado` vuelve con «falla» y no
 * a /alta a secas: si la sesión cacheada dice «verificado» y la base no, la
 * pantalla lo reenviaría solo, en bucle.
 */
export const SIN_ESPACIO: Record<Exclude<ResultadoDeAlta, "ok" | "ok_numero_en_revision">, string> = {
  ya_tiene_espacio: "/bandeja",
  no_verificado: conError("falla"),
  datos_invalidos: conError("datos"),
  alta_cerrada: conError("cerrada"),
};

/** Avisa al operador, ya con la respuesta enviada, si con este espacio el día llega al aviso. */
export function avisarSiLlegoAlTope({ creadas24h, tope }: AltaCreada): void {
  if (creadas24h !== null && tope !== null && llegoAlAviso(creadas24h, tope)) {
    after(() => avisarAlOperador(creadas24h, tope));
  }
}
