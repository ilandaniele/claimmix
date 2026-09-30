/**
 * Unit tests for the case patch logic.
 *
 * Tests FSM validation, ownership checks, and audit log behavior
 * using a mocked Drizzle db and mocked audit log.
 */

// vi.mock calls must be hoisted to module top level before any other imports
// La capa de datos, corriendo contra el db que este test ya simula.
//
// Se lee `mod.db` en CADA llamada y no se desestructura: el mock de @/lib/db
// suele exponer `db` con un getter para que los tests puedan intercambiar la
// base simulada entre corridas, y un `const { db } = ...` congelaría el valor
// de la primera llamada.
//
// Lo que NO se prueba acá es que el contexto de inquilino llegue a la base:
// eso se verifica en tests/unit/data-scope-sin-rol.test.ts y, contra bases de
// verdad, en `pnpm capa-datos` y `pnpm tenancy`.
const { enTenantMock, enTenantVariasMock } = vi.hoisted(() => ({
  enTenantMock: vi.fn(),
  enTenantVariasMock: vi.fn(),
}));

vi.mock("@/data/scope", async () => {
  const { puenteSobreLibDb } = await import("../mocks/puente-de-alcance");
  const puente = await puenteSobreLibDb();
  enTenantMock.mockImplementation(puente.enTenant);
  enTenantVariasMock.mockImplementation(puente.enTenantVarias);
  return { enTenant: enTenantMock, enTenantVarias: enTenantVariasMock };
});

// `auditoriaSiQuedo` real, envuelta para poder mirar con qué la llamó patch.ts.
vi.mock("@/server/cases/auditoria-si-quedo", async () => {
  const actual = await vi.importActual<typeof import("@/server/cases/auditoria-si-quedo")>(
    "@/server/cases/auditoria-si-quedo"
  );
  return { auditoriaSiQuedo: vi.fn(actual.auditoriaSiQuedo) };
});

// Lo que sale del estado hacia el equipo (vencimiento, plan) se prueba con SQL
// de verdad en tests/unit/server/cases/patch-efectos.test.ts; acá el `db` es
// un mock sin `execute`.
vi.mock("@/server/cases/efectos-de-transicion", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/cases/efectos-de-transicion")>()),
  efectosDeTransicion: vi.fn().mockReturnValue([]),
}));

vi.mock("@/lib/observability/logger", () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    $count: vi.fn(),
  },
  tables: {},
}));

