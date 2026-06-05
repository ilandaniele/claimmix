/**
 * i18n parity tests for PII field labels.
 *
 * UNIT-2 (AC9): Asserts all 8 new field.* PII keys exist in both es-AR and en-US bundles,
 *               with non-empty string values.
 *
 * AC13 regression: Legacy field_key labels (field.date, field.location, party_a_name, etc.)
 *                  still exist and are non-empty.
 */

import { describe, it, expect } from "vitest";
import { esAR } from "@/lib/i18n/es-AR";
import { enUS } from "@/lib/i18n/en-US";

// ── New PII field keys (AC9) ───────────────────────────────────────────────────

const NEW_FIELD_KEYS = [
  "field.full_name",
  "field.email",
  "field.phone",
  "field.dni",
  "field.policy_number",
  "field.accident_date",
  "field.accident_location",
  "field.accident_description",
] as const;

describe("UNIT-2: New PII field keys exist in es-AR", () => {
  for (const key of NEW_FIELD_KEYS) {
    it(`es-AR has non-empty value for "${key}"`, () => {
      const value = (esAR as Record<string, string>)[key];
      expect(value, `Key '${key}' missing from esAR`).toBeDefined();
      expect(value, `Key '${key}' is empty in esAR`).not.toBe("");
      expect(typeof value).toBe("string");
    });
  }
});

describe("UNIT-2: New PII field keys exist in en-US", () => {
  for (const key of NEW_FIELD_KEYS) {
    it(`en-US has non-empty value for "${key}"`, () => {
      const value = (enUS as Record<string, string>)[key];
      expect(value, `Key '${key}' missing from enUS`).toBeDefined();
      expect(value, `Key '${key}' is empty in enUS`).not.toBe("");
      expect(typeof value).toBe("string");
    });
  }
});

describe("UNIT-2: Correct Spanish labels in es-AR", () => {
  it("field.full_name → 'Nombre completo'", () => {
    expect((esAR as Record<string, string>)["field.full_name"]).toBe("Nombre completo");
  });
  it("field.email → 'Correo electrónico'", () => {
    expect((esAR as Record<string, string>)["field.email"]).toBe("Correo electrónico");
  });
  it("field.phone → 'Teléfono'", () => {
    expect((esAR as Record<string, string>)["field.phone"]).toBe("Teléfono");
  });
  it("field.dni → 'DNI'", () => {
    expect((esAR as Record<string, string>)["field.dni"]).toBe("DNI");
  });
  it("field.policy_number → 'Número de póliza'", () => {
    expect((esAR as Record<string, string>)["field.policy_number"]).toBe("Número de póliza");
  });
  it("field.accident_date → 'Fecha del siniestro'", () => {
    expect((esAR as Record<string, string>)["field.accident_date"]).toBe("Fecha del siniestro");
  });
  it("field.accident_location → 'Lugar del siniestro'", () => {
    expect((esAR as Record<string, string>)["field.accident_location"]).toBe("Lugar del siniestro");
  });
  it("field.accident_description → 'Descripción del siniestro'", () => {
    expect((esAR as Record<string, string>)["field.accident_description"]).toBe("Descripción del siniestro");
  });
});

describe("UNIT-2: Correct English labels in en-US", () => {
  it("field.full_name → 'Full name'", () => {
    expect((enUS as Record<string, string>)["field.full_name"]).toBe("Full name");
  });
  it("field.email → 'Email address'", () => {
    expect((enUS as Record<string, string>)["field.email"]).toBe("Email address");
  });
  it("field.phone → 'Phone'", () => {
    expect((enUS as Record<string, string>)["field.phone"]).toBe("Phone");
  });
  it("field.dni → 'National ID'", () => {
    expect((enUS as Record<string, string>)["field.dni"]).toBe("National ID");
  });
  it("field.policy_number → 'Policy number'", () => {
    expect((enUS as Record<string, string>)["field.policy_number"]).toBe("Policy number");
  });
  it("field.accident_date → 'Accident date'", () => {
    expect((enUS as Record<string, string>)["field.accident_date"]).toBe("Accident date");
  });
  it("field.accident_location → 'Accident location'", () => {
    expect((enUS as Record<string, string>)["field.accident_location"]).toBe("Accident location");
  });
  it("field.accident_description → 'Accident description'", () => {
    expect((enUS as Record<string, string>)["field.accident_description"]).toBe("Accident description");
  });
});

describe("AC13 regression: legacy field keys still exist", () => {
  const LEGACY_KEYS = [
    "field.date",
    "field.location",
    "field.party_a_name",
    "field.party_a_plate",
    "field.party_b_name",
    "field.party_b_plate",
    "field.declared_damage",
    "field.stolen_items",
    "field.hail_date",
    "field.fire_origin",
    "field.witnesses",
    "field.insurance_policy",
    "field.driver_name",
    "field.driver_license",
  ] as const;

  for (const key of LEGACY_KEYS) {
    it(`es-AR still has '${key}'`, () => {
      const value = (esAR as Record<string, string>)[key];
      expect(value, `Legacy key '${key}' missing from esAR`).toBeDefined();
      expect(value).not.toBe("");
    });

    it(`en-US still has '${key}'`, () => {
      const value = (enUS as Record<string, string>)[key];
      expect(value, `Legacy key '${key}' missing from enUS`).toBeDefined();
      expect(value).not.toBe("");
    });
  }
});

describe("Key parity: es-AR and en-US have identical key sets", () => {
  it("en-US has all keys that es-AR has", () => {
    const esKeys = Object.keys(esAR);
    const enKeys = Object.keys(enUS);
    for (const key of esKeys) {
      expect(enKeys, `en-US is missing key '${key}'`).toContain(key);
    }
  });

  it("es-AR has all keys that en-US has", () => {
    const esKeys = Object.keys(esAR);
    const enKeys = Object.keys(enUS);
    for (const key of enKeys) {
      expect(esKeys, `es-AR is missing key '${key}'`).toContain(key);
    }
  });
});
