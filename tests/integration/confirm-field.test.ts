/**
 * Integration-style unit tests for PATCH /api/cases/:id/confirm-field.
 *
 * These tests mock @/lib/db and @/lib/auth/require-role to test the route
 * handler logic directly without spinning up a server or live DB.
 *
 * AC14: Memory only updated via confirm-field (updateMemoryFromConfirmation called).
 * AC21: Audit log FIELD_CONFIRMED with redacted values.
 * AC16: FSM re-evaluated after confirmation.
 * AC19: 404 for wrong-tenant case (IDOR defense).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks must be hoisted before any imports that use them ────────────────────

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
vi.mock("@/data/scope", async () => {
  const mod = await import("@/lib/db");
  return {
    enTenant: (_ctx: unknown, armar: (d: unknown) => unknown) =>
      Promise.resolve(armar(mod.db)),
    enTenantVarias: (_ctx: unknown, armar: (d: unknown) => unknown[]) =>
      Promise.all(armar(mod.db)),
  };
});

vi.mock("@/lib/db", () => {
  const mockDb = {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  };
  return { db: mockDb };
});

vi.mock("@/lib/auth/require-role", () => ({
  requireRole: vi.fn(),
  ALL_ROLES: ["owner", "admin", "specialist", "analyst", "viewer"],
}));

vi.mock("@/server/memory/update", () => ({
  updateMemoryFromConfirmation: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/audit/log", () => ({
  writeAuditLog: vi.fn().mockResolvedValue(undefined),
  AuditEvent: {
    FIELD_CONFIRMED: "claim.field_confirmed",
    CASE_STATUS_CHANGED: "case.status_changed",
    MEMORY_APPLIED: "memory.applied",
  },
}));

vi.mock("@/server/cases/gap-analyzer", () => ({
  analyzeEmailClaimGaps: vi.fn().mockResolvedValue({
    missingRequiredFields: [],
    fieldsNeedingConfirmation: [],
    isComplete: true,
    status: "listo_para_core",
  }),
}));

// Mock rate-limit to always allow.
vi.mock("@/lib/rate-limit/index", async () => {
  const actual = await vi.importActual<typeof import("@/lib/rate-limit/index")>(
    "@/lib/rate-limit/index"
  );
  return {
    ...actual,
    rateLimit: vi.fn().mockResolvedValue({
      allowed: true,
      remaining: 29,
      resetAt: 0,
      retryAfterSeconds: 0,
    }),
  };
});

import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth/require-role";
import { rateLimit } from "@/lib/rate-limit/index";
import { updateMemoryFromConfirmation } from "@/server/memory/update";
import { writeAuditLog } from "@/lib/audit/log";
import { PATCH } from "@/app/api/cases/[id]/confirm-field/route";
import { analyzeEmailClaimGaps } from "@/server/cases/gap-analyzer";

// ── Constants ─────────────────────────────────────────────────────────────────

const CASE_ID = "123e4567-e89b-12d3-a456-426614174000";
const TENANT_ID = "tenant-1";
const USER_ID = "user-1";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeRequest(body: unknown, caseId = CASE_ID) {
  const url = `http://localhost/api/cases/${caseId}/confirm-field`;
  return new Request(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }) as any;
}

function makeContext(caseId = CASE_ID) {
  return { params: Promise.resolve({ id: caseId }) };
}

/**
 * Set up requireRole to return a valid analyst session.
 */
function setupAuth(role: string = "analyst") {
  vi.mocked(requireRole).mockResolvedValue({
    user: { id: USER_ID, email: "test@example.com" },
    userRow: { id: USER_ID, tenant_id: TENANT_ID, role: role as any },
  });
}

/**
 * Set up requireRole to throw (unauthenticated).
 */
function setupNoAuth() {
  vi.mocked(requireRole).mockRejectedValue(new Error("MISSING_SESSION"));
}

/**
 * Build a chainable select mock that resolves to the given rows.
 * Handles both .limit() and bare await (thennable).
 */