// Mock the audit log to avoid DB calls. `ipValida` queda real: la usa
// `auditoriaSiQuedo`, y el test de ip "anonymous" verifica su comportamiento.
vi.mock("@/lib/audit/log", async () => {
  const actual = await vi.importActual<typeof import("@/lib/audit/log")>("@/lib/audit/log");
  return {
    writeAuditLog: vi.fn().mockResolvedValue(undefined),
    ipValida: actual.ipValida,
    AuditEvent: {
      CASE_STATUS_CHANGED: "case.status_changed",
      CASE_CLOSED: "case.closed",
      CASE_ASSIGNED: "case.assigned",
      CASE_READY_CONFIRMED: "case.ready_confirmed",
    },
  };
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { patchCase } from "@/server/cases/patch";
import { AppError } from "@/lib/errors";
import { db } from "@/lib/db";
import { enTenantVarias } from "@/data/scope";
import { writeAuditLog } from "@/lib/audit/log";
import { auditoriaSiQuedo } from "@/server/cases/auditoria-si-quedo";
import { logger } from "@/lib/observability/logger";
import type { CaseStatus } from "@/lib/schemas/cases";

// ── Test fixtures ─────────────────────────────────────────────────────────────

const adminActor = {
  id: "user-admin-1",
  tenant_id: "tenant-1",
  full_name: "Carlos Medina",
  role: "admin" as const,
  created_at: "2024-01-01T00:00:00Z",
  plan: "profesional",
};

const analystActor = {
  id: "user-analyst-1",
  tenant_id: "tenant-1",
  full_name: "Lucía Ramallo",
  role: "analyst" as const,
  created_at: "2024-01-01T00:00:00Z",
  plan: "profesional",
};

const viewerActor = { ...adminActor, id: "user-viewer-1", role: "viewer" as const };

// E24: «Devolver al agente» exige plan Pro; éste no lo tiene.
const basicActor = { ...adminActor, plan: "basico" };

const listoCase = {
  id: "case-1",
  tenant_id: "tenant-1",
  status: "listo",
  claim_type: "choque",
  assigned_to: "user-analyst-1",
  policy_number: "POL-2024-001",
  policyholder_name: "Juan García",
  confidence_min: 0.85,
  channel: "email_sim",
  created_at: "2024-01-15T00:00:00Z",
  updated_at: null,
  closed_at: null,
};

// ── Mock helpers ──────────────────────────────────────────────────────────────

/**
 * Configure db.select and db.update mocks for a fetch+update cycle.
 *
 * fetchRows: rows returned by db.select().from().where().limit(1)
 * updatedRows: rows returned by db.update().set().where().returning()
 */
function setupPatchMocks(fetchRows: unknown[], updatedRows: unknown[]) {
  // db.select chain: .from().where().limit() → resolves to fetchRows
  const selectChain: any = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue(fetchRows),
  };
  vi.mocked(db.select).mockReturnValue(selectChain as any);

  // db.update chain: .set().where().returning() → resolves to updatedRows
  const returningFn = vi.fn().mockResolvedValue(updatedRows);
  const whereAfterSet = vi.fn().mockReturnValue({ returning: returningFn });
  const setChain: any = {
    set: vi.fn().mockReturnValue({ where: whereAfterSet }),
  };
  vi.mocked(db.update).mockReturnValue(setChain as any);
}

/**
 * Igual que setupPatchMocks, más la cadena de `db.insert(auditLog).select(...)`
 * que usa `auditoriaSiQuedo` en el camino de confirmar_listo. El valor
 * resuelto no importa: patch.ts sólo usa la primera sentencia del batch.
 */
function setupConfirmMocks(fetchRows: unknown[], updatedRows: unknown[]) {
  setupPatchMocks(fetchRows, updatedRows);
  const insertSelectFn = vi.fn().mockResolvedValue(undefined);
  vi.mocked(db.insert).mockReturnValue({ select: insertSelectFn } as any);
}

/**
 * Para E24: dos `db.select` en fila (el caso, después el último movimiento
 * vía `consultaDelUltimoMovimiento`, que suma `.orderBy()` a la cadena) y
 * después el mismo update+insert que `setupConfirmMocks`.
 */
function setupDevolverMocks(caseRow: unknown, ultimoMovimiento: unknown[], updatedRows: unknown[]) {
  const limitFn = vi.fn().mockResolvedValueOnce([caseRow]).mockResolvedValueOnce(ultimoMovimiento);
  const selectChain: any = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: limitFn,
  };
  vi.mocked(db.select).mockReturnValue(selectChain as any);

  const returningFn = vi.fn().mockResolvedValue(updatedRows);
  const whereAfterSet = vi.fn().mockReturnValue({ returning: returningFn });
  const setChain: any = { set: vi.fn().mockReturnValue({ where: whereAfterSet }) };
  vi.mocked(db.update).mockReturnValue(setChain as any);

  const insertSelectFn = vi.fn().mockResolvedValue(undefined);
  vi.mocked(db.insert).mockReturnValue({ select: insertSelectFn } as any);
}

// ── patchCase — FSM validation ────────────────────────────────────────────────

