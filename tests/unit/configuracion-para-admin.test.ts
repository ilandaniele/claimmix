// @vitest-environment node
/**
 * Lo que /configuracion lee para un admin. Nunca rechaza: antes de B5 la lista
 * de avisos se leía sola y un error daba una lista vacía, no la página caída.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { enTenantVarias, listaDelTenant } = vi.hoisted(() => ({
  enTenantVarias: vi.fn(),
  listaDelTenant: vi.fn(),
}));

vi.mock("@/data/scope", () => ({ enTenantVarias }));
vi.mock("@/server/notify/specialist-alert", () => ({ consultaDeLaLista: vi.fn(), listaDelTenant }));
vi.mock("@/lib/observability/logger", () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

import { paraAdmin } from "@/app/(app)/configuracion/para-admin";

const TENANT = "10000000-0000-0000-0000-000000000001";

beforeEach(() => {
  vi.clearAllMocks();
  listaDelTenant.mockResolvedValue(["ana@aseguradora.com.ar"]);
});

describe("paraAdmin", () => {
  it("lee la lista y la config en un solo lote", async () => {
    const vista = { webhook_url: "https://core.aseguradora.com.ar/hook", enabled: true };
    enTenantVarias.mockResolvedValueOnce([[{ emails: ["a@b.com.ar"] }], [vista]]);

    await expect(paraAdmin(TENANT)).resolves.toEqual({ alertas: ["a@b.com.ar"], core: vista, migracionPendiente: false });
    expect(listaDelTenant).not.toHaveBeenCalled();
  });

  it("sin la 0036: la lista sola y el aviso de la migración", async () => {
    enTenantVarias.mockRejectedValueOnce(Object.assign(new Error("relation does not exist"), { code: "42P01" }));

    await expect(paraAdmin(TENANT)).resolves.toEqual({
      alertas: ["ana@aseguradora.com.ar"],
      core: null,
      migracionPendiente: true,
    });
  });

  it("otro error de la base no tumba la página: la lista sola y sin sección del core", async () => {
    enTenantVarias.mockRejectedValueOnce(Object.assign(new Error("terminating connection"), { code: "57P01" }));

    const admin = await paraAdmin(TENANT);

    expect(admin).toEqual({ alertas: ["ana@aseguradora.com.ar"], migracionPendiente: false });
    expect(admin.core).toBeUndefined();
  });
});
