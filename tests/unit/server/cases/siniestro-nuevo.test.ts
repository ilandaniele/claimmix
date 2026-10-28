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
  return [[], { rows: [{ id: "nuevo" }] }, [{ id: "m1" }, { id: "m2" }], [], [], [], [], [], [{ case_id: "nuevo" }]];
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
  it("manda nueve sentencias en el contexto del inquilino, con el lock del caso primero", async () => {
    await abrir();

    expect(m.enTenantVarias).toHaveBeenCalledTimes(1);
    expect(m.enTenantVarias.mock.calls[0][0]).toEqual({ tenantId: TENANT });
    expect(sentencias).toHaveLength(9);
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
    for (const i of [2, 3, 4, 5, 6, 7]) expect(sqlDe(i).params).toContain(nuevo);
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
    }
  });

  it("lee al final dónde quedó el mensaje", async () => {
    await abrir();

    const { sql, params } = sqlDe(8);
    expect(sql).toContain('select "case_id" from "claim_messages"');
    expect(params).toContain(MSG);
  });
});

describe("el resultado", () => {
  it("con el caso nuevo insertado devuelve su id y cuántos mensajes se mudaron", async () => {
    const r = await abrir();

    expect(r).toEqual({ tipo: "abierto", casoNuevo: nuevoDe(1), movidos: 2 });
    expect(m.logInfo).toHaveBeenCalledWith(
      { case_id: CASE, caso_nuevo: nuevoDe(1), movidos: 2 },
      "siniestro_nuevo.abierto"
    );
  });

  it("sin caso nuevo y con el mensaje en otro caso, otra corrida ya lo mudó", async () => {
    m.enTenantVarias.mockResolvedValue([[], { rows: [] }, [], [], [], [], [], [], [{ case_id: "otro" }]]);

    await expect(abrir()).resolves.toEqual({ tipo: "ya_movido" });
  });

  it("sin caso nuevo y con el mensaje todavía acá, sigue como antes", async () => {
    m.enTenantVarias.mockResolvedValue([[], { rows: [] }, [], [], [], [], [], [], [{ case_id: CASE }]]);

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
