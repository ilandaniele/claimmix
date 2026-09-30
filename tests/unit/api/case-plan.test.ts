/**
 * PATCH /api/cases/:id/plan — tildar o destildar un paso del plan (B11).
 *
 * La ruta se prueba con `entrar` y `marcarPaso` reemplazados: acá se afirma
 * quién pasa, qué cuerpo se acepta y que un paso que no pegó es un 404. La
 * sentencia y su permiso sobre el caso se afirman en
 * `tests/unit/server/cases/plan-de-trabajo.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { AppError } from "@/lib/errors";

const { mockEntrar, mockMarcarPaso, sesion } = vi.hoisted(() => ({
  mockEntrar: vi.fn(),
  mockMarcarPaso: vi.fn(),
  sesion: { rol: "analyst" as string | null, cupo: true },
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/api/entrada", () => ({ entrar: mockEntrar }));
vi.mock("@/lib/auth/require-role", async () => ({
  CASE_EDITOR_ROLES: (await import("@/lib/auth/roles")).CASE_EDITOR_ROLES,
}));
vi.mock("@/server/cases/plan-de-trabajo", () => ({ marcarPaso: mockMarcarPaso }));
vi.mock("@/lib/rate-limit/index", () => ({
  RATE_LIMIT_CONFIGS: { CASES_API: { limit: 100, windowMs: 60_000 } },
}));

import { PATCH } from "@/app/api/cases/[id]/plan/route";

const CASE_ID = "123e4567-e89b-12d3-a456-426614174001";
const TENANT_ID = "10000000-0000-0000-0000-000000000001";
const USER_ID = "20000000-0000-0000-0000-000000000001";

function llamar(cuerpo: unknown = { clave: "pedir_presupuesto", hecho: true }, id = CASE_ID) {
  return PATCH(
    new NextRequest(`http://localhost/api/cases/${id}/plan`, {
      method: "PATCH",
      body: cuerpo === null ? undefined : JSON.stringify(cuerpo),
    }),
    { params: Promise.resolve({ id }) }
  );
}

describe("PATCH /api/cases/:id/plan", () => {
  beforeEach(() => {
    sesion.rol = "analyst";
    sesion.cupo = true;
    mockEntrar.mockImplementation(async (_etiqueta: unknown, _cupo: unknown, ...roles: string[]) => {
      if (!sesion.rol) throw new AppError("MISSING_SESSION");
      if (!roles.includes(sesion.rol)) throw new AppError("FORBIDDEN_ROLE");
      return {
        ctx: {
          user: { id: USER_ID },
          userRow: { id: USER_ID, tenant_id: TENANT_ID, role: sesion.rol },
        },
        rl: { allowed: sesion.cupo, remaining: 0, retryAfterSeconds: 60 },
      };
    });
    mockMarcarPaso.mockResolvedValue(true);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("sin sesión da 401 y no toca nada", async () => {
    sesion.rol = null;
    expect((await llamar()).status).toBe(401);
    expect(mockMarcarPaso).not.toHaveBeenCalled();
  });

  it("un viewer recibe 403", async () => {
    sesion.rol = "viewer";
    expect((await llamar()).status).toBe(403);
    expect(mockMarcarPaso).not.toHaveBeenCalled();
  });

  it.each(["owner", "admin", "specialist", "analyst"])("%s pasa la puerta", async (rol) => {
    sesion.rol = rol;
    expect((await llamar()).status).toBe(200);
  });

  it("con el cupo agotado da 429", async () => {
    sesion.cupo = false;
    expect((await llamar()).status).toBe(429);
    expect(mockMarcarPaso).not.toHaveBeenCalled();
  });

  it("usa el cupo de las demás mutaciones de casos, con su propia etiqueta", async () => {
    await llamar();
    expect(mockEntrar.mock.calls[0]?.[0]).toBe("cases-plan");
    expect(mockEntrar.mock.calls[0]?.[1]).toEqual({ limit: 100, windowMs: 60_000 });
  });

  it("un id que no es uuid da 400", async () => {
    const res = await llamar(undefined, "no-es-un-uuid");
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("VALIDATION_FAILED");
    expect(mockMarcarPaso).not.toHaveBeenCalled();
  });

  it.each([
    ["sin cuerpo", null],
    ["sin clave", { hecho: true }],
    ["sin hecho", { clave: "pedir_presupuesto" }],
    ["con la clave vacía", { clave: "", hecho: true }],
    ["con hecho que no es booleano", { clave: "pedir_presupuesto", hecho: "si" }],
    ["con un campo de más", { clave: "pedir_presupuesto", hecho: true, hecho_por: USER_ID }],
  ])("%s da 400 y no toca nada", async (_caso, cuerpo) => {
    const res = await llamar(cuerpo);
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("VALIDATION_FAILED");
    expect(mockMarcarPaso).not.toHaveBeenCalled();
  });

  it("marca el paso con el inquilino, el caso, el actor y su rol", async () => {
    const res = await llamar();

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ clave: "pedir_presupuesto", hecho: true });
    expect(mockMarcarPaso).toHaveBeenCalledTimes(1);
    expect(mockMarcarPaso).toHaveBeenCalledWith({ tenantId: TENANT_ID }, CASE_ID, "pedir_presupuesto", true, {
      id: USER_ID,
      role: "analyst",
    });
  });

  it("destildar manda hecho false", async () => {
    const res = await llamar({ clave: "pedir_presupuesto", hecho: false });

    expect(res.status).toBe(200);
    expect(mockMarcarPaso.mock.calls[0]?.[3]).toBe(false);
  });

  // Un analista en un caso ajeno y una clave que no existe son la misma respuesta.
  it("si no cambió ninguna fila da 404", async () => {
    mockMarcarPaso.mockResolvedValue(false);
    const res = await llamar();

    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("NOT_FOUND");
  });

  it("una migración pendiente sale como 503", async () => {
    mockMarcarPaso.mockRejectedValue(new AppError("MIGRACION_PENDIENTE", "Falta aplicar la migración 0042."));
    const res = await llamar();

    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe("MIGRACION_PENDIENTE");
  });
});
