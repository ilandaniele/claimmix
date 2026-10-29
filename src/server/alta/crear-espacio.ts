/**
 * Crear el espacio de quien ya tiene cuenta y dijo en /alta que viene a dar de
 * alta su empresa, y adónde sigue después.
 *
 * Es un módulo de servidor y no una acción: un archivo con "use server" publica
 * todos sus exports como endpoints, y esto toma cupos y escribe en la base. Lo
 * llama `crearMiEspacio`, que antes mira la sesión. No redirige ni usa `after()`
 * ni cookies: eso queda en la acción, fuera de todo try/catch.
 *
 * El orden es el que no regala nada: primero lo que se mira sin gastar cupos
 * (que los datos valgan), después el cupo por IP, y recién entonces la función de
 * la base. Lo que se libera es SÓLO lo que esta llamada tomó. El tope global de
 * 24 h no se cuenta acá: lo cuenta la base.
 */

import "server-only";

import { basePorCliente } from "@/data/bases";
import { ipValida } from "@/lib/audit/log";
import { logger } from "@/lib/observability/logger";
import { crearInquilino, type AltaCreada, type ResultadoDeAlta } from "@/server/alta/crear-inquilino";
import { soltarCupoDeAlta, tomarCupoDeAlta } from "@/server/alta/cupo-por-ip";
import { PRIMEROS_PASOS } from "@/server/alta/pasos-hechos";
import { faltaElNueveArgentino, normalizarE164, validarEmpresa, type ErrorDeAlta } from "@/server/alta/validar";
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

/**
 * Pide el espacio. `alta` viene sólo si se creó, para que la acción avise al
 * operador con la respuesta ya enviada: diferir trabajo es de la acción.
 */
export async function crearEspacio({
  userId,
  empresa: empresaCruda,
  whatsapp,
  terminos,
  numeroAutomatico,
  ip,
}: {
  userId: string;
  empresa: unknown;
  whatsapp: unknown;
  terminos: boolean;
  numeroAutomatico: boolean;
  ip: string;
}): Promise<{ destino: string; alta?: AltaCreada }> {
  const empresa = validarEmpresa(empresaCruda);
  const numero = normalizarE164(whatsapp);
  if (!empresa.ok || numero === null || !terminos) return { destino: conError("datos") };
  if (numeroAutomatico && faltaElNueveArgentino(numero)) return { destino: conError("celular") };

  const { clave, cupo } = await tomarCupoDeAlta(ip);
  // `ventana: 0` es que el contador no contestó: no hubo «demasiados intentos».
  if (!cupo.allowed) return { destino: conError(cupo.ventana === 0 ? "falla" : "intentos") };

  let alta: AltaCreada;
  try {
    alta = await crearInquilino({ userId, empresa: empresa.empresa, numero, ip: ipValida(ip) });
  } catch (e) {
    logger.error({ error: e instanceof Error ? e.name : "UnknownError" }, "alta.crear_inquilino_fallo");
    await soltarCupoDeAlta(clave, cupo.ventana);
    return { destino: conError("falla") };
  }

  if (alta.resultado !== "ok" && alta.resultado !== "ok_numero_en_revision") {
    if (alta.resultado === "alta_cerrada") {
      logger.warn({ creadas24h: alta.creadas24h, tope: alta.tope }, "alta.cerrada");
    }
    await soltarCupoDeAlta(clave, cupo.ventana);
    return { destino: SIN_ESPACIO[alta.resultado] };
  }

  // Los dos resultados dicen lo mismo: no se confirma que el número ya lo había pedido otro.
  // Recién creado no tiene Gmail: pasosHechos daría este mismo destino, así que no se consulta.
  return { destino: await prepararEspacio(alta, PRIMEROS_PASOS), alta };
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
