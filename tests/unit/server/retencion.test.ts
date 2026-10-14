/**
 * La retención de casos (B19): qué se mira, qué se borra y cuándo no se toca nada.
 *
 * Drizzle va de verdad sobre un driver falso (pg-proxy) para leer el SQL de la
 * selección. `deleteCases` es un doble: que revalide estado y `closed_at` en el
 * DELETE se prueba en cases-bulk-delete.test.ts; acá se afirma lo que la
 * retención le pide.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  /** Consultas del rol dueño (la lista de inquilinos). */
  propias: [] as { sql: string; params: unknown[] }[],
  /** Consultas de la capa, con el inquilino que las pidió. */
  porInquilino: [] as { tenantId: string; sql: string; params: unknown[] }[],
  inquilinos: [] as string[],
  /** Los ids que la selección de cada inquilino devuelve. */
  vencidos: {} as Record<string, string[]>,
  actual: { tenantId: "" },
  fallan: new Set<string>(),
  borrarCasos: vi.fn(),
  auditar: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/observability/logger", () => ({ logger: { info: m.info, warn: vi.fn(), error: m.error } }));
vi.mock("@/lib/audit/log", () => ({
  writeAuditLog: m.auditar,
  AuditEvent: { RETENCION_APLICADA: "retencion.aplicada" },
}));
// El fragmento de «vencido» es el real: se compara con lo que sale en la selección.
vi.mock("@/server/cases/delete", async (importarOriginal) => ({
  ...(await importarOriginal<typeof import("@/server/cases/delete")>()),
  deleteCases: m.borrarCasos,
}));
vi.mock("@/lib/db", async () => {
  const { drizzle } = await import("drizzle-orm/pg-proxy");
  const db = drizzle(async (sql, params) => {
    m.propias.push({ sql, params });
    return { rows: m.inquilinos.map((id) => [id]) };
  });
  return { db };
});
vi.mock("@/data/scope", async () => {
  const { drizzle } = await import("drizzle-orm/pg-proxy");
  const db = drizzle(async (sql, params) => {
    m.porInquilino.push({ tenantId: m.actual.tenantId, sql, params });
    return { rows: (m.vencidos[m.actual.tenantId] ?? []).map((id) => [id]) };
  });
  return {
    enTenant: async (ctx: { tenantId: string }, armar: (d: unknown) => unknown) => {
      m.actual.tenantId = ctx.tenantId;
      if (m.fallan.has(ctx.tenantId)) throw Object.assign(new Error("falló"), { code: "57P01" });
      return armar(db);
    },
  };
});

import { PgDialect } from "drizzle-orm/pg-core";

import { cerradoAntesDe } from "@/server/cases/delete";
import { aplicarRetencion, POR_INQUILINO } from "@/server/cases/retencion";

const A = "aaaaaaaa-0000-0000-0000-00000000000a";
const B = "bbbbbbbb-0000-0000-0000-00000000000b";
const AHORA = new Date("2026-09-30T04:10:00.000Z");
const CORTE_5 = new Date("2021-09-30T04:10:00.000Z");
const enUnaHora = () => Date.now() + 60 * 60 * 1000;

beforeEach(() => {
  vi.clearAllMocks();
  m.propias.length = 0;
  m.porInquilino.length = 0;
  m.inquilinos = [A, B];
  m.vencidos = {};
  m.fallan.clear();
  m.borrarCasos.mockImplementation(async (_ctx: unknown, ids: string[]) => ids);
  m.auditar.mockResolvedValue(undefined);
  process.env.RETENCION_MODO = "borrar";
  delete process.env.RETENCION_ANIOS;
});

afterEach(() => {
  delete process.env.RETENCION_MODO;
  delete process.env.RETENCION_ANIOS;
  vi.useRealTimers();
});

