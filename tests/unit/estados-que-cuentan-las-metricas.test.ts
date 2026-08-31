/**
 * Qué estados cuentan las métricas, y por qué contaban cero.
 *
 * La pantalla de métricas mostraba «Tasa de completitud automática: 0%» y
 * «Siniestros escalados: 0 siniestros» con 28 casos completados y 43 escalados
 * en la base. No era un error de cálculo: contaba `status = 'listo'` y
 * `status = 'escalado'`, que son el vocabulario VIEJO —el del flujo simulado— y
 * que el intake real no escribe nunca. El correo y el WhatsApp terminan en
 * `listo_para_core` y en `requiere_especialista`.
 *
 * Un producto que funciona, mostrándose roto a quien lo está evaluando, sin una
 * sola excepción ni una línea de log.
 *
 * Medido contra la base de producción después del cambio: la tasa pasó de 0% a
 * 6% y los escalados de 0 a 43.
 */

import { describe, it, expect } from "vitest";

import {
  ESTADOS_COMPLETADO_SIN_PERSONA,
  ESTADOS_ESCALADO,
  AI_ALLOWED_STATUSES,
} from "@/core/case/fsm";
import { CaseStatusSchema } from "@/lib/schemas/cases";

describe("los estados que cuentan como completado sin persona", () => {
  it("incluye el del canal REAL, que era el que faltaba", () => {
    expect(ESTADOS_COMPLETADO_SIN_PERSONA.has("listo_para_core")).toBe(true);
  });

  it("y también el viejo, para que las filas de antes sigan contando", () => {
    expect(ESTADOS_COMPLETADO_SIN_PERSONA.has("listo")).toBe(true);
  });

  it("un caso ya exportado sigue contando como completado", () => {
    // Sin esto el número BAJA a medida que los casos avanzan, que es otra forma
    // del mismo error: un contador que se vacía solo.
    expect(ESTADOS_COMPLETADO_SIN_PERSONA.has("enviado_a_core")).toBe(true);
  });

  it("`cerrado` NO cuenta: ahí adentro está el cierre por abandono", () => {
    // Cerrar una denuncia que nadie contestó es lo contrario de completarla.
    expect(ESTADOS_COMPLETADO_SIN_PERSONA.has("cerrado")).toBe(false);
  });

  it("ni los estados en los que todavía se está trabajando", () => {
    for (const s of ["recibido", "info_faltante", "confirmacion_pendiente", "procesando"] as const) {
      expect(ESTADOS_COMPLETADO_SIN_PERSONA.has(s)).toBe(false);
    }
  });
});

describe("los estados que cuentan como escalado", () => {
  it("incluye el del canal REAL", () => {
    expect(ESTADOS_ESCALADO.has("requiere_especialista")).toBe(true);
  });

  it("y el viejo", () => {
    expect(ESTADOS_ESCALADO.has("escalado")).toBe(true);
  });

  it("no se pisa con los completados", () => {
    // Un caso no puede estar en las dos tarjetas a la vez.
    const cruce = [...ESTADOS_ESCALADO].filter((s) =>
      ESTADOS_COMPLETADO_SIN_PERSONA.has(s)
    );
    expect(cruce).toEqual([]);
  });
});

describe("las dos listas hablan de estados que existen", () => {
  it("todos son estados válidos del esquema", () => {
    /*
     * El control que hace que lo de arriba signifique algo. Un nombre mal
     * escrito —`listo_para_core_` o `requiere_specialista`— produce exactamente
     * el mismo síntoma que el defecto original: un contador en cero, sin error.
     */
    for (const s of [...ESTADOS_COMPLETADO_SIN_PERSONA, ...ESTADOS_ESCALADO]) {
      expect(CaseStatusSchema.safeParse(s).success).toBe(true);
    }
  });

  it("el escalado es uno que el agente puede escribir por su cuenta", () => {
    // Si el agente no pudiera dejar un caso en ese estado, la tarjeta contaría
    // sólo lo que escriben las personas, que no es lo que promete su título.
    expect(AI_ALLOWED_STATUSES.has("requiere_especialista")).toBe(true);
  });
});
