/**
 * «Exigir SSO», la baja y el control de inquilino del gancho de sesión.
 *
 * `revisarSesionNueva` se prueba con la consulta de `usuarios.ts` simulada; las
 * consultas mismas (`perfilDelIngreso` y las demás) se prueban contra un `db` de
 * mentira que cuenta cuántas veces se le pregunta.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  perfilDelIngreso: vi.fn(),
  filas: [] as unknown[],
  contextos: [] as unknown[],
  falla: null as unknown,
  /** La falla corta sólo la primera consulta: la segunda devuelve `filas`. */
  fallaUnaVez: false,
  consultas: 0,
}));

/** Lo que devuelve `perfilDelIngreso` para una cuenta activa de T1. */
const perfil = (cambios: Partial<{ tenantId: string; deBaja: boolean; exigeSso: boolean }> = {}) => ({
  tenantId: "T1",
  deBaja: false,
  exigeSso: false,
  ...cambios,
});

vi.mock("server-only", () => ({}));

describe("revisarSesionNueva", () => {
  beforeEach(() => {
    vi.resetModules();
    h.perfilDelIngreso.mockReset();
    vi.doMock("@/server/sso/usuarios", () => ({ perfilDelIngreso: h.perfilDelIngreso }));
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
    h.perfilDelIngreso.mockResolvedValue(perfil({ exigeSso: true }));
    const { revisarSesionNueva } = await cargar();

    expect(await codigoDe(revisarSesionNueva("u1"))).toBe("sso_requerido");
    expect(h.perfilDelIngreso).toHaveBeenCalledTimes(1);
    expect(h.perfilDelIngreso).toHaveBeenCalledWith("u1");
  });

  it("cambiar la contraseña rota la sesión de quien ya estaba adentro, y no la niega", async () => {
    // Regresión: `changePassword` con `revokeOtherSessions` borra las sesiones y crea otra; el gancho
    // la negaba y la persona quedaba afuera de su propia sesión.
    h.perfilDelIngreso.mockResolvedValue(perfil({ exigeSso: true }));
    const { revisarSesionNueva } = await cargar();

    expect(await codigoDe(revisarSesionNueva("u1", "/change-password"))).toBeNull();
  });

  it.each(["/sign-in/email", "/sign-up/email", "/reset-password", undefined])(
    "cualquier otra ruta (%s) sigue sujeta a «exigir»",
    async (ruta) => {
      h.perfilDelIngreso.mockResolvedValue(perfil({ exigeSso: true }));
      const { revisarSesionNueva } = await cargar();

      expect(await codigoDe(revisarSesionNueva("u1", ruta))).toBe("sso_requerido");
    }
  );

  it("fuera del SSO, un dominio que no exige deja pasar, con una sola consulta", async () => {
    h.perfilDelIngreso.mockResolvedValue(perfil());
    const { revisarSesionNueva } = await cargar();

    expect(await codigoDe(revisarSesionNueva("u1"))).toBeNull();
    expect(h.perfilDelIngreso).toHaveBeenCalledTimes(1);
  });

  it("dentro del SSO, la cuenta de su inquilino entra aunque el dominio exija: es el camino que se exige", async () => {
    h.perfilDelIngreso.mockResolvedValue(perfil({ exigeSso: true }));
    const { revisarSesionNueva, enIngresoPorSso } = await cargar();

    const codigo = await codigoDe(enIngresoPorSso({ tenantId: "T1", dominio: "empresa.com" }, () => revisarSesionNueva("u1")));

    expect(codigo).toBeNull();
    expect(h.perfilDelIngreso).toHaveBeenCalledTimes(1);
  });

  it("dentro del SSO, una cuenta de otro inquilino no recibe sesión", async () => {
    h.perfilDelIngreso.mockResolvedValue(perfil({ tenantId: "T2" }));
    const { revisarSesionNueva, enIngresoPorSso } = await cargar();

    const codigo = await codigoDe(enIngresoPorSso({ tenantId: "T1", dominio: "empresa.com" }, () => revisarSesionNueva("u1")));

    expect(codigo).toBe("sso_otro_inquilino");
  });

  it("dentro del SSO, una cuenta sin perfil tampoco", async () => {
    h.perfilDelIngreso.mockResolvedValue(null);
    const { revisarSesionNueva, enIngresoPorSso } = await cargar();

    const codigo = await codigoDe(enIngresoPorSso({ tenantId: "T1", dominio: "empresa.com" }, () => revisarSesionNueva("u1")));

    expect(codigo).toBe("sso_otro_inquilino");
  });

  it.each([
    ["contraseña o Google", undefined],
    ["cambio de contraseña", "/change-password"],
  ])("un usuario dado de baja no recibe sesión por %s", async (_camino, ruta) => {
    h.perfilDelIngreso.mockResolvedValue(perfil({ deBaja: true }));
    const { revisarSesionNueva } = await cargar();

    expect(await codigoDe(revisarSesionNueva("u1", ruta))).toBe("usuario_de_baja");
    expect(h.perfilDelIngreso).toHaveBeenCalledTimes(1);
  });

  it("un usuario dado de baja tampoco entra por el SSO de su propio inquilino", async () => {
    h.perfilDelIngreso.mockResolvedValue(perfil({ deBaja: true }));
    const { revisarSesionNueva, enIngresoPorSso } = await cargar();

    const codigo = await codigoDe(enIngresoPorSso({ tenantId: "T1", dominio: "empresa.com" }, () => revisarSesionNueva("u1")));

    expect(codigo).toBe("usuario_de_baja");
  });

  it("la baja es un 403 con su código y un mensaje para la persona", async () => {
    h.perfilDelIngreso.mockResolvedValue(perfil({ deBaja: true }));
    const { revisarSesionNueva, CODIGO_USUARIO_DE_BAJA } = await cargar();

    const error = await revisarSesionNueva("u1").catch((e: unknown) => e);

    expect(CODIGO_USUARIO_DE_BAJA).toBe("usuario_de_baja");
    expect(error).toMatchObject({ status: "FORBIDDEN", body: { code: CODIGO_USUARIO_DE_BAJA } });
    expect((error as { body: { message: string } }).body.message).toMatch(/dado de baja/);
  });

  it("si la consulta falla, el error sube y no se abre la puerta", async () => {
    h.perfilDelIngreso.mockRejectedValue(new Error("base caída"));
    const { revisarSesionNueva } = await cargar();

    await expect(revisarSesionNueva("u1")).rejects.toThrow("base caída");
  });

  it("los códigos que viajan a /login son los dos que /login sabe decir", async () => {
    const { CODIGO_SSO_REQUERIDO, CODIGO_SSO_OTRO_INQUILINO } = await cargar();
    expect([CODIGO_SSO_REQUERIDO, CODIGO_SSO_OTRO_INQUILINO]).toEqual(["sso_requerido", "sso_otro_inquilino"]);
  });
});

