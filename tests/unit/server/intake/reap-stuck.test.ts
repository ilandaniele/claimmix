/**
 * Unit tests for the stuck-case reaper.
 *
 * Verifies it finds cases stuck in `procesando` past the threshold, transitions
 * them to `escalado` (guarded on still being procesando), writes an audit entry
 * per case, and degrades safely.
 */

import { readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockWriteAuditLog, mockDbDeBase, state } = vi.hoisted(() => ({
  mockWriteAuditLog: vi.fn(),
  mockDbDeBase: vi.fn(),
  state: {
    // `status` porque el barredor ahora lo lee, para poder decir en el registro
    // de auditoria de cual de los dos estados venia el caso.
    stuckRows: [] as Array<{ id: string; tenant_id: string; status: string }>,
    updatedRows: [] as Array<{ id: string; tenant_id: string }>,
  },
}));

vi.mock("server-only", () => ({}));

vi.mock("@/lib/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(state.stuckRows),
        }),
      }),
    }),
    update: () => ({
      set: () => ({
        where: () => ({
          returning: () => Promise.resolve(state.updatedRows),
        }),
      }),
    }),
  },
  dbDeBase: mockDbDeBase,
  tables: {},
}));

vi.mock("@/lib/db/schema", () => ({
  cases: {
    id: "id",
    tenant_id: "tenant_id",
    status: "status",
    created_at: "created_at",
    updated_at: "updated_at",
    extraction_pending: "extraction_pending",
    para_responder_desde: "para_responder_desde",
  },
}));

vi.mock("@/lib/audit/log", () => ({
  writeAuditLog: mockWriteAuditLog,
  AuditEvent: { CASE_STATUS_CHANGED: "case.status_changed" },
}));

import type { DbDueno } from "@/lib/db";
import { reapStuckProcessingCases, getStuckReapAfterMs } from "@/server/intake/reap-stuck";

describe("reapStuckProcessingCases", () => {
  beforeEach(() => {
    state.stuckRows = [];
    state.updatedRows = [];
    mockWriteAuditLog.mockReset();
    mockWriteAuditLog.mockResolvedValue(undefined);
    delete process.env.SIMULATE_STUCK_REAP_AFTER_MS;
  });

  it("returns 0 with no audit writes when nothing is stuck", async () => {
    const res = await reapStuckProcessingCases();
    expect(res).toEqual({ reaped: 0, caseIds: [] });
    expect(mockWriteAuditLog).not.toHaveBeenCalled();
  });

  it("escalates stuck cases and writes one audit entry each", async () => {
    state.stuckRows = [
      { id: "c1", tenant_id: "t1", status: "procesando" },
      { id: "c2", tenant_id: "t1", status: "procesando" },
    ];
    state.updatedRows = [
      { id: "c1", tenant_id: "t1" },
      { id: "c2", tenant_id: "t1" },
    ];

    const res = await reapStuckProcessingCases({ tenantId: "t1" });
    expect(res.reaped).toBe(2);
    expect(res.caseIds).toEqual(["c1", "c2"]);

    expect(mockWriteAuditLog).toHaveBeenCalledTimes(2);
    expect(mockWriteAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: "case.status_changed",
        target_id: "c1",
        payload: expect.objectContaining({ new_status: "escalado", reason: "processing_timeout" }),
      })
    );
  });

  it("reports only the rows the guarded UPDATE actually changed", async () => {
    // SELECT saw 2 stuck, but one finished before the UPDATE (guard on status).
    state.stuckRows = [
      { id: "c1", tenant_id: "t1", status: "procesando" },
      { id: "c2", tenant_id: "t1", status: "procesando" },
    ];
    state.updatedRows = [{ id: "c1", tenant_id: "t1" }];

    const res = await reapStuckProcessingCases();
    expect(res.reaped).toBe(1);
    expect(res.caseIds).toEqual(["c1"]);
    expect(mockWriteAuditLog).toHaveBeenCalledTimes(1);
  });

  it("marca la falla: un cero por base caída no es un cero por nada trabado", async () => {
    const caida = {
      select: () => ({ from: () => ({ where: () => ({ limit: () => Promise.reject(new Error("no anda")) }) }) }),
    } as unknown as DbDueno;
    expect(await reapStuckProcessingCases(undefined, caida)).toEqual({ reaped: 0, caseIds: [], fallo: true });

    state.stuckRows = [{ id: "c1", tenant_id: "t1", status: "procesando" }];
    const sinUpdate = {
      select: () => ({ from: () => ({ where: () => ({ limit: () => Promise.resolve(state.stuckRows) }) }) }),
      update: () => ({ set: () => ({ where: () => ({ returning: () => Promise.reject(new Error("no anda")) }) }) }),
    } as unknown as DbDueno;
    expect(await reapStuckProcessingCases(undefined, sinUpdate)).toEqual({ reaped: 0, caseIds: [], fallo: true });
  });

  it("honors SIMULATE_STUCK_REAP_AFTER_MS within bounds", () => {
    process.env.SIMULATE_STUCK_REAP_AFTER_MS = "60000";
    expect(getStuckReapAfterMs()).toBe(60000);
    process.env.SIMULATE_STUCK_REAP_AFTER_MS = "0";
    expect(getStuckReapAfterMs()).toBe(20 * 60_000); // invalid → default
    process.env.SIMULATE_STUCK_REAP_AFTER_MS = "999999999";
    expect(getStuckReapAfterMs()).toBe(2 * 60 * 60_000); // clamped to max
  });
});

