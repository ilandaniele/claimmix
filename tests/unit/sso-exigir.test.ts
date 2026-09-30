// @vitest-environment node
/**
 * «Exigir SSO» y el control de inquilino del gancho de sesión.
 *
 * `revisarSesionNueva` se prueba con las consultas de `usuarios.ts` simuladas;
 * las consultas mismas (`dominioExigeSso`, `inquilinoDelUsuario`) se prueban
 * contra un `db` de mentira que cuenta cuántas veces se le pregunta.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  dominioExigeSso: vi.fn(),
  correoExigeSso: vi.fn(),
  inquilinoDelUsuario: vi.fn(),
  filas: [] as unknown[],
  contextos: [] as unknown[],
  falla: null as unknown,
  consultas: 0,
}));

vi.mock("server-only", () => ({}));

describe("revisarSesionNueva", () => {
  beforeEach(() => {
    vi.resetModules();
    h.dominioExigeSso.mockReset();
    h.correoExigeSso.mockReset();
    h.inquilinoDelUsuario.mockReset();
    vi.doMock("@/server/sso/usuarios", () => ({
      dominioExigeSso: h.dominioExigeSso,
      correoExigeSso: h.correoExigeSso,
      inquilinoDelUsuario: h.inquilinoDelUsuario,
    }));
  });

  async function cargar() {
    const exigir = await import("@/server/sso/exigir");
    const registro = await import("@/lib/auth/registro-permitido");
    return { ...exigir, ...registro };
  }

  async function codigoDe(promesa: Promise<unknown>): Promise<string | null> {
    try {
      await promesa;
      return null;
    } catch (e) {
      return String((e as { body?: { code?: string } }).body?.code ?? "sin_codigo");
    }
  }

  it("fuera del SSO, un dominio que exige SSO no recibe sesión", async () => {
    h.dominioExigeSso.mockResolvedValue(true);
    const { revisarSesionNueva } = await cargar();

    expect(await codigoDe(revisarSesionNueva("u1"))).toBe("sso_requerido");
    expect(h.dominioExigeSso).toHaveBeenCalledTimes(1);
    expect(h.dominioExigeSso).toHaveBeenCalledWith("u1");
    expect(h.inquilinoDelUsuario).not.toHaveBeenCalled();
  });

  it("el alta de un admin no es un ingreso: crea la sesión de la cuenta recién hecha sin consultar «exigir»", async () => {
    // Regresión: con «exigir» el gancho tiraba después de crear usuario y cuenta, y el alta quedaba a medias.
    h.dominioExigeSso.mockResolvedValue(true);
    const { revisarSesionNueva, enAltaDeAdmin } = await cargar();

    expect(await codigoDe(enAltaDeAdmin(() => revisarSesionNueva("u1")))).toBeNull();
    expect(h.dominioExigeSso).not.toHaveBeenCalled();
  });

  it("cambiar la contraseña rota la sesión de quien ya estaba adentro, y no la niega", async () => {
    // Regresión: `changePassword` con `revokeOtherSessions` borra las sesiones y crea otra; el gancho
    // la negaba y la persona quedaba afuera de su propia sesión.
    h.dominioExigeSso.mockResolvedValue(true);
    const { revisarSesionNueva } = await cargar();

    expect(await codigoDe(revisarSesionNueva("u1", "/change-password"))).toBeNull();
    expect(h.dominioExigeSso).not.toHaveBeenCalled();
  });

  it.each(["/sign-in/email", "/sign-up/email", "/reset-password", undefined])(
    "cualquier otra ruta (%s) sigue sujeta a «exigir»",
    async (ruta) => {
      h.dominioExigeSso.mockResolvedValue(true);
      const { revisarSesionNueva } = await cargar();

      expect(await codigoDe(revisarSesionNueva("u1", ruta))).toBe("sso_requerido");
    }
  );

  it("fuera del SSO, un dominio que no exige deja pasar, con una sola consulta", async () => {
    h.dominioExigeSso.mockResolvedValue(false);
    const { revisarSesionNueva } = await cargar();

    expect(await codigoDe(revisarSesionNueva("u1"))).toBeNull();
    expect(h.dominioExigeSso).toHaveBeenCalledTimes(1);
  });

  it("dentro del SSO no se consulta «exigir»: es justamente el camino que se exige", async () => {
    h.inquilinoDelUsuario.mockResolvedValue("T1");
    const { revisarSesionNueva, enIngresoPorSso } = await cargar();

    const codigo = await codigoDe(enIngresoPorSso({ tenantId: "T1", dominio: "empresa.com" }, () => revisarSesionNueva("u1")));

    expect(codigo).toBeNull();
    expect(h.dominioExigeSso).not.toHaveBeenCalled();
    expect(h.inquilinoDelUsuario).toHaveBeenCalledTimes(1);
  });

  it("dentro del SSO, una cuenta de otro inquilino no recibe sesión", async () => {
    h.inquilinoDelUsuario.mockResolvedValue("T2");
    const { revisarSesionNueva, enIngresoPorSso } = await cargar();

    const codigo = await codigoDe(enIngresoPorSso({ tenantId: "T1", dominio: "empresa.com" }, () => revisarSesionNueva("u1")));

    expect(codigo).toBe("sso_otro_inquilino");
  });

  it("dentro del SSO, una cuenta sin perfil tampoco", async () => {
    h.inquilinoDelUsuario.mockResolvedValue(null);
    const { revisarSesionNueva, enIngresoPorSso } = await cargar();

    const codigo = await codigoDe(enIngresoPorSso({ tenantId: "T1", dominio: "empresa.com" }, () => revisarSesionNueva("u1")));

    expect(codigo).toBe("sso_otro_inquilino");
  });

  it("si la consulta falla, el error sube y no se abre la puerta", async () => {
    h.dominioExigeSso.mockRejectedValue(new Error("base caída"));
    const { revisarSesionNueva } = await cargar();

    await expect(revisarSesionNueva("u1")).rejects.toThrow("base caída");
  });

  it("los códigos que viajan a /login son los dos que /login sabe decir", async () => {
    const { CODIGO_SSO_REQUERIDO, CODIGO_SSO_OTRO_INQUILINO } = await cargar();
    expect([CODIGO_SSO_REQUERIDO, CODIGO_SSO_OTRO_INQUILINO]).toEqual(["sso_requerido", "sso_otro_inquilino"]);
  });
});

describe("altaBloqueadaPorSso", () => {
  beforeEach(() => {
    vi.resetModules();
    h.correoExigeSso.mockReset();
    vi.doMock("@/server/sso/usuarios", () => ({
      dominioExigeSso: h.dominioExigeSso,
      correoExigeSso: h.correoExigeSso,
      inquilinoDelUsuario: h.inquilinoDelUsuario,
    }));
  });

  async function cargar() {
    const exigir = await import("@/server/sso/exigir");
    const registro = await import("@/lib/auth/registro-permitido");
    return { ...exigir, ...registro };
  }

  it("un mail de un dominio que exige SSO no puede darse de alta por contraseña", async () => {
    h.correoExigeSso.mockResolvedValue(true);
    const { altaBloqueadaPorSso } = await cargar();

    expect(await altaBloqueadaPorSso("pepe@empresa.com", "T1")).toBe(true);
    expect(h.correoExigeSso).toHaveBeenCalledWith("pepe@empresa.com", "T1");
  });

  it("un mail de otro dominio sí", async () => {
    h.correoExigeSso.mockResolvedValue(false);
    const { altaBloqueadaPorSso } = await cargar();

    expect(await altaBloqueadaPorSso("pepe@otra.com", "T1")).toBe(false);
  });

  it("pregunta por el inquilino donde aterriza el alta: «exigir» de otro no la frena", async () => {
    // Regresión: se preguntaba sólo por dominio, y «exigir» de A frenaba altas que aterrizan en B.
    h.correoExigeSso.mockImplementation(async (_email: string, tenantId: string) => tenantId === "A");
    const { altaBloqueadaPorSso } = await cargar();

    expect(await altaBloqueadaPorSso("pepe@empresa.com", "A")).toBe(true);
    expect(await altaBloqueadaPorSso("pepe@empresa.com", "B")).toBe(false);
  });

  it("sin inquilino por defecto no hay perfil que crear y no se pregunta", async () => {
    h.correoExigeSso.mockResolvedValue(true);
    const { altaBloqueadaPorSso } = await cargar();

    expect(await altaBloqueadaPorSso("pepe@empresa.com", null)).toBe(false);
    expect(h.correoExigeSso).not.toHaveBeenCalled();
  });

  it("el alta de un admin y el SSO del propio inquilino pasan sin consulta", async () => {
    h.correoExigeSso.mockResolvedValue(true);
    const { altaBloqueadaPorSso, enAltaDeAdmin, enIngresoPorSso } = await cargar();

    expect(await enAltaDeAdmin(() => altaBloqueadaPorSso("pepe@empresa.com", "T1"))).toBe(false);
    expect(
      await enIngresoPorSso({ tenantId: "T1", dominio: "empresa.com" }, () => altaBloqueadaPorSso("pepe@empresa.com", "T1"))
    ).toBe(false);
    expect(h.correoExigeSso).not.toHaveBeenCalled();
  });
});

describe("las consultas de usuarios.ts", () => {
  /** Una cadena de Drizzle que termina en `limit` (o en `where`) y cuenta las consultas. */
  function baseSimulada() {
    const terminar = async () => {
      h.consultas++;
      if (h.falla) throw h.falla;
      return h.filas;
    };
    const cadena: Record<string, unknown> = {};
    for (const m of ["from", "leftJoin", "innerJoin", "where"]) cadena[m] = () => cadena;
    cadena.limit = terminar;
    return { select: () => cadena };
  }

  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("@/server/sso/usuarios");
    vi.doMock("@/lib/db", () => ({ db: baseSimulada() }));
    vi.doMock("@/data/scope", () => ({
      enTenant: async (ctx: unknown, armar: (db: unknown) => unknown) => {
        h.contextos.push(ctx);
        return armar(baseSimulada());
      },
    }));
    h.contextos = [];
    h.filas = [];
    h.falla = null;
    h.consultas = 0;
  });

  it("dominioExigeSso: con fila, exige; sin fila, no; una sola consulta", async () => {
    const { dominioExigeSso } = await import("@/server/sso/usuarios");

    h.filas = [{ uno: 1 }];
    expect(await dominioExigeSso("u1")).toBe(true);
    expect(h.consultas).toBe(1);

    h.filas = [];
    expect(await dominioExigeSso("u1")).toBe(false);
    expect(h.consultas).toBe(2);
  });

  it.each(["42P01", "42703"])("dominioExigeSso: falta de la 0045 (%s) deja pasar", async (code) => {
    const { dominioExigeSso } = await import("@/server/sso/usuarios");
    h.falla = Object.assign(new Error("no existe"), { code });
    expect(await dominioExigeSso("u1")).toBe(false);
  });

  it("dominioExigeSso: cualquier otro error se relanza", async () => {
    const { dominioExigeSso } = await import("@/server/sso/usuarios");
    h.falla = Object.assign(new Error("connection terminated"), { code: "08006" });
    await expect(dominioExigeSso("u1")).rejects.toThrow("connection terminated");
  });

  it("inquilinoDelUsuario: devuelve el inquilino del perfil, o null si no hay perfil", async () => {
    const { inquilinoDelUsuario } = await import("@/server/sso/usuarios");

    h.filas = [{ tenant_id: "T1" }];
    expect(await inquilinoDelUsuario("u1")).toBe("T1");

    h.filas = [];
    expect(await inquilinoDelUsuario("u1")).toBeNull();
    expect(h.consultas).toBe(2);
  });

  it("duenoDelMail: distingue «no existe», «de un inquilino» y «sin perfil»", async () => {
    const { duenoDelMail } = await import("@/server/sso/usuarios");

    h.filas = [];
    expect(await duenoDelMail("a@b.com", "T1")).toEqual({ existe: false });

    h.filas = [{ id: "u1", tenant_id: "T1", huerfana_de_sso: false }];
    expect(await duenoDelMail("a@b.com", "T1")).toEqual({ existe: true, userId: "u1", tenantId: "T1", huerfanaDeSso: false });

    h.filas = [{ id: "u2", tenant_id: null, huerfana_de_sso: false }];
    expect(await duenoDelMail("a@b.com", "T1")).toEqual({ existe: true, userId: "u2", tenantId: null, huerfanaDeSso: false });
    expect(h.consultas).toBe(3);
  });

  it("correoExigeSso: con fila, exige; sin fila, no; sin dominio ni pregunta; falta de la 0045 deja pasar", async () => {
    const { correoExigeSso } = await import("@/server/sso/usuarios");

    h.filas = [{ uno: 1 }];
    expect(await correoExigeSso("a@empresa.com", "T1")).toBe(true);
    h.filas = [];
    expect(await correoExigeSso("a@empresa.com", "T1")).toBe(false);
    expect(h.consultas).toBe(2);

    expect(await correoExigeSso("sin-arroba", "T1")).toBe(false);
    expect(h.consultas).toBe(2);
    // Va por la capa de datos, en el contexto del inquilino: lo demás lo pone RLS.
    expect(h.contextos).toEqual([{ tenantId: "T1" }, { tenantId: "T1" }]);

    h.falla = Object.assign(new Error("no existe"), { code: "42P01" });
    expect(await correoExigeSso("a@empresa.com", "T1")).toBe(false);

    h.falla = Object.assign(new Error("connection terminated"), { code: "08006" });
    await expect(correoExigeSso("a@empresa.com", "T1")).rejects.toThrow("connection terminated");
  });
});
