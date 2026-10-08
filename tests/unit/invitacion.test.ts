/**
 * La invitación: el valor sellado del enlace y las dos consultas que lo usan.
 *
 * El sellado se prueba de verdad (AES-GCM con la clave derivada de
 * BETTER_AUTH_SECRET). Las consultas se prueban hasta donde se puede sin base: el
 * contexto de inquilino con que corren, los parámetros que mandan y el SQL que
 * arman. Que con el contexto de otro inquilino la base no inserte nada lo prueba
 * `scripts/prove-tenancy.mts`, contra la base de verdad.
 */
import { PgDialect } from "drizzle-orm/pg-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  enTenant: vi.fn(),
  ejecutadas: [] as unknown[],
  filas: [] as unknown[],
  exigeSso: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/data/scope", () => ({ enTenant: h.enTenant }));
vi.mock("@/server/sso/usuarios", () => ({ correoExigeSso: h.exigeSso }));

import {
  abrirInvitacion,
  aceptarInvitacion,
  DURACION_DE_LA_INVITACION_MS,
  puedeInvitar,
  resumenDeInvitacion,
  sellarInvitacion,
  type DatosDeInvitacion,
} from "@/server/alta/invitacion";
import { sellar } from "@/server/alta/sellado";

const ESPACIO = "aaaaaaaa-0000-4000-8000-00000000000a";
const OTRO_ESPACIO = "cccccccc-0000-4000-8000-00000000000c";
const ADMIN = "bbbbbbbb-0000-4000-8000-00000000000b";
const PERSONA = "dddddddd-0000-4000-8000-00000000000d";

const base = { t: ESPACIO, e: "lucia@example.com", r: "analyst", n: "Lucía Fernández", i: ADMIN } as const;

const datos = (over: Partial<DatosDeInvitacion> = {}): DatosDeInvitacion => ({
  ...base,
  exp: Date.now() + 1000,
  ...over,
});

beforeEach(() => {
  vi.stubEnv("BETTER_AUTH_SECRET", "test-better-auth-secret-key");
  h.ejecutadas.length = 0;
  h.filas = [];
  h.exigeSso.mockReset();
  h.exigeSso.mockResolvedValue(false);
  h.enTenant.mockImplementation(async (ctx: unknown, armar: (db: unknown) => unknown) => {
    h.ejecutadas.push(ctx);
    return armar({
      execute: async (consulta: unknown) => {
        h.ejecutadas.push(consulta);
        return h.filas;
      },
    });
  });
});

afterEach(() => vi.unstubAllEnvs());

describe("el valor sellado", () => {
  it("se abre y devuelve lo que se selló, con la dirección en minúsculas y el vencimiento a 72 horas", () => {
    const ahora = 1_800_000_000_000;
    const valor = sellarInvitacion({ ...base, e: "Lucia@Example.com" }, ahora);

    expect(abrirInvitacion(valor, ahora + 1000)).toEqual({
      ...base,
      exp: ahora + DURACION_DE_LA_INVITACION_MS,
    });
    expect(DURACION_DE_LA_INVITACION_MS).toBe(72 * 60 * 60 * 1000);
  });

  it("no lleva la dirección a la vista: va cifrado, no sólo firmado", () => {
    const valor = sellarInvitacion(base);

    expect(valor).not.toContain("lucia");
    expect(Buffer.from(valor, "base64url").toString("utf8")).not.toContain("lucia");
  });

  it("vencido no abre", () => {
    const ahora = 1_800_000_000_000;
    const valor = sellarInvitacion(base, ahora);

    expect(abrirInvitacion(valor, ahora + DURACION_DE_LA_INVITACION_MS - 1)).not.toBeNull();
    expect(abrirInvitacion(valor, ahora + DURACION_DE_LA_INVITACION_MS)).toBeNull();
  });

  it("adulterado no abre, en ninguna de sus partes", () => {
    const valor = sellarInvitacion(base);
    const partes = valor.split(".");

    for (let i = 1; i < partes.length; i++) {
      const cambiada = [...partes];
      // El primer carácter: el último de un base64url puede traer bits de relleno que no cambian los bytes.
      cambiada[i] = `${partes[i].startsWith("A") ? "B" : "A"}${partes[i].slice(1)}`;
      expect(abrirInvitacion(cambiada.join(".")), `parte ${i}`).toBeNull();
    }
    expect(abrirInvitacion(`${valor}.x`)).toBeNull();
  });

  it("sellado con otra clave no abre", () => {
    const valor = sellarInvitacion(base);
    vi.stubEnv("BETTER_AUTH_SECRET", "test-otro-secreto-distinto-1234");

    expect(abrirInvitacion(valor)).toBeNull();
  });

  it("un valor sellado para otra cosa no sirve de invitación", () => {
    for (const info of ["alta", "registro", "cm_alta"]) {
      expect(abrirInvitacion(sellar(info, datos())), info).toBeNull();
    }
  });

  it("lo que no es un texto, o no tiene la forma, no abre", () => {
    for (const malo of [undefined, null, 42, {}, "", "basura", "v1.a.b.c"]) {
      expect(abrirInvitacion(malo), String(malo)).toBeNull();
    }
    const casos: Partial<DatosDeInvitacion>[] = [
      { t: "no-es-un-uuid" },
      { i: "no-es-un-uuid" },
      { r: "superusuario" as never },
      { e: "no-es-un-mail" },
      { n: "" },
      { exp: "mañana" as never },
    ];
    for (const caso of casos) {
      expect(abrirInvitacion(sellar("invitacion", datos(caso))), JSON.stringify(caso)).toBeNull();
    }
  });

  it("sin BETTER_AUTH_SECRET no se puede sellar", () => {
    vi.stubEnv("BETTER_AUTH_SECRET", "");

    expect(() => sellarInvitacion(base)).toThrow();
  });
});