describe("patchCase — FSM validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("throws FSM_INVALID_TRANSITION for cerrado → procesando", async () => {
    const cerradoCase = { ...listoCase, status: "cerrado" };
    setupPatchMocks([cerradoCase], [{ ...cerradoCase, status: "procesando" }]);

    await expect(
      patchCase("case-1", { status: "procesando" }, adminActor, null, null)
    ).rejects.toThrow(expect.objectContaining({ code: "FSM_INVALID_TRANSITION" }));
  });

  it("throws FSM_INVALID_TRANSITION for procesando → cerrado", async () => {
    const procesandoCase = { ...listoCase, status: "procesando" };
    setupPatchMocks([procesandoCase], [{ ...procesandoCase, status: "cerrado" }]);

    await expect(
      patchCase("case-1", { status: "cerrado" }, adminActor, null, null)
    ).rejects.toThrow(expect.objectContaining({ code: "FSM_INVALID_TRANSITION" }));
  });

  it("succeeds for valid FSM transition: listo → cerrado", async () => {
    const updatedCase = { ...listoCase, status: "cerrado", closed_at: new Date().toISOString() };
    setupPatchMocks([listoCase], [updatedCase]);

    const result = await patchCase(
      "case-1",
      { status: "cerrado", reason: "paid_out" },
      adminActor,
      null,
      null
    );
    expect(result.case.status).toBe("cerrado");
    // Un caso cerrado no queda en «Para responder».
    const escrito = vi.mocked(db.update).mock.results[0].value.set.mock.calls[0][0];
    expect(escrito).toMatchObject({ para_responder_desde: null });
  });

  it("succeeds for valid FSM transition: listo → escalado", async () => {
    const updatedCase = { ...listoCase, status: "escalado" };
    setupPatchMocks([listoCase], [updatedCase]);

    const result = await patchCase(
      "case-1",
      { status: "escalado" },
      adminActor,
      null,
      null
    );
    expect(result.case.status).toBe("escalado");
  });

  it("throws FSM_INVALID_TRANSITION for listo → esperando (not in allowed transitions)", async () => {
    setupPatchMocks([listoCase], []);

    await expect(
      patchCase("case-1", { status: "esperando" }, adminActor, null, null)
    ).rejects.toThrow(expect.objectContaining({ code: "FSM_INVALID_TRANSITION" }));
  });

  it("throws FSM_INVALID_TRANSITION cuando el PATCH pide enviado_a_core (lo pone sólo el envío a Core)", async () => {
    const listoParaCoreCase = { ...listoCase, status: "listo_para_core" };
    setupPatchMocks([listoParaCoreCase], []);

    await expect(
      patchCase("case-1", { status: "enviado_a_core" }, adminActor, null, null)
    ).rejects.toThrow(expect.objectContaining({ code: "FSM_INVALID_TRANSITION" }));
    expect(db.update).not.toHaveBeenCalled();
  });

  it("throws FSM_INVALID_TRANSITION cuando el PATCH pide error_core (lo pone sólo el envío a Core)", async () => {
    const listoParaCoreCase = { ...listoCase, status: "listo_para_core" };
    setupPatchMocks([listoParaCoreCase], []);

    await expect(
      patchCase("case-1", { status: "error_core" }, adminActor, null, null)
    ).rejects.toThrow(expect.objectContaining({ code: "FSM_INVALID_TRANSITION" }));
    expect(db.update).not.toHaveBeenCalled();
  });

  it("sigue permitiendo enviado_a_core → cerrado", async () => {
    const enviadoACoreCase = { ...listoCase, status: "enviado_a_core" };
    const updatedCase = { ...enviadoACoreCase, status: "cerrado" };
    setupPatchMocks([enviadoACoreCase], [updatedCase]);

    const result = await patchCase("case-1", { status: "cerrado" }, adminActor, null, null);
    expect(result.case.status).toBe("cerrado");
  });

  it("sigue permitiendo error_core → listo_para_core", async () => {
    const errorCoreCase = { ...listoCase, status: "error_core" };
    const updatedCase = { ...errorCoreCase, status: "listo_para_core" };
    setupPatchMocks([errorCoreCase], [updatedCase]);

    const result = await patchCase("case-1", { status: "listo_para_core" }, adminActor, null, null);
    expect(result.case.status).toBe("listo_para_core");
  });
});

// ── patchCase — tomar el control (D-F2, G38) ─────────────────────────────────

describe("patchCase — tomar el control (D-F2)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("con la reserva de extracción viva, pasar a requiere_especialista da FSM_INVALID_TRANSITION", async () => {
    const infoFaltanteCase = {
      ...listoCase,
      status: "info_faltante",
      extraction_lease_at: new Date().toISOString(),
    };
    setupPatchMocks([infoFaltanteCase], []);

    await expect(
      patchCase("case-1", { status: "requiere_especialista", reason: "tomar_el_control" }, adminActor, null, null)
    ).rejects.toThrow(expect.objectContaining({ code: "FSM_INVALID_TRANSITION" }));
    expect(db.update).not.toHaveBeenCalled();
  });

  it("con la reserva vencida, pasar a requiere_especialista da ok", async () => {
    const infoFaltanteCase = {
      ...listoCase,
      status: "info_faltante",
      extraction_lease_at: new Date(Date.now() - 10 * 60_000).toISOString(),
    };
    const updatedCase = { ...infoFaltanteCase, status: "requiere_especialista" };
    setupPatchMocks([infoFaltanteCase], [updatedCase]);

    const result = await patchCase(
      "case-1",
      { status: "requiere_especialista", reason: "tomar_el_control" },
      adminActor,
      null,
      null
    );
    expect(result.case.status).toBe("requiere_especialista");
  });

  it("sin reserva (extraction_lease_at null), pasar a requiere_especialista da ok", async () => {
    const infoFaltanteCase = { ...listoCase, status: "info_faltante", extraction_lease_at: null };
    const updatedCase = { ...infoFaltanteCase, status: "requiere_especialista" };
    setupPatchMocks([infoFaltanteCase], [updatedCase]);

    const result = await patchCase(
      "case-1",
      { status: "requiere_especialista", reason: "tomar_el_control" },
      adminActor,
      null,
      null
    );
    expect(result.case.status).toBe("requiere_especialista");
  });

  it("rechaza tomar el control con extraction_pending true aunque no haya reserva", async () => {
    const infoFaltanteCase = {
      ...listoCase,
      status: "info_faltante",
      extraction_lease_at: null,
      extraction_pending: true,
    };
    setupPatchMocks([infoFaltanteCase], []);

    await expect(
      patchCase("case-1", { status: "requiere_especialista", reason: "tomar_el_control" }, adminActor, null, null)
    ).rejects.toThrow(expect.objectContaining({ code: "FSM_INVALID_TRANSITION" }));
    expect(db.update).not.toHaveBeenCalled();
  });
});

