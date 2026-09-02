/**
 * Unit tests for gap-analysis pure function.
 *
 * Covers all 4 claim types, edge cases, and confidence threshold logic.
 * AC5: listo when all required fields present + confidence >= 0.70
 * AC6: esperando when any required doc missing
 * AC7: escalado when all docs present but confidence < 0.70
 */

import { describe, it, expect } from "vitest";
import { analyzeGaps } from "@/core/case/gap-analysis";
import type { ExtractedField } from "@/lib/schemas/extracted-claim";

// ── Helper ────────────────────────────────────────────────────────────────────

function field(key: string, value: string, confidence: number): ExtractedField {
  return { field_key: key, field_value: value, confidence, source: "ai" };
}

// ── choque ────────────────────────────────────────────────────────────────────

describe("analyzeGaps — choque", () => {
  const allChoqueFields: ExtractedField[] = [
    field("parte_amistoso", "si", 0.90),
    field("fotos_danos", "si", 0.85),
    field("licencia_conducir", "si", 0.88),
    field("incident_date", "15/03/2024", 0.95),
    field("incident_location", "Av. Corrientes 2400", 0.80),
  ];

  it("returns listo when all required fields present with confidence >= 0.70", () => {
    const result = analyzeGaps("choque", allChoqueFields, 0.70);
    expect(result.recommended_status).toBe("listo");
    expect(result.missing_doc_keys).toHaveLength(0);
    expect(result.low_confidence_fields).toHaveLength(0);
    expect(result.confidence_min).toBeGreaterThanOrEqual(0.70);
  });

  it("returns esperando when parte_amistoso is missing", () => {
    const fields = allChoqueFields.filter((f) => f.field_key !== "parte_amistoso");
    const result = analyzeGaps("choque", fields, 0.70);
    expect(result.recommended_status).toBe("esperando");
    expect(result.missing_doc_keys).toContain("parte_amistoso");
  });

  it("returns esperando when fotos_danos is missing", () => {
    const fields = allChoqueFields.filter((f) => f.field_key !== "fotos_danos");
    const result = analyzeGaps("choque", fields, 0.70);
    expect(result.recommended_status).toBe("esperando");
    expect(result.missing_doc_keys).toContain("fotos_danos");
  });

  it("returns esperando when licencia_conducir is missing", () => {
    const fields = allChoqueFields.filter((f) => f.field_key !== "licencia_conducir");
    const result = analyzeGaps("choque", fields, 0.70);
    expect(result.recommended_status).toBe("esperando");
    expect(result.missing_doc_keys).toContain("licencia_conducir");
  });

  it("returns escalado when all docs present but one has low confidence", () => {
    const lowConfFields: ExtractedField[] = [
      field("parte_amistoso", "si", 0.50), // below threshold
      field("fotos_danos", "si", 0.85),
      field("licencia_conducir", "si", 0.88),
    ];
    const result = analyzeGaps("choque", lowConfFields, 0.70);
    expect(result.recommended_status).toBe("escalado");
    expect(result.low_confidence_fields).toHaveLength(1);
    expect(result.low_confidence_fields[0]?.field_key).toBe("parte_amistoso");
  });

  it("confidence_min is the minimum of required field confidences", () => {
    const result = analyzeGaps("choque", allChoqueFields, 0.70);
    expect(result.confidence_min).toBe(0.85); // min of 0.90, 0.85, 0.88
  });

  it("confidence_min is null when no required fields are extracted", () => {
    const result = analyzeGaps("choque", [], 0.70);
    expect(result.confidence_min).toBeNull();
    expect(result.missing_doc_keys).toHaveLength(3); // all 3 required docs missing
  });
});

// ── robo ──────────────────────────────────────────────────────────────────────

describe("analyzeGaps — robo", () => {
  const allRoboFields: ExtractedField[] = [
    field("denuncia_policial", "si", 0.88),
    field("fotos_lugar", "si", 0.80),
    field("incident_date", "03/08/2024", 0.92),
    field("vehicle_plate", "GHI 456", 0.95),
  ];

  it("returns listo when denuncia and fotos present with high confidence", () => {
    const result = analyzeGaps("robo", allRoboFields, 0.70);
    expect(result.recommended_status).toBe("listo");
    expect(result.missing_doc_keys).toHaveLength(0);
  });

  it("returns esperando when denuncia_policial missing", () => {
    const fields = allRoboFields.filter((f) => f.field_key !== "denuncia_policial");
    const result = analyzeGaps("robo", fields, 0.70);
    expect(result.recommended_status).toBe("esperando");
    expect(result.missing_doc_keys).toContain("denuncia_policial");
  });

  it("returns esperando when fotos_lugar missing", () => {
    const fields = allRoboFields.filter((f) => f.field_key !== "fotos_lugar");
    const result = analyzeGaps("robo", fields, 0.70);
    expect(result.recommended_status).toBe("esperando");
    expect(result.missing_doc_keys).toContain("fotos_lugar");
  });

  it("returns escalado when both present but denuncia confidence is 0.55", () => {
    const lowConf: ExtractedField[] = [
      field("denuncia_policial", "si", 0.55),
      field("fotos_lugar", "si", 0.80),
    ];
    const result = analyzeGaps("robo", lowConf, 0.70);
    expect(result.recommended_status).toBe("escalado");
    expect(result.low_confidence_fields[0]?.field_key).toBe("denuncia_policial");
  });
});

