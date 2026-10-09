/**
 * Adónde sigue quien terminó de pedir su espacio, venga de /alta (Google) o de
 * /alta/correo (el enlace del mail). Las dos acciones cierran igual; escribirlo
 * dos veces es dejar que un camino diga una cosa y el otro otra.
 */

import "server-only";

import { after } from "next/server";

import { basePorCliente } from "@/data/bases";
import { logger } from "@/lib/observability/logger";
import { avisarAlOperador, llegoAlAviso } from "@/server/alta/aviso-operador";
import type { AltaCreada, ResultadoDeAlta } from "@/server/alta/crear-inquilino";
import type { ErrorDeAlta } from "@/server/alta/validar";
import { iniciarBase } from "@/server/bases/iniciar";

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

/**
 * Adónde va quien tiene su espacio recién creado. Con una base por cliente el
 * espacio todavía no tiene dónde guardar nada: se lanza la preparación y la
 * persona espera en /preparando. Apagada la bandera, `destino`.
 *
 * Si la preparación no arranca, el espacio ya existe y la persona no puede hacer
 * nada con el error: se anota y se la manda igual a /preparando, que sabe
 * reintentar (el barrido de bases pendientes también).
 */
export async function prepararEspacio({ tenantId }: AltaCreada, destino: string): Promise<string> {
  if (!basePorCliente()) return destino;
  try {
    await iniciarBase(tenantId);
  } catch (e) {
    logger.error({ error: e instanceof Error ? e.name : "UnknownError", tenantId }, "alta.base_no_arranco");
  }
  return "/preparando";
}