function selectChain(rows: unknown[]) {
  const chain: any = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue(rows),
    then: (resolve: (v: unknown) => void) => resolve(rows),
  };
  return chain;
}

/**
 * Build a chainable update mock that resolves successfully.
 */
function updateChain() {
  const chain: any = {
    set: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue([]),
    then: (resolve: (v: unknown) => void) => resolve([]),
  };
  return chain;
}

/**
 * Build a chainable insert mock that resolves successfully.
 */
function insertChain() {
  const chain: any = {
    values: vi.fn().mockReturnThis(),
    onConflictDoUpdate: vi.fn().mockResolvedValue([]),
    then: (resolve: (v: unknown) => void) => resolve([]),
  };
  return chain;
}

/**
 * Default DB mock setup for a successful confirm action.
 *
 * db.select calls (in order):
 *  1. case lookup -> returns caseRow
 *  2. confirmation row -> returns confirmationRow
 *  3. getSenderEmail (raw_messages) -> returns senderRow
 *  4. reEvaluateStatus: extracted_fields -> returns []
 *
 * db.update calls (in order):
 *  1. update claimFieldConfirmations status
 *  2. satisfy missing_docs
 *  3. update case status (if transition)
 *
 * db.insert calls (in order):
 *  1. upsert extracted_fields
 */
function setupDbForConfirm(opts: {
  caseRow?: unknown;
  confirmationRow?: unknown;
  senderRow?: unknown;
  extractedFields?: unknown[];
} = {}) {
  const {
    caseRow = { id: CASE_ID, status: "confirmacion_pendiente", tenant_id: TENANT_ID },
    confirmationRow = {
      id: "conf-1",
      proposed_value: "Juan Pérez",
      conflict_with_value: null,
      status: "pending",
    },
    senderRow = { from_addr: "sender@example.com" },
    extractedFields = [],
  } = opts;

  vi.mocked(db.select)
    .mockReturnValueOnce(selectChain(caseRow ? [caseRow] : []))    // case lookup
    .mockReturnValueOnce(selectChain(confirmationRow ? [confirmationRow] : [])) // confirmation
    .mockReturnValueOnce(selectChain(senderRow ? [senderRow] : [])) // getSenderEmail
    .mockReturnValueOnce(selectChain(extractedFields));              // reEvaluateStatus

  vi.mocked(db.update).mockReturnValue(updateChain() as any);
  vi.mocked(db.insert).mockReturnValue(insertChain() as any);
}

/**
 * Setup for reject action (no insert, different update path).
 */
