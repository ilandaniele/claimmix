/**
 * El export del agente saca los ejemplos de referencia con el nombre y el DNI
 * de la persona tachados, en todos los modos, también en el modo en claro
 * que sólo puede pedir un dueño o un admin.
 */

import { describe, expect, it, vi } from "vitest";

const { filas, db } = vi.hoisted(() => {
  const filas: Array<Record<string, unknown>> = [];

  // Cada select() arma su PROPIA cadena, con su propia columnas: varias
  // consultas corren a la vez (Promise.all) y comparten sólo `filas`, nunca
  // qué columnas pidió cada una. El SELECT real sólo trae las columnas
  // pedidas: proyectar evita que un campo agregado para otra consulta
  // (claim_memory, claim_events) se filtre en una que no lo pidió.
  function armarCadena(columnas: Record<string, unknown> | null) {
    const cadena: Record<string, unknown> = {};
    for (const m of ["from", "innerJoin", "leftJoin", "where", "orderBy", "limit"]) cadena[m] = () => cadena;
    cadena.then = (ok: (v: unknown) => unknown) => {
      const proyectadas = columnas
        ? filas.map((fila) => Object.fromEntries(Object.keys(columnas).map((k) => [k, fila[k]])))
        : filas;
      return ok(proyectadas);
    };
    return cadena;
  }

  const db = { select: (c?: Record<string, unknown>) => armarCadena(c ?? null) };
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
  input_payload: {
    subject: "Choque en ruta",
    body:
      "Habla Martín Sosa, mi DNI es 30.145.882. Mi teléfono es 2915551234 y mi correo es denunciante.demo@ejemplo.com.",
  },
  expected_output: {
    confirmed_fields: [
      { field_key: "full_name", field_value: "Martín Sosa" },
      { field_key: "dni", field_value: "30.145.882" },
      { field_key: "telefono_contacto", field_value: "2915551234" },
    ],
  },
  status: "approved",
  approved_by: "u-1",
  approved_at: "2026-09-26T00:00:00Z",
  created_at: "2026-09-26T00:00:00Z",
  key: "martin.sosa@ejemplo.com",
  value: { full_name: "Martín Sosa", dni: "30.145.882" },
  event_type: "agent.deliberated",
  payload: {
    tools: [{ tool: "polizas_por_dni", args: { dni: "30.145.882", nombre: "Martín Sosa" } }],
    resolved: [{ field: "full_name", value: "Martín Sosa" }],
    question: "¿La patente?",
  },
});

const sinLaPersona = (v: unknown) => {
  const texto = JSON.stringify(v);
  expect(texto).not.toContain("Sosa");
  expect(texto).not.toContain("30.145.882");
  expect(texto).not.toContain("2915551234");
  expect(texto).not.toContain("denunciante.demo@ejemplo.com");
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

  it("el JSON completo tacha claim_memory (clave como huella) y los argumentos de herramientas de claim_events", async () => {
    const salida = await buildAgentMemoryConfigExport({
      tenantId: "t-1",
      exportedBy: "u-1",
      exportType: "full",
      piiMode: "full_admin_only",
      canExportFullPii: true,
    });

    expect(salida.claim_memory[0].key).not.toContain("@");
    expect(salida.claim_memory[0].key).toMatch(/^[0-9a-f]{12}$/);
    sinLaPersona(salida.claim_memory);

    const eventos = JSON.stringify(salida.claim_events);
    expect(eventos).not.toContain("Sosa");
    expect(eventos).not.toContain("30.145.882");
    const evento = salida.claim_events![0] as { payload: { tools: Array<{ tool: string; args: unknown }>; question: string } };
    expect(evento.payload.tools[0].args).toEqual({ dni: "[TACHADO]", nombre: "[TACHADO]" });
    expect(evento.payload.tools[0].tool).toBe("polizas_por_dni");
    expect(evento.payload.question).toBe("¿La patente?");
  });
});