describe("aplicarRetencion: el interruptor", () => {
  it.each([undefined, "", "apagado", "si", "true", "BORRAR!", "1"])(
    "con RETENCION_MODO=%j no toca la base, ni borra, ni audita",
    async (valor) => {
      if (valor === undefined) delete process.env.RETENCION_MODO;
      else process.env.RETENCION_MODO = valor;

      await expect(aplicarRetencion({ hasta: enUnaHora() }, AHORA)).resolves.toBeNull();

      expect(m.propias).toEqual([]);
      expect(m.porInquilino).toEqual([]);
      expect(m.borrarCasos).not.toHaveBeenCalled();
      expect(m.auditar).not.toHaveBeenCalled();
    }
  );

  it.each(["0", "31", "-5", "5.5", "cinco", "1e1"])(
    "unos años que no valen (RETENCION_ANIOS=%j) apagan aunque el modo sea `borrar`: un typo no achica el plazo",
    async (anios) => {
      process.env.RETENCION_ANIOS = anios;
      m.vencidos = { [A]: ["c-1"] };

      await expect(aplicarRetencion({ hasta: enUnaHora() }, AHORA)).resolves.toBeNull();

      expect(m.propias).toEqual([]);
      expect(m.borrarCasos).not.toHaveBeenCalled();
    }
  );

  it("`simular` cuenta los candidatos pero no borra, no encola y no audita", async () => {
    process.env.RETENCION_MODO = "simular";
    m.vencidos = { [A]: ["c-1", "c-2"], [B]: ["c-3"] };

    const r = await aplicarRetencion({ hasta: enUnaHora() }, AHORA);

    expect(r).toEqual({
      modo: "simular",
      anios: 5,
      corte: CORTE_5.toISOString(),
      inquilinos: 2,
      candidatos: 3,
      borrados: 0,
    });
    expect(m.borrarCasos).not.toHaveBeenCalled();
    expect(m.auditar).not.toHaveBeenCalled();
    expect(m.info).toHaveBeenCalledWith({ anios: 5, inquilinos: 2, candidatos: 3 }, "retencion.simulada");
  });
});

describe("aplicarRetencion: el corte", () => {
  it("por omisión son cinco años antes del reloj de la corrida", async () => {
    const r = await aplicarRetencion({ hasta: enUnaHora() }, AHORA);

    expect(r!.anios).toBe(5);
    expect(r!.corte).toBe(CORTE_5.toISOString());
  });

  it("RETENCION_ANIOS=7 corre el corte siete años", async () => {
    process.env.RETENCION_ANIOS = "7";

    const r = await aplicarRetencion({ hasta: enUnaHora() }, AHORA);

    expect(r!.corte).toBe("2019-09-30T04:10:00.000Z");
  });
});

describe("aplicarRetencion: qué se elige", () => {
  it("por inquilino, sólo casos en un estado cerrado con `closed_at` anterior al corte", async () => {
    await aplicarRetencion({ hasta: enUnaHora() }, AHORA);

    const { sql, params } = m.porInquilino[0]!;
    expect(sql).toContain('from "cases"');
    expect(sql).toContain('"cases"."status" in ($');
    expect(sql).toContain('"cases"."closed_at" < $');
    expect(params).toEqual(["cerrado", "pagado", "rechazado", CORTE_5.toISOString(), POR_INQUILINO]);
  });

  it("la condición de vencido es la MISMA que revalida el DELETE, `cerradoAntesDe`", async () => {
    await aplicarRetencion({ hasta: enUnaHora() }, AHORA);

    const esperada = new PgDialect().sqlToQuery(cerradoAntesDe(CORTE_5)!);
    const { sql, params } = m.porInquilino[0]!;
    expect(sql).toContain(` where ${esperada.sql} order by `);
    expect(params.slice(0, esperada.params.length)).toEqual(esperada.params);
  });

  it("ningún estado abierto ni `no_relevante` entra en la lista", async () => {
    await aplicarRetencion({ hasta: enUnaHora() }, AHORA);

    for (const fuera of ["no_relevante", "info_faltante", "en_liquidacion", "listo", "procesando", "escalado"]) {
      expect(m.porInquilino[0]!.params).not.toContain(fuera);
    }
  });

  it("los más viejos primero y con tope de 200 por inquilino", async () => {
    await aplicarRetencion({ hasta: enUnaHora() }, AHORA);

    expect(m.porInquilino[0]!.sql).toContain('order by "cases"."closed_at" asc limit $');
    expect(POR_INQUILINO).toBe(200);
    expect(m.porInquilino[0]!.params).toContain(200);
  });

  it("no mira clientes, pólizas ni la auditoría: la única tabla que consulta es `cases`", async () => {
    m.vencidos = { [A]: ["c-1"] };

    await aplicarRetencion({ hasta: enUnaHora() }, AHORA);

    const todas = [...m.propias, ...m.porInquilino].map((c) => c.sql).join("\n");
    expect(todas).not.toMatch(/"customers"|"policies"|"audit_log"/);
    expect(m.propias).toHaveLength(1);
    expect(m.propias[0]!.sql).toContain('from "tenants"');
  });

  it("lee cada inquilino con SU contexto, en el orden de la lista", async () => {
    await aplicarRetencion({ hasta: enUnaHora() }, AHORA);

    expect(m.porInquilino.map((c) => c.tenantId)).toEqual([A, B]);
  });
});

