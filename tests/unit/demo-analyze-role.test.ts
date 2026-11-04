/**
 * POST /api/demo/analyze — quién puede correr una extracción de demo (E9).
 *
 * `entrar` se reemplaza por uno que cumple su contrato: así se prueba qué
 * roles pide la RUTA, no la puerta.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { AppError } from "@/lib/errors";
import { esARServidor } from "@/lib/i18n/es-AR.servidor";

const { mockEntrar, mockExtract, mockCheckBudget, mockWriteAuditLog, sesion } = vi.hoisted(() => ({
  mockEntrar: vi.fn(),
  mockExtract: vi.fn(),
  mockCheckBudget: vi.fn(),
  mockWriteAuditLog: vi.fn(),
  sesion: { rol: "analyst" as string | null, cupo: true },
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/api/entrada", () => ({ entrar: mockEntrar }));
vi.mock("@/lib/auth/require-role", async () => ({
  CASE_EDITOR_ROLES: (await import("@/lib/auth/roles")).CASE_EDITOR_ROLES,
}));
vi.mock("@/server/ai/gemini-extractor", () => ({ extractEmailClaimGemini: mockExtract }));
vi.mock("@/server/ai/budget", () => ({ checkBudget: mockCheckBudget }));
vi.mock("@/lib/audit/log", () => ({
  AuditEvent: { AI_BUDGET_EXCEEDED: "ai.budget_exceeded" },
  writeAuditLog: mockWriteAuditLog,
}));
vi.mock("@/lib/i18n/locale", () => ({ resolveAccountLocale: vi.fn(async () => "es-AR") }));
vi.mock("@/lib/rate-limit/index", () => ({
  getClientIp: () => "127.0.0.1",
  RATE_LIMIT_CONFIGS: { INTAKE_SIMULATE: { limit: 10, windowMs: 60_000 } },
}));

import { POST } from "@/app/api/demo/analyze/route";

const TENANT_ID = "10000000-0000-0000-0000-000000000001";
const USER_ID = "20000000-0000-0000-0000-000000000001";

function llamar(cuerpo: unknown = { subject: "Choque en ruta 3", body: "Tuve un choque ayer a la tarde." }) {
  return POST(
    new NextRequest("http://localhost/api/demo/analyze", {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": "vitest" },
      body: JSON.stringify(cuerpo),
    })
  );
}

describe("POST /api/demo/analyze", () => {
  beforeEach(() => {
    sesion.rol = "analyst";
    sesion.cupo = true;
    mockEntrar.mockImplementation(
      async (_etiqueta: unknown, _cupo: unknown, ...roles: string[]) => {
        if (!sesion.rol) throw new AppError("MISSING_SESSION");
        if (!roles.includes(sesion.rol)) throw new AppError("FORBIDDEN_ROLE");
        return {
          ctx: {
            user: { id: USER_ID },
            userRow: { id: USER_ID, tenant_id: TENANT_ID, role: sesion.rol },
          },
          rl: { allowed: sesion.cupo, remaining: 0, retryAfterSeconds: 60 },
        };
      }
    );
    mockCheckBudget.mockResolvedValue({ exceeded: false });
    mockExtract.mockResolvedValue({ is_claim: true });
    mockWriteAuditLog.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("pide los roles que editan casos, sin viewer", async () => {
    await llamar();
    const roles = mockEntrar.mock.calls[0]?.slice(2);
    expect(roles).toEqual(["owner", "admin", "specialist", "analyst"]);
    expect(roles).not.toContain("viewer");
  });

  it("un viewer recibe 403 y no llama al extractor", async () => {
    sesion.rol = "viewer";
    const res = await llamar();
    expect(res.status).toBe(403);
    expect(mockExtract).not.toHaveBeenCalled();
  });

  it("un editor de casos corre la extracción y recibe 200", async () => {
    const res = await llamar();

    expect(res.status).toBe(200);
    expect(mockExtract).toHaveBeenCalledWith(
      expect.objectContaining({ memoryHints: [], knownPatterns: [] }),
      TENANT_ID,
      "demo",
      USER_ID
    );
  });

  it("con el tope mensual agotado, ni el 429 ni el historial llevan el gasto del proyecto", async () => {
    vi.stubEnv("MONTHLY_BUDGET_USD", "200");
    mockCheckBudget.mockResolvedValue({
      exceeded: true,
      motivo: "mensual",
      reason: "Presupuesto mensual de IA agotado ($84.12 / $200).",
    });

    const res = await llamar();
    const cuerpo = await res.text();

    expect(res.status).toBe(429);
    expect(cuerpo).toContain(esARServidor["asistente.presupuestoMensual"]);
    expect(cuerpo).not.toContain("84.12");
    expect(mockExtract).not.toHaveBeenCalled();
    expect(mockWriteAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ payload: { reason: "budget_exceeded", ruta: "demo-analyze" } })
    );
    vi.unstubAllEnvs();
  });
});
