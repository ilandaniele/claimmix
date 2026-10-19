/**
 * La marca de «Para responder»: quién la pone, quién la saca y qué SQL corre.
 *
 * Un cliente de drizzle que no se conecta (`pg-proxy`) arma el SQL de verdad y
 * lo guarda: así se prueba la consulta y no una imitación de la cadena.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { consultas, mockEnTenant, mockEnTenantVarias, mockLoggerError } = vi.hoisted(() => ({
  consultas: [] as { sql: string; params: unknown[] }[],
  mockEnTenant: vi.fn(),
  mockEnTenantVarias: vi.fn(),
  mockLoggerError: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/data/scope", () => ({ enTenant: mockEnTenant, enTenantVarias: mockEnTenantVarias }));
vi.mock("@/lib/observability/logger", () => ({
  logger: { error: mockLoggerError, warn: vi.fn(), info: vi.fn() },
}));

import { PgDialect } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/pg-proxy";
import {
  marcarParaResponder,
  marcarParaResponderAunqueSigaElAgente,
  marcarParaResponderDondeEste,
  marcarRespondido,
} from "@/server/cases/para-responder";

const CASE_ID = "123e4567-e89b-12d3-a456-426614174001";
const MSG = "22222222-2222-2222-2222-222222222222";
const TENANT_ID = "10000000-0000-0000-0000-000000000001";
const VISTO = "2026-09-25T12:00:00.000Z";

let filas: unknown[][] = [];
const datos = drizzle(async (sql, params) => {
  consultas.push({ sql, params });
  return { rows: filas };
});
const dialecto = new PgDialect();

let lote: { getSQL(): never }[] = [];
let resultadoDelLote: unknown[] = [];
const sqlDe = (i: number) => dialecto.sqlToQuery(lote[i].getSQL());

beforeEach(() => {
  vi.clearAllMocks();
  consultas.length = 0;
  filas = [];
  mockEnTenant.mockImplementation(async (_ctx: unknown, fn: (db: unknown) => unknown) => fn(datos));
  lote = [];
  resultadoDelLote = [[{ case_id: CASE_ID }], []];
  mockEnTenantVarias.mockImplementation(async (_ctx: unknown, armar: (db: unknown) => never[]) => {
    lote = armar(datos);
    return resultadoDelLote;
  });
});

describe("marcarParaResponder", () => {
  it("marca sólo si el agente ya terminó, conserva la primera hora y mueve updated_at", async () => {
    await marcarParaResponder(CASE_ID, TENANT_ID);

    expect(mockEnTenant).toHaveBeenCalledWith({ tenantId: TENANT_ID }, expect.any(Function));
    const [{ sql, params }] = consultas;
    expect(sql).toContain('"para_responder_desde" = coalesce("cases"."para_responder_desde", now())');
    // La ventana de siete días de WhatsApp cuenta desde acá.
    expect(sql).toContain('"updated_at" = $');
    expect(sql).toContain('"cases"."status" in (');
    expect(params).toEqual(expect.arrayContaining(["listo", "requiere_especialista", "escalado"]));
    for (const s of ["esperando", "no_relevante", "recibido"]) {
      expect(params).not.toContain(s);
    }
  });

  // Quien contesta el aviso de cierre (B4) tiene que llegarle a alguien. Un
  // cierre a mano sigue siendo la última palabra del equipo.
  it("de los cerrados, sólo marca el que cerró el silencio", async () => {
    await marcarParaResponder(CASE_ID, TENANT_ID);

    const [{ sql, params }] = consultas;
    expect(sql).toMatch(/or \(\("cases"\."status" = \$\d+ and exists \(select 1 from audit_log a/);
    expect(sql).toContain('a.target_id = "cases"."id"::text');
    expect(sql).toContain('a.created_at >= "cases"."closed_at"');
    expect(params).toEqual(expect.arrayContaining(["cerrado", "claim.closed_abandoned"]));
  });

  // Sin aviso de cierre (recordatorios apagados, o un cierre de antes de B4)
  // la respuesta quedaba sólo en la auditoría, y así sigue.
  it("de los cerrados por silencio, sólo el que recibió el aviso de cierre", async () => {
    await marcarParaResponder(CASE_ID, TENANT_ID);

    const [{ sql, params }] = consultas;
    expect(sql.replace(/\s+/g, " ")).toMatch(
      /and exists \(select 1 from case_recordatorios r where r\.case_id = "cases"\."id" and r\.etapa = \$\d+ and r\.resultado = 'enviar'\)\)\)/
    );
    expect(params).toContain(9);
  });

  // Tragarse el error hacía que el webhook contestara 200 y Meta no reintentara.
  it("si la base falla, lo deja en el log y tira", async () => {
    mockEnTenant.mockRejectedValue(new Error("neon"));

    await expect(marcarParaResponder(CASE_ID, TENANT_ID)).rejects.toThrow("neon");
    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.objectContaining({ case_id: CASE_ID }),
      "para_responder.no_se_pudo_marcar"
    );
  });

  // B3: la clase del mensaje tardío es del episodio. Uno nuevo arranca sin clase;
  // otro mensaje del mismo episodio no la borra (la reserva la reemplaza).
  it("limpia el mensaje tardío sólo al abrir un episodio", async () => {
    await marcarParaResponder(CASE_ID, TENANT_ID);
    await marcarParaResponderAunqueSigaElAgente(CASE_ID, TENANT_ID);

    for (const { sql } of consultas) {
      for (const col of ["mensaje_tardio_de", "mensaje_tardio_tipo", "mensaje_tardio_resumen"]) {
        expect(sql).toContain(
          `"${col}" = case when "cases"."para_responder_desde" is null then null else "cases"."${col}" end`
        );
      }
    }
  });

  it("sin condición, no mira los mensajes", async () => {
    await marcarParaResponder(CASE_ID, TENANT_ID);

    expect(consultas[0].sql).not.toContain("claim_messages");
  });

  // La reentrega del mensaje que cerró el caso: la respuesta del agente es
  // posterior, así que no hay nada que marcar.
  it("`sinContestar` exige un entrante posterior a la última respuesta", async () => {
    await marcarParaResponder(CASE_ID, TENANT_ID, "sinContestar");

    const [{ sql }] = consultas;
    expect(sql).toMatch(/and exists \(select .* from "claim_messages"/);
    expect(sql).toContain('"claim_messages"."case_id" = "cases"."id"');
    expect(sql).toContain(
      `"claim_messages"."received_at" > coalesce((select max("outbound_messages"."created_at") from "outbound_messages" where "outbound_messages"."case_id" = "cases"."id"), '-infinity'::timestamptz)`
    );
  });

  // Lo que entró mientras el worker corría: la respuesta del agente puede ser
  // posterior y aun así no haberlo leído.
  it("`sinLeer` exige un entrante que el worker no leyó", async () => {
    await marcarParaResponder(CASE_ID, TENANT_ID, { sinLeer: ["m1", "m2"] });

    const [{ sql, params }] = consultas;
    expect(sql).toMatch(/and exists \(select .* from "claim_messages"/);
    expect(sql).toContain('"claim_messages"."id" not in ($');
    expect(params).toEqual(expect.arrayContaining(["inbound", "m1", "m2"]));
  });
});

describe("marcarParaResponderDondeEste", () => {
  it("manda el lock del mensaje y la marca en el caso donde está, en un solo lote", async () => {
    await marcarParaResponderDondeEste(CASE_ID, TENANT_ID, MSG);

    expect(mockEnTenantVarias).toHaveBeenCalledWith({ tenantId: TENANT_ID }, expect.any(Function));
    expect(lote).toHaveLength(2);
    const lock = sqlDe(0);
    expect(lock.sql).toContain("for share");
    expect(lock.params).toEqual([MSG]);

    const marca = sqlDe(1);
    expect(marca.sql).toContain(
      '"cases"."id" = (select m.case_id from claim_messages m where m.id = $'
    );
    expect(marca.sql).toContain('select max("outbound_messages"."created_at")');
    expect(marca.sql).toContain('"cases"."status" in (');
    expect(marca.params).toEqual(expect.arrayContaining([MSG, CASE_ID]));
  });

  it("devuelve el caso donde está el mensaje", async () => {
    resultadoDelLote = [[{ case_id: "caso-nuevo" }], []];

    await expect(marcarParaResponderDondeEste(CASE_ID, TENANT_ID, MSG)).resolves.toBe("caso-nuevo");
  });

  it("si el mensaje no aparece, devuelve el caso de entrada", async () => {
    resultadoDelLote = [[], []];

    await expect(marcarParaResponderDondeEste(CASE_ID, TENANT_ID, MSG)).resolves.toBe(CASE_ID);
  });

  it("si el lote falla, lo deja en el log y tira", async () => {
    mockEnTenantVarias.mockRejectedValue(new Error("neon"));

    await expect(marcarParaResponderDondeEste(CASE_ID, TENANT_ID, MSG)).rejects.toThrow("neon");
    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.objectContaining({ case_id: CASE_ID }),
      "para_responder.no_se_pudo_marcar"
    );
  });
});

describe("marcarParaResponderAunqueSigaElAgente", () => {
  // El tope por remitente (E12) llega en mitad de la conversación: a diferencia
  // de marcarParaResponder, esto marca aunque el agente no haya terminado.
  it("marca sin mirar el estado, conserva la primera hora y mueve updated_at", async () => {
    await marcarParaResponderAunqueSigaElAgente(CASE_ID, TENANT_ID);

    expect(mockEnTenant).toHaveBeenCalledWith({ tenantId: TENANT_ID }, expect.any(Function));
    const [{ sql, params }] = consultas;
    expect(sql).toContain('"para_responder_desde" = coalesce("cases"."para_responder_desde", now())');
    expect(sql).toContain('"updated_at" = $');
    expect(sql).not.toContain('"cases"."status"');
    expect(params).toContain(CASE_ID);
  });
});

describe("marcarRespondido", () => {
  it("no saca la marca si entró un mensaje de la persona después de `visto`", async () => {
    await marcarRespondido({ tenantId: TENANT_ID }, CASE_ID, VISTO);

    const [{ sql, params }] = consultas;
    expect(sql).toContain('set "para_responder_desde" = $1 where');
    expect(params[0]).toBeNull();
    expect(sql).toContain('"cases"."para_responder_desde" is not null');
    expect(sql).toMatch(/not exists \(select .* from "claim_messages"/);
    expect(sql).toContain('"claim_messages"."case_id" = "cases"."id"');
    expect(params).toEqual(expect.arrayContaining([CASE_ID, "inbound", VISTO]));
  });

  // `received_at` se toma antes del INSERT: un mensaje con hora anterior a
  // `visto` puede no haber estado guardado cuando se cargó el caso.
  it("cuenta también lo que llegó un rato antes de `visto`", async () => {
    await marcarRespondido({ tenantId: TENANT_ID }, CASE_ID, VISTO);

    const [{ sql, params }] = consultas;
    expect(sql).toMatch(/"claim_messages"."received_at" > \$\d+::timestamptz - \$\d+::interval/);
    expect(params).toContain("10 seconds");
  });

  it("devuelve si había algo que sacar", async () => {
    await expect(marcarRespondido({ tenantId: TENANT_ID }, CASE_ID, VISTO)).resolves.toBe(false);
    filas = [[CASE_ID]];
    await expect(marcarRespondido({ tenantId: TENANT_ID }, CASE_ID, VISTO)).resolves.toBe(true);
  });
});