describe("aplicarRetencion: borrar", () => {
  it("borra por `deleteCases` con el actor de la retención y el corte como `antesDe`", async () => {
    m.vencidos = { [A]: ["c-1", "c-2"] };

    await aplicarRetencion({ hasta: enUnaHora() }, AHORA);

    expect(m.borrarCasos).toHaveBeenCalledExactlyOnceWith(
      { tenantId: A },
      ["c-1", "c-2"],
      { id: null, role: "retencion" },
      { antesDe: CORTE_5 }
    );
  });

  it("un inquilino sin nada vencido no llama a `deleteCases` ni deja rastro", async () => {
    m.vencidos = { [A]: [], [B]: ["c-9"] };

    await aplicarRetencion({ hasta: enUnaHora() }, AHORA);

    expect(m.borrarCasos).toHaveBeenCalledTimes(1);
    expect(m.borrarCasos.mock.calls[0]![0]).toEqual({ tenantId: B });
    expect(m.auditar).toHaveBeenCalledTimes(1);
  });

  it("un caso reabierto entre la selección y el DELETE no se borra, y el rastro dice cuántos fueron de cada cosa", async () => {
    // `deleteCases` revalida estado y `closed_at` en el propio DELETE: el que se
    // reabrió (P8) no vuelve en `returning`.
    m.vencidos = { [A]: ["c-1", "reabierto"] };
    m.borrarCasos.mockResolvedValue(["c-1"]);

    const r = await aplicarRetencion({ hasta: enUnaHora() }, AHORA);

    expect(r).toMatchObject({ candidatos: 2, borrados: 1 });
    expect(m.auditar.mock.calls[0]![0].payload).toMatchObject({ candidatos: 2, borrados: 1 });
  });

  it("suma lo de todos los inquilinos", async () => {
    m.vencidos = { [A]: ["c-1", "c-2"], [B]: ["c-3"] };

    const r = await aplicarRetencion({ hasta: enUnaHora() }, AHORA);

    expect(r).toEqual({
      modo: "borrar",
      anios: 5,
      corte: CORTE_5.toISOString(),
      inquilinos: 2,
      candidatos: 3,
      borrados: 3,
    });
  });
});