function setupDbForReject(opts: {
  caseRow?: unknown;
  confirmationRow?: unknown;
} = {}) {
  const {
    caseRow = { id: CASE_ID, status: "confirmacion_pendiente", tenant_id: TENANT_ID },
    confirmationRow = {
      id: "conf-1",
      proposed_value: "Juan Pérez",
      conflict_with_value: null,
      status: "pending",
    },
  } = opts;

  vi.mocked(db.select)
    .mockReturnValueOnce(selectChain(caseRow ? [caseRow] : []))
    .mockReturnValueOnce(selectChain(confirmationRow ? [confirmationRow] : []));

  vi.mocked(db.update).mockReturnValue(updateChain() as any);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("PATCH /api/cases/:id/confirm-field", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset db mock queues so mockReturnValueOnce calls don't bleed between tests.
    vi.mocked(db.select).mockReset();
    vi.mocked(db.update).mockReset();
    vi.mocked(db.insert).mockReset();
    // Re-apply stable implementations cleared by mockReset.
    vi.mocked(updateMemoryFromConfirmation).mockResolvedValue(undefined);
    vi.mocked(writeAuditLog).mockResolvedValue(undefined);
  });

  it("confirm action: returns 200 with updated status", async () => {
    setupAuth();
    setupDbForConfirm();

    const req = makeRequest({
      field_key: "full_name",
      value: "Juan Pérez",
      action: "confirm",
    });

    const response = await PATCH(req, makeContext());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      case_id: CASE_ID,
      field_key: "full_name",
    });
  });

  it("AC14: calls updateMemoryFromConfirmation after confirm action", async () => {
    setupAuth();
    setupDbForConfirm();

    await PATCH(
      makeRequest({ field_key: "full_name", value: "Juan Pérez", action: "confirm" }),
      makeContext()
    );

    expect(updateMemoryFromConfirmation).toHaveBeenCalledWith(
      TENANT_ID,
      "full_name",
      "Juan Pérez",
      "sender@example.com",
      CASE_ID,
      USER_ID,
      "Juan Pérez" // old proposed_value from confirmationRow
    );
  });

  it("AC21: writes FIELD_CONFIRMED audit log", async () => {
    setupAuth();
    setupDbForConfirm();

    await PATCH(
      makeRequest({ field_key: "full_name", value: "Juan Pérez", action: "confirm" }),
      makeContext()
    );

    expect(writeAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: "claim.field_confirmed",
        target_id: CASE_ID,
      })
    );
  });

  it("reject action: returns 200 with rejected status", async () => {
    setupAuth();
    setupDbForReject();

    const req = makeRequest({
      field_key: "full_name",
      value: null,
      action: "reject",
    });

    const response = await PATCH(req, makeContext());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.field_key).toBe("full_name");
    expect(body.claim_memory_updated).toBe(false);
  });

  it("reject action: logs FIELD_CONFIRMED audit event", async () => {
    setupAuth();
    setupDbForReject();

    await PATCH(
      makeRequest({ field_key: "full_name", value: null, action: "reject" }),
      makeContext()
    );

    expect(writeAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: "claim.field_confirmed",
        payload: expect.objectContaining({ action: "rejected" }),
      })
    );
  });

  it("returns 401 when unauthenticated", async () => {
    setupNoAuth();

    const response = await PATCH(
      makeRequest({ field_key: "full_name", value: "Juan", action: "confirm" }),
      makeContext()
    );

    expect(response.status).toBe(401);
  });

  it("AC19: returns 404 when case belongs to different tenant (IDOR defense)", async () => {
    setupAuth();

    // Case lookup returns empty array (no row for this tenant).
    vi.mocked(db.select)
      .mockReturnValueOnce(selectChain([]))    // case lookup -> not found
      .mockReturnValueOnce(selectChain([]));   // confirmation (may or may not be called)

    const response = await PATCH(
      makeRequest({ field_key: "full_name", value: "Juan", action: "confirm" }),
      makeContext()
    );

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("returns 400 when request body is invalid", async () => {
    setupAuth();

    // DB select for case lookup - but validation happens before case lookup
    // so we still need the auth mock but not necessarily the db mock.
    // Still set up db just in case the route fetches the case first.
    vi.mocked(db.select).mockReturnValue(selectChain([]) as any);

    const response = await PATCH(
      makeRequest({ field_key: "", value: "test", action: "invalid_action" }),
      makeContext()
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe("VALIDATION_FAILED");
  });

  it("correct action: returns 200 with corrected value", async () => {
    setupAuth();
    setupDbForConfirm();

    const req = makeRequest({
      field_key: "full_name",
      value: "María García",
      action: "correct",
    });

    const response = await PATCH(req, makeContext());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      case_id: CASE_ID,
      field_key: "full_name",
    });
  });

  it("confirm without existing confirmation row still succeeds", async () => {
    setupAuth();
    // Override: no confirmation row
    setupDbForConfirm({ confirmationRow: null });

    const response = await PATCH(
      makeRequest({ field_key: "policy_number", value: "POL-999", action: "confirm" }),
      makeContext()
    );

    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.field_key).toBe("policy_number");
  });
});

