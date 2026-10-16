/**
 * Los faltantes requeridos como funciones puras del núcleo: lo que
 * `analyzeEmailClaimGaps` calcula una vez leído el caso, sin base ni mocks.
 */

import { describe, it, expect } from "vitest";
import {
  REQUIRED_CLAIM_FIELDS,
  claveDelRamoDelCaso,
  faltantesRequeridos,
  mapaDeCampos,
} from "@/core/case/faltantes-requeridos";
import { camposRequeridosDelRamo } from "@/core/case/required-fields";
import type { ExtractedField } from "@/lib/schemas/extracted-claim";

function campo(field_key: string, field_value: string, confidence: number): ExtractedField {
  return { field_key, field_value, confidence, source: "ai" };
}

/** Los seis requeridos base a confianza alta, con un mail. */
const BASE_COMPLETA = [
  campo("full_name", "Juan Pérez", 0.9),
  campo("accident_date", "2024-03-15", 0.9),
  campo("accident_description", "Choque en Av. Corrientes", 0.9),
  campo("claim_type", "choque", 0.9),
  campo("policy_number", "POL-4471-A", 0.9),
  campo("dni", "30145882", 0.9),
  campo("email", "juan@example.com", 0.9),
];

/** El camino completo del analizador, menos la lectura de la base. */
function faltantesDe(campos: ExtractedField[], pedidosSinValor: string[] = []): string[] {
  const mapa = mapaDeCampos(campos);
  const delRamo = camposRequeridosDelRamo(claveDelRamoDelCaso(mapa));
  return faltantesRequeridos(mapa, delRamo, pedidosSinValor);
}

describe("faltantesRequeridos", () => {
  it("sin campos da los 6 requeridos más email_or_phone", () => {
    expect(faltantesDe([])).toEqual([...REQUIRED_CLAIM_FIELDS, "email_or_phone"]);
    expect(REQUIRED_CLAIM_FIELDS).toHaveLength(6);
  });

  it("con la base completa y un ramo que sólo pide provincia, falta sólo eso", () => {
    const deVida = BASE_COMPLETA.map((f) =>
      f.field_key === "claim_type" ? { ...f, field_value: "vida" } : f
    );
    expect(faltantesDe(deVida)).toEqual(["provincia_siniestro"]);
    expect(faltantesDe([...deVida, campo("provincia_siniestro", "Chubut", 0.9)])).toEqual([]);
  });

  it("el ramo choque con confianza alta suma patente, provincia y hora", () => {
    expect(faltantesDe(BASE_COMPLETA)).toEqual([
      "patente_vehiculo",
      "provincia_siniestro",
      "hora_siniestro",
    ]);
  });

  it("el ramo choque con poca confianza no suma campos del ramo", () => {
    const pocoFirme = BASE_COMPLETA.map((f) =>
      f.field_key === "claim_type" ? { ...f, confidence: 0.4 } : f
    );
    const mapa = mapaDeCampos(pocoFirme);

    expect(claveDelRamoDelCaso(mapa)).toBeNull();
    // Sin el ramo no se pide de más, pero el propio claim_type tampoco cuenta como presente.
    expect(faltantesDe(pocoFirme)).toEqual(["claim_type"]);
  });

  it("party_a_plate satisface patente_vehiculo", () => {
    const faltantes = faltantesDe([...BASE_COMPLETA, campo("party_a_plate", "AB123CD", 0.9)]);

    expect(faltantes).not.toContain("patente_vehiculo");
    expect(faltantes).toEqual(["provincia_siniestro", "hora_siniestro"]);
  });

  it("la patente de un tercero no satisface la del asegurado", () => {
    expect(faltantesDe([...BASE_COMPLETA, campo("party_b_plate", "XY987ZT", 0.9)])).toContain(
      "patente_vehiculo"
    );
  });

  it("un campo por debajo del piso de confianza cuenta como faltante", () => {
    const sinDni = BASE_COMPLETA.map((f) => (f.field_key === "dni" ? { ...f, confidence: 0.5 } : f));

    expect(faltantesDe(sinDni)).toContain("dni");
  });

  it("un teléfono con confianza alta quita email_or_phone", () => {
    expect(faltantesDe([])).toContain("email_or_phone");
    expect(faltantesDe([campo("phone", "+5491155550000", 0.9)])).not.toContain("email_or_phone");
  });

  it("un contacto firme pedido a la vez no vuelve a faltar", () => {
    expect(faltantesDe([campo("email", "juan@example.com", 0.9)], ["email", "phone"])).not.toContain(
      "email_or_phone"
    );
  });

  it("un contacto dudoso que se pidió y no llegó sigue faltando", () => {
    const dudoso = [campo("phone", "1155", 0.3)];

    expect(faltantesDe(dudoso, ["phone"])).toContain("email_or_phone");
    // Mencionado y no pedido: tal como estaba, no se vuelve a pedir.
    expect(faltantesDe(dudoso)).not.toContain("email_or_phone");
  });
});

describe("mapaDeCampos", () => {
  it("junta las grafías de un mismo campo bajo la clave canónica", () => {
    const mapa = mapaDeCampos([campo("numero_poliza", "POL-1", 0.9)]);

    expect(mapa.get("policy_number")?.field_value).toBe("POL-1");
    expect(mapa.has("numero_poliza")).toBe(false);
  });

  it("gana la copia de mayor confianza y, a igualdad, la que viene después", () => {
    const mapa = mapaDeCampos([
      campo("full_name", "Juan Pérez", 0.9),
      campo("full_name", "Juan Perez", 0.7),
      campo("dni", "30145882", 0.8),
      campo("dni", "30145883", 0.8),
    ]);

    expect(mapa.get("full_name")?.field_value).toBe("Juan Pérez");
    expect(mapa.get("dni")?.field_value).toBe("30145883");
  });
});

describe("claveDelRamoDelCaso", () => {
  it("es null sin claim_type", () => {
    expect(claveDelRamoDelCaso(new Map())).toBeNull();
  });

  it("devuelve el valor de claim_type cuando alcanza el piso", () => {
    expect(claveDelRamoDelCaso(mapaDeCampos([campo("claim_type", "robo", 0.6)]))).toBe("robo");
    expect(claveDelRamoDelCaso(mapaDeCampos([campo("claim_type", "robo", 0.59)]))).toBeNull();
  });
});