// ── patchCase — not found / IDOR ─────────────────────────────────────────────

describe("patchCase — IDOR and not found", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("throws NOT_FOUND when case does not exist", async () => {
    // db.select returns no rows → case not found
    setupPatchMocks([], []);

    await expect(
      patchCase("non-existent", { status: "listo" }, adminActor, null, null)
    ).rejects.toThrow(expect.objectContaining({ code: "NOT_FOUND" }));
  });

  it("throws NOT_FOUND (not FORBIDDEN) for wrong-tenant case (IDOR prevention)", async () => {
    // Explicit tenant filter means wrong-tenant case returns zero rows
    setupPatchMocks([], []);

    try {
      await patchCase("other-tenant-case", { status: "listo" }, adminActor, null, null);
      expect.fail("Should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(AppError);
      const appErr = e as AppError;
      // Must be NOT_FOUND — never FORBIDDEN_ROLE
      expect(appErr.code).toBe("NOT_FOUND");
      expect(appErr.status).toBe(404);
    }
  });
});

// ── patchCase — ownership check ───────────────────────────────────────────────

describe("patchCase — ownership check", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("allows admin to patch any case in their tenant", async () => {
    const caseAssignedToOther = { ...listoCase, assigned_to: "other-analyst" };
    const updatedCase = { ...caseAssignedToOther, status: "escalado" };
    setupPatchMocks([caseAssignedToOther], [updatedCase]);

    const result = await patchCase(
      "case-1",
      { status: "escalado" },
      adminActor, // admin can patch any case
      null,
      null
    );
    expect(result.case.status).toBe("escalado");
  });

  it("throws NOT_FOUND when analyst patches a case not assigned to them", async () => {
    const caseAssignedToOther = { ...listoCase, assigned_to: "other-analyst-id" };
    setupPatchMocks([caseAssignedToOther], []);

    await expect(
      patchCase(
        "case-1",
        { status: "cerrado" },
        analystActor, // analyst does not own this case
        null,
        null
      )
    ).rejects.toThrow(expect.objectContaining({ code: "NOT_FOUND" }));
  });

  it("allows analyst to patch a case assigned to them", async () => {
    // analystActor.id === listoCase.assigned_to
    const updatedCase = { ...listoCase, status: "cerrado" };
    setupPatchMocks([listoCase], [updatedCase]);

    const result = await patchCase(
      "case-1",
      { status: "cerrado" },
      analystActor,
      null,
      null
    );
    expect(result.case.status).toBe("cerrado");
  });

  it("audits a close that also reassigns as case.closed, not case.assigned", async () => {
    setupPatchMocks([listoCase], [{ ...listoCase, status: "cerrado", assigned_to: null }]);

    await patchCase("case-1", { status: "cerrado", assigned_to: null }, adminActor, null, null);

    expect(vi.mocked(writeAuditLog)).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: "case.closed",
        payload: expect.objectContaining({ assigned_to: null }),
      })
    );
  });
});

// ── patchCase — update failure ────────────────────────────────────────────────

describe("patchCase — update failure", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("throws FSM_INVALID_TRANSITION when the status update matches no rows (TOCTOU — el caso cambió mientras lo mirabas)", async () => {
    // El select encuentra el caso, pero el update con status en el where no
    // matchea ninguna fila: el status cambió en el medio.
    setupPatchMocks([listoCase], []);

    await expect(
      patchCase("case-1", { status: "escalado" }, adminActor, null, null)
    ).rejects.toThrow(expect.objectContaining({ code: "FSM_INVALID_TRANSITION" }));
    expect(writeAuditLog).not.toHaveBeenCalled();
  });

  it("throws NOT_FOUND when a status-less update (sólo reasignación) matches no rows", async () => {
    setupPatchMocks([listoCase], []);

    await expect(
      patchCase("case-1", { assigned_to: "other-analyst-id" }, adminActor, null, null)
    ).rejects.toThrow(expect.objectContaining({ code: "NOT_FOUND" }));
  });

  it("una reasignación sin status sigue funcionando", async () => {
    const updatedCase = { ...listoCase, assigned_to: "other-analyst-id" };
    setupPatchMocks([listoCase], [updatedCase]);

    const result = await patchCase(
      "case-1",
      { assigned_to: "other-analyst-id" },
      adminActor,
      null,
      null
    );
    expect(result.case.assigned_to).toBe("other-analyst-id");
  });
});

// ── patchCase — confirmar_listo (P6) ─────────────────────────────────────────

