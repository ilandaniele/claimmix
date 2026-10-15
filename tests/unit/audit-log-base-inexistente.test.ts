/**
 * `writeAuditLog` con una base de cliente que no existe (3D000).
 *
 * Con `BASE_POR_CLIENTE=1` la fila de auditoría va a la base del inquilino. Si
 * todavía no se creó, o ya se dio de baja, la auditoría no se pierde: se escribe
 * la misma fila en control. Cualquier otro error se traga como siempre.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  enTenant: vi.fn(),
  enControl: vi.fn(),
  error: vi.fn(),
  filas: [] as Array<{ puerta: string; fila: unknown }>,
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/observability/logger", () => ({ logger: { error: h.error, warn: vi.fn(), info: vi.fn() } }));
vi.mock("@/lib/db", () => ({ db: {}, tables: {} }));
vi.mock("@/data/scope", () => ({ enTenant: h.enTenant, enControl: h.enControl }));

import { writeAuditLog, AuditEvent } from "@/lib/audit/log";

const TENANT_ID = "10000000-0000-0000-0000-000000000001";
const ENTRADA = {
  tenant_id: TENANT_ID,
  actor_id: "20000000-0000-0000-0000-000000000001",
  event_type: AuditEvent.USER_SESSIONS_REVOKED,
  target_type: "user",
  payload: { sesiones_cerradas: 2 },
};

const sinBase = () => Object.assign(new Error('database "t_x" does not exist'), { code: "3D000" });

/** La puerta que anota el contexto y la fila que arma el insert, y después contesta `resultado`. */
function puerta(nombre: string, resultado: () => unknown) {
  return async (ctx: { tenantId: string }, armar: (db: unknown) => unknown) => {
    const db = {
      insert: () => ({
        values: (fila: unknown) => {
          h.filas.push({ puerta: nombre, fila });
          return Promise.resolve();
        },
      }),
    };
    expect(ctx).toEqual({ tenantId: TENANT_ID });
    await armar(db);
    return resultado();
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.filas.length = 0;
  h.enTenant.mockImplementation(puerta("enTenant", () => undefined));
  h.enControl.mockImplementation(puerta("enControl", () => undefined));
});

describe("writeAuditLog con la base del inquilino inexistente", () => {
  it("con la base en pie escribe una vez, en la del inquilino", async () => {
    await writeAuditLog(ENTRADA);

    expect(h.filas.map((f) => f.puerta)).toEqual(["enTenant"]);
    expect(h.enControl).not.toHaveBeenCalled();
    expect(h.error).not.toHaveBeenCalled();
  });

  it("ante 3D000 reintenta la misma fila en control", async () => {
    h.enTenant.mockImplementation(puerta("enTenant", () => Promise.reject(sinBase())));

    await expect(writeAuditLog(ENTRADA)).resolves.toBeUndefined();

    expect(h.filas.map((f) => f.puerta)).toEqual(["enTenant", "enControl"]);
    expect(h.filas[1]!.fila).toEqual(h.filas[0]!.fila);
    expect(h.filas[1]!.fila).toMatchObject({
      tenant_id: TENANT_ID,
      event_type: "auth.user_sessions_revoked",
      payload: { sesiones_cerradas: 2 },
    });
    expect(h.error).not.toHaveBeenCalled();
  });

  it("el 3D000 envuelto por drizzle en `cause` también cuenta", async () => {
    h.enTenant.mockImplementation(
      puerta("enTenant", () => Promise.reject(new Error("Failed query", { cause: sinBase() })))
    );

    await writeAuditLog(ENTRADA);

    expect(h.enControl).toHaveBeenCalledTimes(1);
  });

  it("otro error no se reintenta en control y se traga con su código", async () => {
    h.enTenant.mockImplementation(
      puerta("enTenant", () => Promise.reject(Object.assign(new Error("caída"), { code: "08006" })))
    );

    await expect(writeAuditLog(ENTRADA)).resolves.toBeUndefined();

    expect(h.enControl).not.toHaveBeenCalled();
    expect(h.error).toHaveBeenCalledWith({ code: "08006" }, "audit.failed_to_write_audit_log");
  });

  it("si control también falla, la auditoría no rompe el pedido", async () => {
    h.enTenant.mockImplementation(puerta("enTenant", () => Promise.reject(sinBase())));
    h.enControl.mockImplementation(
      puerta("enControl", () => Promise.reject(Object.assign(new Error("denegado"), { code: "42501" })))
    );

    await expect(writeAuditLog(ENTRADA)).resolves.toBeUndefined();

    expect(h.error).toHaveBeenCalledWith({ code: "42501" }, "audit.failed_to_write_audit_log");
  });
});
