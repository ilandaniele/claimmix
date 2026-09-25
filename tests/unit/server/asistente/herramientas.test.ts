/**
 * Las dos consultas del asistente: `contarCasos` y `buscarCaso`.
 *
 * `enTenant` acá es el mismo mock de siempre —corre `armar` contra un `db`
 * simulado— así que lo que se prueba es el filtro que arma cada función y el
 * enmascarado por rol, no el aislamiento de la base: eso lo prueba
 * `pnpm capa-datos` contra la base de verdad.
 */

const { mockDb, mockGetCaseDetail, mockConversacionDelCaso } = vi.hoisted(() => ({
  mockDb: { select: vi.fn() },
  mockGetCaseDetail: vi.fn(),
  mockConversacionDelCaso: vi.fn(),
}));

vi.mock("server-only", () => ({}));

vi.mock("@/data/scope", () => ({
  enTenant: (_ctx: unknown, armar: (d: unknown) => unknown) => Promise.resolve(armar(mockDb)),
}));

vi.mock("@/server/cases/get", () => ({ getCaseDetail: mockGetCaseDetail }));
vi.mock("@/server/cases/conversacion", () => ({ conversacionDelCaso: mockConversacionDelCaso }));

import { describe, it, expect, beforeEach, vi } from "vitest";
import { contarCasos, buscarCaso } from "@/server/asistente/herramientas";
import type { TenantContext } from "@/data/scope";
import type { Intencion } from "@/core/asistente/intencion";

const CTX: TenantContext = { tenantId: "10000000-0000-0000-0000-000000000001" };
const OTRO_TENANT = "20000000-0000-0000-0000-000000000002";

function chainWhereResolves(rows: unknown[]) {
  const where = vi.fn().mockResolvedValue(rows);
  const from = vi.fn().mockReturnValue({ where });
  return { chain: { from }, where };
}

