/**
 * Unit tests for hydrateFieldsFromExtracted() and scrubPiiFromSummary().
 *
 * UNIT-3: Empty fields[] + populated extracted_fields → keys hydrated
 * UNIT-4: Pre-populated fields[] entry → no duplicate added
 * UNIT-5: field_confidences[key] used when present
 * SEC-2: summary containing DNI "92310691" is scrubbed
 */

import { describe, it, expect } from "vitest";
import {
  hydrateFieldsFromExtracted,
  scrubPiiFromSummary,
} from "@/server/ai/hydrate-fields";
import type { ExtractedClaim } from "@/lib/schemas/extracted-claim";
import { extraccion } from "../../../helpers/extraccion";

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeClaim(overrides: Partial<ExtractedClaim> = {}): ExtractedClaim {
  return extraccion({
    extraction_model: "gpt-4o-mini",
    fields: [],
    prompt_tokens: 0,
    completion_tokens: 0,
    cost_usd: 0,
    is_claim: true,
    confidence: 0.9,
    extracted_fields: undefined,
    field_confidences: {},
    missing_fields: [],
    fields_pending_confirmation: [],
    possible_customer_matches: [],
    possible_policy_matches: [],
    severity: null,
    requires_specialist: false,
    not_relevant_reason: undefined,
    summary: "",
    suggested_reply: "",
    ...overrides,
  });
}

// ── hydrateFieldsFromExtracted ─────────────────────────────────────────────────

describe("hydrateFieldsFromExtracted — UNIT-3: empty fields[] + populated extracted_fields", () => {
  it("hydrates full_name and dni when fields[] is empty", () => {
    const claim = makeClaim({
      fields: [],
      extracted_fields: { full_name: "NICOLAS JASPER", dni: "92310691" },
      field_confidences: {},
    });

    const result = hydrateFieldsFromExtracted(claim);

    const fullNameEntry = result.find((f) => f.field_key === "full_name");
    const dniEntry = result.find((f) => f.field_key === "dni");

    expect(fullNameEntry).toBeDefined();
    expect(fullNameEntry?.field_value).toBe("NICOLAS JASPER");
    expect(fullNameEntry?.confidence).toBe(0.85); // default

    expect(dniEntry).toBeDefined();
    expect(dniEntry?.field_value).toBe("92310691");
    expect(dniEntry?.confidence).toBe(0.85); // default
  });

  it("hydrates all 9 keys when all are present in extracted_fields", () => {
    const claim = makeClaim({
      fields: [],
      extracted_fields: {
        full_name: "John Doe",
        email: "john@example.com",
        phone: "1122334455",
        dni: "12345678",
        policy_number: "POL-9999",
        accident_date: "2024-01-15",
        accident_location: "Av. Corrientes 123",
        accident_description: "Choque leve",
        claim_type: "choque",
      },
      field_confidences: {},
    });

    const result = hydrateFieldsFromExtracted(claim);
    expect(result.length).toBe(9);

    const keys = result.map((f) => f.field_key);
    expect(keys).toContain("full_name");
    expect(keys).toContain("email");
    expect(keys).toContain("phone");
    expect(keys).toContain("dni");
    expect(keys).toContain("policy_number");
    expect(keys).toContain("accident_date");
    expect(keys).toContain("accident_location");
    expect(keys).toContain("accident_description");
    expect(keys).toContain("claim_type");
  });

  it("sets source='ai' for all hydrated entries", () => {
    const claim = makeClaim({
      fields: [],
      extracted_fields: { full_name: "Test User", dni: "99887766" },
    });

    const result = hydrateFieldsFromExtracted(claim);
    for (const entry of result) {
      expect(entry.source).toBe("ai");
    }
  });
});

describe("hydrateFieldsFromExtracted — UNIT-4: no duplicate when fields[] already has key", () => {
  it("does NOT add full_name when it already exists in fields[]", () => {
    const claim = makeClaim({
      fields: [
        {
          field_key: "full_name",
          field_value: "PRE-EXISTING",
          confidence: 0.95,
          source: "ai",
        },
      ],
      extracted_fields: { full_name: "NICOLAS JASPER" },
      field_confidences: {},
    });

    const result = hydrateFieldsFromExtracted(claim);
    const fullNameEntries = result.filter((f) => f.field_key === "full_name");

    expect(fullNameEntries.length).toBe(1);
    expect(fullNameEntries[0].field_value).toBe("PRE-EXISTING");
  });

  it("adds missing keys but leaves existing ones untouched", () => {
    const claim = makeClaim({
      fields: [
        {
          field_key: "full_name",
          field_value: "EXISTING NAME",
          confidence: 0.9,
          source: "ai",
        },
      ],
      extracted_fields: {
        full_name: "DIFFERENT NAME",
        dni: "12345678",
      },
      field_confidences: {},
    });

    const result = hydrateFieldsFromExtracted(claim);

    const fullNameEntry = result.find((f) => f.field_key === "full_name");
    const dniEntry = result.find((f) => f.field_key === "dni");

    expect(fullNameEntry?.field_value).toBe("EXISTING NAME"); // unchanged
    expect(dniEntry?.field_value).toBe("12345678"); // added
    expect(result.length).toBe(2);
  });
});

