/**
 * /api/asistente — la puerta: sesión, cupo, Plan Pro y forma del cuerpo. Lo que
 * responde `responderPregunta` y `preguntarSobreCaso` no se prueba acá, tienen lo
 * suyo en `responder.test.ts` y `pregunta-caso.test.ts`.
 */

const { mockEntrar, mockResponderPregunta, mockPreguntarSobreCaso, mockHiloDelCaso } = vi.hoisted(() => ({
  mockEntrar: vi.fn(),
  mockResponderPregunta: vi.fn(),
  mockPreguntarSobreCaso: vi.fn(),
  mockHiloDelCaso: vi.fn(),
}));

vi.mock("@/lib/api/entrada", () => ({ entrar: mockEntrar }));
vi.mock("@/lib/i18n/locale", () => ({
  resolveAccountLocale: vi.fn(async (cuenta?: string | null) => (cuenta === "en-US" ? "en-US" : "es-AR")),
}));
vi.mock("@/server/asistente/responder", () => ({ responderPregunta: mockResponderPregunta }));
vi.mock("@/server/asistente/pregunta-caso", () => ({
  preguntarSobreCaso: mockPreguntarSobreCaso,
  hiloDelCaso: mockHiloDelCaso,
}));

import { describe, it, expect, beforeEach, vi } from "vitest";
import { GET, POST } from "@/app/api/asistente/route";
import { AppError } from "@/lib/errors";

const TENANT_ID = "10000000-0000-0000-0000-000000000001";
const USER_ID = "20000000-0000-0000-0000-000000000001";
const CASE_ID = "30000000-0000-0000-0000-000000000001";

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
  mockPreguntarSobreCaso.mockResolvedValue({ texto: "Falta el DNI.", herramienta: "pregunta_caso", casos: [] });
  mockHiloDelCaso.mockResolvedValue([{ rol: "user", texto: "¿qué falta?" }]);
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

describe("POST /api/asistente con caseId", () => {
  it("una pregunta con caseId va a preguntarSobreCaso y no al clasificador", async () => {
    const res = await POST(makeRequest({ pregunta: "¿qué falta?", caseId: CASE_ID }));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ herramienta: "pregunta_caso" });
    expect(mockPreguntarSobreCaso).toHaveBeenCalledWith(expect.anything(), CASE_ID, "¿qué falta?", "es-AR");
    expect(mockResponderPregunta).not.toHaveBeenCalled();
  });

  it("le pasa el idioma de la cuenta a preguntarSobreCaso: la respuesta no sale en castellano a una cuenta en inglés", async () => {
    const ctx = ctxConPlan("profesional");
    mockEntrar.mockResolvedValue({
      ctx: { ...ctx, userRow: { ...ctx.userRow, locale: "en-US" } },
      rl: { allowed: true, remaining: 19, retryAfterSeconds: 0 },
    });

    await POST(makeRequest({ pregunta: "what is missing?", caseId: CASE_ID }));

    expect(mockPreguntarSobreCaso).toHaveBeenCalledWith(expect.anything(), CASE_ID, "what is missing?", "en-US");
  });

  it("sin caseId sigue yendo al clasificador", async () => {
    await POST(makeRequest({ pregunta: "¿cuántos casos hoy?" }));

    expect(mockResponderPregunta).toHaveBeenCalledTimes(1);
    expect(mockPreguntarSobreCaso).not.toHaveBeenCalled();
  });

  it("400 con un caseId que no es uuid", async () => {
    const res = await POST(makeRequest({ pregunta: "¿qué falta?", caseId: "no-es-uuid" }));

    expect(res.status).toBe(400);
    expect(mockPreguntarSobreCaso).not.toHaveBeenCalled();
  });

  it("403 sin Plan Pro también con caseId", async () => {
    mockEntrar.mockResolvedValue({
      ctx: ctxConPlan("operativo"),
      rl: { allowed: true, remaining: 19, retryAfterSeconds: 0 },
    });

    const res = await POST(makeRequest({ pregunta: "¿qué falta?", caseId: CASE_ID }));

    expect(res.status).toBe(403);
    expect(mockPreguntarSobreCaso).not.toHaveBeenCalled();
  });

  it("404 cuando el caso no es del inquilino", async () => {
    mockPreguntarSobreCaso.mockRejectedValue(new AppError("NOT_FOUND"));

    const res = await POST(makeRequest({ pregunta: "¿qué falta?", caseId: CASE_ID }));

    expect(res.status).toBe(404);
  });

  it("un sinLeer llega como 200: es un estado, no un error", async () => {
    mockPreguntarSobreCaso.mockResolvedValue({
      texto: "Sin leer: se llegó al tope de lecturas por hoy.",
      herramienta: "pregunta_caso",
      casos: [],
      sinLeer: "cupo",
    });

    const res = await POST(makeRequest({ pregunta: "¿qué falta?", caseId: CASE_ID }));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ sinLeer: "cupo" });
  });
});

function makeGet(query: string) {
  return new Request(`http://localhost/api/asistente${query}`);
}

describe("GET /api/asistente?caseId=", () => {
  it("devuelve el hilo guardado", async () => {
    const res = await GET(makeGet(`?caseId=${CASE_ID}`));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ turnos: [{ rol: "user", texto: "¿qué falta?" }] });
    expect(mockHiloDelCaso).toHaveBeenCalledWith(expect.anything(), CASE_ID);
  });

  it("401 sin sesión", async () => {
    mockEntrar.mockRejectedValue(new AppError("MISSING_SESSION"));

    const res = await GET(makeGet(`?caseId=${CASE_ID}`));

    expect(res.status).toBe(401);
    expect(mockHiloDelCaso).not.toHaveBeenCalled();
  });

  it("403 sin Plan Pro", async () => {
    mockEntrar.mockResolvedValue({
      ctx: ctxConPlan("operativo"),
      rl: { allowed: true, remaining: 19, retryAfterSeconds: 0 },
    });

    const res = await GET(makeGet(`?caseId=${CASE_ID}`));

    expect(res.status).toBe(403);
    expect(mockHiloDelCaso).not.toHaveBeenCalled();
  });

  it("400 sin caseId o con uno que no es uuid", async () => {
    expect((await GET(makeGet(""))).status).toBe(400);
    expect((await GET(makeGet("?caseId=1"))).status).toBe(400);
    expect(mockHiloDelCaso).not.toHaveBeenCalled();
  });

  it("429 con el cupo agotado", async () => {
    mockEntrar.mockResolvedValue({
      ctx: ctxConPlan("profesional"),
      rl: { allowed: false, remaining: 0, retryAfterSeconds: 12 },
    });

    const res = await GET(makeGet(`?caseId=${CASE_ID}`));

    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("12");
  });
});
