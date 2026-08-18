/**
 * Naming a claim field the way a person would.
 *
 * Every case here comes from something that actually reached a claimant: a
 * WhatsApp reply listing `dni_asegurado` and `telefono_contacto`, and an email
 * asking someone to confirm that the type of their claim was "other". The
 * failure mode is not a crash — it is a message that reads like the database
 * spoke instead of the company.
 */

import { describe, it, expect } from "vitest";
import {
  displayFieldValue,
  labelForClaimType,
  canonicalFieldKey,
  isWorthConfirming,
  confirmationRank,
  isAffirmativeReply,
  isDerivable,
  labelForField,
} from "@/lib/labels/claim-fields";

describe("labelForField", () => {
  it("names the keys from the real WhatsApp reply in Spanish", () => {
    expect(labelForField("dni_asegurado").label).toBe("DNI del asegurado");
    expect(labelForField("telefono_contacto").label).toBe("Teléfono de contacto");
    expect(labelForField("hora_siniestro").label).toBe("Hora aproximada");
    expect(labelForField("provincia_siniestro").label).toBe("Provincia");
  });

  it("never returns a snake_case label for any key it knows", () => {
    const keys = [
      "full_name", "email", "phone", "email_or_phone", "dni", "policy_number",
      "accident_date", "accident_location", "accident_description", "claim_type",
      "nombre_asegurado", "dni_asegurado", "telefono_contacto", "numero_poliza",
      "fecha_siniestro", "hora_siniestro", "lugar_siniestro", "provincia_siniestro",
      "tipo_vehiculo", "hay_heridos", "heridos", "testigos", "partes_relacionadas",
      "numero_denuncia", "fotos_danos", "fotos_lugar", "foto_vidrio",
      "licencia_conducir", "parte_amistoso", "denuncia_policial",
      "informe_bomberos", "foto_oblea_vtv", "vtv",
    ];

    for (const key of keys) {
      const { label, instruction } = labelForField(key);
      expect(label, key).not.toContain("_");
      expect(instruction, key).not.toContain("_");
      expect(label.charAt(0), key).toBe(label.charAt(0).toUpperCase());
    }
  });

  it("humanizes an unknown key instead of echoing it", () => {
    // The extractor invents keys, so the table can never be complete.
    const { label } = labelForField("color_del_vehiculo");
    expect(label).toBe("Color del vehículo");
    expect(label).not.toContain("_");
  });

  it("fixes the spelling that snake_case destroys", () => {
    expect(labelForField("numero_cbu").label).toBe("Número CBU");
    expect(labelForField("descripcion_danos").label).toBe("Descripción daños");
  });

  it("separates things you type from things you photograph", () => {
    expect(labelForField("telefono_contacto").kind).toBe("dato");
    expect(labelForField("hora_siniestro").kind).toBe("dato");
    expect(labelForField("fotos_danos").kind).toBe("documento");
    expect(labelForField("denuncia_policial").kind).toBe("documento");
  });

  it("guesses the kind of an unknown key from how it is named", () => {
    expect(labelForField("foto_del_paragolpes").kind).toBe("documento");
    expect(labelForField("comprobante_de_pago").kind).toBe("documento");
    expect(labelForField("marca_del_auto").kind).toBe("dato");
  });

  it("lets the tenant's own wording win", () => {
    // An operator who renamed a document knows their book of business better.
    const { label } = labelForField("fotos_danos", "Fotografías de los daños");
    expect(label).toBe("Fotografías de los daños");
  });

  it("ignores a blank override rather than sending an empty bullet", () => {
    expect(labelForField("fotos_danos", "   ").label).toBe("Fotos de los daños");
    expect(labelForField("fotos_danos", null).label).toBe("Fotos de los daños");
  });

  it("still names something when the key is degenerate", () => {
    expect(labelForField("___").label).toBe("Dato adicional");
  });
});

describe("labelForClaimType", () => {
  it("covers every value of the claim type enum", () => {
    expect(labelForClaimType("choque")).toBe("choque de vehículo");
    expect(labelForClaimType("robo")).toBe("robo de vehículo");
    expect(labelForClaimType("robo_contenido")).toBe("robo de pertenencias del vehículo");
    expect(labelForClaimType("granizo")).toBe("daño por granizo");
    expect(labelForClaimType("incendio")).toBe("incendio");
    expect(labelForClaimType("cristales")).toBe("rotura de cristales");
    expect(labelForClaimType("rc")).toBe("daños a terceros");
    expect(labelForClaimType("accidente_personal")).toBe("accidente con lesiones");
  });

  it("never says 'other' — it is a bucket, not a kind of accident", () => {
    // "Registramos exitosamente tu reclamo de other" was sent to a real inbox.
    // So was the fix for it: "tu reclamo de siniestro". Naming the category by
    // the category is not an answer either — null means the caller drops the
    // phrase instead of filling the hole with a synonym for "thing".
    expect(labelForClaimType("other")).toBeNull();
  });

  it("returns null for null and for a type the model made up", () => {
    expect(labelForClaimType(null)).toBeNull();
    expect(labelForClaimType(undefined)).toBeNull();
    expect(labelForClaimType("meteorito")).toBeNull();
  });
});

