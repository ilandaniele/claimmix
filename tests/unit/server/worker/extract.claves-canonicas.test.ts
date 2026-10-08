/**
 * F1: la extracción guarda una sola clave canónica por dato.
 *
 * El modelo y el parser de respaldo pueden nombrar el mismo campo distinto —
 * `numero_poliza` contra `policy_number`— y `upsertExtractedFields` los canoniza
 * y deduplica antes de insertar: dos filas con la misma clave, en la misma
 * sentencia, rompía el `ON CONFLICT (case_id, field_key)`.
 *
 * Lo mismo con los faltantes: `dni` y `dni_asegurado` en `missing_fields` eran
 * dos filas de `missing_docs` por una sola pregunta, porque el índice único
 * sólo ve la clave cruda.
 */

import { describe, it, expect, vi, afterEach } from "vitest";

import { filaDeCaso, registrarMocks } from "./worker-harness";

vi.setConfig({ testTimeout: 30_000 });

const CASE_ID = "canonicas-test-0000-0000-000000000001";
const TENANT_ID = "canonicas-test-0000-0000-000000000002";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("runEmailExtractionWorker — claves canónicas al guardar", () => {
  it("numero_poliza y policy_number del mismo mensaje se guardan como una sola fila, con la de mayor confianza", async () => {
    vi.resetModules();

    const espiaDeUpdate = vi.fn();
    const { mockDb } = registrarMocks({
      fila: filaDeCaso(CASE_ID, TENANT_ID),
      espiaDeUpdate,
      extractor: {
        fields: [
          { field_key: "claim_type", field_value: "choque", confidence: 0.88, source: "ai" },
          { field_key: "numero_poliza", field_value: "AR-000111", confidence: 0.8, source: "ai" },
          { field_key: "policy_number", field_value: "AR-000111", confidence: 0.95, source: "ai" },
        ],
      },
    });

    const { runEmailExtractionWorker } = await import("@/server/worker/extract");
    await runEmailExtractionWorker(CASE_ID, TENANT_ID, null);

    // `insert()` devuelve siempre la misma cadena simulada: un `.values` por
    // llamada, no por tabla. Un solo resultado alcanza para verla entera.
    const cadena = vi.mocked(mockDb.insert).mock.results[0].value as {
      values: ReturnType<typeof vi.fn>;
    };
    const filas = cadena.values.mock.calls
      .flatMap((c) => [c[0]].flat())
      .filter((f): f is { field_key: string; confidence: string } =>
        typeof f === "object" && f !== null && "field_key" in f
      );

    const polizas = filas.filter((f) => f.field_key === "policy_number");
    expect(polizas).toHaveLength(1);
    expect(polizas[0].confidence).toBe("0.95");
    expect(filas.some((f) => f.field_key === "numero_poliza")).toBe(false);
  });
});

describe("runEmailExtractionWorker — claves canónicas al anotar faltantes", () => {
  /** Las claves que se mandaron a insertar en `missing_docs`, y la cadena para mirar el onConflict. */
  function insertadas(mockDb: { insert: ReturnType<typeof vi.fn> }) {
    const cadena = vi.mocked(mockDb.insert).mock.results[0].value as {
      values: ReturnType<typeof vi.fn>;
    };
    const claves = cadena.values.mock.calls
      .flatMap((c) => [c[0]].flat())
      .filter((f): f is { doc_key: string } => typeof f === "object" && f !== null && "doc_key" in f)
      .map((f) => f.doc_key);
    const resultado = cadena.values.mock.results[0].value as { onConflictDoNothing: ReturnType<typeof vi.fn> };
    return { claves, resultado };
  }

  const CAMPOS = [{ field_key: "claim_type", field_value: "choque", confidence: 0.88, source: "ai" }];

  it("missing_fields con un alias inserta una sola fila, con la clave canónica", async () => {
    vi.resetModules();

    const { mockDb } = registrarMocks({
      fila: filaDeCaso(CASE_ID, TENANT_ID),
      espiaDeUpdate: vi.fn(),
      faltantesExistentes: [],
      extractor: { fields: CAMPOS, missing_fields: ["dni_asegurado", "dni", "numero_poliza"] },
    });

    const { runEmailExtractionWorker } = await import("@/server/worker/extract");
    await runEmailExtractionWorker(CASE_ID, TENANT_ID, null);

    const { claves, resultado } = insertadas(mockDb);
    expect([...claves].sort()).toEqual(["dni", "policy_number"]);
    expect(resultado.onConflictDoNothing).toHaveBeenCalledTimes(1);
  });

  it("una fila alias que ya existe impide insertar la canónica", async () => {
    vi.resetModules();

    const { mockDb } = registrarMocks({
      fila: filaDeCaso(CASE_ID, TENANT_ID),
      espiaDeUpdate: vi.fn(),
      faltantesExistentes: ["dni_asegurado"],
      extractor: { fields: CAMPOS, missing_fields: ["dni", "numero_poliza"] },
    });

    const { runEmailExtractionWorker } = await import("@/server/worker/extract");
    await runEmailExtractionWorker(CASE_ID, TENANT_ID, null);

    expect(insertadas(mockDb).claves).toEqual(["policy_number"]);
  });
});
