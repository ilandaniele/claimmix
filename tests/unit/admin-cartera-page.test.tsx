/**
 * /admin/cartera: los cinco números por espacio (IA de la prueba, base, peso, costo por denuncia).
 *
 * La página pinta tal cual lo que devuelve `listTenantSummaries` (la consulta tiene su test en
 * `billing/cartera-consumo.test.ts`); lo que no existe se muestra como «—», nunca como un cero.
 */

import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  operador: vi.fn(),
  locale: vi.fn(),
  resumen: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error("REDIRECT:" + url);
  },
}));
vi.mock("@/lib/auth/require-operator", () => ({ requireOperator: h.operador }));
vi.mock("@/server/i18n/idioma-de-la-cuenta", () => ({ getAccountLocale: h.locale }));
vi.mock("@/server/billing/tenant-summary", () => ({ listTenantSummaries: h.resumen }));

import CarteraPage from "@/app/(app)/admin/cartera/page";
import { enUSServidor } from "@/lib/i18n/en-US.servidor";
import { esARServidor } from "@/lib/i18n/es-AR.servidor";
import { formatUsd } from "@/lib/utils";
import type { TenantSummary } from "@/server/billing/tenant-summary";

const es = esARServidor;
const en = enUSServidor;

const COL = { prueba: 6, base: 7, mb: 8, costoMedio: 9 } as const;

const fila = (cambios: Partial<TenantSummary> = {}): TenantSummary => ({
  id: "22222222-2222-4222-8222-222222222222",
  name: "Seguros Fake",
  plan: "piloto",
  plan_label: "Piloto",
  billing_status: "trial",
  contact_email: "ana@example.com",
  trial_ends_at: "2026-11-15T10:00:00.000Z",
  created_at: "2026-10-01T10:00:00.000Z",
  monthly_fee_usd: 0,
  included_claims: 50,
  overage_price_usd: 0,
  billable_claims: 4,
  total_cases: 4,
  invoice_total_usd: 0,
  ai_cost_usd: 0.4,
  margin_pct: null,
  autoalta: true,
  base_estado: "lista",
  base_mb: 12,
  costo_medio_usd: 0.1,
  ...cambios,
});

async function pintar(filas: TenantSummary[], locale: "es-AR" | "en-US" = "es-AR") {
  h.locale.mockResolvedValue(locale);
  h.resumen.mockResolvedValue({ month: "2026-10", tenants: filas });
  return render(await CarteraPage({ searchParams: Promise.resolve({}) }));
}

