/**
 * PATCH /api/admin/montos (B23): la tabla propia de montos orientativos. Sólo
 * un admin, sólo su inquilino, y nada que no valide llega a la base.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { AppError } from "@/lib/errors";

const m = vi.hoisted(() => ({ requireAdmin: vi.fn(), enTenant: vi.fn(), audit: vi.fn() }));

vi.mock("@/lib/auth/require-admin", () => ({ requireAdmin: m.requireAdmin }));
vi.mock("@/data/scope", () => ({ enTenant: m.enTenant }));
vi.mock("@/lib/audit/log", () => ({
  writeAuditLog: m.audit,
  AuditEvent: { AMOUNT_RANGES_CHANGED: "tenant.amount_ranges_changed" },
}));

import { PATCH } from "@/app/api/admin/montos/route";
import { tenants } from "@/lib/db/schema";

const TENANT_ID = "10000000-0000-0000-0000-000000000001";
const USER_ROW = { id: "user-1", tenant_id: TENANT_ID, role: "admin" };
const RANGOS = { choque: { high: { minimo: 5_000_000, maximo: 12_000_000 } } };

let grabado: { tabla: unknown; valores: unknown } | null;
let falla: unknown;

const pedir = (body: unknown) =>
  PATCH(
    new NextRequest("http://localhost/api/admin/montos", {
      method: "PATCH",
      body: typeof body === "string" ? body : JSON.stringify(body),
      headers: { "content-type": "application/json" },
    })
  );

beforeEach(() => {
  vi.clearAllMocks();
  grabado = null;
  falla = null;
  m.requireAdmin.mockResolvedValue({ user: { id: USER_ROW.id }, userRow: USER_ROW });
  m.audit.mockResolvedValue(undefined);
  m.enTenant.mockImplementation(async (ctx: { tenantId: string }, armar: (db: unknown) => unknown) => {
    expect(ctx.tenantId).toBe(TENANT_ID);
    return armar({
      update: (tabla: unknown) => ({
        set: (valores: unknown) => ({
          where: async () => {
            if (falla) throw falla;
            grabado = { tabla, valores };
          },
        }),
      }),
    });
  });
});

describe("PATCH /api/admin/montos", () => {
  it("quien no es admin no llega a la base", async () => {
    m.requireAdmin.mockRejectedValue(new AppError("FORBIDDEN_ROLE"));
    expect((await pedir({ rangos: RANGOS })).status).toBe(403);
    expect(m.enTenant).not.toHaveBeenCalled();
  });

  it("guarda la tabla del inquilino de la sesión y lo audita", async () => {
    const res = await pedir({ rangos: RANGOS });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ rangos: RANGOS });
    expect(grabado).toEqual({ tabla: tenants, valores: { rangos_de_monto: RANGOS } });
    expect(m.audit).toHaveBeenCalledWith(
      expect.objectContaining({ tenant_id: TENANT_ID, target_id: TENANT_ID, payload: { por_defecto: false } })
    );
  });

  it("null vuelve a la tabla por defecto", async () => {
    expect((await pedir({ rangos: null })).status).toBe(200);
    expect(grabado?.valores).toEqual({ rangos_de_monto: null });
    expect(m.audit).toHaveBeenCalledWith(expect.objectContaining({ payload: { por_defecto: true } }));
  });

  it.each([
    ["JSON roto", "{ no"],
    ["sin rangos", {}],
    ["mínimo mayor que máximo", { rangos: { choque: { high: { minimo: 9, maximo: 1 } } } }],
    ["tipo inventado", { rangos: { avion: { high: { minimo: 1, maximo: 2 } } } }],
    ["gravedad inventada", { rangos: { choque: { enorme: { minimo: 1, maximo: 2 } } } }],
    ["una clave de más", { rangos: RANGOS, tenant_id: "otro" }],
  ])("%s da 400 sin escribir", async (_caso, body) => {
    expect((await pedir(body)).status).toBe(400);
    expect(m.enTenant).not.toHaveBeenCalled();
  });

  it("sin la 0040 contesta 503", async () => {
    falla = Object.assign(new Error("no existe la columna"), { code: "42703" });
    expect((await pedir({ rangos: RANGOS })).status).toBe(503);
    expect(m.audit).not.toHaveBeenCalled();
  });
});