/**
 * Confirmar un campo sin valor: escribía y después contestaba que había fallado.
 *
 * `value` es `string | null` en el esquema, `suggested_value` es nulable, y la
 * pantalla manda `proposed_value` tal cual —lo muestra como «—» cuando es nulo
 * y ofrecía igual el botón de confirmar—. El camino era: se marcaba la fila
 * como `confirmed`, después el `if` que escribe en `extracted_fields` daba
 * falso, y como el `return ok(...)` vive adentro de ese `if`, la petición se
 * caía hasta el `return err(...)` del final.
 *
 * El analista veía «Error al procesar la confirmación. Intentá de nuevo»,
 * reintentaba, y la segunda vez la fila ya no estaba pendiente — con el
 * registro ya confirmado del otro lado.
 *
 * Por eso estos tests afirman DOS cosas y no una: el código de estado Y que no
 * se haya escrito nada. Un test que sólo mirara el 400 pasaba también antes del
 * arreglo, que es justamente cuando el bug existía.
 */
describe("PATCH /api/cases/:id/confirm-field — sin valor que confirmar", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.select).mockReset();
    vi.mocked(db.update).mockReset();
    vi.mocked(db.insert).mockReset();
    vi.mocked(updateMemoryFromConfirmation).mockResolvedValue(undefined);
    vi.mocked(writeAuditLog).mockResolvedValue(undefined);
  });

  it.each(["confirm", "correct"] as const)(
    "%s con value null devuelve 400 y no escribe nada",
    async (action) => {
      setupAuth();
      setupDbForConfirm({ confirmationRow: { id: "conf-1", proposed_value: null, conflict_with_value: null, status: "pending" } });

      const response = await PATCH(
        makeRequest({ field_key: "full_name", value: null, action }),
        makeContext()
      );

      /*
       * Primero lo que importa, y no es el código de estado.
       *
       * Antes del arreglo esto YA devolvía 400 —se caía hasta el `return err`
       * del final—, así que un test que sólo mirara el status pasaba en verde
       * justo mientras el bug existía. Lo que distingue el antes del después es
       * que la fila quede sin tocar.
       */
      expect(db.update).not.toHaveBeenCalled();
      expect(db.insert).not.toHaveBeenCalled();
      expect(writeAuditLog).not.toHaveBeenCalled();

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error.code).toBe("VALIDATION_FAILED");
      // El mensaje decía «Acción no reconocida» sobre una acción que había
      // reconocido perfectamente. Ahora dice qué hacer.
      expect(body.error.message).toMatch(/rechaz/i);
    }
  );

  it("rechazar sí funciona sin valor, que es la salida para un campo vacío", async () => {
    setupAuth();
    setupDbForReject({ confirmationRow: { id: "conf-1", proposed_value: null, conflict_with_value: null, status: "pending" } });

    const response = await PATCH(
      makeRequest({ field_key: "full_name", value: null, action: "reject" }),
      makeContext()
    );

    expect(response.status).toBe(200);
    expect(db.update).toHaveBeenCalled();
  });

  it("confirmar CON valor sigue escribiendo, que es la otra mitad", async () => {
    // Una guarda que corta todo también pasaría los tests de arriba.
    setupAuth();
    setupDbForConfirm();

    const response = await PATCH(
      makeRequest({ field_key: "full_name", value: "Juan Pérez", action: "confirm" }),
      makeContext()
    );

    expect(response.status).toBe(200);
    expect(db.update).toHaveBeenCalled();
    expect(db.insert).toHaveBeenCalled();
  });
});

/**
 * El borde de la ruta: quién entra y cuánto puede pedir.
 *
 * No había ni un test que ejerciera la guarda de `viewer` ni el límite de
 * tráfico de esta ruta. La suite estaba verde igual, así que reordenar el borde
 * —o borrar la guarda— no rompía nada.
 */