// ── Los casos de verdad ───────────────────────────────────────────────────────

describe("el barredor ve los casos que entran de verdad", () => {
  /*
   * Todo lo de arriba prueba `procesando`, y `procesando` lo escriben cuatro
   * caminos: simulate, batch-simulate, re-analyze y reprocess. Ninguno es una
   * denuncia de una persona. Un correo entra en `recibido` y un WhatsApp
   * también, así que el barredor —la única red del intake real— no veía un
   * solo caso real.
   *
   * Medido en producción el 2026-09-08, antes del arreglo: 0 casos en
   * `procesando` —nada que barrer— y 1 en `recibido` de hace más de un día.
   * Ese caso es el agujero.
   *
   * Estas pruebas van en dos mitades a propósito. El mock de la base de este
   * archivo ignora el `where`, así que una prueba de comportamiento no puede
   * distinguir qué estados pide la consulta: pasaría igual con el código
   * viejo. Por eso el filtro se fija sobre el texto del módulo, y el
   * comportamiento —que una fila en `recibido` se barre y queda dicho de dónde
   * venía— se prueba con el mock.
   */

  // El  de arriba vive adentro del otro , así que acá no
  // corre: sin esto, el mock de auditoría acumula las llamadas de una prueba a
  // la siguiente y la cuenta da 2 donde tiene que dar 1.
  beforeEach(() => {
    state.stuckRows = [];
    state.updatedRows = [];
    mockWriteAuditLog.mockReset();
    mockWriteAuditLog.mockResolvedValue(undefined);
  });

  it("la consulta pide los dos estados, no sólo `procesando`", () => {
    // Normalizado: el archivo llega con CRLF acá y con LF en el checkout de CI.
    const fuente = readFileSync("src/server/intake/reap-stuck.ts", "utf8").replace(/\r\n/g, "\n");

    expect(fuente).toContain('const ESTADOS_TRABABLES = ["procesando", "recibido"] as const;');
    expect(fuente).toContain("inArray(cases.status, ESTADOS_TRABABLES)");

    // Y que no haya quedado el filtro viejo en ninguna de las dos cláusulas:
    // la del SELECT y la guarda del UPDATE.
    expect(fuente).not.toContain('eq(cases.status, "procesando")');
    expect(fuente.split("inArray(cases.status, ESTADOS_TRABABLES)").length - 1).toBe(2);
  });

  it("no escala lo que es de retomar", () => {
    const fuente = readFileSync("src/server/intake/reap-stuck.ts", "utf8").replace(/\r\n/g, "\n");

    // Una vez en el SELECT y otra en la guarda del UPDATE.
    expect(fuente.split("eq(cases.extraction_pending, false)").length - 1).toBe(2);
  });

  it("no escala lo que ya tiene una persona: `recibido` en «Para responder» pasado un tope", () => {
    const fuente = readFileSync("src/server/intake/reap-stuck.ts", "utf8").replace(/\r\n/g, "\n");

    // Pasado el tope por formulario o por remitente el caso queda en `recibido`
    // sin agente, a propósito. Una vez en el SELECT y otra en la guarda del UPDATE.
    expect(fuente.split("sinPersonaEncima()").length - 1).toBe(2);
    // Y la exclusión se limita a `recibido`: un `procesando` marcado se barre igual.
    expect(fuente).toContain(
      'const sinPersonaEncima = () => or(ne(cases.status, "recibido"), isNull(cases.para_responder_desde));'
    );
  });

  it("el reloj es coalesce", () => {
    const fuente = readFileSync("src/server/intake/reap-stuck.ts", "utf8").replace(/\r\n/g, "\n");

    expect(fuente).toContain("coalesce(${cases.updated_at}, ${cases.created_at}) < ${cutoff}::timestamptz");
  });

  it("una denuncia trabada en `recibido` se barre", async () => {
    state.stuckRows = [{ id: "caso-real", tenant_id: "t-1", status: "recibido" }];
    state.updatedRows = [{ id: "caso-real", tenant_id: "t-1" }];

    const result = await reapStuckProcessingCases();

    expect(result.reaped).toBe(1);
    expect(result.caseIds).toEqual(["caso-real"]);
  });

  it("y el registro dice de qué estado venía", async () => {
    // Sin esto, el registro de una denuncia abandonada y el de una simulación
    // olvidada se leen igual, y son cosas muy distintas.
    state.stuckRows = [{ id: "caso-real", tenant_id: "t-1", status: "recibido" }];
    state.updatedRows = [{ id: "caso-real", tenant_id: "t-1" }];

    await reapStuckProcessingCases();

    expect(mockWriteAuditLog).toHaveBeenCalledTimes(1);
    expect(mockWriteAuditLog.mock.calls[0][0].payload).toMatchObject({
      new_status: "escalado",
      reason: "processing_timeout",
      previous_status: "recibido",
    });
  });

  it("una simulación sigue diciendo `procesando`", async () => {
    state.stuckRows = [{ id: "sim", tenant_id: "t-1", status: "procesando" }];
    state.updatedRows = [{ id: "sim", tenant_id: "t-1" }];

    await reapStuckProcessingCases();

    expect(mockWriteAuditLog.mock.calls[0][0].payload).toMatchObject({
      previous_status: "procesando",
    });
  });
});