describe("patchCase — confirmar_listo (P6)", () => {
  const listoParaCoreCase = { ...listoCase, status: "listo_para_core" };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("en listo_para_core manda un solo enTenantVarias con dos sentencias y no escribe con writeAuditLog", async () => {
    setupConfirmMocks([listoParaCoreCase], [listoParaCoreCase]);

    const result = await patchCase("case-1", { confirmar_listo: true }, adminActor, null, null);

    expect(result.case.status).toBe("listo_para_core");
    expect(enTenantVarias).toHaveBeenCalledTimes(1);
    const armar = vi.mocked(enTenantVarias).mock.calls[0]![1] as (d: unknown) => unknown[];
    const sentencias = armar(db);
    expect(sentencias).toHaveLength(2);
    expect(writeAuditLog).not.toHaveBeenCalled();
  });

  it("si el update no devuelve filas, 409 FSM_INVALID_TRANSITION (el caso cambió mientras tanto)", async () => {
    setupConfirmMocks([listoParaCoreCase], []);

    await expect(
      patchCase("case-1", { confirmar_listo: true }, adminActor, null, null)
    ).rejects.toThrow(expect.objectContaining({ code: "FSM_INVALID_TRANSITION" }));
  });

  it("en info_faltante, 409 (sólo se confirma un caso que queda listo para Core)", async () => {
    const infoFaltanteCase = { ...listoCase, status: "info_faltante" };
    setupConfirmMocks([infoFaltanteCase], []);

    await expect(
      patchCase("case-1", { confirmar_listo: true }, adminActor, null, null)
    ).rejects.toThrow(expect.objectContaining({ code: "FSM_INVALID_TRANSITION" }));
  });

  it("desde requiere_especialista, { status: listo_para_core, confirmar_listo: true } pasa", async () => {
    const requiereEspecialistaCase = { ...listoCase, status: "requiere_especialista" };
    setupConfirmMocks([requiereEspecialistaCase], [listoParaCoreCase]);

    const result = await patchCase(
      "case-1",
      { status: "listo_para_core", confirmar_listo: true },
      adminActor,
      null,
      null
    );
    expect(result.case.status).toBe("listo_para_core");
  });

  it("un analyst sin el caso asignado recibe 404", async () => {
    const ajeno = { ...listoParaCoreCase, assigned_to: "other-analyst-id" };
    setupConfirmMocks([ajeno], []);

    await expect(
      patchCase("case-1", { confirmar_listo: true }, analystActor, null, null)
    ).rejects.toThrow(expect.objectContaining({ code: "NOT_FOUND" }));
  });

  it('con ip "anonymous", el insert de auditoría guarda ip null', async () => {
    setupConfirmMocks([listoParaCoreCase], [listoParaCoreCase]);

    await patchCase("case-1", { confirmar_listo: true }, adminActor, "anonymous", null);

    const columnas = vi.mocked(db.select).mock.calls.find((c) => c[0] && "ip" in c[0])?.[0] as unknown as Record<
      string,
      { sql: unknown }
    >;
    const dialecto = new PgDialect();
    const { params } = dialecto.sqlToQuery(columnas.ip.sql as never);
    expect(params).toEqual([null]);
  });
});

// ── patchCase — devolver al agente (E24) ─────────────────────────────────────

