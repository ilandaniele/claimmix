// @vitest-environment node
/**
 * Las piezas de /api/admin/sso que la ruta usa y los tests de la ruta simulan:
 * la consulta de DNS, el cierre de sesiones al exigir SSO y el panel.
 *
 * `cerrarSesionesDelDominio` corre contra el constructor de consultas real de
 * Drizzle con un driver de mentira (pg-proxy): no hay base, pero el SQL que se
 * comprueba es el que viajaría.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

type Consulta = { sql: string; params: unknown[]; method: string };

const h = vi.hoisted(() => ({
  resolveTxt: vi.fn(),
  opciones: [] as unknown[],
  nombres: [] as string[],
  consultas: [] as unknown[],
  filasDelDriver: [] as unknown[][],
  fallaDelDriver: null as unknown,
  filaDelPanel: undefined as Record<string, unknown> | undefined,
  fallaDelPanel: null as unknown,
}));

vi.mock("server-only", () => ({}));

vi.mock("node:dns/promises", () => ({
  Resolver: class {
    constructor(opciones: unknown) {
      h.opciones.push(opciones);
    }
    resolveTxt(nombre: string) {
      h.nombres.push(nombre);
      return h.resolveTxt(nombre);
    }
  },
}));

vi.mock("@/lib/db", async () => {
  const { drizzle } = await import("drizzle-orm/pg-proxy");
  return {
    db: drizzle(async (sql, params, method) => {
      h.consultas.push({ sql, params, method } satisfies Consulta);
      if (h.fallaDelDriver) throw h.fallaDelDriver;
      return { rows: h.filasDelDriver };
    }),
  };
});

vi.mock("@/data/scope", () => ({
  enTenant: vi.fn(async (_ctx: unknown, armar: (db: unknown) => unknown) =>
    armar({
      select: () => ({
        from: () => (h.fallaDelPanel ? Promise.reject(h.fallaDelPanel) : Promise.resolve(h.filaDelPanel ? [h.filaDelPanel] : [])),
      }),
    })
  ),
}));

import { resolverTxt } from "@/server/sso/dominio";
import { armarPanel, panelSso } from "@/server/sso/panel";
import { cerrarSesionesDelDominio } from "@/server/sso/usuarios";

const TENANT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

beforeEach(() => {
  vi.stubEnv("BETTER_AUTH_SECRET", "secreto-de-prueba-para-sso-0123456789");
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://claimmix.example.com");
  h.resolveTxt.mockReset();
  h.opciones = [];
  h.nombres = [];
  h.consultas = [];
  h.filasDelDriver = [];
  h.fallaDelDriver = null;
  h.filaDelPanel = undefined;
  h.fallaDelPanel = null;
});

describe("resolverTxt", () => {
  it("devuelve los registros, con plazo y un solo intento", async () => {
    h.resolveTxt.mockResolvedValue([["claimmix-verificacion=", "abc"], ["v=spf1 -all"]]);
    const r = await resolverTxt("_claimmix.empresa.com");
    expect(r).toEqual({ ok: true, registros: [["claimmix-verificacion=", "abc"], ["v=spf1 -all"]] });
    expect(h.nombres).toEqual(["_claimmix.empresa.com"]);
    expect(h.opciones).toEqual([{ timeout: 4_000, tries: 1 }]);
  });

  it.each(["ENODATA", "ENOTFOUND"])("%s es «sin_registro»: el admin todavía no lo publicó", async (code) => {
    h.resolveTxt.mockRejectedValue(Object.assign(new Error("queryTxt"), { code }));
    expect(await resolverTxt("_claimmix.empresa.com")).toEqual({ ok: false, motivo: "sin_registro" });
  });

  it.each(["ETIMEOUT", "ECONNREFUSED", "ESERVFAIL", "EREFUSED", "ECONNRESET"])(
    "%s es «sin_respuesta»: el DNS no contestó, se puede reintentar",
    async (code) => {
      h.resolveTxt.mockRejectedValue(Object.assign(new Error("queryTxt"), { code }));
      expect(await resolverTxt("_claimmix.empresa.com")).toEqual({ ok: false, motivo: "sin_respuesta" });
    }
  );

  it("un error sin código también es «sin_respuesta», y nunca lanza", async () => {
    h.resolveTxt.mockRejectedValue(new Error("algo raro"));
    await expect(resolverTxt("_claimmix.empresa.com")).resolves.toEqual({ ok: false, motivo: "sin_respuesta" });
  });
});

describe("cerrarSesionesDelDominio", () => {
  it("borra las sesiones de las cuentas del inquilino en el dominio, menos la del admin, y cuenta las cerradas", async () => {
    h.filasDelDriver = [["s1"], ["s2"], ["s3"]];
    const n = await cerrarSesionesDelDominio(TENANT, "empresa.com", "admin-1");

    expect(n).toBe(3);
    expect(h.consultas).toHaveLength(1);
    const [consulta] = h.consultas as Consulta[];
    expect(consulta.sql).toMatch(/^delete from "session" where /);
    expect(consulta.sql).toContain('"session"."user_id" <> $1');
    expect(consulta.sql).toMatch(
      /"session"\."user_id" in \(select "user"\."id" from "user" inner join "users" on "users"\."id" = "user"\."id" where \("users"\."tenant_id" = \$2 and lower\(split_part\("user"\."email", '@', 2\)\) = \$3\)\)/
    );
    expect(consulta.sql).toMatch(/returning "id"$/);
    expect(consulta.params).toEqual(["admin-1", TENANT, "empresa.com"]);
  });

  it("no toca las sesiones de otro inquilino con un mail del mismo dominio: el inquilino es parte del filtro", async () => {
    // Regresión: se cerraban por dominio solo, y la cuenta de B con mail @empresa.com de A quedaba sin sesión.
    await cerrarSesionesDelDominio(TENANT, "empresa.com", "admin-1");
    const [consulta] = h.consultas as Consulta[];
    expect(consulta.sql).toContain('"users"."tenant_id" = $2');
    expect(consulta.params[1]).toBe(TENANT);
  });

  it("el dominio viaja como parámetro, no pegado al SQL", async () => {
    const hostil = "x.com') or 1=1 --";
    await cerrarSesionesDelDominio(TENANT, hostil, "admin-1");
    const [consulta] = h.consultas as Consulta[];
    expect(consulta.sql).not.toContain("1=1");
    expect(consulta.params).toContain(hostil);
  });

  it("sin sesiones que cerrar devuelve 0", async () => {
    h.filasDelDriver = [];
    expect(await cerrarSesionesDelDominio(TENANT, "empresa.com", "admin-1")).toBe(0);
  });

  it("si la base falla, el error sube (la ruta decide qué decir)", async () => {
    h.fallaDelDriver = new Error("connection terminated");
    await expect(cerrarSesionesDelDominio(TENANT, "empresa.com", "admin-1")).rejects.toThrow();
  });

  it("es una sola consulta", async () => {
    h.filasDelDriver = [["s1"]];
    await cerrarSesionesDelDominio(TENANT, "empresa.com", "admin-1");
    expect(h.consultas).toHaveLength(1);
  });
});

describe("armarPanel", () => {
  it("sin fila, todo vacío y apagado, con la dirección de vuelta", () => {
    expect(armarPanel(TENANT, undefined)).toEqual({
      issuer: null,
      client_id: null,
      dominio: null,
      dominio_verificado_en: null,
      activo: false,
      exigir: false,
      tiene_secreto: false,
      registro: null,
      url_de_vuelta: "https://claimmix.example.com/api/auth/sso-inquilino/callback",
      migracion_pendiente: false,
    });
  });

  it("con dominio, arma el registro DNS atado al inquilino", () => {
    const panel = armarPanel(TENANT, { dominio: "empresa.com", issuer: "https://idp.empresa.com", tiene_secreto: true });
    expect(panel.registro?.nombre).toBe("_claimmix.empresa.com");
    expect(panel.registro?.valor).toMatch(/^claimmix-verificacion=[\w-]{43}$/);
    expect(armarPanel("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", { dominio: "empresa.com" }).registro?.valor).not.toBe(panel.registro?.valor);
  });

  it("no tiene dónde llevar un secreto: los campos son siempre los mismos", () => {
    const panel = armarPanel(TENANT, { dominio: "empresa.com", client_secret_cifrado: "NO-SALE" } as never);
    expect(JSON.stringify(panel)).not.toContain("NO-SALE");
    expect(Object.keys(panel).sort()).toEqual(
      [
        "activo",
        "client_id",
        "dominio",
        "dominio_verificado_en",
        "exigir",
        "issuer",
        "migracion_pendiente",
        "registro",
        "tiene_secreto",
        "url_de_vuelta",
      ].sort()
    );
  });

  it("puede avisar que falta la migración", () => {
    expect(armarPanel(TENANT, undefined, true).migracion_pendiente).toBe(true);
  });
});

describe("panelSso", () => {
  it("lee la fila del inquilino y arma el panel", async () => {
    h.filaDelPanel = {
      issuer: "https://idp.empresa.com",
      client_id: "c1",
      dominio: "empresa.com",
      dominio_verificado_en: "2026-09-29T12:00:00.000Z",
      activo: true,
      exigir: false,
      tiene_secreto: true,
    };
    const panel = await panelSso(TENANT);
    expect(panel).toMatchObject({ dominio: "empresa.com", activo: true, tiene_secreto: true, migracion_pendiente: false });
  });

  it("sin fila, el panel vacío", async () => {
    expect(await panelSso(TENANT)).toMatchObject({ issuer: null, activo: false, migracion_pendiente: false });
  });

  it.each(["42P01", "42703"])("falta la 0045 (%s): panel vacío con el aviso, sin lanzar", async (code) => {
    h.fallaDelPanel = Object.assign(new Error("no existe"), { code });
    expect(await panelSso(TENANT)).toMatchObject({ issuer: null, migracion_pendiente: true });
  });

  it("con el error envuelto por Drizzle (`cause`) también", async () => {
    h.fallaDelPanel = Object.assign(new Error("Failed query"), { cause: { code: "42P01" } });
    expect((await panelSso(TENANT)).migracion_pendiente).toBe(true);
  });

  it("cualquier otro error se relanza", async () => {
    h.fallaDelPanel = Object.assign(new Error("connection terminated"), { code: "08006" });
    await expect(panelSso(TENANT)).rejects.toThrow("connection terminated");
  });
});
