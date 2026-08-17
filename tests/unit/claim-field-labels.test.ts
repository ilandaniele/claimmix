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
    expect(labelForClaimType("other")).toBe("siniestro");
  });

  it("falls back to 'siniestro' for null and for a type the model made up", () => {
    expect(labelForClaimType(null)).toBe("siniestro");
    expect(labelForClaimType(undefined)).toBe("siniestro");
    expect(labelForClaimType("meteorito")).toBe("siniestro");
  });
});

describe("displayFieldValue", () => {
  it("translates a claim type before asking someone to confirm it", () => {
    expect(displayFieldValue("claim_type", "other")).toBe("siniestro");
    expect(displayFieldValue("claim_type", "choque")).toBe("choque de vehículo");
  });

  it("leaves ordinary values untouched", () => {
    expect(displayFieldValue("full_name", "Martín Sosa")).toBe("Martín Sosa");
    expect(displayFieldValue("accident_date", "2026-08-15")).toBe("2026-08-15");
  });
});
