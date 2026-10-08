/**
 * La bandeja y los tipos de siniestro propios de la aseguradora (B26).
 *
 * `?type=` se valida contra los ramos del código y, si la URL pide uno que no
 * es del código, contra los del inquilino. Un tipo que no existe se descarta
 * como cualquier valor desconocido, y los ramos viajan al cliente con el nombre
 * ya en el idioma de la cuenta.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";

const m = vi.hoisted(() => ({
  listCases: vi.fn(),
  listarTablero: vi.fn(),
  cargarRamos: vi.fn(),
  locale: vi.fn(),
  rol: vi.fn(),
}));

vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({
  getSessionContext: vi.fn(async () => ({ user: { id: "u1" } })),
}));
vi.mock("@/lib/auth/user-row", () => ({
  getUserRow: vi.fn(async () => ({ id: "u1", tenant_id: "t1", role: m.rol() })),
}));
vi.mock("@/server/i18n/idioma-de-la-cuenta", () => ({ getAccountLocale: m.locale }));
vi.mock("@/server/cases/list", () => ({
  buildCaseFilters: vi.fn(),
  contarPorEstado: vi.fn(async () => []),
  desdeDePeriodo: vi.fn(),
  listCases: m.listCases,
  listarTablero: m.listarTablero,
}));
vi.mock("@/server/cases/ramos-del-inquilino", () => ({ cargarRamosDelInquilino: m.cargarRamos }));
vi.mock("@/server/intake/scenarios", () => ({ OPCIONES_DE_ESCENARIO: [] }));
vi.mock("@/app/(app)/bandeja/DashboardClient", () => ({ DashboardClient: () => null }));

import BandejaPage from "@/app/(app)/bandeja/page";
import { DashboardClient } from "@/app/(app)/bandeja/DashboardClient";

const RAMO = {
  clave: "flota_camiones",
  nombre_es: "Flota de camiones",
  nombre_en: "Truck fleet",
  documentos: [],
  datos: [],
};

const TOTALES = { procesando: 43, esperando: 0, confirmacion_pendiente: 0, escalado: 2, listo: 0, cerrado: 0 };

/** Corre la página de servidor y devuelve las props que le pasa a `DashboardClient`. */
async function propsDelTablero(params: Record<string, string | string[]>) {
  const raiz = BandejaPage({ searchParams: Promise.resolve(params) }) as ReactElement<never>;
  const arbol = await (raiz.type as unknown as (p: unknown) => Promise<ReactElement>)(raiz.props);
  const buscar = (nodo: unknown): Record<string, unknown> | null => {
    if (!nodo || typeof nodo !== "object") return null;
    const el = nodo as { type?: unknown; props?: { children?: unknown } };
    if (el.type === DashboardClient) return el.props as Record<string, unknown>;
    const hijos = el.props?.children;
    for (const h of Array.isArray(hijos) ? hijos : [hijos]) {
      const r = buscar(h);
      if (r) return r;
    }
    return null;
  };
  return buscar(arbol);
}