describe("displayFieldValue", () => {
  it("translates a claim type before asking someone to confirm it", () => {
    expect(displayFieldValue("claim_type", "choque")).toBe("choque de vehículo");
  });

  it("returns null for a type there is no point showing back", () => {
    // Nothing a claimant can confirm or correct — the caller must ask instead.
    expect(displayFieldValue("claim_type", "other")).toBeNull();
  });

  it("leaves ordinary values untouched", () => {
    expect(displayFieldValue("full_name", "Martín Sosa")).toBe("Martín Sosa");
    expect(displayFieldValue("accident_date", "2026-08-15")).toBe("2026-08-15");
  });
});

describe("canonicalFieldKey", () => {
  it("collapses the Spanish aliases the extractor emits alongside canonical keys", () => {
    expect(canonicalFieldKey("telefono_contacto")).toBe("phone");
    expect(canonicalFieldKey("descripcion_hecho")).toBe("accident_description");
    expect(canonicalFieldKey("nombre_asegurado")).toBe("full_name");
    expect(canonicalFieldKey("fecha_siniestro")).toBe("accident_date");
  });

  it("leaves a key that is already canonical, or unknown, alone", () => {
    expect(canonicalFieldKey("phone")).toBe("phone");
    expect(canonicalFieldKey("provincia_siniestro")).toBe("provincia_siniestro");
  });
});

describe("isWorthConfirming", () => {
  it("refuses to quote someone's own words back at them", () => {
    expect(isWorthConfirming("accident_description")).toBe(false);
    expect(isWorthConfirming("descripcion_hecho")).toBe(false);
    expect(isWorthConfirming("observaciones")).toBe(false);
  });

  it("allows anything we derived or may have misread", () => {
    expect(isWorthConfirming("claim_type")).toBe(true);
    expect(isWorthConfirming("accident_date")).toBe(true);
    expect(isWorthConfirming("policy_number")).toBe(true);
  });
});

describe("confirmationRank", () => {
  it("puts the deduced classification ahead of anything transcribed", () => {
    expect(confirmationRank("claim_type")).toBeLessThan(confirmationRank("accident_date"));
    expect(confirmationRank("accident_date")).toBeLessThan(confirmationRank("phone"));
    expect(confirmationRank("phone")).toBeLessThan(confirmationRank("provincia_siniestro"));
  });

  it("ranks an alias exactly as its canonical key", () => {
    expect(confirmationRank("telefono_contacto")).toBe(confirmationRank("phone"));
  });
});

describe("isAffirmativeReply", () => {
  it("recognises the word the email asked them to write", () => {
    // The template says: Escribí "Confirmo" si el dato es correcto. Nothing
    // read it, so the identical email went out again.
    expect(isAffirmativeReply("Confirmo")).toBe(true);
    expect(isAffirmativeReply("confirmo.")).toBe(true);
    expect(isAffirmativeReply("Sí")).toBe(true);
    expect(isAffirmativeReply("Es correcto")).toBe(true);
    expect(isAffirmativeReply("Ok!")).toBe(true);
  });

  it("looks past the signature a reply drags along", () => {
    const body = "Confirmo\nIlan Daniele\nBTP SAP Consultant | M +(598) 99 413 456";
    expect(isAffirmativeReply(body)).toBe(true);
  });

  it("does not treat a correction as agreement", () => {
    // Must go through extraction so the correction actually lands.
    expect(isAffirmativeReply("Confirmo, pero la fecha fue el 15")).toBe(false);
    expect(isAffirmativeReply("No, fue en Santa Fe")).toBe(false);
    expect(isAffirmativeReply("Fue un choque en Bahía Blanca")).toBe(false);
  });

  it("handles nothing at all", () => {
    expect(isAffirmativeReply("")).toBe(false);
    expect(isAffirmativeReply(null)).toBe(false);
    expect(isAffirmativeReply("   \n  ")).toBe(false);
  });
});

describe("isDerivable", () => {
  const good = () => 0.9;
  const poor = () => 0.5;

  it("does not ask for the province when the place is already clear", () => {
    // "Bahía Blanca" gives the province. Asking the claimant to confirm it is
    // asking them to check our geography.
    expect(isDerivable("provincia_siniestro", good)).toBe(true);
  });

  it("does ask when the place it derives from is itself doubtful", () => {
    // Then the place is the question, and the derivation is worthless.
    expect(isDerivable("provincia_siniestro", poor)).toBe(false);
  });

  it("leaves fields that derive from nothing alone", () => {
    expect(isDerivable("policy_number", good)).toBe(false);
    expect(isDerivable("claim_type", good)).toBe(false);
  });
});
