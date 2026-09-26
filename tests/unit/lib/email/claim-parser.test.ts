import { describe, expect, it } from "vitest";
import { parseEmailClaimFields, sanearContacto } from "@/lib/email/claim-parser";
import {
  EXAMPLE_CHOQUE_EMAIL_BODY,
  EXAMPLE_CHOQUE_EMAIL_SUBJECT,
} from "../../../fixtures/email-choque-reenvio";
import type { ExtractedField } from "@/lib/schemas/extracted-claim";

function fieldMap(fields: ReturnType<typeof parseEmailClaimFields>) {
  return new Map(fields.map((field) => [field.field_key, field.field_value]));
}

describe("parseEmailClaimFields", () => {
  it("extracts obvious data from a forwarded collision email", () => {
    const fields = fieldMap(
      parseEmailClaimFields({
        subject: EXAMPLE_CHOQUE_EMAIL_SUBJECT,
        body: EXAMPLE_CHOQUE_EMAIL_BODY,
        senderEmail: "fallback@example.com",
      })
    );

    expect(fields.get("full_name")).toBe("Carlos Mendoza");
    expect(fields.get("dni")).toBe("23456789");
    expect(fields.get("policy_number")).toBe("91500000-2");
    expect(fields.get("accident_date")).toBe("27/07/2025");
    expect(fields.get("claim_type")).toBe("choque");
    expect(fields.get("cbu")).toBe("0070068930004000000016");
  });

  it("does not attribute a plate to either party without a «mi vehículo/auto»", () => {
    const fields = fieldMap(
      parseEmailClaimFields({
        subject: EXAMPLE_CHOQUE_EMAIL_SUBJECT,
        body: EXAMPLE_CHOQUE_EMAIL_BODY,
        senderEmail: "fallback@example.com",
      })
    );

    expect(fields.has("party_a_plate")).toBe(false);
    expect(fields.has("party_b_plate")).toBe(false);
  });

  it("uses the sender address when no address appears in the email text", () => {
    const fields = fieldMap(
      parseEmailClaimFields({
        subject: "Siniestro 91500000-2 - Accidente del 27/07/2025",
        body: "Sin direccion de email en el cuerpo.",
        senderEmail: "sender@example.com",
      })
    );

    expect(fields.get("email")).toBe("sender@example.com");
  });

  it("extracts DNI when the following word is stuck to the number", () => {
    const fields = fieldMap(
      parseEmailClaimFields({
        body: "la persona NICOLAS JASPER con DU Nro.92310691es titular de la cuenta.",
      })
    );

    expect(fields.get("full_name")).toBe("Nicolas Jasper");
    expect(fields.get("dni")).toBe("92310691");
  });

  it("extracts labeled claimant data and mentioned documents from a normal claim body", () => {
    const fields = fieldMap(
      parseEmailClaimFields({
        subject: "Siniestro | Choque 15/03/2024 | Ford Focus vs Renault Sandero",
        senderEmail: "idaniele@blueboot.com",
        body: `
          Ilan Daniele <idaniele@blueboot.com>

          Datos del asegurado:
          - Nombre completo: María Elena González
          - DNI: 28.456.789
          - Teléfono: +54 11 4523-8871
          - Email: maria.gonzalez@gmail.com
          - Número de póliza: POL-2024-00892

          Descripción del siniestro:
          El día 15/03/2024 a las 17:30 hs, mi vehículo (Ford Focus 2019, patente AB 123 CD)
          fue impactado por un Renault Sandero (patente EF 456 GH) en la intersección de
          Av. Corrientes 4500 y Medrano, Ciudad Autónoma de Buenos Aires.

          Tipo de siniestro: Choque

          Documentación adjunta:
          - Fotos del vehículo dañado
          - Copia de licencia de conducir
          - Denuncia policial Nro. 0045/2024
        `,
      })
    );

    expect(fields.get("full_name")).toBe("María Elena González");
    expect(fields.get("email")).toBe("maria.gonzalez@gmail.com");
    expect(fields.get("dni")).toBe("28456789");
    expect(fields.get("policy_number")).toBe("POL-2024-00892");
    expect(fields.get("accident_date")).toBe("15/03/2024");
    expect(fields.get("claim_type")).toBe("choque");
    expect(fields.get("party_a_plate")).toBe("AB123CD");
    expect(fields.has("party_b_plate")).toBe(false);
    expect(fields.get("fotos_danos")).toBe("si");
    expect(fields.get("licencia_conducir")).toBe("si");
    expect(fields.get("denuncia_policial")).toBe("si");
    expect(fields.get("police_report_number")).toBe("0045/2024");
  });

  it("extracts the insured's plate from «mi auto patente X», with no parentheses", () => {
    const fields = fieldMap(
      parseEmailClaimFields({
        body: "Choqué ayer con mi auto patente AB123CD en Alem y Rivadavia.",
      })
    );

    expect(fields.get("party_a_plate")).toBe("AB123CD");
  });
});

describe("sanearContacto", () => {
  const email = (field_value: string): ExtractedField => ({
    field_key: "email",
    field_value,
    confidence: 0.9,
    source: "ai",
  });

  it("moves a phone number that landed in email to phone", () => {
    const fields = sanearContacto([email("+54 9 291 555-1234")]);

    expect(fields.find((f) => f.field_key === "email")).toBeUndefined();
    expect(fields.find((f) => f.field_key === "phone")?.field_value).toBe("+54 9 291 555-1234");
  });

  it("drops an email field that is neither an address nor a phone number", () => {
    const fields = sanearContacto([email("no tengo mail")]);

    expect(fields).toHaveLength(0);
  });

  it("leaves a valid email address untouched", () => {
    const fields = sanearContacto([email("asegurado@ejemplo.com")]);

    expect(fields).toEqual([email("asegurado@ejemplo.com")]);
  });

  it("does not overwrite a phone already present", () => {
    const phone: ExtractedField = {
      field_key: "phone",
      field_value: "2915551111",
      confidence: 0.9,
      source: "ai",
    };
    const fields = sanearContacto([email("291 555-9999"), phone]);

    expect(fields.filter((f) => f.field_key === "phone")).toEqual([phone]);
    expect(fields.find((f) => f.field_key === "email")).toBeUndefined();
  });
});
