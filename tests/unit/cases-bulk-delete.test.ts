/**
 * Borrado múltiple: que no cruce inquilinos, que diga la verdad y que anote los
 * adjuntos de R2 para la purga diferida (B19).
 *
 * Es la frontera de aislamiento (AC10) y no tenía ninguna cobertura: el único
 * DELETE en tests/ era el de un mail que ya no está. Y el borrado pasó de cien
 * pedidos a uno, así que el aislamiento que antes daba el chequeo previo de cada
 * request ahora lo da la base con el contexto del lote — que es más fuerte, pero
 * hay que comprobarlo.
 *
 * Drizzle va de verdad sobre un driver falso (pg-proxy): lo que se afirma es el
 * SQL que saldría hacia la base, en el orden en que sale dentro del lote.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  consultas: [] as { sql: string; params: unknown[] }[],
  lotes: [] as { tenantId: string; cuantas: number }[],
  /** Lo que devuelve el DELETE ... RETURNING: los casos que de verdad había. */
  delInquilino: [] as string[],
  falla: { enElDelete: false },
  auditar: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/audit/log", () => ({
  writeAuditLog: m.auditar,
  AuditEvent: { CASE_DELETED: "case.deleted" },
}));
vi.mock("@/data/scope", async () => {
  const { drizzle } = await import("drizzle-orm/pg-proxy");
  const db = drizzle(async (sql, params) => {
    m.consultas.push({ sql, params });
    if (sql.startsWith("delete")) {
      if (m.falla.enElDelete) throw new Error("falló el delete");
      return { rows: m.delInquilino.map((id) => [id]) };
    }
    return { rows: [] };
  });
  return {
    // Como el lote real: las sentencias corren en orden y en la misma transacción.
    enTenantVarias: async (ctx: { tenantId: string }, armar: (d: unknown) => unknown[]) => {
      const consultas = armar(db);
      m.lotes.push({ tenantId: ctx.tenantId, cuantas: consultas.length });
      const resultados: unknown[] = [];
      for (const c of consultas) resultados.push(await c);
      return resultados;
    },
  };
});

import { cerradoAntesDe, cualesBorra, deleteCases } from "@/server/cases/delete";
import { PgDialect } from "drizzle-orm/pg-core";

const TENANT_A = { tenantId: "aaaaaaaa-0000-0000-0000-00000000000a" };
const ADMIN = { id: "user-admin", role: "admin" as const };
const ANALISTA = { id: "user-analista", role: "analyst" as const };
const RETENCION = { id: null, role: "retencion" as const };
const CORTE = new Date("2021-09-30T04:00:00.000Z");

const encolado = () => m.consultas.find((c) => c.sql.startsWith("insert"))!;
const borrado = () => m.consultas.find((c) => c.sql.startsWith("delete"))!;
/** Lo que va después del último `where`: la condición tal como salió. */
const condicion = (sql: string) =>
  sql.slice(sql.lastIndexOf(" where ") + " where ".length).replace(/ (on conflict|returning) .*$/, "");

beforeEach(() => {
  vi.clearAllMocks();
  m.consultas.length = 0;
  m.lotes.length = 0;
  m.delInquilino = [];
  m.falla.enElDelete = false;
  delete process.env.PURGA_GRACIA_DIAS;
  m.auditar.mockResolvedValue(undefined);
});

