/**
 * Gmail API Services User Data Policy, Limited Use: ningún caso real llegado
 * por Gmail entra a entrenamiento ni a few-shot. Sólo simulados entrenan un
 * modelo (`CANALES_DE_ENTRENAMIENTO`); simulados y WhatsApp real pueden ser
 * ejemplo few-shot (`CANALES_DE_EJEMPLO`).
 */

import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { QueryBuilder } from "drizzle-orm/pg-core";

const { mockTenant, mockAudit } = vi.hoisted(() => ({
  mockTenant: vi.fn(),
  mockAudit: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/data/scope", () => ({ enTenant: mockTenant }));

vi.mock("@/lib/audit/log", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/audit/log")>()),
  writeAuditLog: mockAudit,
}));

import { consultasDeEjemplos, approveTrainingExample } from "@/server/training/examples";
import { loadApprovedExamplesForExport } from "@/server/agents/export";

const TENANT_ID = "10000000-0000-0000-0000-000000000001";
const RUN_ID = "20000000-0000-0000-0000-000000000001";
const CASE_ID = "30000000-0000-0000-0000-000000000001";
const USER_ID = "40000000-0000-0000-0000-000000000001";

describe("consultasDeEjemplos — nunca un email real en el few-shot", () => {
  it("cruza con cases y el filtro de canal incluye whatsapp real, nunca email", () => {
    const { delTipo, relleno } = consultasDeEjemplos(new QueryBuilder() as never, "choque");

    for (const consulta of [delTipo, relleno]) {
      const { sql, params } = consulta.toSQL();
      expect(sql).toMatch(/inner join "cases"/i);
      expect(sql).toMatch(/"cases"\."channel" in/i);
      expect(params).toEqual(expect.arrayContaining(["email_sim", "whatsapp_sim", "whatsapp"]));
      expect(params).not.toContain("email");
    }
  });
});

describe("approveTrainingExample — Gmail Limited Use", () => {
  const runRow = {
    id: RUN_ID,
    case_id: CASE_ID,
    claim_message_id: null,
    input_payload: {},
    output_payload: {},
    blocking_reasons: [] as string[],
  };

  it("un caso llegado por email nunca se aprueba como ejemplo", async () => {
    mockAudit.mockClear();
    const queue: unknown[] = [
      [runRow],
      [], // extracted_fields
      [{ claim_type: "choque", channel: "email" }], // case row
    ];
    mockTenant.mockImplementation(async () => queue.shift());

    const resultado = await approveTrainingExample({
      tenantId: TENANT_ID,
      agentRunId: RUN_ID,
      approvedBy: USER_ID,
    });

    expect(resultado).toEqual({ ok: false, reason: "gmail_limited_use" });
    expect(mockTenant).toHaveBeenCalledTimes(3);
    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ agent_run_id: RUN_ID, reason: "gmail_limited_use" }),
      })
    );
  });

  it("un run sin caso no se aprueba: canal desconocido, no Gmail Limited Use", async () => {
    mockAudit.mockClear();
    mockTenant.mockClear();
    const queue: unknown[] = [[{ ...runRow, case_id: null }]];
    mockTenant.mockImplementation(async () => queue.shift());

    const resultado = await approveTrainingExample({
      tenantId: TENANT_ID,
      agentRunId: RUN_ID,
      approvedBy: USER_ID,
    });

    expect(resultado).toEqual({ ok: false, reason: "channel_unknown" });
    expect(mockTenant).toHaveBeenCalledTimes(1);
    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ agent_run_id: RUN_ID, reason: "channel_unknown" }),
      })
    );
  });

  it("un caso simulado sí se aprueba: la guarda no bloquea de más", async () => {
    mockAudit.mockClear();
    const queue: unknown[] = [
      [runRow],
      [], // extracted_fields
      [{ claim_type: "choque", channel: "whatsapp_sim" }], // case row
      [{ id: "ejemplo-nuevo" }], // insert
    ];
    mockTenant.mockImplementation(async () => queue.shift());

    const resultado = await approveTrainingExample({
      tenantId: TENANT_ID,
      agentRunId: RUN_ID,
      approvedBy: USER_ID,
    });

    expect(resultado).toEqual({ ok: true, exampleId: "ejemplo-nuevo" });
  });
});

describe("scripts/export-training.mjs — el dump también excluye email real", () => {
  it("filtra por canal simulado en el SQL", () => {
    const fuente = readFileSync("scripts/export-training.mjs", "utf8");
    expect(fuente).toContain("cs.channel in ('email_sim','whatsapp_sim')");
  });
});

describe("loadApprovedExamplesForExport — nunca un email real", () => {
  it("cruza con cases y filtra por canal de ejemplo", async () => {
    let capturada: { toSQL(): { sql: string; params: unknown[] } } | undefined;
    mockTenant.mockImplementation(async (_ctx: unknown, armar: (db: unknown) => unknown) => {
      capturada = armar(new QueryBuilder()) as typeof capturada;
      return [];
    });

    await loadApprovedExamplesForExport(TENANT_ID, "masked", false);

    const { sql, params } = capturada!.toSQL();
    expect(sql).toMatch(/inner join "cases"/i);
    expect(sql).toMatch(/"cases"\."channel" in/i);
    expect(params).toEqual(expect.arrayContaining(["email_sim", "whatsapp_sim", "whatsapp"]));
    expect(params).not.toContain("email");
  });
});
