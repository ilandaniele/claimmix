/**
 * /api/admin/trabajo (B9, B10, B11, B13): cómo trabaja el equipo. Sólo un
 * admin, sólo de su inquilino, nada que no valide llega a la base y cada cambio
 * queda auditado con quién lo hizo, en la misma sentencia.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { AppError } from "@/lib/errors";
import { PESOS_POR_DEFECTO } from "@/core/case/puntaje-complejidad";
import { PLAN_POR_DEFECTO } from "@/core/case/plan-de-trabajo";

const m = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  enTenant: vi.fn(),
  enTenantVarias: vi.fn(),
  consultaDeCarga: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth/require-admin", () => ({ requireAdmin: m.requireAdmin }));
vi.mock("@/data/scope", () => ({ enTenant: m.enTenant, enTenantVarias: m.enTenantVarias }));
vi.mock("@/server/cases/efectos-de-transicion", () => ({ consultaDeCarga: m.consultaDeCarga }));

import { GET, PATCH } from "@/app/api/admin/trabajo/route";

const TENANT_ID = "10000000-0000-0000-0000-000000000001";
const ADMIN_ID = "20000000-0000-0000-0000-000000000001";
const ANALISTA = "30000000-0000-0000-0000-000000000001";
const USER_ROW = { id: ADMIN_ID, tenant_id: TENANT_ID, role: "admin" };

const REGLAS = { reglas: [{ tipos: ["choque"], personas: [ANALISTA] }] };
const PLAZOS = [{ clave: "informe_perito", titulo: "Informe del perito", dias: 10, ancla: "listo_para_core" }];
const PLAN = { porTipo: { choque: [{ clave: "peritar", titulo: "Coordinar la pericia" }] } };
const CAMBIOS = [
  ["reglas_asignacion", REGLAS],
  ["plazos", PLAZOS],
  ["plan_por_tipo", PLAN],
  ["pesos_puntaje", PESOS_POR_DEFECTO],
] as const;

const dialecto = new PgDialect();
let sentencias: Array<{ sql: string; params: unknown[] }>;
let contesta: unknown;
let falla: unknown;

const patch = (body: unknown) =>
  PATCH(
    new NextRequest("http://localhost/api/admin/trabajo", {
      method: "PATCH",
      body: typeof body === "string" ? body : JSON.stringify(body),
      headers: { "content-type": "application/json" },
    })
  );

beforeEach(() => {
  vi.clearAllMocks();
  sentencias = [];
  contesta = { rows: [{ n: 1 }] };
  falla = null;
  m.requireAdmin.mockResolvedValue({ user: { id: ADMIN_ID }, userRow: USER_ROW });
  m.enTenant.mockImplementation(async (ctx: { tenantId: string }, armar: (db: unknown) => unknown) => {
    expect(ctx).toEqual({ tenantId: TENANT_ID });
    if (falla) throw falla;
    const consulta = armar({ execute: (q: SQL) => q }) as SQL;
    const { sql, params } = dialecto.sqlToQuery(consulta);
    sentencias.push({ sql: sql.replace(/\s+/g, " ").trim(), params });
    return contesta;
  });
  m.consultaDeCarga.mockReturnValue("consulta-de-carga");
});

describe("quién entra", () => {
  it.each([
    ["sin sesión", "MISSING_SESSION", 401],
    ["un analista", "FORBIDDEN_ROLE", 403],
  ])("%s no llega a la base, ni para leer ni para escribir", async (_caso, codigo, estado) => {
    m.requireAdmin.mockRejectedValue(new AppError(codigo as "FORBIDDEN_ROLE"));

    expect((await GET()).status).toBe(estado);
    expect((await patch({ campo: "plazos", valor: [] })).status).toBe(estado);
    expect(m.enTenant).not.toHaveBeenCalled();
    expect(m.enTenantVarias).not.toHaveBeenCalled();
  });
});

describe("PATCH /api/admin/trabajo: qué se acepta", () => {
  it.each([
    ["JSON roto", "{ no"],
    ["sin cuerpo", "null"],
    ["sin campo", { valor: [] }],
    ["un campo que no es de trabajo", { campo: "name", valor: [] }],
    ["la columna del inquilino", { campo: "tenant_id", valor: [] }],
    ["sin valor", { campo: "plazos" }],
    ["un valor de otro campo", { campo: "reglas_asignacion", valor: PLAN }],
    ["una clave de más", { campo: "plazos", valor: [], tenant_id: "otro" }],
    ["reglas con una persona que no es uuid", { campo: "reglas_asignacion", valor: { reglas: [{ personas: ["ana"] }] } }],
    ["un plazo que pisa el de la ley", { campo: "plazos", valor: [{ ...PLAZOS[0], clave: "art46" }] }],
    ["un plazo con ancla inventada", { campo: "plazos", valor: [{ ...PLAZOS[0], ancla: "nunca" }] }],
    ["un plan con un paso repetido", {
      campo: "plan_por_tipo",
      valor: { porTipo: { choque: [PLAN.porTipo.choque[0], PLAN.porTipo.choque[0]] } },
    }],
    ["un plan de un tipo inventado", { campo: "plan_por_tipo", valor: { porTipo: { avion: PLAN.porTipo.choque } } }],
    ["pesos con el umbral al revés", {
      campo: "pesos_puntaje",
      valor: { ...PESOS_POR_DEFECTO, monto: { peso: 15, umbral: { bajo: 9, alto: 1 } } },
    }],
  ])("%s da 400 y no toca la base", async (_caso, body) => {
    const res = await patch(body);

    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("VALIDATION_FAILED");
    expect(m.enTenant).not.toHaveBeenCalled();
  });

  it("dice qué campo falló", async () => {
    const res = await patch({ campo: "reglas_asignacion", valor: { reglas: [{ personas: ["ana"] }] } });

    expect((await res.json()).error.message).toMatch(/^valor\.reglas\.0\.personas\.0: /);
  });

  it.each(CAMBIOS)("%s: acepta lo que valida el esquema del núcleo", async (campo, valor) => {
    const res = await patch({ campo, valor });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ campo, valor });
  });

  it("los valores por defecto del código validan: se pueden guardar tal cual como punto de partida", async () => {
    expect((await patch({ campo: "plan_por_tipo", valor: PLAN_POR_DEFECTO })).status).toBe(200);
    expect((await patch({ campo: "reglas_asignacion", valor: { reglas: [] } })).status).toBe(200);
    expect((await patch({ campo: "plazos", valor: [] })).status).toBe(200);
  });
});

describe("PATCH /api/admin/trabajo: qué se escribe", () => {
  it("es UNA sola sentencia, en el inquilino de la sesión: lee lo viejo, escribe lo nuevo y audita", async () => {
    await patch({ campo: "plazos", valor: PLAZOS });

    expect(m.enTenant).toHaveBeenCalledTimes(1);
    expect(m.enTenantVarias).not.toHaveBeenCalled();
    expect(sentencias).toHaveLength(1);
    const { sql } = sentencias[0]!;
    expect(sql).toContain("WITH viejo AS ( SELECT \"plazos\" AS valor FROM tenants WHERE id = $");
    expect(sql).toContain("nuevo AS ( UPDATE tenants SET \"plazos\" = $");
    expect(sql).toContain("INSERT INTO audit_log");
    expect(sql).toContain("jsonb_build_object('campo', $");
    expect(sql).toContain("'antes', viejo.valor, 'despues', $");
    expect(sql).toContain("SELECT count(*)::int AS n FROM nuevo");
  });

  it("la auditoría lleva quién lo hizo, el evento, el campo y el valor de después", async () => {
    await patch({ campo: "plazos", valor: PLAZOS });

    const { params } = sentencias[0]!;
    expect(params).toContain(ADMIN_ID);
    expect(params).toContain("tenant.work_settings_updated");
    expect(params).toContain("plazos");
    expect(params.filter((p) => p === JSON.stringify(PLAZOS))).toHaveLength(2);
  });

  it("el inquilino sale de la sesión, no del cuerpo", async () => {
    await patch({ campo: "plazos", valor: [] });

    expect(sentencias[0]!.params.filter((p) => p === TENANT_ID)).toHaveLength(2);
    expect((await patch({ campo: "plazos", valor: [], tenant_id: "otro" })).status).toBe(400);
  });

  it.each(CAMBIOS)("%s: la columna sale de la lista blanca y el valor va como parámetro", async (campo, valor) => {
    await patch({ campo, valor });

    const { sql, params } = sentencias[0]!;
    expect(sql).toContain(`SELECT "${campo}" AS valor`);
    expect(sql).toContain(`SET "${campo}" = $`);
    for (const otro of CAMBIOS.map(([c]) => c).filter((c) => c !== campo)) {
      expect(sql).not.toContain(`"${otro}"`);
    }
    expect(sql).not.toContain(JSON.stringify(valor));
    expect(params).toContain(JSON.stringify(valor));
  });

  it("null vuelve al valor por defecto: NULL de SQL, no un jsonb null", async () => {
    const res = await patch({ campo: "pesos_puntaje", valor: null });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ campo: "pesos_puntaje", valor: null });
    const { params } = sentencias[0]!;
    expect(params.filter((p) => p === null)).toHaveLength(2);
    expect(params).not.toContain("null");
  });

  it("si no había fila del inquilino contesta 404", async () => {
    contesta = { rows: [{ n: 0 }] };

    const res = await patch({ campo: "plazos", valor: [] });

    expect(res.status).toBe(404);
  });

  it.each(["42703", "42P01"])("sin la 0042 (%s) contesta 503 y lo dice", async (code) => {
    falla = Object.assign(new Error("Failed query"), { cause: { code } });

    const res = await patch({ campo: "plazos", valor: [] });

    expect(res.status).toBe(503);
    const { error } = await res.json();
    expect(error.code).toBe("MIGRACION_PENDIENTE");
    expect(error.message).toContain("0042");
  });
});

describe("GET /api/admin/trabajo", () => {
  const GUARDADO = { reglas_asignacion: REGLAS, plazos: null, plan_por_tipo: null, pesos_puntaje: null };
  const CARGA = [{ id: ANALISTA, full_name: "Ana Pérez", role: "analyst", abiertos: 2 }];
  let armado: unknown[];

  beforeEach(() => {
    armado = [];
    m.enTenantVarias.mockImplementation(async (ctx: { tenantId: string }, armar: (db: unknown) => unknown[]) => {
      expect(ctx).toEqual({ tenantId: TENANT_ID });
      if (falla) throw falla;
      armado = armar({
        select: () => ({ from: () => ({ where: () => ({ limit: () => "consulta-del-inquilino" }) }) }),
      });
      return [[GUARDADO], CARGA];
    });
  });

  it("es un solo lote: las cuatro columnas del inquilino y la carga del equipo", async () => {
    await GET();

    expect(m.enTenantVarias).toHaveBeenCalledTimes(1);
    expect(m.enTenant).not.toHaveBeenCalled();
    expect(armado).toEqual(["consulta-del-inquilino", "consulta-de-carga"]);
    expect(m.consultaDeCarga).toHaveBeenCalledTimes(1);
  });

  it("devuelve lo guardado, los valores por defecto, los plazos de la ley y la carga", async () => {
    const res = await GET();

    expect(res.status).toBe(200);
    const cuerpo = await res.json();
    expect(cuerpo.guardado).toEqual(GUARDADO);
    expect(cuerpo.carga).toEqual(CARGA);
    expect(cuerpo.legales).toEqual({ art46: { dias: 3 }, art56: { dias: 30, ancla: "listo_para_core" } });
    expect(cuerpo.porDefecto).toEqual({
      reglas_asignacion: { reglas: [] },
      plazos: [],
      plan_por_tipo: PLAN_POR_DEFECTO,
      pesos_puntaje: PESOS_POR_DEFECTO,
    });
  });

  it("sin fila del inquilino devuelve todo sin configurar", async () => {
    m.enTenantVarias.mockResolvedValue([[], CARGA]);

    const cuerpo = await (await GET()).json();

    expect(cuerpo.guardado).toEqual({
      reglas_asignacion: null,
      plazos: null,
      plan_por_tipo: null,
      pesos_puntaje: null,
    });
  });

  it.each(["42703", "42P01"])("sin la 0042 (%s) contesta 503 y lo dice", async (code) => {
    falla = Object.assign(new Error("Failed query"), { cause: { code } });

    const res = await GET();

    expect(res.status).toBe(503);
    expect((await res.json()).error.message).toContain("0042");
  });
});
