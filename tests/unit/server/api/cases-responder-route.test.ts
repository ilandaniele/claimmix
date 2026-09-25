/**
 * POST /api/cases/:id/responder — responder por WhatsApp desde el caso.
 *
 * `entrar` se reemplaza por uno que cumple su contrato (sin sesión 401, rol
 * fuera de la lista 403, cupo agotado lo avisa en `rl`): así se prueba qué
 * exige la RUTA (rol, plan, canal, agente activo, ventana), no `puede-responder`,
 * que tiene su propio test.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { AppError } from "@/lib/errors";

const { mockEntrar, mockResponder, sesion } = vi.hoisted(() => ({
  mockEntrar: vi.fn(),
  mockResponder: vi.fn(),
  sesion: { rol: "analyst" as string | null, plan: "profesional" as string, cupo: true },
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/api/entrada", () => ({ entrar: mockEntrar }));
vi.mock("@/lib/auth/require-role", async () => ({
  CASE_EDITOR_ROLES: (await import("@/lib/auth/roles")).CASE_EDITOR_ROLES,
}));
vi.mock("@/server/confirmations/respuesta-humana", () => ({ responderPorWhatsApp: mockResponder }));
vi.mock("@/lib/rate-limit/index", () => ({
  RATE_LIMIT_CONFIGS: { RESPUESTA_HUMANA: { limit: 10, windowMs: 60_000 } },
}));

import { POST } from "@/app/api/cases/[id]/responder/route";

const CASE_ID = "123e4567-e89b-12d3-a456-426614174001";
const TENANT_ID = "10000000-0000-0000-0000-000000000001";
const USER_ID = "20000000-0000-0000-0000-000000000001";

function llamar(id = CASE_ID, cuerpo: unknown = { texto: "Ya está resuelto, gracias." }) {
  return POST(
    new NextRequest(`http://localhost/api/cases/${id}/responder`, {
      method: "POST",
      headers: { "user-agent": "vitest" },
      body: cuerpo === null ? undefined : JSON.stringify(cuerpo),
    }),
    { params: Promise.resolve({ id }) }
  );
}

describe("POST /api/cases/:id/responder", () => {
  beforeEach(() => {
    sesion.rol = "analyst";
    sesion.plan = "profesional";
    sesion.cupo = true;
    mockEntrar.mockImplementation(
      async (_etiqueta: unknown, _cupo: unknown, ...roles: string[]) => {
        if (!sesion.rol) throw new AppError("MISSING_SESSION");
        if (!roles.includes(sesion.rol)) throw new AppError("FORBIDDEN_ROLE");
        return {
          ctx: {
            user: { id: USER_ID },
            userRow: {
              id: USER_ID,
              tenant_id: TENANT_ID,
              role: sesion.rol,
              plan: sesion.plan,
            },
          },
          rl: { allowed: sesion.cupo, remaining: 0, retryAfterSeconds: 60 },
        };
      }
    );
    mockResponder.mockResolvedValue({ ok: true, id: "outbound-1", estado: "sent" });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("sin sesión da 401 y no toca nada", async () => {
    sesion.rol = null;
    expect((await llamar()).status).toBe(401);
    expect(mockResponder).not.toHaveBeenCalled();
  });

  it("un viewer recibe 403 y no toca nada", async () => {
    sesion.rol = "viewer";
    expect((await llamar()).status).toBe(403);
    expect(mockResponder).not.toHaveBeenCalled();
  });

  it("sin Plan Pro da 403 PLAN_REQUERIDO y no toca nada", async () => {
    sesion.plan = "piloto";
    const res = await llamar();
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("PLAN_REQUERIDO");
    expect(mockResponder).not.toHaveBeenCalled();
  });

  it("con el cupo agotado da 429 y no toca nada", async () => {
    sesion.cupo = false;
    expect((await llamar()).status).toBe(429);
    expect(mockResponder).not.toHaveBeenCalled();
  });

  it("un id que no es uuid da 404 y no toca nada", async () => {
    const res = await llamar("no-es-un-uuid");
    expect(res.status).toBe(404);
    expect(mockResponder).not.toHaveBeenCalled();
  });

  it.each([
    ["sin cuerpo", null],
    ["sin texto", {}],
    ["con texto vacío", { texto: "" }],
    ["con texto de más de 4096 caracteres", { texto: "a".repeat(4097) }],
    ["con un campo extra (`to`)", { texto: "hola", to: "5491100000000" }],
  ])("%s da 400 y no toca nada", async (_caso, cuerpo) => {
    const res = await llamar(CASE_ID, cuerpo);
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("VALIDATION_FAILED");
    expect(mockResponder).not.toHaveBeenCalled();
  });

  it("con 4096 caracteres justos, pasa la validación", async () => {
    const res = await llamar(CASE_ID, { texto: "a".repeat(4096) });
    expect(res.status).toBe(200);
    expect(mockResponder).toHaveBeenCalledTimes(1);
  });

  it("caso inexistente da 404", async () => {
    mockResponder.mockResolvedValue({ ok: false, motivo: "no_encontrado" });
    const res = await llamar();
    expect(res.status).toBe(404);
  });

  it.each(["agente_activo", "ventana", "canal", "plan", "rol"] as const)(
    "motivo %s da 409 RESPUESTA_NO_PERMITIDA con el motivo",
    async (motivo) => {
      mockResponder.mockResolvedValue({ ok: false, motivo });
      const res = await llamar();
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error.code).toBe("RESPUESTA_NO_PERMITIDA");
      expect(body.error.details).toEqual({ motivo });
    }
  );

  it("un error de Meta da 502 ENVIO_FALLIDO", async () => {
    mockResponder.mockResolvedValue({ ok: false, motivo: "envio_fallido" });
    const res = await llamar();
    expect(res.status).toBe(502);
    expect((await res.json()).error.code).toBe("ENVIO_FALLIDO");
  });

  it("mandado con éxito, contesta 200 con id y estado, con el inquilino y el texto de la sesión", async () => {
    const res = await llamar(CASE_ID, { texto: "Ya está resuelto, gracias." });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ id: "outbound-1", estado: "sent" });
    expect(mockResponder).toHaveBeenCalledTimes(1);
    const [ctxLlamado, caseIdLlamado, textoLlamado] = mockResponder.mock.calls[0]!;
    expect(ctxLlamado.userRow.tenant_id).toBe(TENANT_ID);
    expect(caseIdLlamado).toBe(CASE_ID);
    expect(textoLlamado).toBe("Ya está resuelto, gracias.");
  });

  it("usa el cupo de RESPUESTA_HUMANA", async () => {
    await llamar();
    expect(mockEntrar.mock.calls[0]?.[1]).toEqual({ limit: 10, windowMs: 60_000 });
  });
});
