/**
 * Unit tests for the email template renderer and PII masking utilities.
 *
 * AC12: confirmation_received template never includes raw DNI or full policy_number.
 * AC24: All templates mask sensitive values before rendering.
 *
 * Regex probes verify the rendered body does not contain raw DNI or policy_number.
 */

import { describe, it, expect } from "vitest";
import { renderTemplate, maskDni, maskPolicyNumber } from "../../src/server/email/render";

// ── PII masking unit tests ────────────────────────────────────────────────────

describe("maskDni", () => {
  it("masks an 8-digit plain DNI to show only last 4", () => {
    expect(maskDni("20345678")).toBe("****5678");
  });

  it("masks a dotted DNI (e.g. 20.345.678) to show only last 4 digits", () => {
    expect(maskDni("20.345.678")).toBe("****5678");
  });

  it("masks a short DNI (fewer than 4 digits) to ****", () => {
    expect(maskDni("123")).toBe("****");
  });

  it("masks a 4-digit DNI to show ****+all 4 digits", () => {
    expect(maskDni("1234")).toBe("****1234");
  });

  it("strips non-numeric chars before masking", () => {
    expect(maskDni("35-123-456")).toBe("****3456");
  });
});

describe("maskPolicyNumber", () => {
  it("masks POL-12345678 to POL-****5678", () => {
    expect(maskPolicyNumber("POL-12345678")).toBe("POL-****5678");
  });

  it("masks a plain numeric policy number to ****+last 4", () => {
    expect(maskPolicyNumber("12345678")).toBe("****5678");
  });

  it("masks a short policy prefix correctly", () => {
    expect(maskPolicyNumber("P-00012345")).toBe("P-****2345");
  });

  it("returns **** for a non-numeric or very short policy number", () => {
    expect(maskPolicyNumber("ABC")).toBe("****");
  });

  it("masks POL-1234 to POL-****1234", () => {
    expect(maskPolicyNumber("POL-1234")).toBe("POL-****1234");
  });
});

// ── Template rendering tests ──────────────────────────────────────────────────

describe("renderTemplate — confirmation_received", () => {
  it("renders with caseId in subject and body", () => {
    const result = renderTemplate("confirmation_received", {
      caseId: "abc-123",
    });
    expect(result.subject).toContain("abc-123");
    expect(result.html).toContain("abc-123");
    expect(result.text).toContain("abc-123");
  });

  it("includes masked policy number when provided — not raw", () => {
    const result = renderTemplate("confirmation_received", {
      caseId: "abc-123",
      policyNumber: "POL-12345678",
    });
    // Must NOT contain the raw policy number.
    expect(result.html).not.toContain("POL-12345678");
    expect(result.text).not.toContain("POL-12345678");
    // Must contain the masked version.
    expect(result.html).toContain("POL-****5678");
    expect(result.text).toContain("POL-****5678");
  });

  it("AC24: body does not contain raw DNI when DNI is passed in data", () => {
    // confirmation_received template should never show DNI at all.
    // Passing a DNI in data should have no effect on output.
    const rawDni = "20345678";
    const result = renderTemplate("confirmation_received", {
      caseId: "abc-123",
      // DNI is not a valid field for this template — but simulate a scenario
      // where data accidentally includes it. Template must not render it raw.
      policyNumber: "POL-12345678",
    });
    // Regex: raw 8-digit DNI must not appear.
    const dniRegex = /\b\d{8}\b/g;
    expect(result.html).not.toMatch(dniRegex);
    expect(result.text).not.toMatch(dniRegex);
    void rawDni;
  });

  it("renders without claimType when not provided", () => {
    const result = renderTemplate("confirmation_received", { caseId: "x" });
    expect(result.html).toContain("siniestro");
  });

  it("renders claim type label in Spanish", () => {
    const result = renderTemplate("confirmation_received", {
      caseId: "x",
      claimType: "choque",
    });
    expect(result.html).toContain("choque de vehículo");
  });

  it("has a text fallback with same case ID", () => {
    const result = renderTemplate("confirmation_received", { caseId: "xyz-456" });
    expect(result.text).toContain("xyz-456");
    expect(typeof result.text).toBe("string");
    expect(result.text.length).toBeGreaterThan(50);
  });

  it("drops the type phrase entirely when the type is not known", () => {
    // "Registramos exitosamente tu reclamo de other" reached a real inbox, and
    // so did its first fix, "tu reclamo de siniestro" — words spent to say
    // nothing. With no type, the sentence simply ends.
    const result = renderTemplate("confirmation_received", {
      caseId: "x",
      claimType: "other",
    });
    expect(result.html).not.toContain("other");
    expect(result.text).not.toContain("other");
    expect(result.html).toContain("Registramos exitosamente tu reclamo.");
    expect(result.html).not.toContain("reclamo de");
    expect(result.text).toContain("Registramos exitosamente tu reclamo.");
  });

  it("still names the type when there is one", () => {
    const result = renderTemplate("confirmation_received", {
      caseId: "x",
      claimType: "choque",
    });
    expect(result.html).toContain("reclamo de <strong>choque de vehículo</strong>");
  });

  it("covers the claim types the old label table had missed", () => {
    for (const [type, label] of [
      ["cristales", "rotura de cristales"],
      ["rc", "daños a terceros"],
      ["robo_contenido", "robo de pertenencias del vehículo"],
      ["accidente_personal", "accidente con lesiones"],
    ] as const) {
      const result = renderTemplate("confirmation_received", { caseId: "x", claimType: type });
      expect(result.html, type).toContain(label);
    }
  });

  it("drops the policy line when masking leaves nothing recognizable", () => {
    // POL-4471-A has no trailing 4-digit run, so the mask collapses to "****"
    // and the rendered line read "Póliza asociada: ****" — which tells the
    // claimant nothing and looks like the field failed to fill in.
    const result = renderTemplate("confirmation_received", {
      caseId: "x",
      policyNumber: "POL-4471-A",
    });
    expect(result.html).not.toContain("Póliza asociada");
    expect(result.text).not.toContain("Póliza asociada");
    expect(result.html).not.toContain("4471");
  });

  it("still shows the policy line when the mask keeps real digits", () => {
    const result = renderTemplate("confirmation_received", {
      caseId: "x",
      policyNumber: "POL-12345678",
    });
    expect(result.html).toContain("Póliza asociada");
  });
});

