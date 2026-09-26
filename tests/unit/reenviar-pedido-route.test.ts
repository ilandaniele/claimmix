/**
 * POST /api/cases/:id/reenviar-pedido — sólo lo que decide la RUTA (rol, id,
 * cuerpo, cupo, mapeo de motivo a HTTP). `reenviarPedido` va mockeada entera:
 * su lógica tiene su propio test en
 * `tests/unit/server/confirmations/reenvio.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { AppError } from "@/lib/errors";

const { mockEntrar, mockReenviar, sesion } = vi.hoisted(() => ({
  mockEntrar: vi.fn(),
  mockReenviar: vi.fn(),
  sesion: { rol: "analyst" as string | null, cupo: true },
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/api/entrada", () => ({ entrar: mockEntrar }));
vi.mock("@/lib/auth/require-role", async () => ({
  CASE_EDITOR_ROLES: (await import("@/lib/auth/roles")).CASE_EDITOR_ROLES,
}));
vi.mock("@/server/confirmations/reenvio", () => ({ reenviarPedido: mockReenviar }));

import { POST } from "@/app/api/cases/[id]/reenviar-pedido/route";
import { RATE_LIMIT_CONFIGS } from "@/lib/rate-limit/index";

const CASE_ID = "123e4567-e89b-12d3-a456-426614174001";
const TENANT_ID = "10000000-0000-0000-0000-000000000001";
const USER_ID = "20000000-0000-0000-0000-000000000001";

function llamar(id = CASE_ID, cuerpo: unknown = {}) {
  return POST(
    new NextRequest(`http://localhost/api/cases/${id}/reenviar-pedido`, {
      method: "POST",
      headers: { "user-agent": "vitest" },
      body: cuerpo === null ? undefined : JSON.stringify(cuerpo),
    }),
    { params: Promise.resolve({ id }) }
  );
}

describe("POST /api/cases/:id/reenviar-pedido", () => {
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
            userRow: { id: USER_ID, tenant_id: TENANT_ID, role: sesion.rol, plan: "profesional" },
          },
          rl: { allowed: sesion.cupo, remaining: 0, retryAfterSeconds: 30 },
        };
      }
    );
    mockReenviar.mockResolvedValue({ ok: true, claves: ["full_name"], reabierto: false });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("un viewer recibe 403 y no toca nada", async () => {
    sesion.rol = "viewer";
    expect((await llamar()).status).toBe(403);
    expect(mockReenviar).not.toHaveBeenCalled();
  });

  it("con el cupo agotado da 429 y no toca nada", async () => {
    sesion.cupo = false;
    expect((await llamar()).status).toBe(429);
    expect(mockReenviar).not.toHaveBeenCalled();
  });

  it("un id que no es uuid da 404 y no toca nada", async () => {
    const res = await llamar("no-es-un-uuid");
    expect(res.status).toBe(404);
    expect(mockReenviar).not.toHaveBeenCalled();
  });

  it("un cuerpo con reabrir en false (no literal true) da 400", async () => {
    const res = await llamar(CASE_ID, { reabrir: false });
    expect(res.status).toBe(400);
    expect(mockReenviar).not.toHaveBeenCalled();
  });

  it("sin cuerpo, reabrir queda en false", async () => {
    const res = await llamar(CASE_ID, null);
    expect(res.status).toBe(200);
    expect(mockReenviar).toHaveBeenCalledWith(expect.anything(), CASE_ID, false);
  });

  it("con reabrir:true, se lo pasa a reenviarPedido", async () => {
    await llamar(CASE_ID, { reabrir: true });
    expect(mockReenviar).toHaveBeenCalledWith(expect.anything(), CASE_ID, true);
  });

  it("caso inexistente da 404", async () => {
    mockReenviar.mockResolvedValue({ ok: false, motivo: "no_encontrado" });
    const res = await llamar();
    expect(res.status).toBe(404);
  });

  it("reabrir por un analista que no es dueño también da 404 (mismo motivo que no existe)", async () => {
    mockReenviar.mockResolvedValue({ ok: false, motivo: "no_encontrado" });
    const res = await llamar(CASE_ID, { reabrir: true });
    expect(res.status).toBe(404);
  });

  it.each([
    "estado",
    "sin_destinatario",
    "ventana_cerrada",
    "nada_pendiente",
    "reciente",
    "cierre_no_es_abandono",
  ] as const)("motivo %s da 409 RESPUESTA_NO_PERMITIDA con el motivo", async (motivo) => {
    mockReenviar.mockResolvedValue({ ok: false, motivo });
    const res = await llamar();
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe("RESPUESTA_NO_PERMITIDA");
    expect(body.error.details).toEqual({ motivo });
  });

  it("con éxito, contesta 200 con claves y reabierto", async () => {
    mockReenviar.mockResolvedValue({ ok: true, claves: ["full_name", "patente_vehiculo"], reabierto: true });
    const res = await llamar(CASE_ID, { reabrir: true });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ claves: ["full_name", "patente_vehiculo"], reabierto: true });
  });

  it("usa el cupo de REENVIAR_PEDIDO", async () => {
    await llamar();
    expect(mockEntrar.mock.calls[0]?.[1]).toEqual(RATE_LIMIT_CONFIGS.REENVIAR_PEDIDO);
  });
});
