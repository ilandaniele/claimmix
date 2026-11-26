/**
 * `abrirCasoPorSiniestroNuevo`: un solo lote, con el lock del caso primero, el
 * caso nuevo después y lo demás sólo si el caso nuevo existe. Con la capa de
 * datos simulada: acá se prueba qué se manda y qué se contesta, no el
 * aislamiento (eso lo prueba la integración).
 *
 * Un cliente de drizzle que no se conecta (`pg-proxy`) arma el SQL de verdad.
 */

const m = vi.hoisted(() => ({
  enTenantVarias: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/data/scope", () => ({ enTenantVarias: m.enTenantVarias }));
vi.mock("@/lib/observability/logger", () => ({ logger: { error: vi.fn(), warn: m.logWarn, info: m.logInfo } }));

import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/pg-proxy";
import { MEDIUM_CONFIDENCE_HIGH } from "@/server/cases/gap-analyzer";
import { abrirCasoPorSiniestroNuevo } from "@/server/cases/siniestro-nuevo";

const CASE = "123e4567-e89b-12d3-a456-426614174001";
const MSG = "22222222-2222-2222-2222-222222222222";
const TENANT = "10000000-0000-0000-0000-000000000001";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const db = drizzle(async () => ({ rows: [] }));
const dialecto = new PgDialect();

let sentencias: { getSQL(): never }[] = [];

const sqlDe = (i: number) => dialecto.sqlToQuery(sentencias[i].getSQL());
const abrir = () => abrirCasoPorSiniestroNuevo({ tenantId: TENANT, caseId: CASE, messageId: MSG });
const nuevoDe = (i: number) =>
  sqlDe(i).params.find((p) => typeof p === "string" && UUID.test(p) && p !== CASE && p !== MSG) as string;

/** Lo que devuelve el lote cuando el caso nuevo se abrió, con dos mensajes movidos. */
function loteAbierto() {
  return [
    [],
    { rows: [{ id: "nuevo" }] },
    [{ id: "m1" }, { id: "m2" }],
    [],
    [],
    [],
    [],
    [],
    [{ case_id: "nuevo" }],
    [{ field_key: "full_name" }],
  ];
}

beforeEach(() => {
  vi.clearAllMocks();
  sentencias = [];
  m.enTenantVarias.mockImplementation(async (_ctx: unknown, armar: (d: unknown) => never[]) => {
    sentencias = armar(db);
    return loteAbierto();
  });
});

describe("el lote", () => {
  it("manda diez sentencias en el contexto del inquilino, con el lock del caso primero", async () => {
    await abrir();

    expect(m.enTenantVarias).toHaveBeenCalledTimes(1);
    expect(m.enTenantVarias.mock.calls[0][0]).toEqual({ tenantId: TENANT });
    expect(sentencias).toHaveLength(10);
    const lock = sqlDe(0);
    expect(lock.sql).toContain("pg_advisory_xact_lock(hashtext('siniestro_nuevo')");
    expect(lock.params).toContain(CASE);
  });

  it("el caso nuevo nace en `recibido`, con el mismo hilo, sólo si el caso admite «Para responder», no lo tomó una persona ni le contestó una en las últimas 24 h, y el mensaje sigue ahí", async () => {
    await abrir();

    const { sql, params } = sqlDe(1);
    expect(sql).toContain("insert into cases");
    expect(sql).toContain("'recibido'");
    expect(sql).toContain("cases.email_thread_id");
    expect(sql).toContain("cases.channel in ('whatsapp', 'whatsapp_sim')");
    expect(sql).toContain('"cases"."status" in (');
    expect(sql).toContain("m.direction = 'inbound'");
    expect(sql).toContain("returning id");
    expect(sql).toContain("->>'reason'");
    expect(sql).toContain("from outbound_messages o");
    expect(sql).toContain("interval '86400000 milliseconds'");
    expect(params).toEqual(
      expect.arrayContaining([
        CASE,
        MSG,
        "listo",
        "requiere_especialista",
        "tomar_el_control",
        "case.status_changed",
        "wa_respuesta_humana",
      ])
    );
    expect(nuevoDe(1)).toMatch(UUID);
  });

  it("el caso nuevo toma waba_propia del mensaje que se parte y no del caso de antes: el cliente pudo cambiar de número", async () => {
    await abrir();

    const { sql, params } = sqlDe(1);
    expect(sql).toMatch(/insert into cases \([^)]*\bwaba_propia\b[^)]*\)/);
    expect(sql).not.toContain("cases.waba_propia");
    const del = /coalesce\(\(select m\.raw_payload->>'waba_propia' = 'true' from claim_messages m where m\.id = \$(\d+)::uuid\), false\)/.exec(sql);
    expect(del).not.toBeNull();
    expect(params[Number(del![1]) - 1]).toBe(MSG);
  });

  it("no lo abre si ya se partió", async () => {
    await abrir();

    const { sql, params } = sqlDe(1);
    expect(sql).toContain("not exists (select 1 from audit_log p");
    expect(params).toContain("claim.late_message_split");
    expect(sql).not.toContain("n.created_at > cases.created_at");
  });

  it("pasa los entrantes desde el primero sin contestar del episodio, con sus adjuntos y sus crudos", async () => {
    await abrir();

    const mensajes = sqlDe(2);
    expect(mensajes.sql).toContain('update "claim_messages" set "case_id" = $');
    expect(mensajes.params).toContain("inbound");
    expect(mensajes.sql).toContain('"claim_messages"."received_at" >= least(');
    expect(mensajes.sql).toContain("min(m.received_at)");
    expect(mensajes.sql).toContain('"outbound_messages"');
    expect(mensajes.sql).toContain("exists (select 1 from cases n where n.id =");
    expect(mensajes.sql).toContain("returning");

    expect(sqlDe(3).sql).toContain('update "claim_attachments" set "case_id" = $');
    expect(sqlDe(3).sql).toContain("claim_message_id");
    expect(sqlDe(4).sql).toContain('update "raw_messages" set "case_id" = $');
    expect(sqlDe(4).sql).toContain("received_at");
  });

  it("el mismo id de caso nuevo viaja en todo el lote", async () => {
    await abrir();

    const nuevo = nuevoDe(1);
    for (const i of [2, 3, 4, 5, 6, 7, 9]) expect(sqlDe(i).params).toContain(nuevo);
  });

  it("el caso de antes no cambia de estado: pierde la clase y conserva la marca sólo si le queda un entrante sin contestar", async () => {
    await abrir();

    const { sql } = sqlDe(5);
    expect(sql).toContain('update "cases" set');
    expect(sql).not.toContain('"status"');
    for (const col of ["mensaje_tardio_de", "mensaje_tardio_tipo", "mensaje_tardio_resumen", "mensaje_tardio_reservado_en"]) {
      expect(sql).toContain(`"${col}" =`);
    }
    expect(sql).toMatch(/"para_responder_desde" = case when exists \(select .* from "claim_messages"/);
    expect(sql).toContain('select max("outbound_messages"."created_at")');
    expect(sql).toContain('then "cases"."para_responder_desde" else null end');
  });

  it("deja un rastro en cada caso, con ids y una cuenta, nunca el texto del mensaje", async () => {
    await abrir();

    const viejo = sqlDe(6);
    expect(viejo.sql).toMatch(/^insert into "audit_log"/);
    expect(viejo.params).toContain("claim.late_message_split");
    expect(viejo.sql).toContain("'caso_nuevo'");
    expect(viejo.params).toContain(CASE);

    const nuevo = sqlDe(7);
    expect(nuevo.sql).toMatch(/^insert into "audit_log"/);
    expect(nuevo.params).toContain("claim.opened_from_late_message");
    expect(nuevo.sql).toContain("'caso_anterior'");
    expect(nuevo.params).toContain(nuevoDe(1));

    for (const i of [6, 7]) {
      expect(sqlDe(i).sql).toContain("select count(*) from claim_messages m");
      expect(sqlDe(i).sql).not.toContain("body");
      expect(sqlDe(i).sql).not.toContain("field_value");
    }
  });

  it("lee al final dónde quedó el mensaje", async () => {
    await abrir();

    const { sql, params } = sqlDe(8);
    expect(sql).toContain('select "case_id" from "claim_messages"');
    expect(params).toContain(MSG);
  });
});

describe("la identidad que pasa al caso nuevo", () => {
  it("sólo pasan el nombre y el DNI, nunca la póliza", async () => {
    await abrir();

    const { sql, params } = sqlDe(9);
    expect(sql).toContain("insert into extracted_fields");
    expect(sql).toContain("from extracted_fields f");
    expect(sql).toContain("f.field_key in ('full_name', 'dni')");
    expect(sql).not.toContain("policy_number");
    expect(JSON.stringify(params)).not.toContain("policy_number");
  });

  it("con tope 0.95 y sin pisar nada: 1.00 es de un analista y el worker no podría corregirlo", async () => {
    await abrir();

    const { sql } = sqlDe(9);
    expect(sql).toContain("least(f.confidence, 0.95)");
    expect(sql).toContain("on conflict (case_id, field_key) do nothing");
    expect(sql).toContain("returning field_key");
    expect(sql).not.toContain("do update");
    expect(sql).not.toContain("1.00");
  });

  it("sólo datos que el caso de antes daba por ciertos: desde 0.85 y no vacíos", async () => {
    await abrir();

    const { sql, params } = sqlDe(9);
    expect(sql).toContain("btrim(f.field_value) <> ''");
    expect(sql).toContain("f.confidence >= $");
    expect(params).toContain(MEDIUM_CONFIDENCE_HIGH);
    expect(MEDIUM_CONFIDENCE_HIGH).toBe(0.85);
  });

  it("ni un dato con confirmación pendiente ni uno que un analista rechazó", async () => {
    await abrir();

    const { sql } = sqlDe(9);
    expect(sql).toContain("from claim_field_confirmations c");
    expect(sql).toContain("c.case_id = f.case_id and c.field_name = f.field_key");
    expect(sql).toContain("c.status in ('pending', 'rejected')");
    expect(sql).toMatch(/not exists \(select 1 from claim_field_confirmations/);
  });

  it("dentro del inquilino del caso nuevo, que no viaja como parámetro, y sólo si se abrió", async () => {
    await abrir();

    const { sql, params } = sqlDe(9);
    expect(sql).toContain("select nc.id, nc.tenant_id");
    expect(sql).toContain("join cases nc on nc.id = $");
    expect(sql).toContain("nc.tenant_id = f.tenant_id");
    expect(nuevoDe(9)).toBe(nuevoDe(1));
    expect(params).toContain(CASE);
    expect(params).not.toContain(TENANT);
  });

  it("sólo si todos los entrantes de los dos casos son del mismo número", async () => {
    await abrir();

    const { sql, params } = sqlDe(9);
    expect(sql).toContain("join claim_messages p on p.id = $");
    expect(sql).toContain("p.case_id = nc.id");
    expect(sql).toContain("p.from_addr is not null");
    expect(sql).toContain("v.from_addr is distinct from p.from_addr");
    expect(sql).toContain("v.case_id in (f.case_id, nc.id)");
    expect(sql).toContain("v.direction = 'inbound'");
    expect(sql).toContain("exists (select 1 from claim_messages v where v.case_id = f.case_id");
    expect(params).toContain(MSG);
  });

  it("va última, después de mudar los mensajes, y el caso de antes sólo se lee", async () => {
    await abrir();

    expect(sentencias).toHaveLength(10);
    expect(sqlDe(2).sql).toContain('update "claim_messages"');
    expect(sqlDe(9).sql).toContain("insert into extracted_fields");
    const { sql } = sqlDe(9);
    expect(sql).not.toContain("update ");
    expect(sql).not.toContain("delete ");
  });

  it("compara ids sin pasarlos a texto, para que el índice entre bajo RLS", async () => {
    await abrir();

    expect(sqlDe(9).sql).not.toMatch(/::text/);
  });
});

describe("el resultado", () => {
  it("con el caso nuevo insertado devuelve su id y cuántos mensajes se mudaron", async () => {
    const r = await abrir();

    expect(r).toEqual({ tipo: "abierto", casoNuevo: nuevoDe(1), movidos: 2 });
    expect(m.logInfo).toHaveBeenCalledWith(
      { case_id: CASE, caso_nuevo: nuevoDe(1), movidos: 2, heredados: 1 },
      "siniestro_nuevo.abierto"
    );
  });

  it("sin caso nuevo y con el mensaje en otro caso, otra corrida ya lo mudó", async () => {
    m.enTenantVarias.mockResolvedValue([[], { rows: [] }, [], [], [], [], [], [], [{ case_id: "otro" }], []]);

    await expect(abrir()).resolves.toEqual({ tipo: "ya_movido" });
  });

  it("sin caso nuevo y con el mensaje todavía acá, sigue como antes", async () => {
    m.enTenantVarias.mockResolvedValue([[], { rows: [] }, [], [], [], [], [], [], [{ case_id: CASE }], []]);

    await expect(abrir()).resolves.toEqual({ tipo: "sigue" });
    expect(m.logInfo).toHaveBeenCalledWith({ case_id: CASE }, "siniestro_nuevo.no_corresponde");
  });
});

describe("lo que no parte", () => {
  it("la guarda de la toma va en el INSERT, no en una lectura aparte", async () => {
    await abrir();

    expect(m.enTenantVarias).toHaveBeenCalledTimes(1);
    expect(sqlDe(1).sql).toContain("not exists (select 1 from (select");
    expect(sqlDe(1).sql).toContain('"cases"."id"::text');
  });

  it("si la base falla no tira: sigue y deja el código del error en el log", async () => {
    m.enTenantVarias.mockRejectedValue(Object.assign(new Error("connection lost"), { code: "ECONNRESET" }));

    await expect(abrir()).resolves.toEqual({ tipo: "sigue" });
    expect(m.logWarn).toHaveBeenCalledWith({ case_id: CASE, error_code: "ECONNRESET" }, "siniestro_nuevo.no_se_pudo");
  });
});