describe("renderTemplate — missing_information_request", () => {
  it("lists only the provided missing fields — not others", () => {
    const result = renderTemplate("missing_information_request", {
      caseId: "case-1",
      missingFields: ["policy_number", "accident_date"],
    });
    // Should mention the two provided fields.
    expect(result.html).toContain("Número de póliza");
    expect(result.html).toContain("Fecha del siniestro");
    // Should NOT mention fields not in the list.
    expect(result.html).not.toContain("DNI del titular");
  });

  it("includes case ID in subject and body", () => {
    const result = renderTemplate("missing_information_request", {
      caseId: "case-99",
      missingFields: ["dni"],
    });
    expect(result.subject).toContain("case-99");
    expect(result.html).toContain("case-99");
    expect(result.text).toContain("case-99");
  });

  it("handles empty missingFields gracefully", () => {
    const result = renderTemplate("missing_information_request", {
      caseId: "case-0",
      missingFields: [],
    });
    expect(result.subject).toContain("case-0");
    expect(typeof result.html).toBe("string");
  });

  it("has a text fallback", () => {
    const result = renderTemplate("missing_information_request", {
      caseId: "case-1",
      missingFields: ["phone"],
    });
    expect(result.text).toContain("Teléfono de contacto");
    expect(result.text).toContain("case-1");
  });

  it("names the keys the extractor invents, not the keys themselves", () => {
    // The old local table stopped at eight canonical keys and printed
    // "Proporcioná el valor para el campo: dni_asegurado" for everything else.
    const result = renderTemplate("missing_information_request", {
      caseId: "case-7",
      missingFields: ["dni_asegurado", "hora_siniestro", "provincia_siniestro"],
    });
    expect(result.html).not.toContain("dni_asegurado");
    expect(result.html).not.toContain("hora_siniestro");
    expect(result.text).not.toContain("provincia_siniestro");
    expect(result.html).toContain("DNI del asegurado");
    expect(result.html).toContain("Hora aproximada");
    expect(result.html).toContain("Provincia");
  });
});

