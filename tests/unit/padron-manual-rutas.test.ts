/**
 * Alta y edición a mano de clientes y pólizas (B16): POST /api/customers,
 * PATCH /api/customers/:id, POST /api/policies, PATCH /api/policies/:id.
 * Drizzle compila el SQL de verdad (pg-proxy) para leer qué se manda, y el
 * inquilino tiene que salir siempre de la sesión.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { AppError } from "@/lib/errors";

const m = vi.hoisted(() => ({
  entrar: vi.fn(),
  auditar: vi.fn(),
  consultas: [] as { sql: string; params: unknown[] }[],
  tenants: [] as string[],
  filas: [] as unknown[][],
  falla: null as unknown,
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/api/entrada", () => ({ entrar: m.entrar }));
vi.mock("@/lib/i18n/locale", () => ({ resolveAccountLocale: async () => "es-AR" }));
vi.mock("@/lib/audit/log", async (importar) => ({
  ...(await importar<typeof import("@/lib/audit/log")>()),
  writeAuditLog: m.auditar,
}));
vi.mock("@/data/scope", async () => {
  const { drizzle } = await import("drizzle-orm/pg-proxy");
  const db = drizzle(async (sql, params) => {
    m.consultas.push({ sql, params });
    if (m.falla) throw m.falla;
    return { rows: m.filas };
  });
  return {
    enTenant: async (ctx: { tenantId: string }, armar: (d: unknown) => PromiseLike<unknown>) => {
      m.tenants.push(ctx.tenantId);
      return armar(db);
    },
  };
});

import { POST as altaCliente } from "@/app/api/customers/route";
import { PATCH as cambioCliente } from "@/app/api/customers/[id]/route";
import { POST as altaPoliza } from "@/app/api/policies/route";
import { PATCH as cambioPoliza } from "@/app/api/policies/[id]/route";

const TENANT = "10000000-0000-0000-0000-000000000001";
const USER = "20000000-0000-0000-0000-000000000001";
const CLIENTE = "6f1c1a52-0000-4000-8000-000000000001";
const POLIZA = "6f1c1a52-0000-4000-8000-000000000002";
const NUEVO = "6f1c1a52-0000-4000-8000-000000000003";

const sesion = { rol: "admin", permitido: true };

const cuerpo = (datos: unknown, metodo = "POST") =>
  new NextRequest("http://localhost/api/x", {
    method: metodo,
    body: JSON.stringify(datos),
    headers: { "content-type": "application/json" },
  });
const conId = (id: string) => ({ params: Promise.resolve({ id }) });

const VALIDAS = {
  cliente: { nombre: "Ana Pérez", dni: "30.123.456" },
  poliza: { customer_id: CLIENTE, numero: "pol-1" },
};

beforeEach(() => {
  vi.clearAllMocks();
  m.consultas.length = 0;
  m.tenants.length = 0;
  m.filas = [[NUEVO]];
  m.falla = null;
  sesion.rol = "admin";
  sesion.permitido = true;
  m.entrar.mockImplementation(async (_etiqueta: unknown, _cupo: unknown, ...roles: string[]) => {
    if (!roles.includes(sesion.rol)) throw new AppError("FORBIDDEN_ROLE");
    return {
      ctx: { user: { id: USER }, userRow: { id: USER, tenant_id: TENANT, role: sesion.rol, locale: null } },
      rl: { allowed: sesion.permitido },
    };
  });
});

const rutas = [
  ["POST /api/customers", () => altaCliente(cuerpo(VALIDAS.cliente))],
  ["PATCH /api/customers/:id", () => cambioCliente(cuerpo({ email: "ana@x.com" }, "PATCH"), conId(CLIENTE))],
  ["POST /api/policies", () => altaPoliza(cuerpo(VALIDAS.poliza))],
  ["PATCH /api/policies/:id", () => cambioPoliza(cuerpo({ prima: "10" }, "PATCH"), conId(POLIZA))],
] as const;

describe.each(rutas)("%s: puerta", (_nombre, llamar) => {
  it("un analista no escribe", async () => {
    sesion.rol = "analyst";
    expect((await llamar()).status).toBe(403);
    expect(m.consultas).toHaveLength(0);
    expect(m.auditar).not.toHaveBeenCalled();
  });

  it("pasado el cupo, 429 sin tocar la base", async () => {
    sesion.permitido = false;
    expect((await llamar()).status).toBe(429);
    expect(m.consultas).toHaveLength(0);
  });

  it.each(["owner", "admin", "specialist"])("el rol %s escribe, con el inquilino de la sesión", async (rol) => {
    sesion.rol = rol;
    expect((await llamar()).status).toBeLessThan(300);
    expect(m.tenants).toEqual([TENANT]);
  });

  it("pide cupo con la etiqueta propia del padrón", async () => {
    await llamar();
    expect(m.entrar.mock.calls[0]![0]).toBe("padron-escribir");
  });
});

describe("POST /api/customers", () => {
  it("da de alta con DNI normalizado, el inquilino de la sesión, y contesta 201 con el id", async () => {
    const res = await altaCliente(cuerpo(VALIDAS.cliente));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ id: NUEVO });

    expect(m.consultas).toHaveLength(1);
    const { sql, params } = m.consultas[0]!;
    expect(sql).toMatch(/^insert into "customers"/);
    expect(params).toContain(TENANT);
    expect(params).toContain("30123456");
    expect(params).toContain("Ana Pérez");
  });

  it("inserta con el DNI que ya esté guardado en cualquier forma, para que el índice único (sobre el texto crudo) dispare el 23505", async () => {
    await altaCliente(cuerpo(VALIDAS.cliente));
    const { sql, params } = m.consultas[0]!;
    expect(sql).toMatch(
      /values \(default, \$\d+, \$\d+, \$\d+, coalesce\(\(select "customers"\."dni" from "customers" where regexp_replace\(coalesce\("customers"\."dni", ''\), '\[\^0-9\]', '', 'g'\) = \$\d+ limit 1\), \$\d+\)/
    );
    expect(params.filter((p) => p === "30123456")).toHaveLength(2);
  });

  it("un tenant_id en el cuerpo se rechaza y no llega a la base", async () => {
    const res = await altaCliente(cuerpo({ ...VALIDAS.cliente, tenant_id: "otro" }));
    expect(res.status).toBe(400);
    expect(m.consultas).toHaveLength(0);
  });

  it("un dato inválido es 400 con una frase por motivo en `resumen`", async () => {
    const res = await altaCliente(cuerpo({ nombre: "A", dni: "1", email: "x" }));
    const json = await res.json();
    expect(res.status).toBe(400);
    expect(json.error.code).toBe("VALIDATION_FAILED");
    expect(json.resumen).toHaveLength(3);
    expect(json.error.message).toBe(json.resumen[0]);
  });

  it("un cuerpo que no es JSON es 400", async () => {
    const res = await altaCliente(
      new NextRequest("http://localhost/api/customers", { method: "POST", body: "no json", headers: { "content-type": "application/json" } })
    );
    expect(res.status).toBe(400);
    expect(m.consultas).toHaveLength(0);
  });

  it("un DNI que ya existe (23505, que drizzle trae en `cause`) es un dato inválido, no un 409", async () => {
    m.falla = Object.assign(new Error("duplicate key"), { code: "23505" });
    const res = await altaCliente(cuerpo(VALIDAS.cliente));
    const json = await res.json();
    expect(res.status).toBe(400);
    expect(json.error.code).toBe("VALIDATION_FAILED");
    expect(json.resumen).toEqual(["Ya hay un cliente con ese DNI."]);
    expect(m.auditar).not.toHaveBeenCalled();
  });

  it("otro error de la base es 500, no un rechazo", async () => {
    m.falla = Object.assign(new Error("boom"), { code: "57014" });
    expect((await altaCliente(cuerpo(VALIDAS.cliente))).status).toBe(500);
  });

  it("audita el alta con los NOMBRES de los campos, nunca los valores", async () => {
    await altaCliente(cuerpo({ ...VALIDAS.cliente, email: "ana@x.com", telefono: "291 642-6930" }));
    expect(m.auditar).toHaveBeenCalledTimes(1);
    const fila = m.auditar.mock.calls[0]![0];
    expect(fila).toMatchObject({
      tenant_id: TENANT,
      actor_id: USER,
      event_type: "customer.created",
      target_type: "customer",
      target_id: NUEVO,
    });
    expect(fila.payload).toEqual({ campos: ["nombre", "dni", "email", "telefono"] });
    const todo = JSON.stringify(fila);
    expect(todo).not.toContain("30123456");
    expect(todo).not.toContain("ana@x.com");
  });
});

describe("PATCH /api/customers/:id", () => {
  it("cambia sólo lo que vino, con updated_at, acotado por id, y audita los campos", async () => {
    const res = await cambioCliente(cuerpo({ telefono: "291 642-6930" }, "PATCH"), conId(CLIENTE));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: NUEVO });

    const { sql, params } = m.consultas[0]!;
    expect(sql).toMatch(/^update "customers" set "phone" = \$1, "updated_at" = now\(\) where "customers"\."id" = \$2/);
    expect(params).toEqual(["291 642-6930", CLIENTE]);
    expect(m.auditar.mock.calls[0]![0]).toMatchObject({ event_type: "customer.updated", target_id: NUEVO });
    expect(m.auditar.mock.calls[0]![0].payload).toEqual({ campos: ["telefono"] });
  });

  it("un campo vacío borra el dato", async () => {
    await cambioCliente(cuerpo({ email: "" }, "PATCH"), conId(CLIENTE));
    expect(m.consultas[0]!.params).toEqual([null, CLIENTE]);
  });

  it("sin nada que cambiar es 400 y no toca la base", async () => {
    for (const vacio of [{}, { nombre: "" }]) {
      const res = await cambioCliente(cuerpo(vacio, "PATCH"), conId(CLIENTE));
      expect(res.status).toBe(400);
      expect((await res.json()).resumen).toEqual(["No hay nada para cambiar."]);
    }
    expect(m.consultas).toHaveLength(0);
  });

  it("el DNI y el tenant_id no se cambian: se rechazan", async () => {
    expect((await cambioCliente(cuerpo({ dni: "30123456" }, "PATCH"), conId(CLIENTE))).status).toBe(400);
    expect((await cambioCliente(cuerpo({ tenant_id: "otro" }, "PATCH"), conId(CLIENTE))).status).toBe(400);
    expect(m.consultas).toHaveLength(0);
  });

  it("un id que no es uuid es 404 sin tocar la base", async () => {
    const res = await cambioCliente(cuerpo({ email: "ana@x.com" }, "PATCH"), conId("no-es-uuid"));
    expect(res.status).toBe(404);
    expect(m.consultas).toHaveLength(0);
  });

  it("un cliente de otro inquilino (RLS no devuelve la fila) es 404 y no se audita", async () => {
    m.filas = [];
    const res = await cambioCliente(cuerpo({ email: "ana@x.com" }, "PATCH"), conId(CLIENTE));
    expect(res.status).toBe(404);
    expect((await res.json()).resumen).toEqual(["Ese cliente no existe."]);
    expect(m.auditar).not.toHaveBeenCalled();
  });
});

describe("POST /api/policies", () => {
  it("inserta desde un SELECT sobre customers, acotado por el cliente, y contesta 201", async () => {
    const res = await altaPoliza(cuerpo({ ...VALIDAS.poliza, ramo: "auto", prima: "1.234,50" }));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ id: NUEVO });

    const { sql, params } = m.consultas[0]!;
    expect(sql).toMatch(/^insert into "policies" .* select .* from "customers" where "customers"\."id" = \$\d+/);
    expect(sql).not.toMatch(/\bvalues\b/);
    expect(params).toContain("POL-1");
    expect(params).toContain("auto");
    expect(params).toContain("1234.50");
    expect(params).toContain(CLIENTE);
  });

  it("inserta con el número que ya esté guardado en cualquier forma, para que el índice único dispare el 23505", async () => {
    await altaPoliza(cuerpo(VALIDAS.poliza));
    const { sql, params } = m.consultas[0]!;
    expect(sql).toMatch(
      /coalesce\(\(select "policy_number" from "policies" where upper\(replace\("policies"\."policy_number", ' ', ''\)\) = \$\d+ limit 1\), \$\d+\) as "policy_number"/
    );
    expect(params.filter((p) => p === "POL-1")).toHaveLength(2);
  });

  it("sin ramo ni estado queda «other» y activa", async () => {
    await altaPoliza(cuerpo(VALIDAS.poliza));
    const { params } = m.consultas[0]!;
    expect(params).toContain("other");
    expect(params).toContain("active");
  });

  it("un cliente de otro inquilino (el SELECT no trae nada) es 400 y no se audita", async () => {
    m.filas = [];
    const res = await altaPoliza(cuerpo(VALIDAS.poliza));
    expect(res.status).toBe(400);
    expect((await res.json()).resumen).toEqual(["Ese cliente no existe."]);
    expect(m.auditar).not.toHaveBeenCalled();
  });

  it("un número que ya existe (23505) es un dato inválido, no un 409", async () => {
    m.falla = Object.assign(new Error("duplicate key"), { code: "23505" });
    const res = await altaPoliza(cuerpo(VALIDAS.poliza));
    expect(res.status).toBe(400);
    expect((await res.json()).resumen).toEqual(["Ya hay una póliza con ese número."]);
  });

  it("rechaza el tenant_id, un ramo desconocido y un cliente que no es uuid", async () => {
    for (const malo of [
      { ...VALIDAS.poliza, tenant_id: "otro" },
      { ...VALIDAS.poliza, ramo: "moto" },
      { ...VALIDAS.poliza, customer_id: "no-es-uuid" },
    ]) {
      expect((await altaPoliza(cuerpo(malo))).status).toBe(400);
    }
    expect(m.consultas).toHaveLength(0);
  });

  it("audita el alta con los nombres de los campos y no con el número de póliza", async () => {
    await altaPoliza(cuerpo({ ...VALIDAS.poliza, ramo: "auto" }));
    const fila = m.auditar.mock.calls[0]![0];
    expect(fila).toMatchObject({ event_type: "policy.created", target_type: "policy", target_id: NUEVO });
    expect(fila.payload).toEqual({ campos: ["customer_id", "numero", "ramo"] });
    expect(JSON.stringify(fila)).not.toContain("POL-1");
  });
});

describe("PATCH /api/policies/:id", () => {
  it("cambia sólo lo que vino, acotado por id, y audita los campos", async () => {
    const res = await cambioPoliza(cuerpo({ estado: "expired", prima: "" }, "PATCH"), conId(POLIZA));
    expect(res.status).toBe(200);

    const { sql, params } = m.consultas[0]!;
    expect(sql).toMatch(/^update "policies" set .* "updated_at" = now\(\) where "policies"\."id" = \$\d+/);
    expect(params).toContain("expired");
    expect(params).toContain(null);
    expect(params).toContain(POLIZA);
    expect(m.auditar.mock.calls[0]![0].payload).toEqual({ campos: ["estado", "prima"] });
  });

  it("la vigencia va entera: una sola fecha es 400", async () => {
    const res = await cambioPoliza(cuerpo({ desde: "2025-01-01" }, "PATCH"), conId(POLIZA));
    expect(res.status).toBe(400);
    expect(m.consultas).toHaveLength(0);
  });

  it("no cambia el número ni el titular", async () => {
    expect((await cambioPoliza(cuerpo({ numero: "P2" }, "PATCH"), conId(POLIZA))).status).toBe(400);
    expect((await cambioPoliza(cuerpo({ customer_id: CLIENTE }, "PATCH"), conId(POLIZA))).status).toBe(400);
    expect(m.consultas).toHaveLength(0);
  });

  it("sin nada que cambiar es 400", async () => {
    expect((await cambioPoliza(cuerpo({ ramo: "", estado: "" }, "PATCH"), conId(POLIZA))).status).toBe(400);
    expect(m.consultas).toHaveLength(0);
  });

  it("un id que no es uuid, o una póliza de otro inquilino, es 404", async () => {
    expect((await cambioPoliza(cuerpo({ prima: "10" }, "PATCH"), conId("nada"))).status).toBe(404);
    m.filas = [];
    const res = await cambioPoliza(cuerpo({ prima: "10" }, "PATCH"), conId(POLIZA));
    expect(res.status).toBe(404);
    expect(m.auditar).not.toHaveBeenCalled();
  });
});
