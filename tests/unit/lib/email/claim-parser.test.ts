import { describe, expect, it } from "vitest";
import { parseEmailClaimFields } from "@/lib/email/claim-parser";
import {
  EXAMPLE_CHOQUE_EMAIL_BODY,
  EXAMPLE_CHOQUE_EMAIL_SUBJECT,
} from "../../../fixtures/email-choque-reenvio";

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
    expect(fields.get("party_a_plate")).toBe("ABC123");
    expect(fields.get("party_b_plate")).toBe("XY456ZW");
    expect(fields.get("cbu")).toBe("0070068930004000000016");
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
    expect(fields.get("party_b_plate")).toBe("EF456GH");
    expect(fields.get("fotos_danos")).toBe("si");
    expect(fields.get("licencia_conducir")).toBe("si");
    expect(fields.get("denuncia_policial")).toBe("si");
    expect(fields.get("police_report_number")).toBe("0045/2024");
  });
});