describe("aplicarRetencion: el rastro", () => {
  it("un evento por inquilino, sin actor, con sólo conteos y la fecha de corte", async () => {
    m.vencidos = { [A]: ["c-1", "c-2"], [B]: ["c-3"] };

    await aplicarRetencion({ hasta: enUnaHora() }, AHORA);

    expect(m.auditar).toHaveBeenCalledTimes(2);
    expect(m.auditar).toHaveBeenCalledWith({
      tenant_id: A,
      actor_id: null,
      event_type: "retencion.aplicada",
      target_type: "tenant",
      target_id: A,
      payload: { anios: 5, corte: CORTE_5.toISOString(), candidatos: 2, borrados: 2 },
    });
    expect(m.auditar).toHaveBeenCalledWith(expect.objectContaining({ tenant_id: B, target_id: B }));
  });

  it("no lleva ids de casos ni nada del denunciante", async () => {
    m.vencidos = { [A]: ["caso-secreto-1"] };

    await aplicarRetencion({ hasta: enUnaHora() }, AHORA);

    expect(JSON.stringify(m.auditar.mock.calls)).not.toContain("caso-secreto-1");
  });
});

describe("aplicarRetencion: el reloj y los fallos", () => {
  it("con `hasta` ya vencido no procesa ningún inquilino", async () => {
    m.vencidos = { [A]: ["c-1"] };

    const r = await aplicarRetencion({ hasta: Date.now() - 1 }, AHORA);

    expect(m.porInquilino).toEqual([]);
    expect(m.borrarCasos).not.toHaveBeenCalled();
    expect(r).toMatchObject({ inquilinos: 2, candidatos: 0, borrados: 0 });
  });

  it("corta entre inquilinos al pasar `hasta`", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-30T04:00:00Z"));
    const hasta = Date.now() + 10_000;
    m.vencidos = { [A]: ["c-1"], [B]: ["c-2"] };
    m.borrarCasos.mockImplementation(async (_ctx: unknown, ids: string[]) => {
      vi.setSystemTime(Date.now() + 20_000);
      return ids;
    });

    const r = await aplicarRetencion({ hasta }, AHORA);

    expect(m.borrarCasos).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ candidatos: 1, borrados: 1 });
  });

  it("un inquilino que falla se registra con un código y los demás siguen", async () => {
    m.fallan.add(A);
    m.vencidos = { [B]: ["c-2"] };

    const r = await aplicarRetencion({ hasta: enUnaHora() }, AHORA);

    expect(m.error).toHaveBeenCalledWith({ code: "57P01" }, "retencion.inquilino_fallo");
    expect(m.borrarCasos).toHaveBeenCalledTimes(1);
    expect(m.borrarCasos.mock.calls[0]![0]).toEqual({ tenantId: B });
    expect(r).toMatchObject({ candidatos: 1, borrados: 1 });
  });

  it("si `deleteCases` tira, ese inquilino no deja rastro de un borrado que no pasó", async () => {
    m.vencidos = { [A]: ["c-1"], [B]: ["c-2"] };
    m.borrarCasos.mockRejectedValueOnce(new Error("lote caído"));

    const r = await aplicarRetencion({ hasta: enUnaHora() }, AHORA);

    expect(m.auditar).toHaveBeenCalledTimes(1);
    expect(m.auditar.mock.calls[0]![0].tenant_id).toBe(B);
    expect(r).toMatchObject({ borrados: 1 });
  });

  it("sin inquilinos no hay nada que hacer", async () => {
    m.inquilinos = [];

    await expect(aplicarRetencion({ hasta: enUnaHora() }, AHORA)).resolves.toMatchObject({
      inquilinos: 0,
      candidatos: 0,
      borrados: 0,
    });
  });
});

describe("aplicarRetencion: la base que le pasan (P10)", () => {
  it("lista los inquilinos en esa base, y no en la de siempre", async () => {
    const { drizzle } = await import("drizzle-orm/pg-proxy");
    const propias: string[] = [];
    const propia = drizzle(async (sql) => {
      propias.push(sql);
      return { rows: [[A]] };
    });

    const r = await aplicarRetencion({ hasta: enUnaHora() }, AHORA, propia as never);

    expect(r?.inquilinos).toBe(1);
    expect(propias).toHaveLength(1);
    expect(m.propias).toEqual([]);
    expect(m.porInquilino.map((c) => c.tenantId)).toEqual([A]);
  });
});
