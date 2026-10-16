/**
 * La sombra y el entrenamiento en la fila de agent_runs.
 *
 * `logAgentRun` los pone en confidence_payload al insertar, y sólo si vienen:
 * sin ellos la fila es la de siempre. `anotarSombraEnLaCorrida` completa después
 * lo que se decide más tarde (pedir y responder) con un UPDATE de esa fila, y
 * nunca tira: la sombra no puede romper la vuelta.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

const { captured, mockDbInsert, mockDbUpdate, loggerWarn, loggerError } = vi.hoisted(() => ({
  captured: { row: null as Record<string, unknown> | null, set: null as Record<string, unknown> | null, where: null as unknown },
  mockDbInsert: vi.fn(),
  mockDbUpdate: vi.fn(),
  loggerWarn: vi.fn(),
  loggerError: vi.fn(),
}));

// La capa de datos corre contra el db simulado, pero guarda el contexto con que se la llamó.
vi.mock("@/data/scope", async () => {
  const puente = await import("../../../mocks/puente-de-alcance").then((m) => m.puenteSobreLibDb());
  return { ...puente, enTenant: vi.fn(puente.enTenant) };
});

vi.mock("server-only", () => ({}));

// Las columnas son las de verdad: así se ve el SQL que le llegaría a la base.
vi.mock("@/lib/db", async () => {
  const { agentRuns } = await import("@/lib/db/schema");
  return { db: { insert: mockDbInsert, update: mockDbUpdate }, tables: { agentRuns } };
});

vi.mock("@/lib/db/helpers", () => ({
  firstRow: <T>(rows: T[]): T | null => rows[0] ?? null,
}));

vi.mock("@/lib/observability/logger", () => ({
  logger: { error: loggerError, warn: loggerWarn, info: vi.fn() },
}));

import { enTenant } from "@/data/scope";
import { sombraDeLaExtraccion, type ParteDeSombra } from "@/core/agente/sombra";
import { anotarSombraEnLaCorrida, logAgentRun } from "@/server/training/agent-runs";

const TENANT = "tenant-001";
const CASO = "case-001";
const CORRIDA = "run-001";

const dialecto = new PgDialect();
const aSql = (consulta: unknown) => dialecto.sqlToQuery(consulta as SQL);

const PARTE: ParteDeSombra = {
  pedir: { agente: ["dni"], codigo: ["dni", "patente"], descartadas: 0 },
  responder: { agente: "pedir", codigo: "pedir", rechazo: null },
};

function updateQueResuelve() {
  mockDbUpdate.mockReturnValue({
    set: vi.fn((valores: Record<string, unknown>) => {
      captured.set = valores;
      return {
        where: vi.fn((filtro: unknown) => {
          captured.where = filtro;
          return Promise.resolve([]);
        }),
      };
    }),
  });
}

function updateQueFalla(err: unknown) {
  mockDbUpdate.mockReturnValue({
    set: vi.fn().mockReturnValue({ where: vi.fn().mockRejectedValue(err) }),
  });
}

describe("anotarSombraEnLaCorrida", () => {
  beforeEach(() => {
    captured.set = null;
    captured.where = null;
    mockDbUpdate.mockReset();
    loggerWarn.mockClear();
    vi.mocked(enTenant).mockClear();
    updateQueResuelve();
  });

  it("actualiza la fila de la corrida y del caso, por el inquilino, y nada más", async () => {
    await anotarSombraEnLaCorrida(TENANT, CASO, CORRIDA, PARTE);

    expect(enTenant).toHaveBeenCalledWith({ tenantId: TENANT }, expect.any(Function));
    const { sql, params } = aSql(captured.where);
    expect(sql).toContain('"agent_runs"."id" = $1');
    expect(sql).toContain('"agent_runs"."case_id" = $2');
    expect(sql).not.toContain("tenant_id");
    expect(params).toEqual([CORRIDA, CASO]);
  });

  it("el set suma a la sombra con || y no toca otras claves de confidence_payload", async () => {
    await anotarSombraEnLaCorrida(TENANT, CASO, CORRIDA, PARTE);

    expect(Object.keys(captured.set ?? {})).toEqual(["confidence_payload"]);
    const { sql, params } = aSql(captured.set?.confidence_payload);
    expect(sql).toBe(
      `"agent_runs"."confidence_payload" || jsonb_build_object('sombra', coalesce("agent_runs"."confidence_payload"->'sombra', '{}'::jsonb) || $1::jsonb)`
    );
    expect(params).toEqual([JSON.stringify(PARTE)]);
  });

  it("un error con code anota el code, sin el mensaje ni lo que se iba a escribir", async () => {
    updateQueFalla(Object.assign(new Error("connection to postgres://usuario:clave@host fallo"), { code: "57P01" }));

    await expect(anotarSombraEnLaCorrida(TENANT, CASO, CORRIDA, PARTE)).resolves.toBeUndefined();

    expect(loggerWarn).toHaveBeenCalledTimes(1);
    expect(loggerWarn).toHaveBeenCalledWith({ detalle: "57P01" }, "agent_runs.sombra_error");
    const anotado = JSON.stringify(loggerWarn.mock.calls);
    expect(anotado).not.toContain("postgres://");
    expect(anotado).not.toContain("dni");
    expect(anotado).not.toContain(CORRIDA);
  });

  it("un error de red sin code anota su nombre", async () => {
    updateQueFalla(Object.assign(new Error("fetch failed"), { name: "NeonDbError" }));

    await expect(anotarSombraEnLaCorrida(TENANT, CASO, CORRIDA, PARTE)).resolves.toBeUndefined();

    expect(loggerWarn).toHaveBeenCalledWith({ detalle: "NeonDbError" }, "agent_runs.sombra_error");
  });

  it("un rechazo que no es un Error se anota como UnknownError", async () => {
    updateQueFalla("boom");

    await expect(anotarSombraEnLaCorrida(TENANT, CASO, CORRIDA, PARTE)).resolves.toBeUndefined();

    expect(loggerWarn).toHaveBeenCalledWith({ detalle: "UnknownError" }, "agent_runs.sombra_error");
  });

  it("si la base tira al armar la consulta tampoco tira", async () => {
    mockDbUpdate.mockImplementation(() => {
      throw Object.assign(new Error("sin permiso"), { code: "42501" });
    });

    await expect(anotarSombraEnLaCorrida(TENANT, CASO, CORRIDA, PARTE)).resolves.toBeUndefined();

    expect(loggerWarn).toHaveBeenCalledWith({ detalle: "42501" }, "agent_runs.sombra_error");
  });
});

describe("logAgentRun con sombra y entrenamiento", () => {
  const PARAMS = {
    tenantId: TENANT,
    caseId: CASO,
    modelName: "gemini-2.5-flash",
    promptVersion: "builtin-v1",
    input: { subject: "Siniestro", body: "Tuve un choque." },
    claim: {
      extraction_model: "gemini-2.5-flash",
      is_claim: true,
      confidence: 0.9,
      fields: [{ field_key: "claim_type", field_value: "choque", confidence: 0.95, source: "ai" }],
      missing_fields: [],
    } as any,
    trainability: {
      isTrainableSuggestion: true,
      trainabilityScore: 0.85,
      trainabilityReasons: [],
      blockingReasons: [],
    },
  };

  const SOMBRA = sombraDeLaExtraccion(
    { severity: "low", requires_specialist: false },
    { gravedad: "high", deriva: true, piso: true }
  );
  const ENTRENAMIENTO = { base: "base-de-prueba", extraccion: ["regla-1"], decidir: ["regla-2"] };

  const DE_SIEMPRE = {
    confidence: 0.9,
    field_confidences: {},
    fields: [{ field_key: "claim_type", confidence: 0.95, source: "ai" }],
  };

  beforeEach(() => {
    captured.row = null;
    loggerError.mockClear();
    mockDbInsert.mockReturnValue({
      values: vi.fn((row: Record<string, unknown>) => {
        captured.row = row;
        return { returning: vi.fn().mockResolvedValue([{ id: CORRIDA }]) };
      }),
    });
  });

  it("sin sombra ni entrenamiento el confidence_payload es el de siempre", async () => {
    expect(await logAgentRun(PARAMS)).toBe(CORRIDA);

    expect(captured.row?.confidence_payload).toStrictEqual(DE_SIEMPRE);
  });

  it("con los dos los suma al lado de lo de siempre", async () => {
    await logAgentRun({ ...PARAMS, sombra: SOMBRA, entrenamiento: ENTRENAMIENTO });

    expect(captured.row?.confidence_payload).toStrictEqual({
      ...DE_SIEMPRE,
      entrenamiento: ENTRENAMIENTO,
      sombra: SOMBRA,
    });
  });

  it("con uno solo no inventa el otro", async () => {
    await logAgentRun({ ...PARAMS, sombra: SOMBRA });
    expect(captured.row?.confidence_payload).toStrictEqual({ ...DE_SIEMPRE, sombra: SOMBRA });

    await logAgentRun({ ...PARAMS, entrenamiento: ENTRENAMIENTO });
    expect(captured.row?.confidence_payload).toStrictEqual({ ...DE_SIEMPRE, entrenamiento: ENTRENAMIENTO });
  });
});
