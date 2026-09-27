/**
 * El export del agente saca los ejemplos de referencia con el nombre y el DNI
 * de la persona tachados, en todos los modos, también en el modo en claro
 * que sólo puede pedir un dueño o un admin.
 */

import { describe, expect, it, vi } from "vitest";

const { filas, db } = vi.hoisted(() => {
  const filas: unknown[] = [];
  const db: Record<string, unknown> = {};
  for (const m of ["select", "from", "leftJoin", "where", "orderBy", "limit"]) db[m] = () => db;
  db.then = (ok: (v: unknown) => unknown) => ok(filas);
  return { filas, db };
});

vi.mock("@/data/scope", () => ({
  enTenant: (_ctx: unknown, armar: (d: unknown) => unknown) => Promise.resolve(armar(db)),
}));

import { buildAgentMemoryConfigExport, loadApprovedExamplesForExport } from "@/server/agents/export";

filas.push({
  id: "ej-1",
  agent_run_id: "run-1",
  case_id: "caso-1",
  claim_message_id: null,
  claim_type: "choque",
  input_payload: { subject: "Choque en ruta", body: "Habla Martín Sosa, mi DNI es 30.145.882." },
  expected_output: {
    confirmed_fields: [
      { field_key: "full_name", field_value: "Martín Sosa" },
      { field_key: "dni", field_value: "30.145.882" },
    ],
  },
  status: "approved",
  approved_by: "u-1",
  approved_at: "2026-09-26T00:00:00Z",
  created_at: "2026-09-26T00:00:00Z",
});

const sinLaPersona = (v: unknown) => {
  const texto = JSON.stringify(v);
  expect(texto).not.toContain("Sosa");
  expect(texto).not.toContain("30.145.882");
  expect(texto).toContain("[NOMBRE]");
};

describe("export de ejemplos de referencia", () => {
  it("el JSONL tacha nombre y DNI aunque se pida en claro", async () => {
    sinLaPersona(await loadApprovedExamplesForExport("t-1", "full_admin_only", true));
  });

  it("el JSON de memoria tacha los aprobados y los descartados", async () => {
    const salida = await buildAgentMemoryConfigExport({
      tenantId: "t-1",
      exportedBy: "u-1",
      exportType: "memory_only",
      piiMode: "full_admin_only",
      canExportFullPii: true,
    });
    sinLaPersona(salida.approved_training_examples);
    sinLaPersona(salida.rejected_training_examples);
  });
});
