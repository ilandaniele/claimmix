/**
 * POST /api/cases/:id/respondido — «Marcar como respondido».
 *
 * `entrar` se reemplaza por uno que cumple su contrato (sin sesión 401, rol
 * fuera de la lista 403, cupo agotado lo avisa en `rl`): así se prueba qué
 * roles deja pasar la RUTA, no la puerta, que tiene su propio test.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { AppError } from "@/lib/errors";

const { mockEntrar, mockMarcar, mockWriteAuditLog, sesion } = vi.hoisted(() => ({
  mockEntrar: vi.fn(),
  mockMarcar: vi.fn(),
  mockWriteAuditLog: vi.fn(),
  sesion: { rol: "analyst" as string | null, cupo: true },
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/api/entrada", () => ({ entrar: mockEntrar }));
vi.mock("@/lib/auth/require-role", async () => ({
  CASE_EDITOR_ROLES: (await import("@/lib/auth/roles")).CASE_EDITOR_ROLES,
}));
vi.mock("@/server/cases/para-responder", () => ({ marcarRespondido: mockMarcar }));
vi.mock("@/lib/audit/log", () => ({
  AuditEvent: { CASE_MARKED_ANSWERED: "case.marked_answered" },
  writeAuditLog: mockWriteAuditLog,
}));
vi.mock("@/lib/rate-limit/index", () => ({
  getClientIp: () => "127.0.0.1",
  RATE_LIMIT_CONFIGS: { CASES_API: { limit: 100, windowMs: 60_000 } },
}));

import { POST } from "@/app/api/cases/[id]/respondido/route";

const CASE_ID = "123e4567-e89b-12d3-a456-426614174001";
const TENANT_ID = "10000000-0000-0000-0000-000000000001";
const USER_ID = "20000000-0000-0000-0000-000000000001";
const VISTO = "2026-09-25T12:00:00.000Z";

function llamar(id = CASE_ID, cuerpo: unknown = { visto: VISTO }) {
  return POST(
    new NextRequest(`http://localhost/api/cases/${id}/respondido`, {
      method: "POST",
      headers: { "user-agent": "vitest" },
      body: cuerpo === null ? undefined : JSON.stringify(cuerpo),
    }),
    { params: Promise.resolve({ id }) }
  );
}

describe("POST /api/cases/:id/respondido", () => {
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
    mockMarcar.mockResolvedValue(true);
    mockWriteAuditLog.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("sin sesión da 401 y no toca nada", async () => {
    sesion.rol = null;
    expect((await llamar()).status).toBe(401);
    expect(mockMarcar).not.toHaveBeenCalled();
  });

  it("un viewer recibe 403", async () => {
    sesion.rol = "viewer";
    expect((await llamar()).status).toBe(403);
    expect(mockMarcar).not.toHaveBeenCalled();
  });

  it("con el cupo agotado da 429", async () => {
    sesion.cupo = false;
    expect((await llamar()).status).toBe(429);
    expect(mockMarcar).not.toHaveBeenCalled();
  });

  it("un id que no es uuid da 400", async () => {
    const res = await llamar("no-es-un-uuid");
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("VALIDATION_FAILED");
    expect(mockMarcar).not.toHaveBeenCalled();
  });

  // Sin `visto` no hay forma de saber si entró algo que quien contesta no vio.
  it.each([
    ["sin cuerpo", null],
    ["sin visto", {}],
    ["con visto que no es una fecha", { visto: "ayer" }],
  ])("%s da 400 y no toca nada", async (_caso, cuerpo) => {
    const res = await llamar(CASE_ID, cuerpo);
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("VALIDATION_FAILED");
    expect(mockMarcar).not.toHaveBeenCalled();
  });

  it("usa el cupo de las demás mutaciones de casos", async () => {
    await llamar();
    expect(mockEntrar.mock.calls[0]?.[1]).toEqual({ limit: 100, windowMs: 60_000 });
  });

  it("lo saca de «Para responder» con el inquilino de la sesión y lo audita", async () => {
    const res = await llamar();

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ actualizado: true });
    expect(mockMarcar).toHaveBeenCalledTimes(1);
    expect(mockMarcar).toHaveBeenCalledWith({ tenantId: TENANT_ID }, CASE_ID, VISTO);
    expect(mockWriteAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        tenant_id: TENANT_ID,
        actor_id: USER_ID,
        event_type: "case.marked_answered",
        target_type: "case",
        target_id: CASE_ID,
      })
    );
  });

  it("si no había nada que sacar contesta false y no audita", async () => {
    mockMarcar.mockResolvedValue(false);
    const res = await llamar();

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ actualizado: false });
    expect(mockWriteAuditLog).not.toHaveBeenCalled();
  });
});