describe("las consultas de usuarios.ts", () => {
  /** Una cadena de Drizzle que termina en `limit` (o en `where`) y cuenta las consultas. */
  function baseSimulada() {
    const terminar = async () => {
      h.consultas++;
      if (h.falla) {
        const falla = h.falla;
        if (h.fallaUnaVez) h.falla = null;
        throw falla;
      }
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
      enControl: async (ctx: unknown, armar: (db: unknown) => unknown) => {
        h.contextos.push(ctx);
        return armar(baseSimulada());
      },
    }));
    h.contextos = [];
    h.filas = [];
    h.falla = null;
    h.fallaUnaVez = false;
    h.consultas = 0;
  });

  it("perfilDelIngreso: inquilino, baja y «exigir» en una sola consulta; sin perfil, null", async () => {
    const { perfilDelIngreso } = await import("@/server/sso/usuarios");

    h.filas = [{ tenant_id: "T1", de_baja: false, exige: true }];
    expect(await perfilDelIngreso("u1")).toEqual({ tenantId: "T1", deBaja: false, exigeSso: true });
    expect(h.consultas).toBe(1);

    h.filas = [{ tenant_id: "T1", de_baja: true, exige: false }];
    expect(await perfilDelIngreso("u1")).toEqual({ tenantId: "T1", deBaja: true, exigeSso: false });

    h.filas = [];
    expect(await perfilDelIngreso("u1")).toBeNull();
    expect(h.consultas).toBe(3);
  });

  it.each(["42P01", "42703"])("perfilDelIngreso: falta de la 0045 (%s) no exige, y la baja se sigue mirando", async (code) => {
    const { perfilDelIngreso } = await import("@/server/sso/usuarios");
    h.falla = Object.assign(new Error("no existe"), { code });
    h.fallaUnaVez = true;
    h.filas = [{ tenant_id: "T1", de_baja: true, exige: false }];

    expect(await perfilDelIngreso("u1")).toEqual({ tenantId: "T1", deBaja: true, exigeSso: false });
    expect(h.consultas).toBe(2);
  });

  it("perfilDelIngreso: si la segunda también falla (sin la 0053), no se abre la puerta", async () => {
    const { perfilDelIngreso } = await import("@/server/sso/usuarios");
    h.falla = Object.assign(new Error("no existe la columna dado_de_baja_en"), { code: "42703" });
    await expect(perfilDelIngreso("u1")).rejects.toThrow("dado_de_baja_en");
  });

  it("perfilDelIngreso: cualquier otro error se relanza", async () => {
    const { perfilDelIngreso } = await import("@/server/sso/usuarios");
    h.falla = Object.assign(new Error("connection terminated"), { code: "08006" });
    await expect(perfilDelIngreso("u1")).rejects.toThrow("connection terminated");
    expect(h.consultas).toBe(1);
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
