/**
 * Asignación a mano (B9): quién puede tomar, soltar o pasar un caso, y que el
 * destino se valide en la base, dentro del mismo UPDATE.
 *
 * Antes `assigned_to` iba directo al SET: la FK a `users` ignora RLS, así que un
 * uuid de otro inquilino pasaba con 200 y uno inexistente daba 23503, que es un
 * oráculo de qué usuarios existen. Ahora la guarda es SQL y las tres respuestas
 * (ajeno, inexistente, sin rol de editor) son la misma: cero filas.
 */
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

vi.mock("@/server/cases/auditoria-si-quedo", async () => {
  const actual = await vi.importActual<typeof import("@/server/cases/auditoria-si-quedo")>(
    "@/server/cases/auditoria-si-quedo"
  );
  return { auditoriaSiQuedo: vi.fn(actual.auditoriaSiQuedo) };
});

vi.mock("@/lib/observability/logger", () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

vi.mock("@/lib/db", () => ({
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn(), $count: vi.fn() },
  tables: {},
}));

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
import { db } from "@/lib/db";
import { writeAuditLog } from "@/lib/audit/log";
import { auditoriaSiQuedo } from "@/server/cases/auditoria-si-quedo";
import { puedeAsignar, CASE_EDITOR_ROLES } from "@/lib/auth/roles";

const admin = { id: "u-admin", tenant_id: "t-1", role: "admin" as const, plan: "profesional" };
const analista = { id: "u-analista", tenant_id: "t-1", role: "analyst" as const, plan: "profesional" };
const viewer = { id: "u-viewer", tenant_id: "t-1", role: "viewer" as const, plan: "profesional" };

const caso = {
  id: "case-1",
  tenant_id: "t-1",
  status: "listo",
  claim_type: "choque",
  assigned_to: null as string | null,
  channel: "email_sim",
  extraction_pending: false,
  extraction_lease_at: null,
};

function armarDb(fetchRows: unknown[], updatedRows: unknown[]) {
  const selectChain: any = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue(fetchRows),
  };
  vi.mocked(db.select).mockReturnValue(selectChain);
  const returning = vi.fn().mockResolvedValue(updatedRows);
  const where = vi.fn().mockReturnValue({ returning });
  const set = vi.fn().mockReturnValue({ where });
  vi.mocked(db.update).mockReturnValue({ set } as any);
  vi.mocked(db.insert).mockReturnValue({ select: vi.fn().mockResolvedValue(undefined) } as any);
  return { set, where };
}

/** El WHERE del primer UPDATE, ya renderizado a SQL con sus parámetros. */
function whereRenderizado(where: ReturnType<typeof vi.fn>) {
  return new PgDialect().sqlToQuery(where.mock.calls[0]![0]);
}

const ACTUALES: (string | null)[] = [null, analista.id, "u-otro"];
const DESTINOS: (string | null)[] = [null, analista.id, "u-otro"];

describe("puedeAsignar", () => {
  it.each(ACTUALES.flatMap((a) => DESTINOS.map((d) => [a, d] as const)))(
    "analista con caso de %s hacia %s",
    (actual, destino) => {
      const esperado = (actual === null || actual === analista.id) && (destino === analista.id || destino === null);
      expect(puedeAsignar(analista, actual, destino)).toBe(esperado);
    }
  );

  it.each(["owner", "admin", "specialist"])("%s asigna a quien sea, y suelta cualquiera", (role) => {
    for (const a of ACTUALES) for (const d of DESTINOS) expect(puedeAsignar({ id: "x", role }, a, d)).toBe(true);
  });

  it("viewer y cualquier rol desconocido nunca asignan", () => {
    for (const a of ACTUALES)
      for (const d of DESTINOS) {
        expect(puedeAsignar(viewer, a, d)).toBe(false);
        expect(puedeAsignar({ id: "x", role: "cliente" }, a, d)).toBe(false);
      }
  });
});