// ── granizo ───────────────────────────────────────────────────────────────────

describe("analyzeGaps — granizo", () => {
  const allGranizoFields: ExtractedField[] = [
    field("foto_oblea_vtv", "si", 0.87),
    field("fotos_danos", "si", 0.82),
    field("vehicle_plate", "VWX 901", 0.95),
  ];

  it("returns listo when foto_oblea_vtv and fotos_danos present", () => {
    const result = analyzeGaps("granizo", allGranizoFields, 0.70);
    expect(result.recommended_status).toBe("listo");
  });

  it("returns esperando when foto_oblea_vtv missing — AC6 scenario", () => {
    const fields = allGranizoFields.filter((f) => f.field_key !== "foto_oblea_vtv");
    const result = analyzeGaps("granizo", fields, 0.70);
    expect(result.recommended_status).toBe("esperando");
    expect(result.missing_doc_keys).toContain("foto_oblea_vtv");
  });

  it("returns esperando when fotos_danos missing", () => {
    const fields = allGranizoFields.filter((f) => f.field_key !== "fotos_danos");
    const result = analyzeGaps("granizo", fields, 0.70);
    expect(result.recommended_status).toBe("esperando");
    expect(result.missing_doc_keys).toContain("fotos_danos");
  });

  it("escalado when all present but foto_oblea_vtv confidence = 0.60 (below 0.70)", () => {
    const lowConf: ExtractedField[] = [
      field("foto_oblea_vtv", "si", 0.60),
      field("fotos_danos", "si", 0.82),
    ];
    const result = analyzeGaps("granizo", lowConf, 0.70);
    expect(result.recommended_status).toBe("escalado");
  });
});

// ── incendio ──────────────────────────────────────────────────────────────────

describe("analyzeGaps — incendio", () => {
  const allIncendioFields: ExtractedField[] = [
    field("informe_bomberos", "si", 0.88),
    field("fotos_danos", "si", 0.85),
    field("denuncia_policial", "si", 0.87),
    field("vehicle_plate", "KLM 456", 0.95),
  ];

  it("returns listo when all 3 required docs present", () => {
    const result = analyzeGaps("incendio", allIncendioFields, 0.70);
    expect(result.recommended_status).toBe("listo");
    expect(result.missing_doc_keys).toHaveLength(0);
  });

  it("returns esperando when informe_bomberos missing", () => {
    const fields = allIncendioFields.filter((f) => f.field_key !== "informe_bomberos");
    const result = analyzeGaps("incendio", fields, 0.70);
    expect(result.recommended_status).toBe("esperando");
    expect(result.missing_doc_keys).toContain("informe_bomberos");
  });

  it("returns esperando when multiple required docs missing", () => {
    const result = analyzeGaps("incendio", [], 0.70);
    expect(result.recommended_status).toBe("esperando");
    expect(result.missing_doc_keys).toHaveLength(3);
    expect(result.missing_doc_keys).toContain("informe_bomberos");
    expect(result.missing_doc_keys).toContain("fotos_danos");
    expect(result.missing_doc_keys).toContain("denuncia_policial");
  });

  it("escalado when all present but informe_bomberos confidence = 0.45", () => {
    const lowConf: ExtractedField[] = [
      field("informe_bomberos", "si", 0.45),
      field("fotos_danos", "si", 0.85),
      field("denuncia_policial", "si", 0.87),
    ];
    const result = analyzeGaps("incendio", lowConf, 0.70);
    expect(result.recommended_status).toBe("escalado");
    expect(result.low_confidence_fields).toHaveLength(1);
    expect(result.low_confidence_fields[0]?.field_key).toBe("informe_bomberos");
  });
});

// ── Confidence threshold configuration ───────────────────────────────────────

describe("analyzeGaps — custom threshold", () => {
  it("uses 0.80 threshold when passed explicitly", () => {
    const fields: ExtractedField[] = [
      field("denuncia_policial", "si", 0.75), // above 0.70 but below 0.80
      field("fotos_lugar", "si", 0.82),
    ];
    const result = analyzeGaps("robo", fields, 0.80);
    expect(result.recommended_status).toBe("escalado");
    expect(result.low_confidence_fields[0]?.field_key).toBe("denuncia_policial");
  });

  it("uses 0.50 threshold when passed explicitly", () => {
    const fields: ExtractedField[] = [
      field("denuncia_policial", "si", 0.52),
      field("fotos_lugar", "si", 0.55),
    ];
    const result = analyzeGaps("robo", fields, 0.50);
    expect(result.recommended_status).toBe("listo");
  });
});
