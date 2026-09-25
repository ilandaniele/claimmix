/**
 * POST /api/asistente — la puerta: sesión, cupo, Plan Pro y forma del cuerpo.
 * Lo que responde `responderPregunta` no se prueba acá, ya tiene lo suyo en
 * `responder.test.ts`.
 */

const { mockEntrar, mockResponderPregunta } = vi.hoisted(() => ({
  mockEntrar: vi.fn(),
  mockResponderPregunta: vi.fn(),
}));

vi.mock("@/lib/api/entrada", () => ({ entrar: mockEntrar }));
vi.mock("@/server/asistente/responder", () => ({ responderPregunta: mockResponderPregunta }));

import { describe, it, expect, beforeEach, vi } from "vitest";
import { POST } from "@/app/api/asistente/route";
import { AppError } from "@/lib/errors";

const TENANT_ID = "10000000-0000-0000-0000-000000000001";
const USER_ID = "20000000-0000-0000-0000-000000000001";

function makeRequest(body: unknown) {
  return new Request("http://localhost/api/asistente", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function ctxConPlan(plan: string, role = "analyst") {
  return {
    db: {},
    user: { id: USER_ID },
    userRow: { id: USER_ID, tenant_id: TENANT_ID, role, plan },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockEntrar.mockResolvedValue({
    ctx: ctxConPlan("profesional"),
    rl: { allowed: true, remaining: 19, retryAfterSeconds: 0 },
  });
  mockResponderPregunta.mockResolvedValue({ texto: "9 casos", herramienta: "contar_casos", casos: [] });
});

describe("POST /api/asistente", () => {
  it("responde 200 con lo que arma responderPregunta", async () => {
    const res = await POST(makeRequest({ pregunta: "¿cuántos casos hoy?" }));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ herramienta: "contar_casos" });
  });

  it("401 cuando no hay sesión", async () => {
    mockEntrar.mockRejectedValue(new AppError("MISSING_SESSION"));

    const res = await POST(makeRequest({ pregunta: "¿cuántos casos hoy?" }));
    expect(res.status).toBe(401);
    expect(mockResponderPregunta).not.toHaveBeenCalled();
  });

  it("403 sin Plan Pro", async () => {
    mockEntrar.mockResolvedValue({
      ctx: ctxConPlan("operativo"),
      rl: { allowed: true, remaining: 19, retryAfterSeconds: 0 },
    });

    const res = await POST(makeRequest({ pregunta: "¿cuántos casos hoy?" }));
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({ error: { code: "PLAN_REQUERIDO" } });
    expect(mockResponderPregunta).not.toHaveBeenCalled();
  });

  it("400 con una pregunta demasiado corta", async () => {
    const res = await POST(makeRequest({ pregunta: "a" }));
    expect(res.status).toBe(400);
    expect(mockResponderPregunta).not.toHaveBeenCalled();
  });

  it("400 sin el campo pregunta", async () => {
    const res = await POST(makeRequest({}));
    expect(res.status).toBe(400);
  });

  it("400 con una clave extra en el cuerpo", async () => {
    const res = await POST(makeRequest({ pregunta: "¿cuántos casos hoy?", tenant_id: "otro" }));
    expect(res.status).toBe(400);
    expect(mockResponderPregunta).not.toHaveBeenCalled();
  });

  it("429 cuando se agotó el cupo", async () => {
    mockEntrar.mockResolvedValue({
      ctx: ctxConPlan("profesional"),
      rl: { allowed: false, remaining: 0, retryAfterSeconds: 30 },
    });

    const res = await POST(makeRequest({ pregunta: "¿cuántos casos hoy?" }));
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("30");
    expect(mockResponderPregunta).not.toHaveBeenCalled();
  });

  it("propaga el AppError que tire responderPregunta (p. ej. presupuesto agotado)", async () => {
    mockResponderPregunta.mockRejectedValue(new AppError("AI_BUDGET_EXCEEDED"));

    const res = await POST(makeRequest({ pregunta: "¿cuántos casos hoy?" }));
    expect(res.status).toBe(429);
    await expect(res.json()).resolves.toMatchObject({ error: { code: "AI_BUDGET_EXCEEDED" } });
  });
});