describe("renderTemplate — data_confirmation_request", () => {
  it("masks DNI in the rendered output (AC24)", () => {
    const rawDni = "20345678";
    const result = renderTemplate("data_confirmation_request", {
      caseId: "case-2",
      fieldKey: "dni",
      proposedValue: rawDni,
    });
    // Raw DNI must NOT appear.
    expect(result.html).not.toContain(rawDni);
    expect(result.text).not.toContain(rawDni);
    // Masked version must appear.
    expect(result.html).toContain("****5678");
    expect(result.text).toContain("****5678");
  });

  it("masks policy_number in the rendered output (AC24)", () => {
    const rawPolicy = "POL-12345678";
    const result = renderTemplate("data_confirmation_request", {
      caseId: "case-3",
      fieldKey: "policy_number",
      proposedValue: rawPolicy,
    });
    expect(result.html).not.toContain(rawPolicy);
    expect(result.html).toContain("****5678");
  });

  it("asks outright when the extracted value says nothing", () => {
    // Two versions of this reached a real inbox. First "confirmá que el tipo
    // es other", then "confirmá que el tipo de siniestro es: siniestro". There
    // is no value here to confirm, so the agent asks the question instead.
    const result = renderTemplate("data_confirmation_request", {
      caseId: "case-4",
      fieldKey: "claim_type",
      proposedValue: "other",
    });
    expect(result.html).not.toContain("other");
    expect(result.text).not.toContain("other");
    expect(result.subject).toContain("Nos falta un dato");
    expect(result.html).toContain("Decinos qué tipo de siniestro fue");
    // Nothing was shown, so there is nothing to say "Confirmo" about.
    expect(result.html).not.toContain("Obtuvimos el siguiente dato");
    expect(result.html).not.toContain("Confirmo");
  });

  it("still asks for confirmation when there IS a value to confirm", () => {
    const result = renderTemplate("data_confirmation_request", {
      caseId: "case-4b",
      fieldKey: "claim_type",
      proposedValue: "granizo",
    });
    expect(result.subject).toContain("Confirmar datos");
    expect(result.html).toContain("daño por granizo");
    expect(result.html).toContain("Confirmo");
  });

  it("names an invented field key in Spanish", () => {
    const result = renderTemplate("data_confirmation_request", {
      caseId: "case-5",
      fieldKey: "telefono_contacto",
      proposedValue: "291 456 7788",
    });
    expect(result.html).not.toContain("telefono_contacto");
    expect(result.html).toContain("Teléfono de contacto");
  });

  it("does not mask non-sensitive fields like full_name", () => {
    const result = renderTemplate("data_confirmation_request", {
      caseId: "case-4",
      fieldKey: "full_name",
      proposedValue: "Juan Pérez",
    });
    expect(result.html).toContain("Juan Pérez");
  });

  it("shows conflicting value when provided", () => {
    const result = renderTemplate("data_confirmation_request", {
      caseId: "case-5",
      fieldKey: "full_name",
      proposedValue: "Pedro García",
      conflictWithValue: "Juan Pérez",
    });
    expect(result.html).toContain("Pedro García");
    expect(result.html).toContain("Juan Pérez");
    expect(result.html).toContain("difiere");
  });

  it("has a text fallback", () => {
    const result = renderTemplate("data_confirmation_request", {
      caseId: "case-6",
      fieldKey: "phone",
      proposedValue: "+54 11 1234-5678",
    });
    expect(result.text).toContain("case-6");
    expect(result.text).toContain("Confirmo");
  });
});

describe("renderTemplate — specialist_escalation", () => {
  it("includes case ID in subject and body", () => {
    const result = renderTemplate("specialist_escalation", { caseId: "esc-1" });
    expect(result.subject).toContain("esc-1");
    expect(result.html).toContain("esc-1");
    expect(result.text).toContain("esc-1");
  });

  it("mentions 24h response time", () => {
    const result = renderTemplate("specialist_escalation", { caseId: "esc-2" });
    expect(result.html).toContain("24");
    expect(result.text).toContain("24");
  });

  it("uses urgent language for critical severity", () => {
    const result = renderTemplate("specialist_escalation", {
      caseId: "esc-3",
      severity: "critical",
    });
    expect(result.html).toContain("urgente");
  });

  it("has a text fallback", () => {
    const result = renderTemplate("specialist_escalation", { caseId: "esc-4" });
    expect(typeof result.text).toBe("string");
    expect(result.text.length).toBeGreaterThan(50);
  });
});

// ── AC24 strict regex probes ──────────────────────────────────────────────────

