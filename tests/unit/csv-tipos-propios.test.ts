/**
 * `GET /api/cases/export.csv` con un tipo de siniestro propio de la aseguradora (B26).
 *
 * Un tipo propio no está en el diccionario del código: sin su nombre el archivo
 * diría la clave de la base (`flota_camiones`). Los ramos se leen sólo si el
 * archivo trae alguno, así que un CSV de tipos nativos no paga la consulta.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

const { mockEntrar, mockListCasesForExport, mockCargarRamos } = vi.hoisted(() => ({
  mockEntrar: vi.fn(),
  mockListCasesForExport: vi.fn(),
  mockCargarRamos: vi.fn(),
}));

vi.mock("@/lib/api/entrada", () => ({ entrar: mockEntrar }));
vi.mock("@/server/cases/list", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/cases/list")>()),
  listCasesForExport: mockListCasesForExport,
}));
vi.mock("@/server/cases/ramos-del-inquilino", () => ({ cargarRamosDelInquilino: mockCargarRamos }));
vi.mock("@/lib/i18n/locale", () => ({
  resolveAccountLocale: vi.fn().mockResolvedValue("es-AR"),
}));

import { GET } from "@/app/api/cases/export.csv/route";

const TENANT_ID = "10000000-0000-0000-0000-000000000001";
const USER_ID = "20000000-0000-0000-0000-000000000001";

const fila = (claim_type: string) => ({
  id: "30000000-0000-0000-0000-000000000003",
  policyholder_name: "Ana Pérez",
  policy_number: "POL-1",
  claim_type,
  status: "recibido",
  confidence_min: null,
  created_at: "2026-09-01T15:00:00.000Z",
  assigned_to: null,
});

describe("el CSV con tipos propios", () => {
  beforeEach(() => {
    mockEntrar.mockResolvedValue({
      ctx: { user: { id: USER_ID }, userRow: { id: USER_ID, tenant_id: TENANT_ID, role: "admin", locale: "es-AR" } },
      rl: { allowed: true, remaining: 10, retryAfterSeconds: 0 },
    });
    mockCargarRamos.mockResolvedValue([
      {
        clave: "flota_camiones",
        nombre_es: "Flota de camiones",
        nombre_en: "Truck fleet",
        documentos: [],
        datos: [],
      },
    ]);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("escribe el nombre de la aseguradora y no la clave", async () => {
    mockListCasesForExport.mockResolvedValue([fila("flota_camiones")]);

    const res = await GET(new NextRequest("http://localhost/api/cases/export.csv"));
    const csv = await res.text();

    expect(csv).toContain("Flota de camiones");
    expect(csv).not.toContain("flota_camiones");
    expect(mockCargarRamos).toHaveBeenCalledWith(TENANT_ID);
  });

  it("un tipo propio que la aseguradora ya borró sale con la clave legible, sin romper", async () => {
    mockListCasesForExport.mockResolvedValue([fila("ramo_borrado")]);
    mockCargarRamos.mockResolvedValue([]);

    const res = await GET(new NextRequest("http://localhost/api/cases/export.csv"));

    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Ramo borrado");
  });

  it("un ramo propio con clave «constructor» sale con su nombre, no con la función de Object", async () => {
    mockListCasesForExport.mockResolvedValue([fila("constructor")]);
    mockCargarRamos.mockResolvedValue([
      { clave: "constructor", nombre_es: "Obras en construcción", nombre_en: "Works", documentos: [], datos: [] },
    ]);

    const res = await GET(new NextRequest("http://localhost/api/cases/export.csv"));
    const csv = await res.text();

    expect(csv).toContain("Obras en construcción");
    expect(csv).not.toContain("native code");
  });

  it("un archivo de tipos nativos no lee los ramos del inquilino", async () => {
    mockListCasesForExport.mockResolvedValue([fila("consorcio")]);

    const res = await GET(new NextRequest("http://localhost/api/cases/export.csv"));

    expect(await res.text()).toContain("Consorcio");
    expect(mockCargarRamos).not.toHaveBeenCalled();
  });
});