describe("puedeInvitar", () => {
  it("un owner invita a cualquier rol; un admin, a todos menos a un owner; el resto, a nadie", () => {
    expect(puedeInvitar("owner", "owner")).toBe(true);
    expect(puedeInvitar("owner", "viewer")).toBe(true);
    expect(puedeInvitar("admin", "analyst")).toBe(true);
    expect(puedeInvitar("admin", "admin")).toBe(true);
    expect(puedeInvitar("admin", "owner")).toBe(false);
    for (const rol of ["specialist", "analyst", "viewer", "", null, undefined]) {
      expect(puedeInvitar(rol, "viewer"), String(rol)).toBe(false);
    }
  });
});

describe("aceptarInvitacion", () => {
  const quien = { userId: PERSONA, ip: "203.0.113.9", ua: "vitest" };
  const compilar = (consulta: unknown) => new PgDialect().sqlToQuery(consulta as never);

  it("corre con el espacio del enlace como contexto y manda una sola sentencia", async () => {
    h.filas = [{ id: PERSONA }];

    const aceptada = await aceptarInvitacion(datos(), quien);

    expect(aceptada).toBe(true);
    expect(h.enTenant).toHaveBeenCalledOnce();
    expect(h.ejecutadas[0]).toEqual({ tenantId: ESPACIO });
    expect(h.ejecutadas).toHaveLength(2);
  });

  it("inserta sólo si quien invitó sigue siendo admin u owner del espacio y el espacio está activo", async () => {
    await aceptarInvitacion(datos(), quien);

    const { sql, params } = compilar(h.ejecutadas[1]);
    expect(sql).toMatch(/insert into public\.users/i);
    expect(sql).toMatch(/i\.role = 'owner' or \(i\.role = 'admin' and \$\d+::text <> 'owner'\)/);
    expect(sql).toMatch(/billing_status not in \('suspended', 'churned'\)/);
    expect(sql).toMatch(/on conflict \(id\) do nothing/i);
    // El asiento sale de la fila insertada: sin perfil nuevo no hay asiento.
    expect(sql).toMatch(/insert into public\.audit_log[\s\S]*from nuevo/i);
    expect(params).toEqual(expect.arrayContaining([PERSONA, ESPACIO, ADMIN, "analyst", "Lucía Fernández"]));
  });

  it("el único espacio que escribe es el del enlace", async () => {
    await aceptarInvitacion(datos(), quien);

    const { sql, params } = compilar(h.ejecutadas[1]);
    const uuids = params.filter((p) => typeof p === "string" && /^[0-9a-f]{8}-/.test(p));
    expect(new Set(uuids)).toEqual(new Set([PERSONA, ESPACIO, ADMIN]));
    expect(sql).not.toMatch(/update |delete /i);
    expect(sql).not.toMatch(/insert into public\.tenants/i);
  });

  it("sin fila insertada —quien invitó perdió el rol, el espacio no está activo o la persona ya tenía perfil— da false", async () => {
    h.filas = [];

    expect(await aceptarInvitacion(datos(), quien)).toBe(false);
  });

  it("entiende el resultado del driver, sea un arreglo o { rows }", async () => {
    h.filas = { rows: [{ id: PERSONA }] } as never;
    expect(await aceptarInvitacion(datos(), quien)).toBe(true);

    h.filas = { rows: [] } as never;
    expect(await aceptarInvitacion(datos(), quien)).toBe(false);
  });

  it("el asiento no lleva la dirección: sólo el rol", async () => {
    await aceptarInvitacion(datos(), quien);

    const { params } = compilar(h.ejecutadas[1]);
    expect(JSON.stringify(params)).not.toContain("lucia@example.com");
    expect(params).toContain(JSON.stringify({ rol: "analyst" }));
  });

  it("si la base falla, tira: no se confunde con una invitación rechazada", async () => {
    h.enTenant.mockRejectedValue(new Error("base caída"));

    await expect(aceptarInvitacion(datos(), quien)).rejects.toThrow("base caída");
  });
});

