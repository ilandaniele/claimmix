/**
 * `marcarCasillaVencida`: una sola sentencia contra control, con el inquilino
 * como contexto (la base filtra por él, no hay `tenant_id` a mano), que deja
 * `invalid_grant` en `last_error` y no toca `enabled`. Nunca tira: si la base
 * falla, lo anota y sigue.
 *
 * La base es un drizzle sobre un proxy que anota el SQL y los parámetros.
 */

import { drizzle } from "drizzle-orm/pg-proxy";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  consultas: [] as Array<{ sql: string; params: unknown[] }>,
  contextos: [] as unknown[],
  falla: null as Error | null,
  logError: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/data/scope", async () => {
  const proxy = drizzle(async (sql, params) => {
    h.consultas.push({ sql, params });
    return { rows: [] };
  });
  return {
    enControl: async (ctx: unknown, armar: (db: typeof proxy) => unknown) => {
      h.contextos.push(ctx);
      if (h.falla) throw h.falla;
      return armar(proxy);
    },
  };
});
vi.mock("@/lib/security/cifrado", () => ({ cifrar: (v: string) => v, descifrar: (v: string) => v }));
vi.mock("@/lib/observability/logger", () => ({
  logger: { error: h.logError, warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { marcarCasillaVencida } from "@/server/email/gmail/accounts";

const TENANT = "10000000-0000-0000-0000-000000000001";

beforeEach(() => {
  vi.clearAllMocks();
  h.consultas.length = 0;
  h.contextos.length = 0;
  h.falla = null;
});

describe("marcarCasillaVencida", () => {
  it("abre control con el inquilino como contexto", async () => {
    await marcarCasillaVencida(TENANT, "Casilla@Example.com");

    expect(h.contextos).toEqual([{ tenantId: TENANT }]);
  });

  it("es una sola sentencia: UPDATE de last_error, sin tocar enabled", async () => {
    await marcarCasillaVencida(TENANT, "Casilla@Example.com");

    expect(h.consultas).toHaveLength(1);
    const { sql, params } = h.consultas[0];
    expect(sql).toContain('update "gmail_accounts"');
    expect(sql).toContain('"last_error"');
    expect(sql).not.toContain('"enabled" =');
    expect(params).toEqual(expect.arrayContaining(["invalid_grant", "casilla@example.com"]));
  });

  it("si la base falla no tira: lo anota y sigue", async () => {
    h.falla = Object.assign(new Error("connection terminated"), { code: "08006" });

    await expect(marcarCasillaVencida(TENANT, "casilla@example.com")).resolves.toBeUndefined();

    expect(h.logError).toHaveBeenCalledWith({ detalle: "08006" }, "gmail_accounts.marcar_vencida_error");
  });
});
