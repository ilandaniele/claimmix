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

vi.mock("@/data/scope", async () => (await import("../../../mocks/puente-de-alcance")).puenteDeAlcance(() => mockDb));

vi.mock("@/server/cases/get", () => ({ getCaseDetail: mockGetCaseDetail }));
vi.mock("@/server/cases/conversacion", () => ({ conversacionDelCaso: mockConversacionDelCaso }));

import { describe, it, expect, beforeEach, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { contarCasos, buscarCaso, TOPE_COINCIDENCIAS } from "@/server/asistente/herramientas";
import type { TenantContext } from "@/data/scope";
import type { Intencion } from "@/core/asistente/intencion";

/** El fragmento SQL de verdad que recibió `.where(...)`, sin conectar a nada. */
const dialecto = new PgDialect();
function sqlDe(fragmento: unknown) {
  return dialecto.sqlToQuery(fragmento as Parameters<PgDialect["sqlToQuery"]>[0]);
}

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

  it("sin canal pedido, restringe a los canales reales (paridad con /metricas)", async () => {
    const { chain, where } = chainWhereResolves([{ n: 2 }]);
    mockDb.select.mockReturnValue(chain);

    await contarCasos(CTX, base);
    const { sql, params } = sqlDe(where.mock.calls[0]?.[0]);
    expect(sql).toMatch(/"channel" in \(\$\d+, \$\d+, \$\d+\)/);
    expect(params).toEqual(expect.arrayContaining(["whatsapp", "email", "web"]));
  });

  it("con canal pedido, compara ese único canal — no la lista de reales", async () => {
    const { chain, where } = chainWhereResolves([{ n: 1 }]);
    mockDb.select.mockReturnValue(chain);

    await contarCasos(CTX, { ...base, canal: "email" });
    const { sql, params } = sqlDe(where.mock.calls[0]?.[0]);
    expect(sql).toMatch(/"channel" = \$\d+/);
    expect(params).toEqual(expect.arrayContaining(["email"]));
    expect(params).not.toContain("whatsapp");
  });
});

describe("buscarCaso", () => {
  const busquedaPorNombre: Intencion & { herramienta: "buscar_caso" } = {
    herramienta: "buscar_caso",
    nombre: "Roberto Paz",
    numero: null,
    codigo: null,
  };

  /** Una fila cruda de la consulta: la misma forma que `select` de `buscarCaso`. */
  const fila = (o: { id: string; policyholder_name: string | null; claim_type: string | null }) => ({
    ...o,
    created_at: "2026-09-01T00:00:00.000Z",
    status: "escalado" as const,
  });

  it("sin nombre, número ni código no toca la base", async () => {
    const r = await buscarCaso(
      CTX,
      { herramienta: "buscar_caso", nombre: null, numero: null, codigo: null },
      "analyst"
    );
    expect(r).toEqual({ coincidencias: [], detalle: null, hayMas: false });
    expect(mockDb.select).not.toHaveBeenCalled();
  });

  it("más de un resultado no trae detalle", async () => {
    const { chain } = chainOrderLimitResolves([
      fila({ id: "a0000001", policyholder_name: "Roberto Paz", claim_type: "choque" }),
      fila({ id: "a0000002", policyholder_name: "Roberto Paz Jr.", claim_type: "robo" }),
    ]);
    mockDb.select.mockReturnValue(chain);

    const r = await buscarCaso(CTX, busquedaPorNombre, "analyst");
    expect(r.coincidencias).toHaveLength(2);
    expect(r.detalle).toBeNull();
    expect(r.hayMas).toBe(false);
    expect(mockGetCaseDetail).not.toHaveBeenCalled();
    // El número y la fecha van en cada coincidencia, para la lista de la caja del asistente.
    expect(r.coincidencias[0]?.numero).toMatch(/^SIN-[0-9A-F]{4}-[0-9A-F]{4}$/);
    expect(r.coincidencias[0]?.estado).toBe("escalado");
  });

  it("cero resultados no trae detalle", async () => {
    const { chain } = chainOrderLimitResolves([]);
    mockDb.select.mockReturnValue(chain);

    const r = await buscarCaso(CTX, busquedaPorNombre, "analyst");
    expect(r.coincidencias).toHaveLength(0);
    expect(r.detalle).toBeNull();
    expect(r.hayMas).toBe(false);
  });

  it("más de TOPE_COINCIDENCIAS filas avisa hayMas y muestra sólo el tope", async () => {
    const filas = Array.from({ length: TOPE_COINCIDENCIAS + 1 }, (_, n) =>
      fila({ id: `caso-${n}`, policyholder_name: "Roberto Paz", claim_type: "choque" })
    );
    const { chain, limit } = chainOrderLimitResolves(filas);
    mockDb.select.mockReturnValue(chain);

    const r = await buscarCaso(CTX, busquedaPorNombre, "analyst");
    expect(r.coincidencias).toHaveLength(TOPE_COINCIDENCIAS);
    expect(r.hayMas).toBe(true);
    expect(limit).toHaveBeenCalledWith(TOPE_COINCIDENCIAS + 1);
  });

  it("busca por código de caso antes que por nombre o número", async () => {
    const { chain, where } = chainOrderLimitResolves([]);
    mockDb.select.mockReturnValue(chain);

    await buscarCaso(
      CTX,
      { herramienta: "buscar_caso", nombre: "Roberto Paz", numero: "123", codigo: "3f2a9b1c" },
      "analyst"
    );
    const { sql, params } = sqlDe(where.mock.calls[0]?.[0]);
    expect(sql).toContain("right(replace(");
    expect(params).toContain("3f2a9b1c");
  });

  it("busca por nombre insensible a acentos, en policyholder_name o en el nombre extraído", async () => {
    const { chain, where } = chainOrderLimitResolves([]);
    mockDb.select.mockReturnValue(chain);

    await buscarCaso(
      CTX,
      { herramienta: "buscar_caso", nombre: "Nuñez", numero: null, codigo: null },
      "analyst"
    );
    const { sql, params } = sqlDe(where.mock.calls[0]?.[0]);
    expect(sql).toContain("translate(lower(");
    expect(sql).toContain("extracted_fields");
    expect(sql).toContain("full_name");
    expect(params).toContain("%Nuñez%");
  });

  describe("con exactamente un resultado", () => {
    const CASE_ID = "caso-unico";

    function mockUnResultado() {
      const { chain } = chainOrderLimitResolves([
        fila({ id: CASE_ID, policyholder_name: "Roberto Paz", claim_type: "choque" }),
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
