/**
 * PATCH /api/admin/alertas: quién puede cambiar la lista y qué no se guarda nunca.
 *
 * Toca `tenants`, que no tiene RLS: el filtro por inquilino lo pone el WHERE
 * de la ruta, no la base. Y la dirección vedada no puede colarse aunque venga
 * en mayúsculas o con un signo `+`.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { AppError } from "@/lib/errors";

const { mockRequireAdmin, mockEnTenant, mockAudit } = vi.hoisted(() => ({
  mockRequireAdmin: vi.fn(),
  mockEnTenant: vi.fn(),
  mockAudit: vi.fn(),
}));

vi.mock("@/lib/auth/require-admin", () => ({ requireAdmin: mockRequireAdmin }));

vi.mock("@/data/scope", () => ({ enTenant: mockEnTenant }));

vi.mock("@/lib/audit/log", () => ({
  writeAuditLog: mockAudit,
  AuditEvent: { SPECIALIST_ALERT_RECIPIENTS_CHANGED: "tenant.specialist_alert_recipients_changed" },
}));

import { PATCH } from "@/app/api/admin/alertas/route";
import { tenants } from "@/lib/db/schema";

const USER_ROW = { id: "user-1", tenant_id: "tenant-1", role: "admin" as const };

/** Lo que quedó grabado en el `update(...).set(...).where(...)` del intento. */
let grabado: { t: unknown; v: unknown; c: unknown } | null;
/** Si está, el `where` de la actualización rechaza con esto. */
let fallaConError: unknown = null;

function request(body: string) {
  return new NextRequest("http://localhost/api/admin/alertas", {
    method: "PATCH",
    body,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  grabado = null;
  fallaConError = null;
  mockRequireAdmin.mockResolvedValue({ user: { id: USER_ROW.id }, userRow: USER_ROW });
  mockAudit.mockResolvedValue(undefined);
  mockEnTenant.mockImplementation((_ctx: unknown, armar: (db: unknown) => unknown) =>
    armar({
      update: (t: unknown) => ({
        set: (v: unknown) => ({
          where: (c: unknown) => {
            grabado = { t, v, c };
            return fallaConError ? Promise.reject(fallaConError) : Promise.resolve(undefined);
          },
        }),
      }),
    })
  );
});

describe("PATCH /api/admin/alertas — validación", () => {
  it("da 400 con un JSON roto", async () => {
    const res = await PATCH(request("{ esto no es json"));

    expect(res.status).toBe(400);
    expect(mockEnTenant).not.toHaveBeenCalled();
  });

  it("da 400 con once direcciones", async () => {
    const emails = Array.from({ length: 11 }, (_, i) => `mail${i}@aseguradora.com`);

    const res = await PATCH(request(JSON.stringify({ emails })));

    expect(res.status).toBe(400);
    expect(mockEnTenant).not.toHaveBeenCalled();
  });

  it("da 400 con una dirección que no es un mail", async () => {
    const res = await PATCH(request(JSON.stringify({ emails: ["no-es-mail"] })));

    expect(res.status).toBe(400);
    expect(mockEnTenant).not.toHaveBeenCalled();
  });

  it.each(["ilan.daniele@gmail.com", "ILAN.DANIELE@GMAIL.COM", "ilandaniele+a@googlemail.com"])(
    "da 400 con la dirección vedada (%s)",
    async (vedada) => {
      const res = await PATCH(request(JSON.stringify({ emails: [vedada] })));

      expect(res.status).toBe(400);
      expect(mockEnTenant).not.toHaveBeenCalled();
      expect(mockAudit).not.toHaveBeenCalled();
    }
  );
});

describe("PATCH /api/admin/alertas — guarda la lista", () => {
  it("normaliza, deduplica y guarda", async () => {
    const res = await PATCH(request(JSON.stringify({ emails: [" A@X.com ", "a@x.com", "b@y.com"] })));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ emails: ["a@x.com", "b@y.com"] });
    expect(grabado?.v).toEqual({ specialist_alert_emails: ["a@x.com", "b@y.com"] });
  });

  it("ignora un tenant_id del body: usa el de la sesión", async () => {
    const { PgDialect } = await import("drizzle-orm/pg-core");

    await PATCH(request(JSON.stringify({ emails: ["a@x.com"], tenant_id: "otro" })));

    expect(grabado?.t).toBe(tenants);
    const compilado = new PgDialect().sqlToQuery(grabado?.c as never);
    expect(compilado.sql).toContain('"tenants"."id"');
    expect(compilado.params).toContain("tenant-1");
    expect(compilado.params).not.toContain("otro");
  });

  it("audita la cantidad, nunca las direcciones", async () => {
    await PATCH(request(JSON.stringify({ emails: ["a@x.com", "b@y.com"] })));

    const entrada = mockAudit.mock.calls[0][0];
    expect(entrada.payload).toEqual({ count: 2 });
    expect(JSON.stringify(entrada.payload)).not.toContain("@");
  });

  it("da 400 con el mensaje de la migración si la columna no existe", async () => {
    fallaConError = { code: "42703" };

    const res = await PATCH(request(JSON.stringify({ emails: ["a@x.com"] })));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toContain("0034");
  });
});