describe("resumenDeInvitacion", () => {
  const fila = { espacio: "Seguros Ejemplo", estado: "active", quien: "Jefa Ejemplo", rol_de_quien: "admin" };

  it("pregunta con el espacio del enlace y devuelve el nombre del espacio y de quien invita", async () => {
    h.filas = [fila];

    expect(await resumenDeInvitacion(datos())).toEqual({
      espacio: "Seguros Ejemplo",
      quien: "Jefa Ejemplo",
      exigeSso: false,
    });
    expect(h.ejecutadas[0]).toEqual({ tenantId: ESPACIO });
  });

  it("dice si el espacio del enlace exige el SSO para el dominio de la dirección invitada", async () => {
    h.filas = [fila];
    h.exigeSso.mockResolvedValue(true);

    expect((await resumenDeInvitacion(datos()))?.exigeSso).toBe(true);
    expect(h.exigeSso).toHaveBeenCalledWith("lucia@example.com", ESPACIO);
  });

  it("con una invitación que no sirve no mira el SSO", async () => {
    h.filas = [{ ...fila, estado: "suspended" }];

    expect(await resumenDeInvitacion(datos())).toBeNull();
    expect(h.exigeSso).not.toHaveBeenCalled();
  });

  it("es null si el espacio no existe o quien invitó ya no está", async () => {
    h.filas = [];
    expect(await resumenDeInvitacion(datos())).toBeNull();

    h.filas = [{ ...fila, quien: null, rol_de_quien: null }];
    expect(await resumenDeInvitacion(datos())).toBeNull();
  });

  it("es null si el espacio está suspendido o dado de baja", async () => {
    for (const estado of ["suspended", "churned"]) {
      h.filas = [{ ...fila, estado }];
      expect(await resumenDeInvitacion(datos()), estado).toBeNull();
    }
  });

  it("es null si quien invitó ya no puede invitar con ese rol", async () => {
    h.filas = [{ ...fila, rol_de_quien: "analyst" }];
    expect(await resumenDeInvitacion(datos())).toBeNull();

    h.filas = [{ ...fila, rol_de_quien: "admin" }];
    expect(await resumenDeInvitacion(datos({ r: "owner" }))).toBeNull();

    h.filas = [{ ...fila, rol_de_quien: "owner" }];
    expect(await resumenDeInvitacion(datos({ r: "owner" }))).not.toBeNull();
  });

  it("nunca pregunta por otro espacio que el del enlace", async () => {
    h.filas = [fila];
    await resumenDeInvitacion(datos());

    const { params } = compilar(h.ejecutadas[1]);
    expect(params).not.toContain(OTRO_ESPACIO);
    expect(params).toEqual(expect.arrayContaining([ESPACIO, ADMIN]));

    function compilar(consulta: unknown) {
      return new PgDialect().sqlToQuery(consulta as never);
    }
  });
});