describe("PATCH /api/cases/:id/confirm-field — el borde", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.select).mockReset();
    vi.mocked(db.update).mockReset();
    vi.mocked(db.insert).mockReset();
    vi.mocked(rateLimit).mockResolvedValue({
      allowed: true,
      remaining: 29,
      resetAt: 0,
      retryAfterSeconds: 0,
    } as never);
  });

  it("un viewer recibe 403 y no llega a tocar la base", async () => {
    setupAuth("viewer");
    setupDbForConfirm();

    const response = await PATCH(
      makeRequest({ field_key: "full_name", value: "Juan Pérez", action: "confirm" }),
      makeContext()
    );

    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error.code).toBe("FORBIDDEN_ROLE");
    expect(db.update).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("un viewer con el cuerpo mal formado recibe 403, no 400", async () => {
    // El orden importa: si la validación se adelantara a la guarda, un viewer
    // se enteraría de qué campos espera una ruta que no puede usar.
    setupAuth("viewer");
    setupDbForConfirm();

    const response = await PATCH(
      makeRequest({ field_key: "", action: "inventada" }),
      makeContext()
    );

    expect(response.status).toBe(403);
  });

  it("pasado el cupo, 429 y tampoco escribe", async () => {
    setupAuth();
    setupDbForConfirm();
    vi.mocked(rateLimit).mockResolvedValue({
      allowed: false,
      remaining: 0,
      resetAt: 0,
      retryAfterSeconds: 42,
    } as never);

    const response = await PATCH(
      makeRequest({ field_key: "full_name", value: "Juan Pérez", action: "confirm" }),
      makeContext()
    );

    expect(response.status).toBe(429);
    expect(db.update).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
  });
});

/**
 * Que no se pueda recalcular el estado no deshace la confirmación.
 *
 * La confirmación ya se escribió cuando se llega a recalcular. Si el análisis
 * de brechas o el UPDATE del estado fallan, lo que corresponde es devolver el
 * estado que había y seguir: el analista hizo su trabajo y no tiene por qué
 * volver a hacerlo porque falló un paso posterior.
 *
 * Estas dos ramas no las tocaba ningún test.
 */
describe("PATCH /api/cases/:id/confirm-field — el recálculo de estado falla", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.select).mockReset();
    vi.mocked(db.update).mockReset();
    vi.mocked(db.insert).mockReset();
    vi.mocked(updateMemoryFromConfirmation).mockResolvedValue(undefined);
    vi.mocked(writeAuditLog).mockResolvedValue(undefined);
    vi.mocked(analyzeEmailClaimGaps).mockResolvedValue({
      missingRequiredFields: [],
      fieldsNeedingConfirmation: [],
      isComplete: true,
      status: "listo_para_core",
    } as never);
    vi.mocked(rateLimit).mockResolvedValue({
      allowed: true,
      remaining: 29,
      resetAt: 0,
      retryAfterSeconds: 0,
    } as never);
  });

  it("si revienta el análisis de brechas, responde 200 con el estado de antes", async () => {
    setupAuth();
    setupDbForConfirm({ caseRow: { id: CASE_ID, status: "confirmacion_pendiente", tenant_id: TENANT_ID } });
    vi.mocked(analyzeEmailClaimGaps).mockRejectedValue(new Error("gap analyzer caído"));

    const response = await PATCH(
      makeRequest({ field_key: "full_name", value: "Juan Pérez", action: "confirm" }),
      makeContext()
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.new_status).toBe("confirmacion_pendiente");
    // Y la confirmación quedó escrita igual, que es el punto.
    expect(db.insert).toHaveBeenCalled();
  });

  it("si revienta el UPDATE del estado, tampoco se pierde la confirmación", async () => {
    setupAuth();
    setupDbForConfirm({ caseRow: { id: CASE_ID, status: "confirmacion_pendiente", tenant_id: TENANT_ID } });

    // Los tres primeros UPDATE andan; el cuarto —el del estado— falla.
    let n = 0;
    vi.mocked(db.update).mockImplementation((() => {
      n += 1;
      if (n < 3) return updateChain();
      return {
        set: vi.fn().mockReturnThis(),
        where: vi.fn().mockRejectedValue(new Error("deadlock")),
      };
    }) as never);

    const response = await PATCH(
      makeRequest({ field_key: "full_name", value: "Juan Pérez", action: "confirm" }),
      makeContext()
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.new_status).toBe("confirmacion_pendiente");
    expect(db.insert).toHaveBeenCalled();
  });
});