describe("patchCase — asignación a mano", () => {
  beforeEach(() => vi.clearAllMocks());

  it("el analista toma un caso libre: guarda en SQL y audita de quién a quién", async () => {
    const { set, where } = armarDb([caso], [{ ...caso, assigned_to: analista.id }]);

    const r = await patchCase("case-1", { assigned_to: analista.id }, analista, null, null);

    expect(r.case.assigned_to).toBe(analista.id);
    expect(set.mock.calls[0]![0]).toMatchObject({ assigned_to: analista.id });
    const { sql, params } = whereRenderizado(where);
    expect(sql).toMatch(/is not distinct from/i);
    expect(sql).toMatch(/exists \(select 1 from "users"/i);
    expect(params).toEqual(["case-1", null, analista.id, ...CASE_EDITOR_ROLES]);
    expect(writeAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: "case.assigned",
        payload: expect.objectContaining({ assigned_to: analista.id, assigned_from: null }),
      })
    );
  });

  it("soltar un caso (null) no consulta a users: no hay destino que validar", async () => {
    const propio = { ...caso, assigned_to: analista.id };
    const { where } = armarDb([propio], [{ ...propio, assigned_to: null }]);

    await patchCase("case-1", { assigned_to: null }, analista, null, null);

    const { sql, params } = whereRenderizado(where);
    expect(sql).not.toMatch(/exists/i);
    expect(params).toEqual(["case-1", analista.id]);
  });

  it("el analista no le pasa un caso propio a otro: NOT_FOUND sin tocar la base", async () => {
    armarDb([{ ...caso, assigned_to: analista.id }], []);

    await expect(patchCase("case-1", { assigned_to: "u-otro" }, analista, null, null)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(db.update).not.toHaveBeenCalled();
    expect(writeAuditLog).not.toHaveBeenCalled();
  });

  it("el analista no asigna un caso libre a otro", async () => {
    armarDb([caso], []);

    await expect(patchCase("case-1", { assigned_to: "u-otro" }, analista, null, null)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(db.update).not.toHaveBeenCalled();
  });

  it("el analista no suelta un caso ajeno", async () => {
    armarDb([{ ...caso, assigned_to: "u-otro" }], []);

    await expect(patchCase("case-1", { assigned_to: null }, analista, null, null)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(db.update).not.toHaveBeenCalled();
  });

  it("el viewer no asigna", async () => {
    armarDb([caso], []);

    await expect(patchCase("case-1", { assigned_to: viewer.id }, viewer, null, null)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(db.update).not.toHaveBeenCalled();
  });

  it.each([
    ["de otro inquilino", "3f1c5d0e-0000-4000-8000-000000000001"],
    ["inexistente", "3f1c5d0e-0000-4000-8000-000000000002"],
    ["con rol viewer", "3f1c5d0e-0000-4000-8000-000000000003"],
  ])("admin con un destino %s: cero filas, el mismo NOT_FOUND y sin auditoría", async (_cual, destino) => {
    const { where } = armarDb([caso], []);

    await expect(patchCase("case-1", { assigned_to: destino }, admin, null, null)).rejects.toMatchObject({
      code: "NOT_FOUND",
      status: 404,
    });
    // La decisión la toma la base: el destino viaja como parámetro del EXISTS.
    expect(whereRenderizado(where).params).toContain(destino);
    expect(writeAuditLog).not.toHaveBeenCalled();
  });

  it("si la base rechaza el UPDATE (23503 de la FK), sigue siendo el mismo NOT_FOUND", async () => {
    armarDb([caso], []);
    vi.mocked(db.update).mockImplementation(() => {
      throw Object.assign(new Error("fk"), { code: "23503" });
    });

    await expect(
      patchCase("case-1", { assigned_to: "3f1c5d0e-0000-4000-8000-000000000002" }, admin, null, null)
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("carrera: el caso lo tomó otro entre la lectura y el UPDATE", async () => {
    armarDb([caso], []);

    await expect(patchCase("case-1", { assigned_to: analista.id }, analista, null, null)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(writeAuditLog).not.toHaveBeenCalled();
  });

  it("cambio de estado con asignación: la misma guarda va en el UPDATE con estado", async () => {
    const { where } = armarDb([caso], [{ ...caso, status: "escalado", assigned_to: "u-otro" }]);

    await patchCase("case-1", { status: "escalado", assigned_to: "u-otro" }, admin, null, null);

    const { sql, params } = whereRenderizado(where);
    expect(sql).toMatch(/is not distinct from/i);
    expect(params).toEqual(["case-1", "listo", null, "u-otro", ...CASE_EDITOR_ROLES]);
  });

  it("cambio de estado con destino inválido: NOT_FOUND, no «el caso cambió»", async () => {
    armarDb([caso], []);

    await expect(
      patchCase("case-1", { status: "escalado", assigned_to: "u-otro" }, admin, null, null)
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("salida a mano con asignación: el lote con auditoría lleva la misma guarda", async () => {
    const pendiente = { ...caso, status: "listo_para_core" };
    const { where } = armarDb([pendiente], [{ ...pendiente, status: "en_liquidacion" }]);

    await patchCase("case-1", { status: "en_liquidacion", assigned_to: "u-otro" }, admin, null, null);

    const { sql, params } = whereRenderizado(where);
    expect(sql).toMatch(/exists \(select 1 from "users"/i);
    expect(params).toContain("u-otro");
    expect(vi.mocked(auditoriaSiQuedo).mock.calls[0]![1].payload).toMatchObject({
      assigned_to: "u-otro",
      assigned_from: null,
    });
  });

  it("salida a mano con destino inválido: NOT_FOUND", async () => {
    const pendiente = { ...caso, status: "listo_para_core" };
    armarDb([pendiente], []);

    await expect(
      patchCase("case-1", { status: "en_liquidacion", assigned_to: "u-otro" }, admin, null, null)
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("sin assigned_to en el patch, el WHERE no lleva guarda de asignación", async () => {
    const { where } = armarDb([caso], [{ ...caso, status: "escalado" }]);

    await patchCase("case-1", { status: "escalado" }, admin, null, null);

    const { sql, params } = whereRenderizado(where);
    expect(sql).not.toMatch(/distinct|exists/i);
    expect(params).toEqual(["case-1", "listo"]);
  });
});