describe("la bandeja con tipos propios", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.locale.mockResolvedValue("es-AR");
    m.listCases.mockResolvedValue({ data: [], meta: { total: 0, page: 1, per_page: 20, pages: 0 } });
    m.listarTablero.mockResolvedValue({
      data: [],
      meta: { total: 0, page: 1, per_page: 20, pages: 1 },
      totales: TOTALES,
    });
    m.cargarRamos.mockResolvedValue([RAMO]);
    m.rol.mockReturnValue("owner");
  });

  it("acepta un tipo propio del inquilino en la URL", async () => {
    await propsDelTablero({ type: "flota_camiones" });

    expect(m.listCases.mock.calls[0]?.[1]).toMatchObject({ type: ["flota_camiones"] });
  });

  it("descarta un tipo que ni el código ni el inquilino conocen", async () => {
    await propsDelTablero({ type: ["flota_camiones", "meteorito"] });

    expect(m.listCases.mock.calls[0]?.[1]).toMatchObject({ type: ["flota_camiones"] });
  });

  it("un tipo nativo no espera por los ramos para validarse", async () => {
    let resuelve: (r: unknown) => void = () => undefined;
    m.cargarRamos.mockReturnValue(new Promise((r) => (resuelve = r)));

    const corriendo = propsDelTablero({ type: "consorcio" });
    await vi.waitFor(() => expect(m.listCases).toHaveBeenCalled());
    resuelve([RAMO]);
    await corriendo;

    expect(m.listCases.mock.calls[0]?.[1]).toMatchObject({ type: ["consorcio"] });
  });

  it("le pasa los tipos propios al tablero con el nombre en el idioma de la cuenta", async () => {
    expect((await propsDelTablero({}))?.["tiposPropios"]).toEqual([
      { clave: "flota_camiones", nombre: "Flota de camiones" },
    ]);

    m.locale.mockResolvedValue("en-US");
    expect((await propsDelTablero({}))?.["tiposPropios"]).toEqual([
      { clave: "flota_camiones", nombre: "Truck fleet" },
    ]);
  });

  it("una fila con la clave de un ramo del código no es un tipo propio: el filtro ya lo tiene", async () => {
    m.cargarRamos.mockResolvedValue([{ ...RAMO, clave: "consorcio", nombre_es: "Edificio", nombre_en: "Building" }, RAMO]);

    expect((await propsDelTablero({}))?.["tiposPropios"]).toEqual([
      { clave: "flota_camiones", nombre: "Flota de camiones" },
    ]);
  });

  it("en la vista de descartes el remitente sale en claro sólo para quien ve el padrón", async () => {
    const fila = { id: "c-1", asunto: "Promo", remitente: "ventas@example.com" };
    m.listCases.mockResolvedValue({ data: [fila], meta: { total: 1, page: 1, per_page: 20, pages: 1 } });

    const filas = async () => ((await propsDelTablero({}))?.["initialData"] as { data: (typeof fila)[] }).data;

    expect((await filas())[0]?.remitente).toBe("ventas@example.com");

    m.rol.mockReturnValue("viewer");
    expect((await filas())[0]?.remitente).toBe("[oculto]");
  });

  it("con vista=tablero pide la consulta del tablero y le pasa los totales de las columnas", async () => {
    const props = await propsDelTablero({ vista: "tablero", q: "perez", status: "escalado" });

    expect(m.listCases).not.toHaveBeenCalled();
    expect(m.listarTablero.mock.calls[0]?.[1]).toMatchObject({ q: "perez", status: ["escalado"] });
    expect(props?.["totalesDelTablero"]).toEqual(TOTALES);
  });

  it("en el tablero las tarjetas no arrastran los totales dentro de initialData", async () => {
    const props = await propsDelTablero({ vista: "tablero" });

    expect(props?.["initialData"]).not.toHaveProperty("totales");
  });

  it("en el tablero el remitente también sale tapado para quien no ve el padrón", async () => {
    const fila = { id: "c-1", remitente: "ventas@example.com" };
    m.listarTablero.mockResolvedValue({
      data: [fila],
      meta: { total: 1, page: 1, per_page: 20, pages: 1 },
      totales: TOTALES,
    });
    m.rol.mockReturnValue("viewer");

    const filas = ((await propsDelTablero({ vista: "tablero" }))?.["initialData"] as { data: (typeof fila)[] }).data;
    expect(filas[0]?.remitente).toBe("[oculto]");
  });

  it("sin vista, o con una que no existe, sigue la lista y no hay totales de tablero", async () => {
    for (const vista of [undefined, "kanban"]) {
      m.listCases.mockClear();
      const props = await propsDelTablero(vista ? { vista } : {});
      expect(m.listCases).toHaveBeenCalledTimes(1);
      expect(m.listarTablero).not.toHaveBeenCalled();
      expect(props?.["totalesDelTablero"]).toBeUndefined();
    }
  });
});
