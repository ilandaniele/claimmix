/**
 * `anotarDerivacionSiEsNueva`: un solo lote, con el lock del caso primero y la
 * auditoría guardada después. Con la capa de datos simulada: acá se prueba qué
 * se manda y qué se contesta, no el aislamiento (eso lo prueba la integración).
 */

const { enTenantVariasMock } = vi.hoisted(() => ({ enTenantVariasMock: vi.fn() }));

vi.mock("@/data/scope", () => ({ enTenantVarias: enTenantVariasMock }));
vi.mock("@/lib/observability/logger", () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

import { describe, it, expect, vi, beforeEach } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/pg-proxy";
import { anotarDerivacionSiEsNueva } from "@/server/confirmations/derivacion-nueva";
import { logger } from "@/lib/observability/logger";

const CASO = "00000000-0000-0000-0000-0000000000c1";
const INQUILINO = "10000000-0000-0000-0000-000000000001";
const db = drizzle(async () => ({ rows: [] }));
const dialecto = new PgDialect();

const derivar = () =>
  anotarDerivacionSiEsNueva({
    tenantId: INQUILINO,
    caseId: CASO,
    payload: { severity: "high", reason: "severidad high" },
  });

beforeEach(() => {
  vi.clearAllMocks();
});

describe("anotarDerivacionSiEsNueva", () => {
  it("manda dos sentencias en el contexto del inquilino: el lock del caso y la auditoría", async () => {
    enTenantVariasMock.mockResolvedValue([[], [{ id: 1 }]]);

    await derivar();

    expect(enTenantVariasMock).toHaveBeenCalledTimes(1);
    const [ctx, armar] = enTenantVariasMock.mock.calls[0];
    expect(ctx).toEqual({ tenantId: INQUILINO });

    const sentencias = armar(db);
    expect(sentencias).toHaveLength(2);

    const lock = dialecto.sqlToQuery(sentencias[0].getSQL());
    expect(lock.sql).toContain("pg_advisory_xact_lock");
    expect(lock.params).toContain(CASO);

    const auditoria = sentencias[1].toSQL();
    expect(auditoria.sql).toContain("not exists");
    expect(auditoria.params).toContain("claim.specialist_required");
    expect(auditoria.params).toContain(JSON.stringify({ severity: "high", reason: "severidad high" }));
  });

  it("con una fila insertada, la derivación era nueva", async () => {
    enTenantVariasMock.mockResolvedValue([[], [{ id: 1 }]]);

    await expect(derivar()).resolves.toBe(true);
  });

  it("con cero filas, el caso ya tenía la derivación de este episodio", async () => {
    enTenantVariasMock.mockResolvedValue([[], []]);

    await expect(derivar()).resolves.toBe(false);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("si la base falla, contesta que sí —como antes de la guarda— y lo deja en el log", async () => {
    enTenantVariasMock.mockRejectedValue(Object.assign(new Error("connection lost"), { code: "ECONNRESET" }));

    await expect(derivar()).resolves.toBe(true);
    expect(logger.error).toHaveBeenCalledWith(
      { code: "ECONNRESET", case_id: CASO },
      "escalation.audit_guard_failed"
    );
  });
});