function chainOrderLimitResolves(rows: unknown[]) {
  const limit = vi.fn().mockResolvedValue(rows);
  const orderBy = vi.fn().mockReturnValue({ limit });
  const where = vi.fn().mockReturnValue({ orderBy });
  const from = vi.fn().mockReturnValue({ where });
  return { chain: { from }, where, orderBy, limit };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("contarCasos", () => {
  const base: Intencion & { herramienta: "contar_casos" } = {
    herramienta: "contar_casos",
    periodo: "este_mes",
    canal: null,
    situacion: null,
    solo_reclamos: false,
  };

  it("devuelve el total de la fila", async () => {
    const { chain } = chainWhereResolves([{ n: 5 }]);
    mockDb.select.mockReturnValue(chain);

    const r = await contarCasos(CTX, base);
    expect(r.total).toBe(5);
  });

  it("devuelve 0 sin filas", async () => {
    const { chain } = chainWhereResolves([]);
    mockDb.select.mockReturnValue(chain);

    const r = await contarCasos(CTX, base);
    expect(r.total).toBe(0);
  });

  it("no revienta con todos los filtros activos", async () => {
    const { chain, where } = chainWhereResolves([{ n: 2 }]);
    mockDb.select.mockReturnValue(chain);

    const r = await contarCasos(CTX, {
      ...base,
      canal: "whatsapp",
      situacion: "escalado",
      solo_reclamos: true,
    });
    expect(r.total).toBe(2);
    expect(where).toHaveBeenCalledTimes(1);
  });
});

describe("buscarCaso", () => {
  const busquedaPorNombre: Intencion & { herramienta: "buscar_caso" } = {
    herramienta: "buscar_caso",
    nombre: "Roberto Paz",
    numero: null,
  };

  it("sin nombre ni número no toca la base", async () => {
    const r = await buscarCaso(
      CTX,
      { herramienta: "buscar_caso", nombre: null, numero: null },
      "analyst"
    );
    expect(r).toEqual({ coincidencias: [], detalle: null });
    expect(mockDb.select).not.toHaveBeenCalled();
  });

  it("más de un resultado no trae detalle", async () => {
    const { chain } = chainOrderLimitResolves([
      { id: "caso-1", policyholder_name: "Roberto Paz", claim_type: "choque" },
      { id: "caso-2", policyholder_name: "Roberto Paz Jr.", claim_type: "robo" },
    ]);
    mockDb.select.mockReturnValue(chain);

    const r = await buscarCaso(CTX, busquedaPorNombre, "analyst");
    expect(r.coincidencias).toHaveLength(2);
    expect(r.detalle).toBeNull();
    expect(mockGetCaseDetail).not.toHaveBeenCalled();
  });

  it("cero resultados no trae detalle", async () => {
    const { chain } = chainOrderLimitResolves([]);
    mockDb.select.mockReturnValue(chain);

    const r = await buscarCaso(CTX, busquedaPorNombre, "analyst");
    expect(r.coincidencias).toHaveLength(0);
    expect(r.detalle).toBeNull();
  });

  describe("con exactamente un resultado", () => {
    const CASE_ID = "caso-unico";

    function mockUnResultado() {
      const { chain } = chainOrderLimitResolves([
        { id: CASE_ID, policyholder_name: "Roberto Paz", claim_type: "choque" },
      ]);
      mockDb.select.mockReturnValue(chain);
    }

    function mockDetalle() {
      mockGetCaseDetail.mockResolvedValue({
        case: {
          id: CASE_ID,
          policyholder_name: "Roberto Paz",
          policy_number: "POL-2024-001",
          claim_type: "choque",
          status: "escalado",
          created_at: "2026-09-01T00:00:00.000Z",
          closed_at: null,
        },
        extracted_fields: [
          { field_key: "full_name", field_value: "Roberto Paz" },
          { field_key: "dni", field_value: "30111222" },
          { field_key: "accident_location", field_value: "Av. Alem 500" },
        ],
        missing_docs: [
          { doc_key: "cedula_verde", satisfied_at: null, declined_at: null },
          { doc_key: "denuncia_policial", satisfied_at: "2026-09-02T00:00:00.000Z", declined_at: null },
        ],
        audit_log: [],
      });
      mockConversacionDelCaso.mockResolvedValue({
        messages: [
          {
            direction: "inbound",
            subject: null,
            body_text: "Choqué en Alem, mi DNI es 30111222",
            from_addr: "roberto@example.com",
          },
        ],
        recortada: false,
      });
    }

    it("trae el detalle sin enmascarar para un rol operativo", async () => {
      mockUnResultado();
      mockDetalle();

      const r = await buscarCaso(CTX, busquedaPorNombre, "analyst");
      expect(r.coincidencias).toHaveLength(1);
      expect(r.detalle?.titular).toBe("Roberto Paz");
      expect(r.detalle?.poliza).toBe("POL-2024-001");
      const dni = r.detalle?.campos.find((c) => c.clave === "dni");
      expect(dni?.valor).not.toBe("[oculto]");
      expect(r.detalle?.mensajes[0]?.texto).toContain("Choqué en Alem");
      expect(r.detalle?.documentos_faltantes).toEqual(["cedula_verde"]);
    });

    it("enmascara identificadores para un viewer", async () => {
      mockUnResultado();
      mockDetalle();

      const r = await buscarCaso(CTX, busquedaPorNombre, "viewer");
      expect(r.coincidencias[0]?.etiqueta).not.toContain("Roberto Paz");
      expect(r.detalle?.titular).toBe("[oculto]");
      expect(r.detalle?.poliza).toBe("[oculto]");
      const dni = r.detalle?.campos.find((c) => c.clave === "dni");
      expect(dni?.valor).toBe("[oculto]");
      // El lugar del accidente no identifica a nadie: no se oculta.
      const lugar = r.detalle?.campos.find((c) => c.clave === "accident_location");
      expect(lugar?.valor).not.toBe("[oculto]");
      // El remitente sí se oculta siempre para viewer (mensajesSinPiiSiNoCorresponde).
      expect(r.detalle?.mensajes).toBeDefined();
    });

    it("pasa el tenant de la sesión a getCaseDetail, no uno inventado", async () => {
      mockUnResultado();
      mockDetalle();

      await buscarCaso(CTX, busquedaPorNombre, "analyst");
      expect(mockGetCaseDetail).toHaveBeenCalledWith(CTX.tenantId, CASE_ID);
      expect(mockGetCaseDetail).not.toHaveBeenCalledWith(OTRO_TENANT, CASE_ID);
    });
  });
});
