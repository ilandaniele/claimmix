/**
 * `yaContestamosElUltimoMensaje` — la consulta detrás de `yaSeLeContesto`.
 *
 * Un solo lote (`enTenantVarias`) trae la entrada más nueva de `claim_messages`
 * y la salida más nueva de `outbound_messages`; la comparación la hace
 * `yaSeLeContesto`, ya probada aparte con siete booleanos. Acá sólo se prueba
 * que la consulta llega y que un fallo de base no se cae hacia arriba.
 */

vi.mock("server-only", () => ({}));

vi.mock("@/data/scope", async () => {
  const mod = await import("@/lib/db");
  return {
    enTenantVarias: (_ctx: unknown, armar: (d: unknown) => unknown[]) =>
      Promise.all(armar(mod.db)),
  };
});

vi.mock("@/lib/db", () => ({
  db: { select: vi.fn() },
  tables: {},
}));

const { mockLogError } = vi.hoisted(() => ({ mockLogError: vi.fn() }));

vi.mock("@/lib/observability/logger", () => ({
  logger: { error: mockLogError, warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { describe, it, expect, vi, beforeEach } from "vitest";
import { db } from "@/lib/db";
import { yaContestamosElUltimoMensaje } from "@/server/confirmations/ya-contestado";

const CASE_ID = "aaaaaaaa-0000-0000-0000-000000000001";
const TENANT_ID = "bbbbbbbb-0000-0000-0000-000000000001";
const HASTA = "2026-09-21T11:00:00.000Z";

/**
 * La primera consulta del lote trae la entrada, la segunda la salida — mismo
 * orden en que `yaContestamosElUltimoMensaje` las arma.
 */
function setupDbMocks(
  entradaRows: Array<{ received_at: string }>,
  salidaRows: Array<{ created_at: string }>
) {
  const porLlamada = [entradaRows, salidaRows];
  let i = 0;
  vi.mocked(db.select).mockImplementation(() => {
    const rows = porLlamada[i] ?? [];
    i++;
    return {
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: () => Promise.resolve(rows),
          }),
        }),
      }),
    } as unknown as ReturnType<typeof db.select>;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("yaContestamosElUltimoMensaje: compara entrada y salida", () => {
  it("la salida es posterior a la entrada: ya contestamos", async () => {
    setupDbMocks(
      [{ received_at: "2026-09-21T10:00:00.000Z" }],
      [{ created_at: "2026-09-21T10:05:00.000Z" }]
    );

    await expect(yaContestamosElUltimoMensaje(CASE_ID, TENANT_ID, HASTA)).resolves.toBe(true);
  });

  it("la salida es anterior a la entrada: todavía no", async () => {
    setupDbMocks(
      [{ received_at: "2026-09-21T10:05:00.000Z" }],
      [{ created_at: "2026-09-21T10:00:00.000Z" }]
    );

    await expect(yaContestamosElUltimoMensaje(CASE_ID, TENANT_ID, HASTA)).resolves.toBe(false);
  });

  it("sin ninguna salida todavía: no contestado", async () => {
    setupDbMocks([{ received_at: "2026-09-21T10:00:00.000Z" }], []);

    await expect(yaContestamosElUltimoMensaje(CASE_ID, TENANT_ID, HASTA)).resolves.toBe(false);
  });
});

describe("yaContestamosElUltimoMensaje: si la base falla, contesta", () => {
  it("un lote que tira no deja a la corrida heredada muda", async () => {
    vi.mocked(db.select).mockImplementation(() => {
      throw new Error("la base se cayó");
    });

    await expect(yaContestamosElUltimoMensaje(CASE_ID, TENANT_ID, HASTA)).resolves.toBe(false);
    expect(mockLogError).toHaveBeenCalledWith(
      expect.objectContaining({ code: "Error" }),
      "orchestrate.ya_contestado_fallo"
    );
  });
});
