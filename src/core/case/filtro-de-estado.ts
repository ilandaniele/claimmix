/**
 * Las cinco opciones de estado de la bandeja, y qué estados cubre cada una.
 *
 * ── El problema que resuelve ────────────────────────────────────────────────
 *
 * La bandeja tenía dos controles que contaban lo mismo de dos formas: las
 * cuatro baldosas de arriba agrupaban los estados canónicos, y las pestañas de
 * abajo contaban un estado suelto. Medido en producción el 10/09:
 *
 *     opción       pestaña   baldosa   casos de verdad
 *     Escalado           1        43   escalado 1 + requiere_especialista 42
 *     Listo              0        27   listo_para_core 27
 *     Esperando          0         8   info_faltante 6 + confirmacion_pendiente 2
 *
 * O sea que tres de las cinco pestañas decían **0 sobre 483 casos**. El canal
 * real nunca escribe `listo`, `esperando` ni `escalado` —esos son el
 * vocabulario del flujo simulado— así que el control con el que se navega la
 * bandeja todo el día llevaba meses sin servir, y en la misma pantalla había
 * una baldosa diciendo el número correcto.
 *
 * Es el mismo defecto que ya se arregló dos veces en este repo: en las métricas
 * y en las baldosas. Acá estaba la tercera copia.
 *
 * ── Por qué un grupo y no un estado ─────────────────────────────────────────
 *
 * Porque el contador y el filtro tienen que decir lo mismo. Un chip que diga
 * «Escalado 43» y devuelva un caso al apretarlo es peor que uno que diga 1:
 * el primero miente sobre lo que hay, el segundo sólo muestra de menos.
 *
 * Los conjuntos salen de `fsm.ts`, que es donde ya estaban definidos con su
 * porqué, salvo dos que no existían como conjunto y se arman acá.
 *
 * ── La partición ────────────────────────────────────────────────────────────
 *
 * Los cinco grupos NO se pisan: un caso cae en uno solo. Es lo que un filtro
 * necesita y lo que `ESTADOS_RESUELTOS` no da —incluye `cerrado`, así que
 * «Listo» y «Cerrado» compartirían 76 casos y los dos números sumarían más que
 * el total—.
 *
 * Lo que queda afuera de los cinco es `no_relevante` (329 casos, el balde más
 * grande) y `error_core`. El primero ya se filtra por «No relevantes», que es
 * el grupo `is_claim`; el segundo no es un estado de trabajo sino una falla de
 * integración.
 */

import {
  ESTADOS_COMPLETADO_SIN_PERSONA,
  ESTADOS_ESCALADO,
  ESTADOS_ESPERANDO_AL_DENUNCIANTE,
  type CaseStatus,
} from "./fsm";

/** Lo que va al parámetro `status` de la URL. */
export type ClaveDeEstado =
  | "procesando"
  | "esperando"
  | "confirmacion_pendiente"
  | "escalado"
  | "listo"
  | "cerrado";

/**
 * Qué estados cubre cada opción.
 *
 * El orden es el del recorrido de un siniestro, no el alfabético: quien mira la
 * bandeja lee de arriba abajo cómo avanza el trabajo.
 */
export const ESTADOS_DE_LA_OPCION: Record<ClaveDeEstado, ReadonlySet<CaseStatus>> = {
  // Entró y todavía no lo miró nadie. `recibido` es el del canal real.
  procesando: new Set<CaseStatus>(["procesando", "recibido"]),
  esperando: ESTADOS_ESPERANDO_AL_DENUNCIANTE,
  /*
   * La espera NUESTRA, separada de la del denunciante a propósito.
   *
   * `ESTADOS_ESPERANDO_AL_DENUNCIANTE` deja `confirmacion_pendiente` afuera y
   * explica por qué: ahí falta que un analista confirme un campo, no que
   * conteste el asegurado. Juntarlas bajo «Esperando» es cómo un tablero deja
   * de decir a quién hay que ir a buscar.
   */
  confirmacion_pendiente: new Set<CaseStatus>(["confirmacion_pendiente"]),
  escalado: ESTADOS_ESCALADO,
  listo: ESTADOS_COMPLETADO_SIN_PERSONA,
  cerrado: new Set<CaseStatus>(["cerrado"]),
};

export const CLAVES_DE_ESTADO = Object.keys(ESTADOS_DE_LA_OPCION) as ClaveDeEstado[];

export function esClaveDeEstado(v: string): v is ClaveDeEstado {
  return Object.prototype.hasOwnProperty.call(ESTADOS_DE_LA_OPCION, v);
}

/**
 * Los estados que hay que consultar para un valor del parámetro `status`.
 *
 * Acepta una clave de grupo **o** un estado suelto, y eso no es indecisión: la
 * URL la escribe cualquiera y la API la usan el CSV y el sondeo en vivo. Pedir
 * `?status=requiere_especialista` tiene que seguir devolviendo eso exacto.
 *
 * Las cinco claves de grupo se llaman como su estado principal, así que no hay
 * ambigüedad posible: `escalado` como grupo INCLUYE a `escalado` suelto.
 */
export function estadosAConsultar(valor: string): CaseStatus[] {
  if (esClaveDeEstado(valor)) return [...ESTADOS_DE_LA_OPCION[valor]];
  return [valor as CaseStatus];
}

/**
 * Cuántos casos cae en cada opción, a partir del conteo por estado.
 *
 * Recibe las filas del GROUP BY ya contadas y no habla con la base, igual que
 * `kpisDeLaBandeja`: quién puede pedirlas es decisión del borde.
 */
export function contarPorOpcion(
  porEstado: ReadonlyArray<{ status: string; count: number }>
): Record<ClaveDeEstado, number> {
  const cuenta = new Map(porEstado.map((r) => [r.status, r.count]));
  const salida = {} as Record<ClaveDeEstado, number>;

  for (const clave of CLAVES_DE_ESTADO) {
    salida[clave] = [...ESTADOS_DE_LA_OPCION[clave]].reduce(
      // Un estado sin casos no vuelve del GROUP BY: cuenta 0, no rompe.
      (acc, s) => acc + (cuenta.get(s) ?? 0),
      0
    );
  }

  return salida;
}