describe("deleteCases", () => {
  it("devuelve los ids que borró", async () => {
    m.delInquilino = ["c-1", "c-2"];
    await expect(deleteCases(TENANT_A, ["c-1", "c-2"], ADMIN)).resolves.toEqual(["c-1", "c-2"]);
  });

  it("un id de otra aseguradora no se borra ni se reporta", async () => {
    // La base devuelve sólo el propio: el ajeno no coincide con ninguna fila
    // porque el contexto del lote lo excluye.
    m.delInquilino = ["mio-1"];

    const borrados = await deleteCases(TENANT_A, ["mio-1", "de-otro-inquilino"], ADMIN);

    expect(borrados).toEqual(["mio-1"]);
    expect(borrados).not.toContain("de-otro-inquilino");
  });

  it("una lista entera de otro inquilino borra cero", async () => {
    await expect(deleteCases(TENANT_A, ["ajeno-1", "ajeno-2"], ADMIN)).resolves.toEqual([]);
    expect(m.auditar).not.toHaveBeenCalled();
  });

  it("con la lista vacía no toca la base", async () => {
    // Sin esto, `inArray(id, [])` genera SQL que borra según el motor. No es un
    // caso hipotético: el cliente manda lo que haya seleccionado.
    m.delInquilino = ["no-deberia-verse"];
    await expect(deleteCases(TENANT_A, [], ADMIN)).resolves.toEqual([]);
    expect(m.lotes).toEqual([]);
    expect(m.consultas).toEqual([]);
  });

  it("le pasa a la capa el inquilino del contexto", async () => {
    m.delInquilino = ["c-1"];
    await deleteCases(TENANT_A, ["c-1"], ADMIN);
    expect(m.lotes[0]!.tenantId).toBe(TENANT_A.tenantId);
  });

  it("un analista sólo borra lo que tiene asignado", async () => {
    // `patchCase` ya le contesta 404 a un analista que edita un caso ajeno. El
    // borrado —que es irreversible y cascadea a nueve tablas— no tenía nada.
    m.delInquilino = ["mio-1"];
    await deleteCases(TENANT_A, ["mio-1"], ANALISTA);

    expect(condicion(borrado().sql)).toContain('"cases"."assigned_to" = $');
    expect(borrado().params).toContain("user-analista");
  });

  it("un admin borra cualquier caso del inquilino", async () => {
    m.delInquilino = ["de-otro-analista"];
    await deleteCases(TENANT_A, ["de-otro-analista"], ADMIN);

    expect(borrado().sql).not.toContain("assigned_to");
    expect(encolado().sql).not.toContain("assigned_to");
  });
});

describe("deleteCases: la cola de adjuntos", () => {
  it("manda el encolado y el borrado en UN lote, el encolado primero", async () => {
    // Un lote es una transacción: si el DELETE falla, el encolado se revierte
    // con él. Y el orden no es negociable: el DELETE arrastra los adjuntos por
    // cascada, y después ya no hay de dónde leerlos.
    m.delInquilino = ["c-1"];

    await deleteCases(TENANT_A, ["c-1"], ADMIN);

    expect(m.lotes).toEqual([{ tenantId: TENANT_A.tenantId, cuantas: 2 }]);
    expect(m.consultas.map((c) => c.sql.split(" ")[0])).toEqual(["insert", "delete"]);
  });

  it("anota los paths de los adjuntos de los casos que se borran, sin repetir dentro del lote", async () => {
    m.delInquilino = ["c-1"];

    await deleteCases(TENANT_A, ["c-1"], ADMIN);

    const sql = encolado().sql;
    expect(sql).toContain('insert into "adjuntos_por_purgar"');
    expect(sql).toContain('select distinct on ("claim_attachments"."storage_path")');
    expect(sql).toContain('from "claim_attachments" inner join "cases" on "cases"."id" = "claim_attachments"."case_id"');
    expect(sql).toContain('"claim_attachments"."storage_path" is not null');
  });

  it("el encolado sólo agrega: sin ON CONFLICT, para que una fila vieja no pise al segundo borrado del mismo objeto", async () => {
    // `claimmix_app` no puede actualizar la cola, así que un choque no podría renovar
    // la fila vieja: con DO NOTHING la que mandaba era la vieja, cancelada o ya vencida.
    await deleteCases(TENANT_A, ["c-1"], ADMIN);

    expect(encolado().sql).not.toContain("on conflict");
  });

  it("toma el inquilino de la fila del caso y no de un parámetro", async () => {
    await deleteCases(TENANT_A, ["c-1"], ADMIN);

    expect(encolado().sql).toContain('"cases"."tenant_id"');
    expect(encolado().params).not.toContain(TENANT_A.tenantId);
  });

  it("el encolado y el borrado usan la MISMA condición, con los mismos parámetros", async () => {
    // Si una se armara con una condición y la otra con otra parecida, la cola
    // recibiría adjuntos de casos vivos o dejaría afuera los de los borrados.
    await deleteCases(TENANT_A, ["c-1", "c-2"], ANALISTA);
    const dialecto = new PgDialect();
    const esperada = dialecto.sqlToQuery(cualesBorra(["c-1", "c-2"], ANALISTA)!);

    expect(condicion(borrado().sql)).toBe(esperada.sql);
    expect(borrado().params).toEqual(esperada.params);

    // En el encolado los parámetros arrancan uno más adelante: el primero es la gracia.
    const corrida = esperada.sql.replace(/\$(\d+)/g, (_, n) => `$${Number(n) + 1}`);
    expect(condicion(encolado().sql)).toContain(corrida);
    expect(encolado().params.slice(1)).toEqual(esperada.params);
  });

  it("la gracia por omisión es de 30 días", async () => {
    await deleteCases(TENANT_A, ["c-1"], ADMIN);

    expect(encolado().sql).toContain("now() + make_interval(days => $");
    expect(encolado().params).toContain(30);
  });

  it.each([
    ["45", 45],
    ["7", 7],
    ["365", 365],
    ["3", 30],
    ["400", 30],
    ["abc", 30],
    ["", 30],
  ])("PURGA_GRACIA_DIAS=%j da %i días", async (valor, dias) => {
    process.env.PURGA_GRACIA_DIAS = valor;

    await deleteCases(TENANT_A, ["c-1"], ADMIN);

    expect(encolado().params).toContain(dias);
  });

  it("si el DELETE falla, el error sube y no queda rastro de un borrado que no pasó", async () => {
    m.falla.enElDelete = true;

    await expect(deleteCases(TENANT_A, ["c-1"], ADMIN)).rejects.toThrow(/delete from "cases"/);
    expect(m.auditar).not.toHaveBeenCalled();
  });

  it("no hace nada contra R2: sólo anota", async () => {
    // El módulo del bucket ni siquiera se importa desde acá.
    await deleteCases(TENANT_A, ["c-1"], ADMIN);

    expect(m.consultas.every((c) => /^(insert|delete)/.test(c.sql))).toBe(true);
  });
});