describe("patchCase — devolver al agente (E24)", () => {
  const requiereEspecialistaWhatsapp = {
    ...listoCase,
    status: "requiere_especialista",
    channel: "whatsapp",
    extraction_pending: false,
    extraction_lease_at: null,
  };
  const ultimoTomoElControl = [
    {
      event_type: "case.status_changed",
      payload: { reason: "tomar_el_control", new_status: "requiere_especialista" },
    },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("devuelve el caso al agente: info_faltante, sin «para responder», auditado", async () => {
    const updatedCase = { ...requiereEspecialistaWhatsapp, status: "info_faltante" };
    setupDevolverMocks(requiereEspecialistaWhatsapp, ultimoTomoElControl, [updatedCase]);

    const result = await patchCase(
      "case-1",
      { status: "info_faltante", reason: "devolver_al_agente" },
      adminActor,
      null,
      null
    );

    expect(result.case.status).toBe("info_faltante");
    const escrito = vi.mocked(db.update).mock.results[0].value.set.mock.calls[0][0];
    expect(escrito).toMatchObject({ para_responder_desde: null });
    expect(db.insert).toHaveBeenCalled();
  });

  it("sin plan Pro, PLAN_REQUERIDO", async () => {
    setupDevolverMocks(requiereEspecialistaWhatsapp, ultimoTomoElControl, []);

    await expect(
      patchCase("case-1", { status: "info_faltante", reason: "devolver_al_agente" }, basicActor, null, null)
    ).rejects.toThrow(expect.objectContaining({ code: "PLAN_REQUERIDO" }));
  });

  it("canal email, FSM_INVALID_TRANSITION (es sólo para WhatsApp)", async () => {
    const emailCase = { ...requiereEspecialistaWhatsapp, channel: "email_sim" };
    setupDevolverMocks(emailCase, ultimoTomoElControl, []);

    await expect(
      patchCase("case-1", { status: "info_faltante", reason: "devolver_al_agente" }, adminActor, null, null)
    ).rejects.toThrow(expect.objectContaining({ code: "FSM_INVALID_TRANSITION" }));
  });

  it("último movimiento no fue «tomar el control», FSM_INVALID_TRANSITION", async () => {
    setupDevolverMocks(
      requiereEspecialistaWhatsapp,
      [{ event_type: "claim.specialist_required", payload: {} }],
      []
    );

    await expect(
      patchCase("case-1", { status: "info_faltante", reason: "devolver_al_agente" }, adminActor, null, null)
    ).rejects.toThrow(expect.objectContaining({ code: "FSM_INVALID_TRANSITION" }));
  });

  it("con extraction_pending, FSM_INVALID_TRANSITION (el agente está trabajando)", async () => {
    const pendiente = { ...requiereEspecialistaWhatsapp, extraction_pending: true };
    setupDevolverMocks(pendiente, ultimoTomoElControl, []);

    await expect(
      patchCase("case-1", { status: "info_faltante", reason: "devolver_al_agente" }, adminActor, null, null)
    ).rejects.toThrow(expect.objectContaining({ code: "FSM_INVALID_TRANSITION" }));
  });

  it("con reserva viva, FSM_INVALID_TRANSITION (el agente está trabajando)", async () => {
    const reservado = { ...requiereEspecialistaWhatsapp, extraction_lease_at: new Date().toISOString() };
    setupDevolverMocks(reservado, ultimoTomoElControl, []);

    await expect(
      patchCase("case-1", { status: "info_faltante", reason: "devolver_al_agente" }, adminActor, null, null)
    ).rejects.toThrow(expect.objectContaining({ code: "FSM_INVALID_TRANSITION" }));
  });

  it("si el update no devuelve filas, «El caso cambió mientras lo mirabas»", async () => {
    setupDevolverMocks(requiereEspecialistaWhatsapp, ultimoTomoElControl, []);

    await expect(
      patchCase("case-1", { status: "info_faltante", reason: "devolver_al_agente" }, adminActor, null, null)
    ).rejects.toThrow(
      expect.objectContaining({
        code: "FSM_INVALID_TRANSITION",
        message: "El caso cambió mientras lo mirabas.",
      })
    );
  });

  it("sin reason: devolver_al_agente, requiere_especialista → info_faltante sigue siendo FSM inválida", async () => {
    setupPatchMocks([requiereEspecialistaWhatsapp], []);

    await expect(
      patchCase("case-1", { status: "info_faltante" }, adminActor, null, null)
    ).rejects.toThrow(expect.objectContaining({ code: "FSM_INVALID_TRANSITION" }));
  });
});

// ── patchCase — salidas a mano (listo_para_core atascado, B25) ───────────────

describe("patchCase — salidas a mano", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const SALIDAS: [CaseStatus, CaseStatus][] = [
    ["listo_para_core", "en_liquidacion"],
    ["listo_para_core", "cerrado"],
    ["error_core", "en_liquidacion"],
    ["error_core", "cerrado"],
    ["enviado_a_core", "en_liquidacion"],
    ["en_liquidacion", "pagado"],
    ["en_liquidacion", "rechazado"],
    ["en_liquidacion", "cerrado"],
  ];

  it.each(SALIDAS)("%s → %s: un solo batch con el update guardado y su auditoría", async (desde, hacia) => {
    const caso = { ...listoCase, status: desde };
    setupConfirmMocks([caso], [{ ...caso, status: hacia }]);

    const result = await patchCase("case-1", { status: hacia }, adminActor, null, null);

    expect(result.case.status).toBe(hacia);
    expect(enTenantVarias).toHaveBeenCalledTimes(1);
    // El único enTenant es la lectura del caso: el update va en el batch.
    expect(enTenantMock).toHaveBeenCalledTimes(1);
    expect(writeAuditLog).not.toHaveBeenCalled();

    const cadena = vi.mocked(db.update).mock.results[0]!.value;
    const escrito = cadena.set.mock.calls[0][0];
    expect(escrito.status).toBe(hacia);
    // Pagado y rechazado son un cierre: su fecha va a `closed_at`. La de
    // `en_liquidacion` es la de su fila de auditoría, sin columna propia.
    if (hacia === "en_liquidacion") expect(escrito).not.toHaveProperty("closed_at");
    else expect(escrito.closed_at).toEqual(expect.any(String));
    expect(Object.keys(escrito).filter((k) => k.endsWith("_at")).sort()).toEqual(
      hacia === "en_liquidacion" ? ["updated_at"] : ["closed_at", "updated_at"]
    );
    // Sólo el cierre borra «Para responder»: marcar la liquidación no contesta
    // el mensaje que la persona dejó.
    if (hacia === "cerrado") expect(escrito).toMatchObject({ para_responder_desde: null });
    else expect(escrito).not.toHaveProperty("para_responder_desde");
    expect(escrito).not.toHaveProperty("core_external_id");
    expect(escrito).not.toHaveProperty("core_sent_at");

    const donde = cadena.set.mock.results[0].value.where.mock.calls[0][0];
    expect(new PgDialect().sqlToQuery(donde).params).toEqual(["case-1", desde]);

    expect(auditoriaSiQuedo).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        eventType: hacia === "cerrado" ? "case.closed" : "case.status_changed",
        payload: expect.objectContaining({ old_status: desde, new_status: hacia }),
      }),
      hacia
    );
  });

  it.each([
    ["listo_para_core", "en_liquidacion", "entregado_por_fuera"],
    ["error_core", "en_liquidacion", "entregado_por_fuera"],
    ["enviado_a_core", "en_liquidacion", null],
    ["listo_para_core", "cerrado", null],
    ["en_liquidacion", "pagado", null],
  ] as [CaseStatus, CaseStatus, string | null][])("%s → %s audita reason %s", async (desde, hacia, reason) => {
    const caso = { ...listoCase, status: desde };
    setupConfirmMocks([caso], [{ ...caso, status: hacia }]);

    await patchCase("case-1", { status: hacia }, adminActor, null, null);

    expect(vi.mocked(auditoriaSiQuedo).mock.calls[0]![1].payload).toEqual({
      reason,
      old_status: desde,
      new_status: hacia,
    });
  });

  it("el reason que manda la persona gana", async () => {
    const caso = { ...listoCase, status: "listo_para_core" };
    setupConfirmMocks([caso], [{ ...caso, status: "en_liquidacion" }]);

    await patchCase("case-1", { status: "en_liquidacion", reason: "exportado_csv" }, adminActor, null, null);

    expect(vi.mocked(auditoriaSiQuedo).mock.calls[0]![1].payload).toMatchObject({ reason: "exportado_csv" });
  });

  // Igual que el camino genérico: la reasignación queda en la auditoría, y un
  // cierre sigue siendo `case.closed`.
  it.each([
    ["cerrado", null, "case.closed"],
    ["en_liquidacion", "analyst-id", "case.assigned"],
  ] as [CaseStatus, string | null, string][])("→ %s con assigned_to %s: reasigna y lo audita como %s", async (hacia, assigned_to, eventType) => {
    const caso = { ...listoCase, status: "listo_para_core" };
    setupConfirmMocks([caso], [{ ...caso, status: hacia, assigned_to }]);

    await patchCase("case-1", { status: hacia, assigned_to }, adminActor, null, null);

    const escrito = vi.mocked(db.update).mock.results[0]!.value.set.mock.calls[0][0];
    expect(escrito).toMatchObject({ assigned_to });
    expect(vi.mocked(auditoriaSiQuedo).mock.calls[0]![1]).toMatchObject({
      eventType,
      payload: { old_status: "listo_para_core", new_status: hacia, assigned_to },
    });
  });

  it.each([
    ["pagado", "en_liquidacion"],
    ["rechazado", "cerrado"],
    ["en_liquidacion", "listo_para_core"],
    ["listo", "en_liquidacion"],
    ["cerrado", "pagado"],
    ["recibido", "en_liquidacion"],
    ["enviado_a_core", "pagado"],
  ] as [CaseStatus, CaseStatus][])("%s → %s no existe: FSM_INVALID_TRANSITION sin escribir nada", async (desde, hacia) => {
    const caso = { ...listoCase, status: desde };
    setupConfirmMocks([caso], [{ ...caso, status: hacia }]);

    await expect(
      patchCase("case-1", { status: hacia }, adminActor, null, null)
    ).rejects.toThrow(expect.objectContaining({ code: "FSM_INVALID_TRANSITION" }));
    expect(db.update).not.toHaveBeenCalled();
    expect(enTenantVarias).not.toHaveBeenCalled();
  });

  it.each([
    ["en_liquidacion", "enviado_a_core"],
    ["en_liquidacion", "error_core"],
    ["listo_para_core", "enviado_a_core"],
    ["listo_para_core", "error_core"],
    ["error_core", "enviado_a_core"],
  ] as [CaseStatus, CaseStatus][])("%s → %s: lo pone sólo el envío a Core", async (desde, hacia) => {
    const caso = { ...listoCase, status: desde };
    setupConfirmMocks([caso], []);

    await expect(
      patchCase("case-1", { status: hacia }, adminActor, null, null)
    ).rejects.toThrow(
      expect.objectContaining({ code: "FSM_INVALID_TRANSITION", message: "Ese estado lo pone sólo el envío a Core." })
    );
    expect(db.update).not.toHaveBeenCalled();
  });

  it("confirmar_listo junto con una salida a mano: FSM_INVALID_TRANSITION", async () => {
    const caso = { ...listoCase, status: "listo_para_core" };
    setupConfirmMocks([caso], [{ ...caso, status: "en_liquidacion" }]);

    await expect(
      patchCase("case-1", { status: "en_liquidacion", confirmar_listo: true }, adminActor, null, null)
    ).rejects.toThrow(expect.objectContaining({ code: "FSM_INVALID_TRANSITION" }));
    expect(db.update).not.toHaveBeenCalled();
  });

  it("un analyst con un caso ajeno recibe 404 y no escribe", async () => {
    const ajeno = { ...listoCase, status: "listo_para_core", assigned_to: "other-analyst-id" };
    setupConfirmMocks([ajeno], [{ ...ajeno, status: "en_liquidacion" }]);

    await expect(
      patchCase("case-1", { status: "en_liquidacion" }, analystActor, null, null)
    ).rejects.toThrow(expect.objectContaining({ code: "NOT_FOUND" }));
    expect(db.update).not.toHaveBeenCalled();
  });

  it("un viewer recibe 404 y no escribe", async () => {
    const caso = { ...listoCase, status: "en_liquidacion", assigned_to: viewerActor.id };
    setupConfirmMocks([caso], [{ ...caso, status: "pagado" }]);

    await expect(
      patchCase("case-1", { status: "pagado" }, viewerActor, null, null)
    ).rejects.toThrow(expect.objectContaining({ code: "NOT_FOUND" }));
    expect(db.update).not.toHaveBeenCalled();
  });

  it("si la base todavía no conoce el estado (23514, falta la 0035), INTERNAL_ERROR y log", async () => {
    const code = "23514";
    const caso = { ...listoCase, status: "listo_para_core" };
    setupConfirmMocks([caso], []);
    // Falla también el reintento sin lo del equipo.
    enTenantVariasMock.mockRejectedValueOnce({ code }).mockRejectedValueOnce({ code });

    await expect(
      patchCase("case-1", { status: "en_liquidacion" }, adminActor, null, null)
    ).rejects.toThrow(expect.objectContaining({ code: "INTERNAL_ERROR" }));
    expect(logger.error).toHaveBeenCalledWith({ code }, "patch.cambio_con_auditoria_fallo");
  });

  it("si el batch con lo del equipo falla, reintenta sólo con el estado y su auditoría y avisa", async () => {
    const caso = { ...listoCase, status: "listo_para_core" };
    setupConfirmMocks([caso], [{ ...caso, status: "en_liquidacion" }]);
    enTenantVariasMock.mockRejectedValueOnce({ code: "42703" });

    const result = await patchCase("case-1", { status: "en_liquidacion" }, adminActor, null, null);

    expect(result.case.status).toBe("en_liquidacion");
    expect(enTenantVarias).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledWith(
      { code: "42703", case_id: "case-1", status: "en_liquidacion" },
      "patch.efectos_fallaron"
    );
    expect(logger.error).not.toHaveBeenCalled();
    // El reintento no toca el vencimiento: el set es el de siempre.
    expect(db.update).toHaveBeenCalledTimes(1);
    expect(vi.mocked(db.update).mock.results[0]!.value.set.mock.calls[0][0]).not.toHaveProperty("vence_en");
  });

  it("si el update no devuelve filas, «El caso cambió mientras lo mirabas»", async () => {
    const caso = { ...listoCase, status: "en_liquidacion" };
    setupConfirmMocks([caso], []);

    await expect(
      patchCase("case-1", { status: "rechazado" }, adminActor, null, null)
    ).rejects.toThrow(
      expect.objectContaining({ code: "FSM_INVALID_TRANSITION", message: "El caso cambió mientras lo mirabas." })
    );
  });

  it("un error del update genérico queda logueado con su código", async () => {
    setupPatchMocks([listoCase], []);
    const returning = vi.fn().mockRejectedValue({ code: "XX000" });
    vi.mocked(db.update).mockReturnValue({
      set: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({ returning }) }),
    } as any);

    await expect(
      patchCase("case-1", { status: "escalado" }, adminActor, null, null)
    ).rejects.toThrow(expect.objectContaining({ code: "FSM_INVALID_TRANSITION" }));
    expect(logger.error).toHaveBeenCalledWith({ code: "XX000" }, "patch.cambio_fallo");
  });
});
