/**
 * La marca de «Para responder»: quién la pone, quién la saca y qué SQL corre.
 *
 * Un cliente de drizzle que no se conecta (`pg-proxy`) arma el SQL de verdad y
 * lo guarda: así se prueba la consulta y no una imitación de la cadena.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { consultas, mockEnTenant, mockLoggerError } = vi.hoisted(() => ({
  consultas: [] as { sql: string; params: unknown[] }[],
  mockEnTenant: vi.fn(),
  mockLoggerError: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/data/scope", () => ({ enTenant: mockEnTenant }));
vi.mock("@/lib/observability/logger", () => ({
  logger: { error: mockLoggerError, warn: vi.fn(), info: vi.fn() },
}));

import { drizzle } from "drizzle-orm/pg-proxy";
import { marcarParaResponder, marcarRespondido } from "@/server/cases/para-responder";

const CASE_ID = "123e4567-e89b-12d3-a456-426614174001";
const TENANT_ID = "10000000-0000-0000-0000-000000000001";
const VISTO = "2026-09-25T12:00:00.000Z";

let filas: unknown[][] = [];
const datos = drizzle(async (sql, params) => {
  consultas.push({ sql, params });
  return { rows: filas };
});

beforeEach(() => {
  vi.clearAllMocks();
  consultas.length = 0;
  filas = [];
  mockEnTenant.mockImplementation(async (_ctx: unknown, fn: (db: unknown) => unknown) => fn(datos));
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
    for (const s of ["cerrado", "esperando", "no_relevante", "recibido"]) {
      expect(params).not.toContain(s);
    }
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
