/**
 * La puerta de /api/v1 con un inquilino que no tiene base (3D000).
 *
 * La clave trae el inquilino adentro y la hace el que llama: con
 * `BASE_POR_CLIENTE=1` un uuid inventado, o el de un inquilino que se dio de
 * baja, apunta a una base `t_<hex>` que no existe. Eso es una clave que no sirve:
 * 401 igual que una clave mala, no un 500 que delate qué inquilinos hay.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  enTenant: vi.fn(),
  rateLimit: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/data/scope", () => ({ enTenant: h.enTenant }));
vi.mock("@/lib/rate-limit/index", () => ({
  rateLimit: h.rateLimit,
  RATE_LIMIT_CONFIGS: { CORE_API: { limit: 120, windowMs: 60_000, lote: 5 } },
  getClientIp: () => "203.0.113.9",
}));

import { autenticarClave } from "@/app/api/v1/_auth";
import { claveNueva } from "@/server/core-sync/clave";

const TENANT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const entraCon = (clave: string) =>
  autenticarClave(new Request("http://localhost/api/v1/cases", { headers: { Authorization: `Bearer ${clave}` } }));

const sinBase = () => Object.assign(new Error('database "t_x" does not exist'), { code: "3D000" });

beforeEach(() => {
  vi.clearAllMocks();
  h.rateLimit.mockResolvedValue({ allowed: true, remaining: 4, resetAt: 0, retryAfterSeconds: 0 });
});

describe("autenticarClave ante un inquilino sin base", () => {
  it("3D000 da 401 con WWW-Authenticate, igual que una clave mala", async () => {
    h.enTenant.mockRejectedValue(sinBase());

    const res = (await entraCon(claveNueva(TENANT_ID).clave)) as Response;

    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toBe("Bearer");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect((await res.json()).error.code).toBe("INVALID_CREDENTIALS");
  });

  it("es la misma respuesta que da una clave que no coincide", async () => {
    h.enTenant.mockRejectedValueOnce(sinBase());
    const sinBaseRes = (await entraCon(claveNueva(TENANT_ID).clave)) as Response;

    h.enTenant.mockResolvedValueOnce([{ hash: claveNueva(TENANT_ID).hash }]);
    const mala = (await entraCon(claveNueva(TENANT_ID).clave)) as Response;

    expect(sinBaseRes.status).toBe(mala.status);
    expect(await sinBaseRes.json()).toEqual(await mala.json());
  });

  it("el 3D000 envuelto por drizzle en `cause` también", async () => {
    h.enTenant.mockRejectedValue(new Error("Failed query", { cause: sinBase() }));

    const res = (await entraCon(claveNueva(TENANT_ID).clave)) as Response;

    expect(res.status).toBe(401);
  });

  it("otro error de la base sigue siendo un error, no un 401", async () => {
    h.enTenant.mockRejectedValue(Object.assign(new Error("caída"), { code: "08006" }));

    await expect(entraCon(claveNueva(TENANT_ID).clave)).rejects.toThrow("caída");
  });

  it("la clave buena de un inquilino con base entra", async () => {
    const { clave, hash } = claveNueva(TENANT_ID);
    h.enTenant.mockResolvedValue([{ hash }]);

    expect(await entraCon(clave)).toEqual({ tenantId: TENANT_ID });
  });

  it("una clave malformada no llega a la base", async () => {
    const res = (await entraCon("cmk_no-es-una-clave")) as Response;

    expect(res.status).toBe(401);
    expect(h.enTenant).not.toHaveBeenCalled();
  });
});
