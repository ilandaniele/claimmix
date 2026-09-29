/**
 * El monto orientativo que escribe la extracción (B23): sale de la tabla del
 * tenant, leída en el mismo SELECT del caso, y nunca pisa uno que vino de un
 * presupuesto de taller leído. La guarda está en el UPDATE mismo, no en lo que
 * el worker leyó antes, así que se mira el SQL que manda.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import { filaDeCaso, registrarMocks, type OpcionesDelExtractor } from "./worker-harness";

const CASE_ID = "monto-test-0000-0000-000000000001";
const TENANT_ID = "monto-test-0000-0000-000000000002";
const PROPIOS = { choque: { medium: { minimo: 111_000, maximo: 222_000 } } };

const dialecto = new PgDialect();

async function correr(extractor: OpcionesDelExtractor = {}) {
  vi.resetModules();
  const espiaDeUpdate = vi.fn<(data: Record<string, unknown>) => void>();
  const { mockDb } = registrarMocks({
    fila: filaDeCaso(CASE_ID, TENANT_ID, { rangos_de_monto: PROPIOS }),
    espiaDeUpdate,
    extractor,
  });
  const { runEmailExtractionWorker } = await import("@/server/worker/extract");
  await runEmailExtractionWorker(CASE_ID, TENANT_ID, null);

  const escrito = espiaDeUpdate.mock.calls.map((c) => c[0]).find((d) => "monto_estimado" in d);
  const columnas = mockDb.select.mock.calls
    .map((c: unknown[]) => c[0] as Record<string, unknown> | undefined)
    .find((c: Record<string, unknown> | undefined) => c && "rangos_de_monto" in c);
  return {
    monto: escrito && dialecto.sqlToQuery(escrito.monto_estimado as SQL),
    rangos: columnas && dialecto.sqlToQuery(columnas.rangos_de_monto as SQL),
  };
}

afterEach(() => vi.restoreAllMocks());

describe("runEmailExtractionWorker — monto estimado", () => {
  it("lee la tabla del tenant en el SELECT del caso", async () => {
    const { rangos } = await correr();

    expect(rangos?.sql).toBe(
      '(select "tenants"."rangos_de_monto" from "tenants" where "tenants"."id" = "cases"."tenant_id")'
    );
  });

  it("escribe el rango de la tabla propia, salvo que el caso ya tenga uno de presupuesto", async () => {
    const { monto } = await correr();

    expect(monto?.sql).toBe(
      `CASE WHEN "cases"."monto_estimado"->>'origen' = 'presupuesto' AND "cases"."claim_type" IS NOT DISTINCT FROM $1 AND "cases"."severity" IS NOT DISTINCT FROM $2 THEN "cases"."monto_estimado" ELSE $3::jsonb END`
    );
    expect(JSON.parse(monto!.params[2] as string)).toEqual({
      minimo: 111_000,
      maximo: 222_000,
      moneda: "ARS",
      origen: "tabla",
    });
  });

  // Un presupuesto de 300.000 aceptado como choque leve no es el monto de un
  // choque grave: el SET compara con la fila de antes del UPDATE.
  it("el de presupuesto queda sólo si el caso sigue con el tipo y la gravedad que se escriben", async () => {
    const { monto } = await correr({ severity: "high" });

    expect(monto?.params.slice(0, 2)).toEqual(["choque", "high"]);
    expect(JSON.parse(monto!.params[2] as string)).toMatchObject({ origen: "tabla" });
  });

  it("sin tipo no inventa un monto, y el de presupuesto igual queda", async () => {
    const { monto } = await correr({
      fields: [{ field_key: "full_name", field_value: "Juan Pérez", confidence: 0.92, source: "ai" }],
      extracted_fields: { full_name: "Juan Pérez" },
    });

    expect(monto?.sql).toContain(`THEN "cases"."monto_estimado"`);
    expect(monto?.params).toEqual([null, "medium", null]);
  });
});