describe("cualesBorra con `antesDe` (la retención)", () => {
  it("sin `antesDe` no mira ni el estado ni la fecha de cierre", async () => {
    await deleteCases(TENANT_A, ["c-1"], ADMIN);

    expect(borrado().sql).not.toContain("closed_at");
    expect(borrado().sql).not.toContain('"status"');
  });

  it("con `antesDe` el DELETE revalida estado cerrado y fecha de cierre", async () => {
    m.delInquilino = ["c-1"];

    await deleteCases(TENANT_A, ["c-1"], RETENCION, { antesDe: CORTE });

    const c = condicion(borrado().sql);
    expect(c).toContain('"cases"."status" in ($');
    expect(c).toContain('"cases"."closed_at" < $');
    expect(borrado().params).toEqual(expect.arrayContaining(["cerrado", "pagado", "rechazado", CORTE.toISOString()]));
  });

  it("el DELETE usa `cerradoAntesDe`, el mismo fragmento con que la retención arma su lista", async () => {
    await deleteCases(TENANT_A, ["c-1"], RETENCION, { antesDe: CORTE });

    const cerrado = new PgDialect().sqlToQuery(cerradoAntesDe(CORTE)!);
    expect(condicion(borrado().sql)).toContain(cerrado.sql.replace(/\$(\d+)/g, (_, n) => `$${Number(n) + 1}`));
    expect(borrado().params.slice(1)).toEqual(cerrado.params);
  });

  it("el encolado de los adjuntos revalida lo mismo: un caso reabierto no entrega sus archivos", async () => {
    await deleteCases(TENANT_A, ["c-1"], RETENCION, { antesDe: CORTE });

    expect(encolado().sql).toContain('"cases"."closed_at" < $');
    expect(encolado().params).toEqual(expect.arrayContaining(["cerrado", "pagado", "rechazado", CORTE.toISOString()]));
  });

  it("la retención no aplica `soloLoSuyo`: no es un analista y no tiene id", async () => {
    await deleteCases(TENANT_A, ["c-1"], RETENCION, { antesDe: CORTE });

    expect(borrado().sql).not.toContain("assigned_to");
  });

  it("un estado abierto no está entre los que se pueden borrar por retención", async () => {
    await deleteCases(TENANT_A, ["c-1"], RETENCION, { antesDe: CORTE });

    for (const abierto of ["info_faltante", "en_liquidacion", "listo", "no_relevante", "nuevo"]) {
      expect(borrado().params).not.toContain(abierto);
    }
  });

  it("anota la auditoría sin actor y marcada como retención", async () => {
    m.delInquilino = ["c-1"];

    await deleteCases(TENANT_A, ["c-1"], RETENCION, { antesDe: CORTE });

    expect(m.auditar).toHaveBeenCalledWith(
      expect.objectContaining({ actor_id: null, event_type: "case.deleted", target_id: "c-1" })
    );
    expect(m.auditar.mock.calls[0]![0].payload).toEqual({ borrados_en_la_tanda: 1, por_retencion: true });
  });
});