/**
 * De dónde vino la acción queda en el registro.
 *
 * Hasta acá `FIELD_CONFIRMED` y `CASE_STATUS_CHANGED` guardaban `ip: null` y
 * `ua: null`, mientras el PATCH del caso —al lado, sobre el mismo caso— sí los
 * guardaba. Un historial donde la mitad de las acciones tiene origen y la otra
 * mitad no sirve poco para lo único que existe: reconstruir quién tocó qué.
 *
 * Es dato personal de un empleado de la aseguradora y se guarda a propósito. La
 * política de privacidad ahora lo declara.
 */
describe("PATCH /api/cases/:id/confirm-field — de dónde vino la acción", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.select).mockReset();
    vi.mocked(db.update).mockReset();
    vi.mocked(db.insert).mockReset();
    vi.mocked(updateMemoryFromConfirmation).mockResolvedValue(undefined);
    vi.mocked(writeAuditLog).mockResolvedValue(undefined);
    vi.mocked(rateLimit).mockResolvedValue({
      allowed: true,
      remaining: 29,
      resetAt: 0,
      retryAfterSeconds: 0,
    } as never);
  });

  function pedirCon(headers: Record<string, string>, body: unknown) {
    return new Request(`http://localhost/api/cases/${CASE_ID}/confirm-field`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    }) as never;
  }

  it("confirmar deja la IP y el navegador en la auditoría", async () => {
    setupAuth();
    setupDbForConfirm();

    await PATCH(
      pedirCon(
        { "x-forwarded-for": "203.0.113.7", "user-agent": "Firefox/141.0" },
        { field_key: "full_name", value: "Juan Pérez", action: "confirm" }
      ),
      makeContext()
    );

    const entrada = vi.mocked(writeAuditLog).mock.calls[0][0];
    expect(entrada.ip).toBe("203.0.113.7");
    expect(entrada.ua).toBe("Firefox/141.0");
  });

  it("rechazar también", async () => {
    // La otra rama: es la que no escribe en ninguna otra tabla, así que si el
    // dato no llega hasta acá el registro queda a medias justo donde más
    // importa —una confirmación rechazada no deja otro rastro—.
    setupAuth();
    setupDbForReject();

    await PATCH(
      pedirCon(
        { "x-forwarded-for": "203.0.113.9", "user-agent": "Safari/18" },
        { field_key: "full_name", value: null, action: "reject" }
      ),
      makeContext()
    );

    const entrada = vi.mocked(writeAuditLog).mock.calls[0][0];
    expect(entrada.ip).toBe("203.0.113.9");
    expect(entrada.ua).toBe("Safari/18");
  });

  it("el cambio de estado que dispara la confirmación lo guarda igual", async () => {
    setupAuth();
    setupDbForConfirm();

    await PATCH(
      pedirCon(
        { "x-forwarded-for": "203.0.113.11", "user-agent": "Chrome/140" },
        { field_key: "full_name", value: "Juan Pérez", action: "confirm" }
      ),
      makeContext()
    );

    const cambioDeEstado = vi
      .mocked(writeAuditLog)
      .mock.calls.map((c) => c[0])
      .find((e) => e.event_type === "case.status_changed");
    expect(cambioDeEstado).toBeDefined();
    expect(cambioDeEstado!.ip).toBe("203.0.113.11");
  });

  it("sin cabecera de origen queda null, no una cadena vacía", async () => {
    // `null` dice «no se pudo determinar»; `""` parece un valor.
    setupAuth();
    setupDbForConfirm();

    await PATCH(
      pedirCon({}, { field_key: "full_name", value: "Juan Pérez", action: "confirm" }),
      makeContext()
    );

    const entrada = vi.mocked(writeAuditLog).mock.calls[0][0];
    expect(entrada.ua).toBeNull();
  });
});
