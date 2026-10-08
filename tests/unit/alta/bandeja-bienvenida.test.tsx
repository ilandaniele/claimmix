/**
 * El aviso de bienvenida de la bandeja (`?bienvenida=1`), que deja /alta al
 * crear el espacio.
 *
 * Es sólo un texto: no consulta nada. Los días salen de ALTA_PRUEBA_DIAS y el
 * idioma, de la cuenta.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";

const m = vi.hoisted(() => ({
  listCases: vi.fn(),
  contarPorEstado: vi.fn(),
  cargarRamos: vi.fn(),
  locale: vi.fn(),
}));

vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({
  getSessionContext: vi.fn(async () => ({ user: { id: "u1" } })),
}));
vi.mock("@/lib/auth/user-row", () => ({
  getUserRow: vi.fn(async () => ({ id: "u1", tenant_id: "t1" })),
}));
vi.mock("@/server/i18n/idioma-de-la-cuenta", () => ({ getAccountLocale: m.locale }));
vi.mock("@/server/cases/list", () => ({
  buildCaseFilters: vi.fn(),
  contarPorEstado: m.contarPorEstado,
  desdeDePeriodo: vi.fn(),
  listCases: m.listCases,
}));
vi.mock("@/server/cases/ramos-del-inquilino", () => ({ cargarRamosDelInquilino: m.cargarRamos }));
vi.mock("@/server/intake/scenarios", () => ({ OPCIONES_DE_ESCENARIO: [] }));
vi.mock("@/app/(app)/bandeja/DashboardClient", () => ({ DashboardClient: () => null }));

import BandejaPage from "@/app/(app)/bandeja/page";

/** Todo el texto que la página de servidor pone en su árbol, sin renderizar los componentes hijos. */
async function textoDeLaPagina(params: Record<string, string>): Promise<string> {
  const raiz = BandejaPage({ searchParams: Promise.resolve(params) }) as ReactElement<never>;
  const arbol = await (raiz.type as unknown as (p: unknown) => Promise<ReactElement>)(raiz.props);
  const juntar = (nodo: unknown): string[] => {
    if (typeof nodo === "string") return [nodo];
    if (!nodo || typeof nodo !== "object") return [];
    const hijos = (nodo as { props?: { children?: unknown } }).props?.children;
    return (Array.isArray(hijos) ? hijos : [hijos]).flatMap(juntar);
  };
  return juntar(arbol).join(" ");
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.ALTA_PRUEBA_DIAS;
  m.locale.mockResolvedValue("es-AR");
  m.listCases.mockResolvedValue({ cases: [], total: 0 });
  m.contarPorEstado.mockResolvedValue([]);
  m.cargarRamos.mockResolvedValue([]);
});

describe("la bandeja con ?bienvenida=1", () => {
  it("avisa que el espacio está listo, con los 30 días de prueba y el WhatsApp pendiente", async () => {
    const texto = await textoDeLaPagina({ bienvenida: "1" });

    expect(texto).toContain(
      "Tu espacio está listo. La prueba dura 30 días. Tu WhatsApp quedó pendiente: lo conectamos nosotros y te avisamos."
    );
  });

  it("los días salen de ALTA_PRUEBA_DIAS", async () => {
    process.env.ALTA_PRUEBA_DIAS = "14";

    expect(await textoDeLaPagina({ bienvenida: "1" })).toContain("La prueba dura 14 días.");
  });

  it("sale en el idioma de la cuenta", async () => {
    m.locale.mockResolvedValue("en-US");

    expect(await textoDeLaPagina({ bienvenida: "1" })).toContain("Your workspace is ready. The trial lasts 30 days.");
  });

  it("no suma ninguna consulta a la base", async () => {
    await textoDeLaPagina({});
    const sin = [m.listCases.mock.calls.length, m.contarPorEstado.mock.calls.length, m.cargarRamos.mock.calls.length];
    vi.clearAllMocks();
    m.listCases.mockResolvedValue({ cases: [], total: 0 });
    m.contarPorEstado.mockResolvedValue([]);
    m.cargarRamos.mockResolvedValue([]);
    m.locale.mockResolvedValue("es-AR");

    await textoDeLaPagina({ bienvenida: "1" });

    expect([m.listCases.mock.calls.length, m.contarPorEstado.mock.calls.length, m.cargarRamos.mock.calls.length]).toEqual(
      sin
    );
  });

  it.each<Record<string, string>>([{}, { bienvenida: "0" }, { bienvenida: "true" }, { bienvenida: "" }])(
    "con %j no muestra el aviso",
    async (params) => {
      expect(await textoDeLaPagina(params)).not.toContain("Tu espacio está listo");
    }
  );
});