describe("hydrateFieldsFromExtracted — UNIT-5: field_confidences used when present", () => {
  it("uses field_confidences[key] for confidence when available", () => {
    const claim = makeClaim({
      fields: [],
      extracted_fields: { dni: "92310691" },
      field_confidences: { dni: 0.92 },
    });

    const result = hydrateFieldsFromExtracted(claim);
    const dniEntry = result.find((f) => f.field_key === "dni");

    expect(dniEntry?.confidence).toBe(0.92);
  });

  it("falls back to 0.85 default when field_confidences[key] is absent", () => {
    const claim = makeClaim({
      fields: [],
      extracted_fields: { full_name: "Test User" },
      field_confidences: {}, // no entry for full_name
    });

    const result = hydrateFieldsFromExtracted(claim);
    const entry = result.find((f) => f.field_key === "full_name");

    expect(entry?.confidence).toBe(0.85);
  });

  it("clamps confidence to [0, 1] even if field_confidences value is out of range", () => {
    const claim = makeClaim({
      fields: [],
      extracted_fields: { policy_number: "POL-123" },
      field_confidences: { policy_number: 1.5 }, // out of range
    });

    const result = hydrateFieldsFromExtracted(claim);
    const entry = result.find((f) => f.field_key === "policy_number");

    expect(entry?.confidence).toBe(1);
  });
});

describe("hydrateFieldsFromExtracted — edge cases", () => {
  it("returns original fields[] when extracted_fields is undefined", () => {
    const claim = makeClaim({
      fields: [
        { field_key: "incident_date", field_value: "2024-01-01", confidence: 0.9, source: "ai" },
      ],
      extracted_fields: undefined,
    });

    const result = hydrateFieldsFromExtracted(claim);
    expect(result.length).toBe(1);
  });

  it("does NOT hydrate empty string values from extracted_fields", () => {
    const claim = makeClaim({
      fields: [],
      extracted_fields: { full_name: "", dni: "12345678" },
      field_confidences: {},
    });

    const result = hydrateFieldsFromExtracted(claim);
    const keys = result.map((f) => f.field_key);

    expect(keys).not.toContain("full_name"); // empty string, skip
    expect(keys).toContain("dni"); // non-empty, add
  });

  it("trims whitespace-only values and does NOT hydrate them", () => {
    const claim = makeClaim({
      fields: [],
      extracted_fields: { full_name: "   ", email: "test@example.com" },
      field_confidences: {},
    });

    const result = hydrateFieldsFromExtracted(claim);
    const keys = result.map((f) => f.field_key);

    expect(keys).not.toContain("full_name"); // whitespace-only, skip
    expect(keys).toContain("email");
  });

  it("trims leading/trailing whitespace from hydrated values", () => {
    const claim = makeClaim({
      fields: [],
      extracted_fields: { full_name: "  NICOLAS JASPER  " },
      field_confidences: {},
    });

    const result = hydrateFieldsFromExtracted(claim);
    const entry = result.find((f) => f.field_key === "full_name");

    expect(entry?.field_value).toBe("NICOLAS JASPER");
  });

  it("truncates field_value to 2000 chars", () => {
    const longValue = "A".repeat(3000);
    const claim = makeClaim({
      fields: [],
      extracted_fields: { accident_description: longValue },
      field_confidences: {},
    });

    const result = hydrateFieldsFromExtracted(claim);
    const entry = result.find((f) => f.field_key === "accident_description");

    expect(entry?.field_value.length).toBe(2000);
  });

  it("does not mutate the input claim's fields array", () => {
    const originalFields = [
      { field_key: "incident_date", field_value: "2024-01-01", confidence: 0.9, source: "ai" as const },
    ];
    const claim = makeClaim({
      fields: originalFields,
      extracted_fields: { full_name: "Test" },
    });

    const result = hydrateFieldsFromExtracted(claim);

    // Original array should not be mutated
    expect(claim.fields.length).toBe(1);
    // Result should have 2 entries
    expect(result.length).toBe(2);
  });
});

