/**
 * El sembrador de documentos pendientes es una sola sentencia: INSERT ... SELECT
 * con ON CONFLICT DO NOTHING. Se compila con drizzle de verdad (pg-proxy) y se
 * lee el SQL que saldría: qué documentos siembra y de dónde los saca.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { consultas, mockLogError, falla } = vi.hoisted(() => ({
  consultas: [] as { sql: string; params: unknown[] }[],
  mockLogError: vi.fn(),
  // `soloLaPrimera`: la primera sentencia tira con `codigo` y las siguientes andan.
  falla: { activa: false, soloLaPrimera: false, codigo: undefined as string | undefined },
}));

vi.mock("@/data/scope", async () => {
  const { drizzle } = await import("drizzle-orm/pg-proxy");
  const db = drizzle(async (sql, params) => {
    consultas.push({ sql, params });
    if (falla.activa || (falla.soloLaPrimera && consultas.length === 1)) {
      throw Object.assign(new Error("boom"), { code: falla.codigo });
    }
    return { rows: [] };
  });
  return (await import("../mocks/puente-de-alcance")).puenteDeAlcance(() => db);
});

vi.mock("@/server/ai/gemini-extractor", () => ({
  callGemini: vi.fn(),
  errMeta: vi.fn(),
  esPasajero: vi.fn(),
}));
vi.mock("@/server/ai/budget", () => ({ registrarConsumoDelModelo: vi.fn() }));
vi.mock("@/server/storage/claim-attachments-bucket", () => ({ readAttachment: vi.fn() }));
vi.mock("@/lib/audit/log", () => ({ writeAuditLog: vi.fn(), AuditEvent: {} }));
vi.mock("@/lib/observability/logger", () => ({
  logger: { error: mockLogError, warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { seedRequiredDocs } from "@/server/cases/documents";

const CASE = "11111111-1111-1111-1111-111111111111";
const TENANT = "10000000-0000-0000-0000-000000000001";

beforeEach(() => {
  consultas.length = 0;
  falla.activa = false;
  falla.soloLaPrimera = false;
  falla.codigo = undefined;
  vi.clearAllMocks();
});

describe("seedRequiredDocs", () => {
  it("un ramo del código siembra sus obligatorios en una sola sentencia, salvo que el inquilino tenga fila con esa clave", async () => {
    await seedRequiredDocs(CASE, TENANT, "consorcio");

    expect(consultas).toHaveLength(1);
    const { sql, params } = consultas[0]!;
    expect(sql).toMatch(/^insert into "missing_docs"/);
    expect(sql).toMatch(
      /unnest\(coalesce\(\(select "tenant_claim_types"\."documentos" from "tenant_claim_types" where "tenant_claim_types"\."clave" = \$\d+\), array\[\$\d+, \$\d+\]::text\[\]\)\)/
    );
    expect(sql).toMatch(/on conflict do nothing/);
    // El opcional (denuncia policial) no se siembra: nadie lo reclamaría nunca.
    expect(params).toEqual(expect.arrayContaining(["consorcio", "fotos_danos", "presupuesto_reparacion"]));
    expect(params).not.toContain("denuncia_policial");
  });

  it("un ramo del código puede cambiar sus documentos aunque el código no pida ninguno", async () => {
    await seedRequiredDocs(CASE, TENANT, "other");

    expect(consultas).toHaveLength(1);
    expect(consultas[0]!.sql).toMatch(/coalesce\(\(select "tenant_claim_types"\."documentos".*, array\[\]::text\[\]\)/);
  });

  it("sin la tabla (0044 sin aplicar) un ramo del código vuelve a sus documentos del código", async () => {
    falla.soloLaPrimera = true;
    falla.codigo = "42P01";

    await seedRequiredDocs(CASE, TENANT, "consorcio");

    expect(consultas).toHaveLength(2);
    const { sql, params } = consultas[1]!;
    expect(sql).not.toContain("tenant_claim_types");
    expect(sql).toMatch(/unnest\(array\[\$\d+, \$\d+\]::text\[\]\)/);
    expect(params).toEqual(expect.arrayContaining(["fotos_danos", "presupuesto_reparacion"]));
    expect(mockLogError).not.toHaveBeenCalled();
  });

  it("otro error de la base con un ramo del código no se reintenta: se registra y no tira", async () => {
    falla.soloLaPrimera = true;
    falla.codigo = "57014";

    await expect(seedRequiredDocs(CASE, TENANT, "consorcio")).resolves.toBeUndefined();

    expect(consultas).toHaveLength(1);
    expect(mockLogError).toHaveBeenCalledWith(expect.objectContaining({ case_id: CASE }), "documents.seed_failed");
  });

  it("sale del caso y de su inquilino, no de un valor que llegue de afuera", async () => {
    await seedRequiredDocs(CASE, TENANT, "choque");

    const { sql, params } = consultas[0]!;
    expect(sql).toMatch(/from "cases" where "cases"\."id" = \$\d+/);
    expect(params).toContain(CASE);
    expect(params).not.toContain(TENANT);
  });

  it("un ramo propio lee los documentos de tenant_claim_types y no inventa los del código", async () => {
    await seedRequiredDocs(CASE, TENANT, "mi_ramo");

    const { sql, params } = consultas[0]!;
    expect(sql).toMatch(/unnest\(\(select "tenant_claim_types"\."documentos" from "tenant_claim_types" where "tenant_claim_types"\."clave" = \$\d+\)\)/);
    expect(params).toContain("mi_ramo");
    expect(params).not.toContain("fotos_danos");
  });

  it("nada hasta que se conoce el ramo", async () => {
    await seedRequiredDocs(CASE, TENANT, null);
    await seedRequiredDocs(CASE, TENANT, undefined);
    expect(consultas).toHaveLength(0);
  });

  it("nunca tira: el caso ya está guardado", async () => {
    falla.activa = true;
    await expect(seedRequiredDocs(CASE, TENANT, "choque")).resolves.toBeUndefined();
    expect(mockLogError).toHaveBeenCalledWith(
      expect.objectContaining({ case_id: CASE }),
      "documents.seed_failed"
    );
  });
});
