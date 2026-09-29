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
vi.mock("@/server/notify/specialist-alert", () => ({ listaDelTenant }));
vi.mock("@/lib/observability/logger", () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

import { drizzle } from "drizzle-orm/pg-proxy";
import { paraAdmin } from "@/app/(app)/configuracion/para-admin";

const TENANT = "10000000-0000-0000-0000-000000000001";
const VISTA = { webhook_url: "https://core.aseguradora.com.ar/hook", enabled: true };
const falta = (code: string) => Object.assign(new Error("no existe"), { code });

/** El SQL de la lectura del tenant que armó la llamada `n` al lote. */
function lecturaDelTenant(n: number): string {
  const armar = enTenantVarias.mock.calls[n][1] as (db: unknown) => Array<{ toSQL: () => { sql: string } }>;
  return armar(drizzle(async () => ({ rows: [] })))[0].toSQL().sql;
}

beforeEach(() => {
  vi.clearAllMocks();
  listaDelTenant.mockResolvedValue(["ana@aseguradora.com.ar"]);
});

describe("paraAdmin", () => {
  it("lee avisos, recordatorios y montos de una sola fila, y la config, en un solo lote", async () => {
    const montos = { choque: { high: { minimo: 1, maximo: 2 } } };
    enTenantVarias.mockResolvedValueOnce([[{ emails: ["a@b.com.ar"], horas: [48, 120], montos }], [VISTA]]);

    await expect(paraAdmin(TENANT)).resolves.toEqual({
      alertas: ["a@b.com.ar"],
      recordatorioHoras: [48, 120],
      montos,
      core: VISTA,
      migracionPendiente: false,
    });
    expect(enTenantVarias).toHaveBeenCalledOnce();
    expect(lecturaDelTenant(0)).toContain(
      'select "specialist_alert_emails", "recordatorio_horas", "rangos_de_monto" from "tenants"'
    );
    expect(listaDelTenant).not.toHaveBeenCalled();
  });

  it("sin la 0040: avisos y recordatorios se ven, los montos no", async () => {
    enTenantVarias
      .mockRejectedValueOnce(falta("42703"))
      .mockResolvedValueOnce([[{ emails: ["a@b.com.ar"], horas: [48] }], [VISTA]]);

    const admin = await paraAdmin(TENANT);

    expect(admin).toMatchObject({ alertas: ["a@b.com.ar"], recordatorioHoras: [48], core: VISTA });
    expect(admin.montos).toBeUndefined();
    expect(lecturaDelTenant(1)).toContain("recordatorio_horas");
    expect(lecturaDelTenant(1)).not.toContain("rangos_de_monto");
  });

  // Antes el 42703 de la columna nueva se leía como «falta la 0036» y escondía
  // la entrega al core, que sí estaba.
  it("sin la 0039: la config del core se ve y los recordatorios no", async () => {
    enTenantVarias
      .mockRejectedValueOnce(falta("42703"))
      .mockRejectedValueOnce(falta("42703"))
      .mockResolvedValueOnce([[{ emails: ["a@b.com.ar"] }], [VISTA]]);

    const admin = await paraAdmin(TENANT);

    expect(admin).toMatchObject({ alertas: ["a@b.com.ar"], core: VISTA, migracionPendiente: false });
    expect(admin.recordatorioHoras).toBeUndefined();
    expect(lecturaDelTenant(2)).not.toContain("recordatorio_horas");
  });

  it("sin la 0036: la lista sola y el aviso de la migración", async () => {
    enTenantVarias
      .mockRejectedValueOnce(falta("42P01"))
      .mockRejectedValueOnce(falta("42P01"))
      .mockRejectedValueOnce(falta("42P01"));

    await expect(paraAdmin(TENANT)).resolves.toEqual({
      alertas: ["ana@aseguradora.com.ar"],
      core: null,
      migracionPendiente: true,
    });
  });

  it("otro error de la base no tumba la página: la lista sola y sin sección del core", async () => {
    enTenantVarias.mockRejectedValueOnce(falta("57P01"));

    const admin = await paraAdmin(TENANT);

    expect(admin).toEqual({ alertas: ["ana@aseguradora.com.ar"], migracionPendiente: false });
    expect(admin.core).toBeUndefined();
    expect(enTenantVarias).toHaveBeenCalledOnce();
  });
});
