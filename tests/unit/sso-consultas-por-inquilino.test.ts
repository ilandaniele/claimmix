/**
 * Las consultas de «Exigir SSO» miran el inquilino de la cuenta, no sólo el dominio del mail.
 *
 * El dominio verificado es único por inquilino, pero una cuenta del inquilino B puede tener
 * un mail del dominio del A (un contratista, un estudio que atiende a dos aseguradoras).
 * Si «exigir» se decidiera sólo por dominio, A dejaría a esa cuenta sin sesión por
 * contraseña y sin poder entrar por el SSO de A (es de otro inquilino), y B no podría
 * configurar ese dominio: quedaría afuera del todo.
 *
 * Corre contra el constructor de consultas real de Drizzle con un driver de mentira
 * (pg-proxy): no hay base, pero el SQL que se comprueba es el que viajaría.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

type Consulta = { sql: string; params: unknown[]; method: string };

const h = vi.hoisted(() => ({
  contextos: [] as unknown[],
  consultas: [] as unknown[],
  filasDelDriver: [] as unknown[][],
}));

vi.mock("server-only", () => ({}));

vi.mock("@/lib/db", async () => {
  const { drizzle } = await import("drizzle-orm/pg-proxy");
  return {
    db: drizzle(async (sql, params, method) => {
      h.consultas.push({ sql, params, method } satisfies Consulta);
      return { rows: h.filasDelDriver };
    }),
  };
});

vi.mock("@/data/scope", async () => {
  const puente = await (await import("../mocks/puente-de-alcance")).puenteSobreLibDb();
  return {
    enControl: (ctx: unknown, armar: (db: unknown) => unknown) => {
      h.contextos.push(ctx);
      return puente.enControl(ctx, armar);
    },
  };
});

import { correoExigeSso, duenoDelMail, perfilDelIngreso } from "@/server/sso/usuarios";

const TENANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const consulta = () => (h.consultas as Consulta[])[0]!;

beforeEach(() => {
  h.contextos = [];
  h.consultas = [];
  h.filasDelDriver = [];
});

describe("perfilDelIngreso", () => {
  it("compara el inquilino del perfil con el de la configuración, además del dominio", async () => {
    await perfilDelIngreso("u1");

    expect(h.consultas).toHaveLength(1);
    expect(consulta().sql).toContain('from "users" inner join "user" on "user"."id" = "users"."id"');
    expect(consulta().sql).toMatch(/left join "sso_settings" on \("sso_settings"\."tenant_id" = "users"\."tenant_id" and "sso_settings"\."dominio" = lower\(split_part\("user"\."email", '@', 2\)\) and /);
  });

  it("una cuenta sin perfil no tiene fila: no hay inquilino ni nada que exigir", async () => {
    expect(await perfilDelIngreso("u1")).toBeNull();
  });

  it("mira la baja en la misma consulta", async () => {
    h.filasDelDriver = [[TENANT_A, true, false]];

    expect(await perfilDelIngreso("u1")).toEqual({ tenantId: TENANT_A, deBaja: true, exigeSso: false });
    expect(h.consultas).toHaveLength(1);
    expect(consulta().sql).toContain('"users"."dado_de_baja_en" is not null');
  });
});

describe("correoExigeSso", () => {
  it("pregunta en el contexto del inquilino donde aterrizaría la cuenta, y deja el filtro a RLS", async () => {
    await correoExigeSso("pepe@empresa.com", TENANT_A);

    expect(h.contextos).toEqual([{ tenantId: TENANT_A }]);
    expect(h.consultas).toHaveLength(1);
    expect(consulta().sql).toContain('from "sso_settings"');
    expect(consulta().sql).not.toContain("tenant_id");
    expect(consulta().params.slice(0, 3)).toEqual(["empresa.com", true, true]);
  });

  it("con fila, exige; sin fila, no", async () => {
    h.filasDelDriver = [[1]];
    expect(await correoExigeSso("pepe@empresa.com", TENANT_A)).toBe(true);
    h.filasDelDriver = [];
    expect(await correoExigeSso("pepe@empresa.com", TENANT_A)).toBe(false);
  });
});

describe("duenoDelMail", () => {
  it("una sola consulta, y la cuenta huérfana se mide contra el SSO de este inquilino", async () => {
    await duenoDelMail("pepe@empresa.com", TENANT_A);

    expect(h.consultas).toHaveLength(1);
    expect(consulta().sql).toMatch(/bool_and\("account"\."provider_id" = \$1\)/);
    expect(consulta().sql).toMatch(/from "account" where "account"\."user_id" = "user"\."id"/);
    expect(consulta().params).toContain(`sso:${TENANT_A}`);
  });

  it("sin cuentas, `bool_and` da null y cuenta como «no es huérfana de SSO»", async () => {
    await duenoDelMail("pepe@empresa.com", TENANT_A);
    expect(consulta().sql).toMatch(/coalesce\(\(select bool_and/);
    expect(consulta().sql).toMatch(/, false\)/);
  });

  it("sin perfil y con sólo la cuenta del SSO: huérfana, recuperable", async () => {
    h.filasDelDriver = [["u1", null, true]];
    expect(await duenoDelMail("pepe@empresa.com", TENANT_A)).toEqual({
      existe: true,
      userId: "u1",
      tenantId: null,
      huerfanaDeSso: true,
    });
  });

  it("sin perfil y con otra cuenta (contraseña, Google): no es huérfana", async () => {
    h.filasDelDriver = [["u1", null, false]];
    expect(await duenoDelMail("pepe@empresa.com", TENANT_A)).toMatchObject({ tenantId: null, huerfanaDeSso: false });
  });

  it("con perfil nunca es huérfana, aunque todas sus cuentas sean del SSO", async () => {
    h.filasDelDriver = [["u1", TENANT_A, true]];
    expect(await duenoDelMail("pepe@empresa.com", TENANT_A)).toMatchObject({ tenantId: TENANT_A, huerfanaDeSso: false });
  });

  it("sin cuenta con ese mail, no existe", async () => {
    h.filasDelDriver = [];
    expect(await duenoDelMail("nadie@empresa.com", TENANT_A)).toEqual({ existe: false });
  });
});
