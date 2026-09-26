/**
 * F1: un ejemplo aprobado con `numero_poliza` no puede enseñarle al modelo
 * una clave que ya no se guarda — `formatApprovedExamples` la canoniza antes
 * de mostrarla.
 */

import { describe, it, expect } from "vitest";
import { formatApprovedExamples, type ApprovedExample } from "@/server/training/examples";

describe("formatApprovedExamples — canoniza claves (F1)", () => {
  it("numero_poliza en extracted_fields se muestra como policy_number", () => {
    const example: ApprovedExample = {
      input: { subject: "Siniestro", body: "Mi poliza es AR-000111." },
      expectedOutput: {
        agent_output: {
          extracted_fields: { numero_poliza: "AR-000111" },
        },
      },
    };

    const prompt = formatApprovedExamples([example]);

    expect(prompt).toContain("policy_number");
    expect(prompt).not.toContain("numero_poliza");
  });

  it("numero_poliza en fields[] se muestra como policy_number", () => {
    const example: ApprovedExample = {
      input: { subject: "Siniestro", body: "Mi poliza es AR-000111." },
      expectedOutput: {
        agent_output: {
          fields: [{ field_key: "numero_poliza", field_value: "AR-000111" }],
        },
      },
    };

    const prompt = formatApprovedExamples([example]);

    expect(prompt).toContain("policy_number");
    expect(prompt).not.toContain("numero_poliza");
  });
});