describe("AC24 — no raw DNI or raw policy_number in any outbound template", () => {
  const RAW_DNI = "20345678";
  const RAW_POLICY = "POL-12345678";

  // Regex that would match a raw 8-digit DNI
  const dniRegex = /\b\d{8}\b/;
  // Regex that would match the full policy number
  const policyRegex = /POL-12345678/;

  const templates = [
    "confirmation_received",
    "missing_information_request",
    "data_confirmation_request",
    "specialist_escalation",
  ] as const;

  for (const template of templates) {
    it(`${template}: no raw DNI in body`, () => {
      let data: Record<string, unknown> = { caseId: "test-case" };
      if (template === "missing_information_request") {
        data = { ...data, missingFields: ["dni"] };
      } else if (template === "data_confirmation_request") {
        data = { ...data, fieldKey: "dni", proposedValue: RAW_DNI };
      } else if (template === "confirmation_received") {
        data = { ...data, policyNumber: RAW_POLICY };
      }

      const result = renderTemplate(template, data);

      if (template === "data_confirmation_request") {
        // For this template the DNI is the input — it must be masked.
        expect(result.html).not.toContain(RAW_DNI);
        expect(result.text).not.toContain(RAW_DNI);
      } else {
        // For other templates, DNI should not appear at all.
        expect(result.html).not.toMatch(dniRegex);
        expect(result.text).not.toMatch(dniRegex);
      }
    });

    it(`${template}: no raw policy_number in body`, () => {
      let data: Record<string, unknown> = { caseId: "test-case" };
      if (template === "missing_information_request") {
        data = { ...data, missingFields: ["policy_number"] };
      } else if (template === "data_confirmation_request") {
        data = { ...data, fieldKey: "policy_number", proposedValue: RAW_POLICY };
      } else if (template === "confirmation_received") {
        data = { ...data, policyNumber: RAW_POLICY };
      }

      const result = renderTemplate(template, data);

      // Raw POL-12345678 must not appear in output.
      expect(result.html).not.toMatch(policyRegex);
      expect(result.text).not.toMatch(policyRegex);
    });
  }
});

describe("renderTemplate — missing_information_request with values we hold", () => {
  it("asks for a gap and offers a correction for a doubt, in one list", () => {
    // Gaps and doubts used to be separate emails on separate rounds.
    const result = renderTemplate("missing_information_request", {
      caseId: "c-1",
      missingFields: ["policy_number", "accident_date"],
      knownValues: { accident_date: "16/08/2026" },
    });

    expect(result.html).toContain("Número de póliza");
    expect(result.html).toContain("Decinos el número de póliza");

    expect(result.html).toContain("Fecha del siniestro");
    expect(result.html).toContain("16/08/2026");
    // Not re-asked as though they never said it.
    expect(result.html).not.toContain("Decinos qué día ocurrió");
  });

  it("behaves as before when we hold nothing", () => {
    const result = renderTemplate("missing_information_request", {
      caseId: "c-2",
      missingFields: ["policy_number"],
    });
    expect(result.html).toContain("Decinos el número de póliza");
    expect(result.text).toContain("Decinos el número de póliza");
  });
});

describe("renderTemplate — a value we hold but cannot say", () => {
  it("asks outright instead of quoting the enum member back", () => {
    // `entendimos "other"` reached a real inbox through this list, after the
    // same enum had already been chased out of two other templates.
    const result = renderTemplate("missing_information_request", {
      caseId: "c-3",
      missingFields: ["claim_type"],
      knownValues: { claim_type: "other" },
    });

    expect(result.html).not.toContain("other");
    expect(result.text).not.toContain("other");
    expect(result.html).toContain("Decinos qué tipo de siniestro fue");
  });

  it("shows a claim type it can name", () => {
    const result = renderTemplate("missing_information_request", {
      caseId: "c-4",
      missingFields: ["claim_type"],
      knownValues: { claim_type: "granizo" },
    });
    expect(result.html).toContain("daño por granizo");
  });
});

