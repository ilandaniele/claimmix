/**
 * La demo pública no puede mostrar lesiones ni otro dato de salud.
 *
 * `/api/demo/public-analyze` no crea un caso ni lo revisa nadie: cuando el
 * texto pegado derivaría a un especialista en el producto real (severidad
 * alta o crítica, o heridos), acá se redacta la respuesta entera en vez de
 * mostrarla. Este archivo prueba la ruta con el extractor simulado y, aparte,
 * que los cuatro ejemplos de la demo se comporten como documenta la decisión
 * A-9: «robo» deriva, los otros tres no, y ninguno menciona una lesión.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const { mockExtract, mockCheckDemoBudget, mockGetDemoTenantId, mockRateLimit, mockGetClientIp } =
  vi.hoisted(() => ({
    mockExtract: vi.fn(),
    mockCheckDemoBudget: vi.fn(),
    mockGetDemoTenantId: vi.fn(),
    mockRateLimit: vi.fn(),
    mockGetClientIp: vi.fn(),
  }));

vi.mock("server-only", () => ({}));

vi.mock("@/server/ai/gemini-extractor", () => ({
  extractEmailClaimGemini: mockExtract,
}));

vi.mock("@/server/ai/budget", () => ({
  checkDemoBudget: mockCheckDemoBudget,
  getDemoTenantId: mockGetDemoTenantId,
}));

vi.mock("@/lib/rate-limit/index", () => ({
  rateLimit: mockRateLimit,
  getClientIp: mockGetClientIp,
}));

import { POST } from "@/app/api/demo/public-analyze/route";

const DEMO_TENANT = "20000000-0000-0000-0000-000000000002";

function makeRequest(subject: string, body: string) {
  return new NextRequest("http://localhost/api/demo/public-analyze", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ subject, body }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetDemoTenantId.mockReturnValue(DEMO_TENANT);
  mockCheckDemoBudget.mockResolvedValue({ exceeded: false });
  mockGetClientIp.mockReturnValue("127.0.0.1");
  mockRateLimit.mockResolvedValue({ allowed: true, remaining: 4, retryAfterSeconds: 0 });
});

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
};

describe("POST /api/demo/public-analyze — redacción de datos de salud", () => {
  it("con heridos, redacta la respuesta entera y sólo deja el tipo de siniestro", async () => {
    mockExtract.mockResolvedValue({
      ...BASE_RESULT,
      severity: "medium",
      injury_severity: "severe",
    });

    const res = await POST(
      makeRequest(
        "Consulta sobre mi póliza",
        "Buenas tardes, les escribo por un tema administrativo sobre mi póliza. Muchas gracias."
      )
    );

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toMatchObject({
      requires_specialist: true,
      fields: [],
      extracted_fields: { claim_type: "accidente_personal" },
      field_confidences: {},
      missing_fields: [],
      fields_pending_confirmation: [],
      summary: "",
      suggested_reply: "",
      injury_severity: null,
    });
  });

  it("con severidad media y sin heridos, la respuesta no cambia", async () => {
    const extraido = {
      ...BASE_RESULT,
      severity: "medium",
      injury_severity: "none",
    };
    mockExtract.mockResolvedValue(extraido);

    const res = await POST(
      makeRequest(
        "Consulta sobre mi póliza",
        "Buenas tardes, les escribo por un tema administrativo sobre mi póliza. Muchas gracias."
      )
    );

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual(extraido);
  });
});

describe("los ejemplos de la demo, contra la regla de derivación (A-9)", () => {
  it("choque, granizo y cristales no derivan", async () => {
    const { classifySeverity, requiresSpecialist } = await import("@/server/ai/severity-classifier");
    const { EXAMPLES } = await import("@/app/demo/DemoPublic");

    for (const clave of ["choque", "granizo", "cristales"] as const) {
      const ejemplo = EXAMPLES[clave];
      const sev = classifySeverity(`${ejemplo.subject}\n\n${ejemplo.body}`, null, []);
      expect(requiresSpecialist(sev), `${clave} no debería derivar`).toBe(false);
    }
  });

  it("robo deriva, que es lo que documenta la decisión A-9", async () => {
    const { classifySeverity, requiresSpecialist } = await import("@/server/ai/severity-classifier");
    const { EXAMPLES } = await import("@/app/demo/DemoPublic");

    const sev = classifySeverity(`${EXAMPLES.robo.subject}\n\n${EXAMPLES.robo.body}`, null, []);
    expect(requiresSpecialist(sev)).toBe(true);
  });

  it("ningún ejemplo menciona una lesión", async () => {
    const { EXAMPLES } = await import("@/app/demo/DemoPublic");

    for (const ejemplo of Object.values(EXAMPLES)) {
      const texto = `${ejemplo.subject}\n${ejemplo.body}`.toLowerCase();
      expect(texto).not.toContain("fractura");
      expect(texto).not.toContain("guardia");
      expect(texto).not.toContain("traumatólogo");
    }
  });
});
