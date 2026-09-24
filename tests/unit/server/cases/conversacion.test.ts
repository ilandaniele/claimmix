/**
 * La conversación del caso: un solo viaje, las dos direcciones y los dos
 * canales, sin duplicar el mail, con el alta simulada, la vista previa del mail
 * simulado y sin la fila fantasma del worker.
 *
 * Las consultas se arman con un cliente drizzle de verdad —que no se conecta
 * hasta ejecutar— para poder leer su SQL; lo que devuelven es de mentira.
 */

vi.mock("server-only", () => ({}));

const { enTenantVarias, enTenant } = vi.hoisted(() => ({
  enTenantVarias: vi.fn(),
  enTenant: vi.fn(),
}));
vi.mock("@/data/scope", () => ({ enTenantVarias, enTenant }));

import { describe, it, expect, vi, beforeEach } from "vitest";
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import * as schema from "@/lib/db/schema";
import { conversacionDelCaso, TOPE_MENSAJES } from "@/server/cases/conversacion";

const CTX = { tenantId: "tenant-1" };
const CASO = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
const POR_FUENTE = TOPE_MENSAJES + 1;
const cliente = drizzle(neon("postgres://u:p@h/db"), { schema });

type Sql = { sql: string; params: unknown[] };
let armadas: Sql[] = [];

/** Arma el lote con el cliente de verdad y contesta lo que se le pase. */
function responder(filas: [unknown[], unknown[], unknown[], unknown[]]) {
  enTenantVarias.mockImplementation(async (_ctx, armar: (db: unknown) => Array<{ toSQL(): Sql }>) => {
    armadas = armar(cliente).map((q) => q.toSQL());
    return filas;
  });
}

/** Una fila de `claim_messages`: entrante salvo que se diga otra cosa. */
const entrante = (o: Record<string, unknown> = {}) => ({
  id: "in-1",
  direction: "inbound",
  provider: "gmail",
  subject: "Choque",
  from_addr: "ana@ejemplo.com",
  body_text: "Choqué ayer.",
  received_at: "2026-06-01 10:00:00+00",
  status: "received",
  attachment_count: 0,
  ...o,
});