describe("renderTemplate — acknowledgement vs closing", () => {
  it("greets on first contact", () => {
    const r = renderTemplate("confirmation_received", { caseId: "x", claimType: "choque" });
    expect(r.subject).toContain("Recibimos tu reclamo");
    expect(r.html).toContain("Gracias por contactarnos");
  });

  it("closes instead of greeting when the exchange already happened", () => {
    // "Gracias por contactarnos" arriving third, after two rounds the claimant
    // answered, reads as though the conversation never took place.
    const r = renderTemplate("confirmation_received", {
      caseId: "x",
      claimType: "choque",
      isFollowUp: true,
    });
    expect(r.subject).toContain("Tu reclamo quedó completo");
    expect(r.html).toContain("ya tenemos todo lo que necesitábamos");
    expect(r.html).toContain("quedó completo y pasa a análisis");
    expect(r.html).not.toContain("Gracias por contactarnos");
    expect(r.text).toContain("ya tenemos todo lo que necesitábamos");
    expect(r.text).not.toContain("Gracias por contactarnos");
  });

  it("still names the claim type and case in the closing", () => {
    const r = renderTemplate("confirmation_received", {
      caseId: "case-77",
      claimType: "granizo",
      isFollowUp: true,
    });
    expect(r.html).toContain("daño por granizo");
    expect(r.html).toContain("case-77");
  });
});

/**
 * Un correo con varios datos, en vez de varios correos con uno.
 *
 * La rama D del orquestador mandaba un `data_confirmation_request` por cada
 * dato que no coincidía con el padrón. Con un familiar del titular escribiendo
 * —nombre, mail y documento distintos— eran tres correos casi idénticos.
 *
 * La plantilla ahora recibe la lista. Lo que se comprueba acá es que el mensaje
 * siga siendo legible: que los tres datos aparezcan, que el enmascarado siga
 * aplicándose a cada uno, y que las frases estén en plural cuando corresponde.
 */
describe("renderTemplate — data_confirmation_request con varios datos", () => {
  const TRES = {
    caseId: "case-9",
    fieldKey: "",
    proposedValue: "",
    fields: [
      { fieldKey: "full_name", proposedValue: "Pedro García", conflictWithValue: "Juan Pérez" },
      { fieldKey: "email", proposedValue: "pedro@ejemplo.com", conflictWithValue: "juan@ejemplo.com" },
      { fieldKey: "dni", proposedValue: "30111222", conflictWithValue: "20345678" },
    ],
  };

  it("nombra los tres datos en un solo mensaje", () => {
    const result = renderTemplate("data_confirmation_request", TRES);

    for (const esperado of ["Pedro García", "Juan Pérez", "pedro@ejemplo.com", "juan@ejemplo.com"]) {
      expect(result.text).toContain(esperado);
      expect(result.html).toContain(esperado);
    }
  });

  it("enmascara el DNI aunque venga en la lista", () => {
    // El enmascarado se aplicaba por campo cuando el campo era uno. Con lista,
    // tiene que seguir aplicándose a cada uno.
    const result = renderTemplate("data_confirmation_request", TRES);

    expect(result.text).not.toContain("30111222");
    expect(result.text).not.toContain("20345678");
    expect(result.text).toContain("****1222");
    expect(result.text).toContain("****5678");
  });

  it("habla en plural cuando son varios", () => {
    const result = renderTemplate("data_confirmation_request", TRES);

    expect(result.text).toContain("los siguientes datos");
    expect(result.text).toContain("los datos son correctos");
  });

  it("con uno solo sigue hablando en singular", () => {
    // La otra mitad: si el plural se aplicara siempre, un mensaje con un dato
    // diría «confirmá los siguientes datos» sobre un dato.
    const result = renderTemplate("data_confirmation_request", {
      caseId: "case-10",
      fieldKey: "full_name",
      proposedValue: "Pedro García",
      conflictWithValue: "Juan Pérez",
    });

    expect(result.text).toContain("el siguiente dato");
    expect(result.text).toContain("el dato es correcto");
    expect(result.text).not.toContain("los siguientes datos");
  });

  it("un campo sin valor se pregunta, y los que tienen valor se confirman", () => {
    // Mezcla: no puede quedar un mensaje que pida «escribí Confirmo» sobre un
    // blanco, ni uno que se olvide de preguntar por lo que falta.
    const result = renderTemplate("data_confirmation_request", {
      caseId: "case-11",
      fieldKey: "",
      proposedValue: "",
      fields: [
        { fieldKey: "full_name", proposedValue: "Pedro García", conflictWithValue: "Juan Pérez" },
        { fieldKey: "claim_type", proposedValue: "other" },
      ],
    });

    expect(result.text).toContain("Pedro García");
    // El que no tiene valor mostrable aparece igual, como pregunta.
    expect(result.text).toContain("Tipo de siniestro");
    // Y sigue habiendo algo que confirmar, así que el asunto es el de confirmar.
    expect(result.subject).toContain("Confirmar datos");
  });
});