describe("PATCH /api/admin/alertas — permisos", () => {
  it("da 403 y no escribe nada si no es admin", async () => {
    mockRequireAdmin.mockRejectedValue(new AppError("FORBIDDEN_ROLE"));

    const res = await PATCH(request(JSON.stringify({ emails: ["a@x.com"] })));

    expect(res.status).toBe(403);
    expect(mockEnTenant).not.toHaveBeenCalled();
    expect(mockAudit).not.toHaveBeenCalled();
  });
});

describe("PATCH /api/admin/alertas — recordatorios (B4)", () => {
  it("acepta recordatorio_horas válido y lo guarda en el mismo UPDATE que la lista", async () => {
    const res = await PATCH(request(JSON.stringify({ emails: ["a@x.com"], recordatorio_horas: [48, 120] })));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ emails: ["a@x.com"], recordatorio_horas: [48, 120] });
    expect(mockEnTenant).toHaveBeenCalledOnce();
    expect(grabado?.v).toEqual({ specialist_alert_emails: ["a@x.com"], recordatorio_horas: [48, 120] });
  });

  it("apagar es guardar la lista vacía", async () => {
    await PATCH(request(JSON.stringify({ emails: [], recordatorio_horas: [] })));

    expect(grabado?.v).toEqual({ specialist_alert_emails: [], recordatorio_horas: [] });
  });

  it("sin recordatorio_horas no lo toca", async () => {
    await PATCH(request(JSON.stringify({ emails: ["a@x.com"] })));

    expect(grabado?.v).not.toHaveProperty("recordatorio_horas");
  });

  it.each([
    ["más de dos", [48, 120, 240]],
    ["menos de 24", [12]],
    ["no ascendente", [120, 48]],
    ["hueco menor a 24", [48, 60]],
    ["no número", ["48"]],
  ])("da 400 con horas inválidas (%s)", async (_nombre, horas) => {
    const res = await PATCH(request(JSON.stringify({ emails: [], recordatorio_horas: horas })));

    expect(res.status).toBe(400);
    expect(mockEnTenant).not.toHaveBeenCalled();
  });

  it("el tenant sale de la sesión aunque el body traiga otro", async () => {
    const { PgDialect } = await import("drizzle-orm/pg-core");

    await PATCH(request(JSON.stringify({ emails: [], recordatorio_horas: [48], tenant_id: "otro" })));

    expect(mockEnTenant.mock.calls[0][0]).toEqual({ tenantId: "tenant-1" });
    const compilado = new PgDialect().sqlToQuery(grabado?.c as never);
    expect(compilado.params).toContain("tenant-1");
    expect(compilado.params).not.toContain("otro");
  });

  it("un rol no admin recibe 403 y no escribe", async () => {
    mockRequireAdmin.mockRejectedValue(new AppError("FORBIDDEN_ROLE"));

    const res = await PATCH(request(JSON.stringify({ emails: [], recordatorio_horas: [48] })));

    expect(res.status).toBe(403);
    expect(mockEnTenant).not.toHaveBeenCalled();
  });

  it("sin la 0039, el mensaje nombra esa migración", async () => {
    fallaConError = { code: "42703" };

    const res = await PATCH(request(JSON.stringify({ emails: [], recordatorio_horas: [48] })));

    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toContain("0039");
  });
});