describe("reapStuckProcessingCases: la base de cada cliente (P10)", () => {
  const TENANT = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const SAVED = process.env.BASE_POR_CLIENTE;

  /** Una base propia: devuelve un solo caso trabado y lo escala. */
  const baseDelCliente = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([{ id: "caso-del-cliente", tenant_id: TENANT, status: "recibido" }]),
        }),
      }),
    }),
    update: () => ({
      set: () => ({
        where: () => ({ returning: () => Promise.resolve([{ id: "caso-del-cliente", tenant_id: TENANT }]) }),
      }),
    }),
  } as unknown as DbDueno;

  beforeEach(() => {
    state.stuckRows = [];
    state.updatedRows = [];
    mockWriteAuditLog.mockReset();
    mockWriteAuditLog.mockResolvedValue(undefined);
    mockDbDeBase.mockReset();
    mockDbDeBase.mockReturnValue(baseDelCliente);
  });

  afterEach(() => {
    if (SAVED === undefined) delete process.env.BASE_POR_CLIENTE;
    else process.env.BASE_POR_CLIENTE = SAVED;
  });

  it("con el flag apagado y un inquilino barre la base de siempre", async () => {
    delete process.env.BASE_POR_CLIENTE;

    const res = await reapStuckProcessingCases({ tenantId: TENANT });

    expect(mockDbDeBase).not.toHaveBeenCalled();
    expect(res).toEqual({ reaped: 0, caseIds: [] });
  });

  it("con el flag prendido y un inquilino barre la base de ese inquilino", async () => {
    process.env.BASE_POR_CLIENTE = "1";

    const res = await reapStuckProcessingCases({ tenantId: TENANT });

    expect(mockDbDeBase).toHaveBeenCalledWith("t_aaaaaaaabbbbccccddddeeeeeeeeeeee");
    expect(res).toEqual({ reaped: 1, caseIds: ["caso-del-cliente"] });
  });

  it("con el flag prendido y sin inquilino barre la base de siempre", async () => {
    process.env.BASE_POR_CLIENTE = "1";

    await reapStuckProcessingCases();

    expect(mockDbDeBase).not.toHaveBeenCalled();
  });

  it("la base que le pasan manda sobre la del inquilino", async () => {
    process.env.BASE_POR_CLIENTE = "1";
    const otra = {
      ...baseDelCliente,
      select: () => ({ from: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }) }),
    } as unknown as DbDueno;

    const res = await reapStuckProcessingCases({ tenantId: TENANT }, otra);

    expect(mockDbDeBase).not.toHaveBeenCalled();
    expect(res).toEqual({ reaped: 0, caseIds: [] });
  });
});
