/**
 * El descarte del clasificador (`is_claim=false`).
 *
 * Tres cosas que antes no se sostenían: el motivo del modelo se guarda recortado
 * y, si no vino, la columna queda nula (el texto lo pone la pantalla); el
 * payload de auditoría lleva un código fijo y nunca el texto del modelo, que
 * puede traer datos personales; y el UPDATE sólo pisa un caso que sigue en un
 * estado de arranque, así que una corrida repetida no vuelve a anotar el descarte.
 */

import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import { ESTADOS_DE_ARRANQUE } from "@/core/case/estados-de-arranque";
import { filaDeCaso, registrarMocks } from "./worker-harness";

// Cada caso reimporta el grafo entero del worker: ver extract.overlay.test.ts.
vi.setConfig({ testTimeout: 30_000 });

const CASE_ID = "descarte-0000-0000-0000-000000000001";
const TENANT_ID = "descarte-0000-0000-0000-000000000002";
const dialecto = new PgDialect();

afterEach(() => {
  vi.restoreAllMocks();
});

async function correr({ motivo, casoMovido = false }: { motivo?: string; casoMovido?: boolean } = {}) {
  vi.resetModules();

  const espiaDeUpdate: Mock<(data: Record<string, unknown>) => void> = vi.fn();
  const espiaDeFiltro: Mock<(data: Record<string, unknown>, filtro: unknown) => void> = vi.fn();
  const { espiaDeAuditoria } = registrarMocks({
    fila: filaDeCaso(CASE_ID, TENANT_ID),
    espiaDeUpdate,
    espiaDeFiltro,
    casoMovido,
  });

  // El modelo dice «no es un reclamo»; ver extract.claim-type.test.ts.
  vi.doMock("@/server/ai/mock-extractor", () => {
    const claimSimulado = vi.fn().mockReturnValue({
      extraction_model: "mock-email-v1",
      fields: [],
      prompt_tokens: 0,
      completion_tokens: 0,
      cost_usd: 0,
      is_claim: false,
      confidence: 0.9,
      extracted_fields: {},
      field_confidences: {},
      missing_fields: [],
      fields_pending_confirmation: [],
      possible_customer_matches: [],
      possible_policy_matches: [],
      severity: "low",
      requires_specialist: false,
      not_relevant_reason: motivo,
      summary: "",
      suggested_reply: "",
    });
    return {
      extractEmailClaimMock: claimSimulado,
      denunciaSimuladaVacia: vi.fn(() => claimSimulado()),
    };
  });

  // Se importa antes que el worker para espiar la misma instancia que él usa.
  const { logger } = await import("@/lib/observability/logger");
  const aviso = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
  const { AuditEvent } = await import("@/lib/audit/log");

  const { runEmailExtractionWorker } = await import("@/server/worker/extract");
  await runEmailExtractionWorker(CASE_ID, TENANT_ID, null);

  const delDescarte = espiaDeFiltro.mock.calls.find(([data]) => data.status === "no_relevante");
  return {
    escrito: delDescarte?.[0],
    filtro: delDescarte ? dialecto.sqlToQuery(delDescarte[1] as SQL) : undefined,
    completados: espiaDeAuditoria.mock.calls
      .map((c) => c[0])
      .filter((e) => e.event_type === AuditEvent.EXTRACTION_COMPLETE),
    aviso,
  };
}

describe("runEmailExtractionWorker — descarte del clasificador", () => {
  it("sin motivo del modelo deja la columna nula, sin texto fijo", async () => {
    const { escrito } = await correr();

    expect(escrito).toMatchObject({ status: "no_relevante", is_claim: false });
    expect(escrito!.not_relevant_reason).toBeNull();
  });

  it("un motivo en blanco tampoco cuenta", async () => {
    const { escrito } = await correr({ motivo: "   " });

    expect(escrito!.not_relevant_reason).toBeNull();
  });

  it("con motivo lo guarda sin los espacios de los bordes", async () => {
    const { escrito } = await correr({ motivo: "  Consulta por horarios de atención.  " });

    expect(escrito!.not_relevant_reason).toBe("Consulta por horarios de atención.");
  });

  it("recorta el motivo a 500 caracteres", async () => {
    const { escrito } = await correr({ motivo: `  ${"a".repeat(600)}  ` });

    expect(escrito!.not_relevant_reason).toBe("a".repeat(500));
  });

  it("la auditoría lleva el código «clasificador» y no el texto del modelo", async () => {
    const motivo = "El DNI 12345678 no figura en ninguna póliza.";
    const { completados } = await correr({ motivo });

    expect(completados).toHaveLength(1);
    expect(completados[0]).toMatchObject({
      tenant_id: TENANT_ID,
      target_id: CASE_ID,
      payload: { is_claim: false, new_status: "no_relevante", reason: "clasificador" },
    });
    expect(JSON.stringify(completados[0].payload)).not.toContain("12345678");
  });

  it("el UPDATE sólo pisa un caso que sigue en un estado de arranque", async () => {
    const { filtro } = await correr();

    expect(filtro!.sql).toContain('"cases"."id" = $');
    expect(filtro!.sql).toContain('"cases"."status" in (');
    expect(filtro!.params).toEqual(expect.arrayContaining([CASE_ID, ...ESTADOS_DE_ARRANQUE]));
  });

  it("si el UPDATE no toca ninguna fila, no anota el descarte y lo deja dicho en el log", async () => {
    const { completados, aviso } = await correr({ motivo: "Consulta por horarios.", casoMovido: true });

    expect(completados).toHaveLength(0);
    expect(aviso).toHaveBeenCalledWith({ case_id: CASE_ID }, "email_worker.not_relevant_not_applied");
  });

  it("y con el caso donde estaba, no avisa nada", async () => {
    const { aviso } = await correr({ motivo: "Consulta por horarios." });

    expect(aviso).not.toHaveBeenCalledWith(expect.anything(), "email_worker.not_relevant_not_applied");
  });
});