describe("conversacionDelCaso", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    armadas = [];
  });

  it("va una sola vez a la base, con las cuatro consultas en el mismo lote", async () => {
    responder([[{ id: CASO }], [], [], []]);

    await conversacionDelCaso(CTX, CASO);

    expect(enTenantVarias).toHaveBeenCalledTimes(1);
    expect(enTenantVarias.mock.calls[0]![0]).toBe(CTX);
    expect(enTenant).not.toHaveBeenCalled();
    expect(armadas).toHaveLength(4);
  });

  it("devuelve null si el caso no se ve", async () => {
    responder([[], [], [], []]);
    expect(await conversacionDelCaso(CTX, CASO)).toBeNull();
  });

  it("mail: lo entrante y lo saliente, sin duplicar y del más viejo al más nuevo", async () => {
    responder([
      [{ id: CASO }],
      [
        entrante({ id: "in-2", received_at: "2026-06-01 12:00:00+00" }),
        entrante({
          id: "out-1",
          direction: "outbound",
          subject: "Re: Choque",
          from_addr: "siniestros@aseguradora.com",
          body_text: "Nos falta la foto del registro.",
          received_at: "2026-06-01 11:00:00.5+00",
          status: "sent",
        }),
        entrante(),
      ],
      [],
      [],
    ]);

    const { messages: conversacion, recortada } = (await conversacionDelCaso(CTX, CASO))!;

    expect(recortada).toBe(false);
    expect(conversacion.map((m) => [m.id, m.direction])).toEqual([
      ["in-1", "inbound"],
      ["out-1", "outbound"],
      ["in-2", "inbound"],
    ]);
    expect(conversacion[1]).toMatchObject({
      subject: "Re: Choque",
      from_addr: "siniestros@aseguradora.com",
      estado_envio: "sent",
      attachment_count: 0,
    });
    expect(conversacion[0]!.estado_envio).toBeNull();
  });

  it("WhatsApp: lo saliente sale de outbound_messages, sin asunto ni remitente", async () => {
    responder([
      [{ id: CASO }],
      [entrante({ provider: "whatsapp", subject: "WhatsApp", from_addr: "5491100000000" })],
      [],
      [
        {
          id: "wa-1",
          channel: "whatsapp",
          rendered_body: "¿Me mandás la foto del registro?",
          status: "skipped_simulated",
          created_at: "2026-06-01 10:05:00+00",
        },
      ],
    ]);

    const [, saliente] = (await conversacionDelCaso(CTX, CASO))!.messages;

    expect(saliente).toEqual({
      id: "wa-1",
      direction: "outbound",
      provider: "whatsapp",
      subject: null,
      from_addr: null,
      body_text: "¿Me mandás la foto del registro?",
      received_at: "2026-06-01 10:05:00+00",
      estado_envio: "skipped_simulated",
      attachment_count: 0,
    });
  });

  it("el mail simulado aparece: su vista previa sólo existe en outbound_messages, en HTML", async () => {
    responder([
      [{ id: CASO }],
      [entrante({ from_addr: "ana@example.com" })],
      [],
      [
        {
          id: "sim-1",
          channel: "email",
          rendered_body:
            "<!DOCTYPE html><html><head><title>Nos falta un dato</title></head>" +
            "<body><p>Ana, nos falta la foto del registro.</p><p>Caso #123</p></body></html>",
          status: "skipped_simulated",
          created_at: "2026-06-01 10:05:00+00",
        },
      ],
    ]);

    const [, saliente] = (await conversacionDelCaso(CTX, CASO))!.messages;

    expect(saliente).toEqual({
      id: "sim-1",
      direction: "outbound",
      provider: "email",
      subject: null,
      from_addr: null,
      body_text: "Ana, nos falta la foto del registro.\nCaso #123",
      received_at: "2026-06-01 10:05:00+00",
      estado_envio: "skipped_simulated",
      attachment_count: 0,
    });
  });

  it("alta simulada: lo que escribió la persona sale de raw_messages, antes de la respuesta", async () => {
    // `/api/intake/simulate` y `batch-simulate` no escriben en claim_messages:
    // sin esta fuente la tarjeta mostraba la respuesta sola.
    responder([
      [{ id: CASO }],
      [],
      [
        {
          id: "raw-1",
          provider: "email_sim",
          subject: "[email_sim] Siniestro - custom",
          from_addr: "ana@example.com",
          body_text: "Choqué ayer en Córdoba.",
          received_at: "2026-06-01 10:00:00+00",
        },
      ],
      [
        {
          id: "sim-1",
          channel: "email",
          rendered_body: "<p>Ana, nos falta la foto del registro.</p>",
          status: "skipped_simulated",
          created_at: "2026-06-01 10:05:00+00",
        },
      ],
    ]);

    const [entrada, respuesta] = (await conversacionDelCaso(CTX, CASO))!.messages;

    expect(entrada).toEqual({
      id: "raw-1",
      direction: "inbound",
      provider: "email_sim",
      subject: "[email_sim] Siniestro - custom",
      from_addr: "ana@example.com",
      body_text: "Choqué ayer en Córdoba.",
      received_at: "2026-06-01 10:00:00+00",
      estado_envio: null,
      attachment_count: 0,
    });
    expect(respuesta).toMatchObject({ id: "sim-1", direction: "outbound" });
  });

  describe("el tope", () => {
    const minuto = (n: number) => new Date(Date.UTC(2026, 5, 1, 0, n)).toISOString();

    it("corta sobre la unión: ninguna respuesta de antes de la ventana", async () => {
      // Una charla larga por WhatsApp: 51 fotos después de 51 respuestas. Cada
      // fuente trae sus 51 más nuevos; cortar por fuente mostraba las 51
      // respuestas viejas pegadas a fotos de mucho después.
      const fotos = Array.from({ length: POR_FUENTE }, (_, i) =>
        entrante({ id: `in-${i}`, received_at: minuto(200 - i) })
      );
      const respuestas = Array.from({ length: POR_FUENTE }, (_, i) => ({
        id: `wa-${i}`,
        channel: "whatsapp",
        rendered_body: "Recibido.",
        status: "sent",
        created_at: minuto(100 - i),
      }));
      responder([[{ id: CASO }], fotos, [], respuestas]);

      const { messages: mensajes, recortada } = (await conversacionDelCaso(CTX, CASO))!;

      expect(recortada).toBe(true);
      expect(mensajes).toHaveLength(TOPE_MENSAJES);
      expect(mensajes.every((m) => m.direction === "inbound")).toBe(true);
      expect(mensajes.at(-1)!.id).toBe("in-0");
    });

    it("justo en el tope no avisa corte", async () => {
      const entrantes = Array.from({ length: TOPE_MENSAJES }, (_, i) =>
        entrante({ id: `in-${i}`, received_at: minuto(100 - i) })
      );
      responder([[{ id: CASO }], entrantes, [], []]);

      const { messages: mensajes, recortada } = (await conversacionDelCaso(CTX, CASO))!;

      expect(recortada).toBe(false);
      expect(mensajes).toHaveLength(TOPE_MENSAJES);
    });
  });

  describe("el SQL del lote", () => {
    beforeEach(async () => {
      responder([[{ id: CASO }], [], [], []]);
      await conversacionDelCaso(CTX, CASO);
    });

    it("no filtra por inquilino a mano: eso lo pone la base", () => {
      for (const q of armadas) expect(q.sql).not.toMatch(/tenant_id/);
    });

    it("claim_messages va una sola vez, las dos direcciones juntas y con los adjuntos contados", () => {
      expect(armadas.filter((q) => /from "claim_messages"/.test(q.sql))).toHaveLength(1);
      const [, hilo] = armadas;
      expect(hilo!.sql).toMatch(/from "claim_messages"/);
      expect(hilo!.sql).not.toMatch(/"direction" =/);
      expect(hilo!.sql).toMatch(/left join "claim_attachments"/);
      expect(hilo!.sql).toMatch(/group by "claim_messages"\."id"/);
      expect(hilo!.params).toEqual([CASO, POR_FUENTE]);
    });

    it("de raw_messages sólo el alta simulada: lo de WhatsApp ya está en claim_messages", () => {
      const [, , simulados] = armadas;
      expect(simulados!.sql).toMatch(/from "raw_messages"/);
      expect(simulados!.params).toEqual([CASO, "email_sim", POR_FUENTE]);
    });

    it("de outbound_messages WhatsApp y el mail simulado: ni el mail real ni la fila 'email_sim' del worker", () => {
      const [, , , salientes] = armadas;
      expect(salientes!.sql).toMatch(/from "outbound_messages"/);
      expect(salientes!.sql).toMatch(
        /"outbound_messages"\."channel" = \$2 or \("outbound_messages"\."channel" = \$3 and "outbound_messages"\."status" = \$4\)/
      );
      expect(salientes!.params).toEqual([CASO, "whatsapp", "email", "skipped_simulated", POR_FUENTE]);
    });
  });
});