// ── scrubPiiFromSummary ────────────────────────────────────────────────────────

describe("scrubPiiFromSummary — SEC-2: DNI scrubbing", () => {
  it("removes literal DNI value from summary", () => {
    const claim = makeClaim({
      extracted_fields: { full_name: "NICOLAS JASPER", dni: "92310691" },
      summary: "El asegurado NICOLAS JASPER con DNI 92310691 reportó el siniestro.",
    });

    const result = scrubPiiFromSummary(claim);

    expect(result.summary).not.toContain("92310691");
    expect(result.summary).toContain("[DNI omitido]");
  });

  it("removes full_name from summary and replaces with 'el asegurado'", () => {
    const claim = makeClaim({
      extracted_fields: { full_name: "NICOLAS JASPER", dni: "92310691" },
      summary: "NICOLAS JASPER solicitó asistencia.",
    });

    const result = scrubPiiFromSummary(claim);

    expect(result.summary).not.toContain("NICOLAS JASPER");
    expect(result.summary).toContain("el asegurado");
  });

  it("removes DNI from suggested_reply", () => {
    const claim = makeClaim({
      extracted_fields: { dni: "92310691" },
      suggested_reply: "Estimado cliente, su DNI 92310691 fue verificado.",
    });

    const result = scrubPiiFromSummary(claim);

    expect(result.suggested_reply).not.toContain("92310691");
  });

  it("removes policy_number from summary", () => {
    const claim = makeClaim({
      extracted_fields: { policy_number: "91520998-2" },
      summary: "El siniestro 91520998-2 está siendo procesado.",
    });

    const result = scrubPiiFromSummary(claim);

    expect(result.summary).not.toContain("91520998-2");
    expect(result.summary).toContain("[póliza omitida]");
  });

  it("scrubs DNI from not_relevant_reason when set", () => {
    const claim = makeClaim({
      extracted_fields: { dni: "12345678" },
      not_relevant_reason: "DNI 12345678 no coincide.",
    });

    const result = scrubPiiFromSummary(claim);

    expect(result.not_relevant_reason).not.toContain("12345678");
  });

  it("leaves not_relevant_reason as undefined when it was undefined", () => {
    const claim = makeClaim({
      extracted_fields: { dni: "12345678" },
      not_relevant_reason: undefined,
    });

    const result = scrubPiiFromSummary(claim);

    expect(result.not_relevant_reason).toBeUndefined();
  });

  it("is case-insensitive for full_name matching", () => {
    const claim = makeClaim({
      extracted_fields: { full_name: "NICOLAS JASPER" },
      summary: "nicolas jasper realizó la denuncia.",
    });

    const result = scrubPiiFromSummary(claim);

    expect(result.summary).not.toContain("nicolas jasper");
    expect(result.summary).toContain("el asegurado");
  });

  it("does not modify extracted_fields (only free-text fields are scrubbed)", () => {
    const claim = makeClaim({
      extracted_fields: { full_name: "NICOLAS JASPER", dni: "92310691" },
      summary: "NICOLAS JASPER, DNI 92310691",
    });

    const result = scrubPiiFromSummary(claim);

    // Structured fields should be UNTOUCHED
    expect(result.extracted_fields?.full_name).toBe("NICOLAS JASPER");
    expect(result.extracted_fields?.dni).toBe("92310691");
  });

  it("applies generic DNI pattern fallback for new DNI values not in extracted_fields", () => {
    const claim = makeClaim({
      extracted_fields: {}, // no extracted DNI
      summary: "El asegurado tiene DNI 12.345.678 registrado.",
    });

    const result = scrubPiiFromSummary(claim);

    // Generic DNI pattern should catch 12.345.678
    expect(result.summary).not.toContain("12.345.678");
    expect(result.summary).toContain("[DNI omitido]");
  });

  it("does not mutate the input claim", () => {
    const claim = makeClaim({
      extracted_fields: { dni: "92310691" },
      summary: "DNI 92310691 en el texto.",
    });

    scrubPiiFromSummary(claim);

    // Original summary should be unchanged
    expect(claim.summary).toBe("DNI 92310691 en el texto.");
  });

  it("returns empty summary unchanged when it was already empty", () => {
    const claim = makeClaim({
      extracted_fields: { full_name: "Test", dni: "12345678" },
      summary: "",
    });

    const result = scrubPiiFromSummary(claim);
    expect(result.summary).toBe("");
  });
});
