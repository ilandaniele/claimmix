/**
 * La demo pública no se desborda con una ráfaga desde IPs distintas.
 *
 * `checkDemoBudget` suma lo ya gastado y el uso se anota recién cuando el
 * modelo contesta: una ráfaga a la vez lee la misma suma vieja y pasa entera.
 * El tope por IP no la frena, porque cada pedido viene de una IP distinta. Lo
 * que la acota es el contador diario global de admisiones, que es atómico.
 * Acá corre el limitador real (memoria bajo vitest) con el extractor simulado.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const { mockExtract } = vi.hoisted(() => ({
  mockExtract: vi.fn(),
}));

vi.mock("server-only", () => ({}));

vi.mock("@/server/ai/gemini-extractor", () => ({
  extractEmailClaimGemini: mockExtract,
}));

vi.mock("@/server/ai/budget", () => ({
  checkDemoBudget: vi.fn().mockResolvedValue({ exceeded: false }),
  getDemoTenantId: vi.fn().mockReturnValue("20000000-0000-0000-0000-000000000002"),
}));

import { POST } from "@/app/api/demo/public-analyze/route";
import { clearAllRateLimits } from "@/lib/rate-limit/index";

const BASE_RESULT = {
  extraction_model: "test-model",
  fields: [{ field_key: "full_name", field_value: "Ana Morales", confidence: 0.9, source: "ai" as const }],
  prompt_tokens: 10,
  completion_tokens: 10,
  cost_usd: 0,
  is_claim: true,
  confidence: 0.9,
  extracted_fields: { full_name: "Ana Morales", claim_type: "accidente_personal" },
  field_confidences: { full_name: 0.9 },
  missing_fields: [],
  fields_pending_confirmation: [],
  possible_customer_matches: [],
  possible_policy_matches: [],
  requires_specialist: false,
  summary: "Resumen del caso.",
  suggested_reply: "Sugerencia de respuesta.",
  fraud_risk_level: "none" as const,
  fraud_indicators: [],
  severity: "low",
  injury_severity: "none",
};

// Una IP distinta por pedido: el tope por IP (5/h) nunca llega a dispararse.
function pedido(i: number) {
  return new NextRequest("http://localhost/api/demo/public-analyze", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-forwarded-for": `10.${Math.floor(i / 250)}.${i % 250}.7`,
    },
    body: JSON.stringify({
      subject: "Consulta sobre mi póliza",
      body: "Buenas tardes, les escribo por un tema administrativo sobre mi póliza. Muchas gracias.",
    }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  clearAllRateLimits();
  mockExtract.mockResolvedValue(BASE_RESULT);
});

describe("POST /api/demo/public-analyze — ráfaga desde IPs distintas", () => {
  it("una ráfaga desde IPs distintas no pasa del tope diario de admisiones", async () => {
    const N = 120;
    const res = await Promise.all(Array.from({ length: N }, (_, i) => POST(pedido(i))));
    const codigos = res.map((r) => r.status);

    expect(mockExtract).toHaveBeenCalledTimes(100);
    expect(codigos.filter((c) => c === 200)).toHaveLength(100);
    expect(codigos.filter((c) => c === 429)).toHaveLength(20);

    const rechazado = res.find((r) => r.status === 429)!;
    expect(rechazado.headers.get("Retry-After")).toBeTruthy();
    expect((await rechazado.json()).error.code).toBe("RATE_LIMITED");
  });

  it("con cupo, cada pedido sigue llegando al modelo", async () => {
    const res = await Promise.all([0, 1, 2].map((i) => POST(pedido(i))));

    expect(mockExtract).toHaveBeenCalledTimes(3);
    expect(res.map((r) => r.status)).toEqual([200, 200, 200]);
  });
});