/** El texto de una celda de la fila del cliente, por posición de columna. */
function celda(nombre: string, columna: number): string {
  const tr = screen.getByText(nombre).closest("tr") as HTMLTableRowElement;
  return (within(tr).getAllByRole("cell")[columna] as HTMLElement).textContent ?? "";
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("AI_PRUEBA_MONTHLY_USD_POR_INQUILINO", "");
  h.operador.mockResolvedValue({ userRow: { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" } });
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

describe("las columnas", () => {
  it("son once, con las cuatro nuevas entre el costo de IA y el margen", async () => {
    await pintar([fila()]);

    const cabeceras = screen.getAllByRole("columnheader").map((th) => th.textContent);
    expect(cabeceras).toHaveLength(11);
    expect(cabeceras.slice(5, 11)).toEqual([
      es["cartera.col.costoIa"],
      es["cartera.col.prueba"],
      es["cartera.col.base"],
      es["cartera.col.mb"],
      es["cartera.col.costoMedio"],
      es["cartera.col.margen"],
    ]);
  });

  it("sin filas, la celda vacía ocupa las once", async () => {
    await pintar([]);

    const vacia = screen.getByText(es["cartera.empty"]);
    expect(vacia.getAttribute("colspan")).toBe("11");
  });
});

describe("la prueba", () => {
  it("una fila de alta automática en prueba muestra lo gastado contra el techo", async () => {
    await pintar([fila({ ai_cost_usd: 0.4 })]);

    expect(celda("Seguros Fake", COL.prueba)).toBe(
      es["cartera.prueba.gasto"].replace("{gasto}", formatUsd(0.4)).replace("{techo}", formatUsd(1)),
    );
  });

  it("el techo es el del entorno", async () => {
    vi.stubEnv("AI_PRUEBA_MONTHLY_USD_POR_INQUILINO", "5");
    await pintar([fila({ ai_cost_usd: 0.4 })]);

    expect(celda("Seguros Fake", COL.prueba)).toContain(formatUsd(5));
  });

  it("una fila que no es de alta automática muestra «—»", async () => {
    await pintar([fila({ autoalta: false })]);

    expect(celda("Seguros Fake", COL.prueba)).toBe("—");
  });

  it("una fila de alta automática que ya no está en prueba muestra «—»", async () => {
    await pintar([fila({ billing_status: "active" })]);

    expect(celda("Seguros Fake", COL.prueba)).toBe("—");
  });

  it("conviven las dos filas en la misma tabla", async () => {
    await pintar([fila(), fila({ id: "33333333-3333-4333-8333-333333333333", name: "Seguros Viejo", autoalta: false })]);

    expect(celda("Seguros Fake", COL.prueba)).not.toBe("—");
    expect(celda("Seguros Viejo", COL.prueba)).toBe("—");
  });
});

describe("la base", () => {
  it("lista se muestra «lista» en español y «ready» en inglés", async () => {
    await pintar([fila({ base_estado: "lista" })]);
    expect(celda("Seguros Fake", COL.base)).toBe(es["cartera.base.lista"]);
    expect(es["cartera.base.lista"]).toBe("lista");

    cleanup();
    await pintar([fila({ base_estado: "lista" })], "en-US");
    expect(celda("Seguros Fake", COL.base)).toBe(en["cartera.base.lista"]);
    expect(en["cartera.base.lista"]).toBe("ready");
  });

  it.each([
    ["creando", "cartera.base.creando"],
    ["fallida", "cartera.base.fallida"],
    ["borrada", "cartera.base.borrada"],
  ] as const)("%s tiene su texto", async (estado, clave) => {
    await pintar([fila({ base_estado: estado })]);

    expect(celda("Seguros Fake", COL.base)).toBe(es[clave]);
  });

  it("sin base muestra «—»", async () => {
    await pintar([fila({ base_estado: null })]);

    expect(celda("Seguros Fake", COL.base)).toBe("—");
  });
});

describe("el peso de la base", () => {
  it("12 MB muestra 12", async () => {
    await pintar([fila({ base_mb: 12 })]);

    expect(celda("Seguros Fake", COL.mb)).toBe("12");
  });

  it("0 MB muestra 0 y no un guion", async () => {
    await pintar([fila({ base_mb: 0 })]);

    expect(celda("Seguros Fake", COL.mb)).toBe("0");
  });

  it("sin dato muestra «—»", async () => {
    await pintar([fila({ base_mb: null })]);

    expect(celda("Seguros Fake", COL.mb)).toBe("—");
  });
});

describe("el costo por denuncia", () => {
  it("sale con hasta cuatro decimales", async () => {
    await pintar([fila({ costo_medio_usd: 0.7512 })]);

    expect(celda("Seguros Fake", COL.costoMedio)).toBe(formatUsd(0.7512, 4));
    expect(celda("Seguros Fake", COL.costoMedio)).toContain("0,7512");
  });

  it("0.75 sale con el formato de cuatro decimales de formatUsd", async () => {
    await pintar([fila({ costo_medio_usd: 0.75 })]);

    expect(celda("Seguros Fake", COL.costoMedio)).toBe(formatUsd(0.75, 4));
  });

  it("sin denuncias muestra «—»", async () => {
    await pintar([fila({ costo_medio_usd: null })]);

    expect(celda("Seguros Fake", COL.costoMedio)).toBe("—");
  });
});
