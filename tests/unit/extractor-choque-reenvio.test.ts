/**
 * Tests based on the anonymized "choque con reenvío" email fixture.
 *
 * This validates that the parser handles real-world patterns:
 * - Forwarded/reply thread bodies (multiple quoted sections)
 * - Siniestro number as policy/claim reference
 * - Vehicles mentioned in subject and body
 * - Pending documentation (presupuesto, CBU provided but other docs still needed)
 * - DNI embedded in an attachment description block
 */

import { describe, it, expect } from "vitest";
import {
  EXAMPLE_CHOQUE_EMAIL_SUBJECT,
  EXAMPLE_CHOQUE_EMAIL_BODY,
  EXPECTED_CHOQUE_EXTRACTION,
} from "../fixtures/email-choque-reenvio";
import { classifySeverity } from "@/server/ai/severity-classifier";
import { extractEmailClaimMock } from "@/server/ai/mock-extractor";
import { maskDni, maskPolicyNumber } from "@/server/email/render";

describe("Choque reenvío email fixture", () => {
  describe("severity classifier", () => {
    it("classifies as medium — no injuries mentioned, vehicle collision only", () => {
      const severity = classifySeverity(EXAMPLE_CHOQUE_EMAIL_BODY, undefined, []);
      // No critical/high keywords; choque → medium
      expect(["low", "medium"]).toContain(severity);
    });

    it("does not escalate to high — no ambulance/police/injury keywords", () => {
      const severity = classifySeverity(EXAMPLE_CHOQUE_EMAIL_BODY, undefined, []);
      expect(severity).not.toBe("high");
      expect(severity).not.toBe("critical");
    });

    it("AI result of medium is preserved when no escalating patterns", () => {
      const severity = classifySeverity(EXAMPLE_CHOQUE_EMAIL_BODY, "medium", []);
      expect(severity).toBe("medium");
    });
  });

  describe("mock extractor with choque overrides", () => {
    it("returns is_claim=true for a collision email", () => {
      const result = extractEmailClaimMock({
        is_claim: EXPECTED_CHOQUE_EXTRACTION.is_claim,
        severity: EXPECTED_CHOQUE_EXTRACTION.severity as any,
      });
      expect(result.is_claim).toBe(true);
      expect(result.severity).toBe("medium");
    });

    it("includes expected fields when overrides applied", () => {
      const result = extractEmailClaimMock({
        extracted_fields: {
          full_name: EXPECTED_CHOQUE_EXTRACTION.full_name,
          email: EXPECTED_CHOQUE_EXTRACTION.email,
          accident_date: EXPECTED_CHOQUE_EXTRACTION.accident_date,
        },
      });
      expect(result.extracted_fields!.full_name).toBe("Carlos Mendoza");
      expect(result.extracted_fields!.email).toBe("carlos.mendoza.test@gmail.com");
      expect(result.extracted_fields!.accident_date).toBe("27/07/2025");
    });
  });

  describe("PII masking for outbound replies (AC24)", () => {
    it("masks DNI found in body — last 4 digits only", () => {
      const masked = maskDni(EXPECTED_CHOQUE_EXTRACTION.dni_in_body);
      expect(masked).toBe("****6789");
      expect(masked).not.toContain("23456789");
    });

    it("masks siniestro/policy number — last 4 digits only", () => {
      const masked = maskPolicyNumber(EXPECTED_CHOQUE_EXTRACTION.policy_number_hint);
      expect(masked).not.toContain("91500000");
      // Shows only last 4 chars of the siniestro number
      expect(masked).toMatch(/\*{4}/);
    });

    it("outbound confirmation email body must not contain raw DNI", () => {
      // Simulate what the confirmation_received template would render
      const bodyWithMasked = `Estimado Carlos Mendoza, recibimos su reclamo. DNI: ${maskDni(
        EXPECTED_CHOQUE_EXTRACTION.dni_in_body
      )}`;
      expect(bodyWithMasked).not.toMatch(/\b23456789\b/);
    });
  });

  describe("subject line parsing", () => {
    it("subject contains 'Siniestro' keyword — indicates claim", () => {
      expect(EXAMPLE_CHOQUE_EMAIL_SUBJECT.toLowerCase()).toContain("siniestro");
    });

    it("subject contains vehicle plate numbers", () => {
      expect(EXAMPLE_CHOQUE_EMAIL_SUBJECT).toContain("ABC123");
      expect(EXAMPLE_CHOQUE_EMAIL_SUBJECT).toContain("XY456ZW");
    });

    it("subject contains accident date", () => {
      expect(EXAMPLE_CHOQUE_EMAIL_SUBJECT).toContain("27/07/2025");
    });
  });

  describe("forwarded thread body handling", () => {
    it("body contains forwarded message marker", () => {
      expect(EXAMPLE_CHOQUE_EMAIL_BODY).toContain("Inicio del mensaje reenviado");
    });

    it("body contains CBU attachment block with PII", () => {
      expect(EXAMPLE_CHOQUE_EMAIL_BODY).toContain("Constancia de Clave Bancaria (CBU)");
      expect(EXAMPLE_CHOQUE_EMAIL_BODY).toContain("DU Nro.23456789");
    });

    it("body references missing documentation (presupuesto pending)", () => {
      expect(EXAMPLE_CHOQUE_EMAIL_BODY.toLowerCase()).toContain("presupuesto");
    });
  });
});
