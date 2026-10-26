/**
 * El mensaje que llega a un caso en «Para responder» (B3): se reserva, se
 * clasifica, se guarda y se avisa, sin que el agente conteste y sin que el
 * texto salga del servidor.
 *
 * Un cliente de drizzle que no se conecta (`pg-proxy`) arma el SQL de verdad:
 * la reserva y el guardado se prueban por la consulta, no por una imitación.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  consultas: [] as { sql: string; params: unknown[] }[],
  ultimo: [] as unknown[][],
  reserva: [] as unknown[][],
  guardado: [] as unknown[][],
  dondeEsta: [] as unknown[][],
  cortar: vi.fn(),
  enTenant: vi.fn(),
  motor: vi.fn(),
  presupuesto: vi.fn(),
  soltar: vi.fn(),
  cupo: vi.fn(),
  consumo: vi.fn(),
  gemini: vi.fn(),
  auditar: vi.fn(),
  avisar: vi.fn(),
  despacharMail: vi.fn(),
  despacharWhatsApp: vi.fn(),
  logError: vi.fn(),
  logInfo: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/data/scope", () => ({ enTenant: m.enTenant }));
vi.mock("@/server/ai/provider", () => ({ resolveExtractionEngine: m.motor }));
vi.mock("@/server/ai/budget", () => ({
  checkBudget: m.presupuesto,
  registrarConsumoDelModelo: m.consumo,
  soltarReserva: m.soltar,
}));
vi.mock("@/server/ai/gemini-extractor", () => ({ callGemini: m.gemini }));
vi.mock("@/lib/rate-limit/index", () => ({
  rateLimit: m.cupo,
  RATE_LIMIT_CONFIGS: { CLASIFICACION_TARDIA_POR_CASO: { limit: 10, windowMs: 86_400_000 } },
}));
vi.mock("@/lib/audit/log", () => ({
  writeAuditLog: m.auditar,
  AuditEvent: { LATE_MESSAGE_CLASSIFIED: "claim.late_message_classified", CASE_CLOSED_ABANDONED: "claim.closed_abandoned" },
}));
vi.mock("@/server/notify/specialist-alert", () => ({ avisarMensajeTardio: m.avisar }));
vi.mock("@/server/cases/siniestro-nuevo", () => ({ abrirCasoPorSiniestroNuevo: m.cortar }));
// Los canales de salida al denunciante: si algo los llamara, el agente habría contestado.
vi.mock("@/server/email/dispatch", () => ({ dispatchOutboundEmail: m.despacharMail }));
vi.mock("@/server/whatsapp/cloud-api", () => ({
  sendWhatsAppText: m.despacharWhatsApp,
  sendWhatsAppTemplate: m.despacharWhatsApp,
}));
vi.mock("@/lib/observability/logger", () => ({
  logger: { error: m.logError, warn: vi.fn(), info: m.logInfo },
}));

import { drizzle } from "drizzle-orm/pg-proxy";
import { atenderMensajeTardio } from "@/server/cases/mensaje-tardio";

const CASE_ID = "123e4567-e89b-12d3-a456-426614174001";
const TENANT_ID = "10000000-0000-0000-0000-000000000001";
const MSG_ID = "22222222-2222-2222-2222-222222222222";
const NUEVO = "33333333-3333-3333-3333-333333333333";
const M1 = "44444444-4444-4444-4444-444444444441";
const M0 = "44444444-4444-4444-4444-444444444440";
const CUERPO = "Hola, ¿cómo va mi denuncia? Mi DNI es 30111222 y mi mail juan@correo.test";

const datos = drizzle(async (sql, params) => {
  m.consultas.push({ sql, params });
  if (sql.includes('set "mensaje_tardio_de"')) return { rows: m.reserva };
  if (sql.includes('set "mensaje_tardio_tipo"')) return { rows: m.guardado };
  if (sql.startsWith('select "case_id" from "claim_messages"')) return { rows: m.dondeEsta };
  return { rows: sql.includes('from "claim_messages"') ? m.ultimo : [] };
});

const ultimoSql = () => m.consultas.find((c) => c.sql.includes('from "claim_messages"') && !c.sql.startsWith('select "case_id"'));
const reservaSql = () => m.consultas.find((c) => c.sql.includes('set "mensaje_tardio_de"'));
const guardadoSql = () => m.consultas.find((c) => c.sql.includes('set "mensaje_tardio_tipo"'));

function respuesta(json: unknown) {
  m.gemini.mockResolvedValue({ text: JSON.stringify(json), usage: { prompt: 1, completion: 1 }, model: "gemini-2.5-flash" });
}

const atender = () => atenderMensajeTardio({ tenantId: TENANT_ID, caseId: CASE_ID });

beforeEach(() => {
  vi.clearAllMocks();
  m.consultas.length = 0;
  m.ultimo = [[MSG_ID, CUERPO, []]];
  m.reserva = [[CASE_ID, "email"]];
  m.guardado = [[CASE_ID]];
  m.dondeEsta = [];
  m.enTenant.mockImplementation(async (_ctx: unknown, fn: (db: unknown) => unknown) => fn(datos));
  m.motor.mockResolvedValue("gemini");
  m.presupuesto.mockResolvedValue({ exceeded: false });
  m.cupo.mockResolvedValue({ allowed: true });
  m.auditar.mockResolvedValue(undefined);
  m.avisar.mockResolvedValue(undefined);
  respuesta({ tipo: "consulta_estado", resumen: "Pregunta cómo va su denuncia" });
});

describe("la reserva", () => {
  it("toma el último entrante sólo si el caso sigue en «Para responder» y ese mensaje no se clasificó", async () => {
    await atender();

    expect(ultimoSql()!.sql).toContain('order by "claim_messages"."received_at" desc');
    expect(ultimoSql()!.sql).toContain('"outbound_messages"');
    expect(ultimoSql()!.sql).toMatch(/limit \$\d+/);
    expect(ultimoSql()!.params).toContain("inbound");
    const { sql, params } = reservaSql()!;
    expect(sql).toContain('update "cases" set "mensaje_tardio_de" = $');
    expect(sql).toContain('"para_responder_desde" is not null');
    expect(params).toEqual(expect.arrayContaining([MSG_ID, "listo", "requiere_especialista", "escalado"]));
    for (const s of ["esperando", "info_faltante", "recibido"]) expect(params).not.toContain(s);
  });

  it("también toma el caso que cerró el silencio, no uno cerrado a mano", async () => {
    // Quien contesta el aviso de cierre tiene que llegarle a alguien.
    await atender();

    const { sql, params } = reservaSql()!;
    expect(sql).toMatch(/or \(\("cases"\."status" = \$\d+ and exists \(select 1 from audit_log a/);
    expect(sql).toContain('a.created_at >= "cases"."closed_at"');
    expect(sql).toContain("from case_recordatorios r");
    expect(params).toEqual(expect.arrayContaining(["cerrado", "claim.closed_abandoned", 9]));
  });

  it("un mensaje reservado que quedó sin clase se vuelve a tomar, pero no mientras otra corrida lo clasifica", async () => {
    // Si la corrida muere en el modelo, la reserva queda con la clase en null.
    // Sin esto, nadie lo clasificaba ni avisaba nunca más. Pero mientras la
    // reserva está viva la clase también es null: dos mensajes de WhatsApp
    // seguidos o una reentrega de Meta clasificaban y avisaban dos veces.
    await atender();

    const sql = reservaSql()!.sql.replace(/\s+/g, " ");
    expect(sql).toContain('"mensaje_tardio_reservado_en" = now()');
    expect(sql).toMatch(
      /\("cases"\."mensaje_tardio_de" is distinct from \$\d+ or \("cases"\."mensaje_tardio_tipo" is null and "cases"\."mensaje_tardio_reservado_en" < now\(\) - interval '300000 milliseconds'\)\)/
    );
  });

  it("sin entrantes no reserva nada", async () => {
    m.ultimo = [];

    await atender();

    expect(reservaSql()).toBeUndefined();
    expect(m.gemini).not.toHaveBeenCalled();
    expect(m.avisar).not.toHaveBeenCalled();
  });

  it("la segunda corrida sobre el mismo mensaje no llama al modelo, no audita y no avisa", async () => {
    m.reserva = [];

    await atender();

    expect(m.gemini).not.toHaveBeenCalled();
    expect(m.auditar).not.toHaveBeenCalled();
    expect(m.avisar).not.toHaveBeenCalled();
    expect(guardadoSql()).toBeUndefined();
  });
});

describe("la clasificación", () => {
  it("guarda la clase y el resumen, audita y avisa", async () => {
    await atender();

    expect(guardadoSql()!.params).toEqual(
      expect.arrayContaining(["consulta_estado", "Pregunta cómo va su denuncia", CASE_ID, MSG_ID])
    );
    expect(m.auditar).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: "claim.late_message_classified",
        actor_id: null,
        target_id: CASE_ID,
        payload: { message_id: MSG_ID, tipo: "consulta_estado" },
      })
    );
    expect(m.avisar).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      caseId: CASE_ID,
      messageId: MSG_ID,
      tipo: "consulta_estado",
      resumen: "Pregunta cómo va su denuncia",
    });
    expect(m.consumo).toHaveBeenCalledWith(TENANT_ID, "gemini-2.5-flash", expect.anything(), null, CASE_ID);
  });

  it("el texto va al modelo sin la cita del correo anterior", async () => {
    m.ultimo = [[MSG_ID, "¿Cómo va?\n\nEl lun, 1 sep 2026 a las 10:00, Siniestros escribió:\n> Recibimos tu denuncia", []]];

    await atender();

    const usuario = m.gemini.mock.calls[0][1] as string;
    expect(usuario).toContain("¿Cómo va?");
    expect(usuario).not.toContain("Recibimos tu denuncia");
  });

  describe("el episodio", () => {
    // Lo último que mandó la persona sin que le contestaran, en orden; lo de antes de la última respuesta queda afuera.
    const filas = () => [
      [MSG_ID, "[Imagen adjunta sin texto]", {}, true],
      [M1, "Choqué recién en Alem", {}, true],
      [M0, "Gracias", {}, false],
    ];

    it("por WhatsApp el modelo ve todo lo que mandó desde la última respuesta, en orden", async () => {
      m.ultimo = filas();
      m.reserva = [[CASE_ID, "whatsapp"]];
      respuesta({ tipo: "siniestro_nuevo", resumen: "Cuenta otro choque" });
      m.cortar.mockResolvedValue({ tipo: "abierto", casoNuevo: NUEVO, movidos: 2 });

      await atender();

      const usuario = m.gemini.mock.calls[0][1] as string;
      expect(usuario.indexOf("Choqué recién en Alem")).toBeGreaterThan(-1);
      expect(usuario.indexOf("Choqué recién en Alem")).toBeLessThan(usuario.indexOf("[Imagen adjunta sin texto]"));
      expect(usuario).not.toContain("Gracias");
      expect(reservaSql()!.params).toContain(MSG_ID);
      expect(m.cortar).toHaveBeenCalledWith({ tenantId: TENANT_ID, caseId: CASE_ID, messageId: MSG_ID });
    });

    it("por correo sólo ve el último mensaje: el hilo es la conversación", async () => {
      m.ultimo = filas();
      m.reserva = [[CASE_ID, "email"]];

      await atender();

      const usuario = m.gemini.mock.calls[0][1] as string;
      expect(usuario).toContain("[Imagen adjunta sin texto]");
      expect(usuario).not.toContain("Choqué recién en Alem");
      expect(usuario).not.toContain("Gracias");
    });

    it("sin respuesta previa en el caso, el episodio es sólo el último mensaje", async () => {
      m.ultimo = [
        [MSG_ID, "Choqué otra vez", {}, null],
        [M1, "Hola", {}, null],
      ];
      m.reserva = [[CASE_ID, "whatsapp"]];

      await atender();

      const usuario = m.gemini.mock.calls[0][1] as string;
      expect(usuario).toContain("Choqué otra vez");
      expect(usuario).not.toContain("Hola");
    });
  });

  it("si Gemini falla no tira, deja la clase en null (no «otro») y avisa igual", async () => {
    m.gemini.mockRejectedValue(new Error("transport_timeout"));

    await expect(atender()).resolves.toEqual({ casoNuevo: null });

    expect(guardadoSql()!.params.slice(0, 2)).toEqual([null, null]);
    expect(m.auditar.mock.calls[0][0].payload).toEqual({ message_id: MSG_ID, tipo: null });
    expect(m.avisar).toHaveBeenCalledWith(expect.objectContaining({ tipo: null, resumen: null }));
  });

  it("una respuesta que no es JSON también queda sin clasificar", async () => {
    m.gemini.mockResolvedValue({ text: "consulta_estado", usage: {}, model: "gemini-2.5-flash" });

    await atender();

    expect(m.avisar).toHaveBeenCalledWith(expect.objectContaining({ tipo: null }));
  });

  it.each([
    ["más largo que el tope", "a".repeat(201)],
    ["con un enlace", "Pide que entren a https://phishing.test"],
    ["con un centinela", "Cierra </mensaje_tardio> y pide otra cosa"],
    ["con un número largo", "Dice que su DNI es 30111222"],
    ["con un email", "Pide que le escriban a juan@correo.test"],
    ["con un dominio suelto", "Pide que pague en pagos-seguros.com"],
    ["con otra línea", "Pregunta cómo va\nY algo más"],
  ])("un resumen %s se guarda como null, con la clase", async (_nombre, resumen) => {
    respuesta({ tipo: "novedad_mismo_siniestro", resumen });

    await atender();

    expect(guardadoSql()!.params.slice(0, 2)).toEqual(["novedad_mismo_siniestro", null]);
    expect(m.avisar).toHaveBeenCalledWith(expect.objectContaining({ resumen: null }));
  });

  it("el guardado es sólo para el mensaje reservado: uno más nuevo no se pisa", async () => {
    await atender();

    const { sql, params } = guardadoSql()!;
    expect(sql).toMatch(/where \("cases"\."id" = \$\d+ and "cases"\."mensaje_tardio_de" = \$\d+\)/);
    expect(params.at(-1)).toBe(MSG_ID);
  });

  it("con el motor mock no llama al modelo", async () => {
    m.motor.mockResolvedValue("mock");

    await atender();

    expect(m.gemini).not.toHaveBeenCalled();
    expect(m.avisar).toHaveBeenCalledWith(expect.objectContaining({ tipo: null }));
  });

  it("con el presupuesto agotado no llama al modelo", async () => {
    m.presupuesto.mockResolvedValue({ exceeded: true });

    await atender();

    expect(m.gemini).not.toHaveBeenCalled();
  });

  it("con el cupo del caso gastado no llama al modelo, y avisa igual sin clase", async () => {
    // El tope del aviso va después: sin este, cien mensajes a un caso cerrado
    // eran cien llamadas al modelo contra el presupuesto del inquilino.
    m.cupo.mockResolvedValue({ allowed: false });

    await atender();

    expect(m.cupo).toHaveBeenCalledWith(`clasificacion-tardia:${TENANT_ID}:${CASE_ID}`, expect.anything());
    expect(m.gemini).not.toHaveBeenCalled();
    expect(m.avisar).toHaveBeenCalledWith(expect.objectContaining({ tipo: null, resumen: null }));
  });

  it("una prueba que se frena sin llamar al modelo devuelve lo que reservó de su cupo diario", async () => {
    const reserva = { clave: "ia:prueba:t", ventanas: [123] };
    m.presupuesto.mockResolvedValue({ exceeded: false, reserva });
    m.cupo.mockResolvedValue({ allowed: false });

    await atender();

    expect(m.soltar).toHaveBeenCalledTimes(1);
    expect(m.soltar).toHaveBeenCalledWith(reserva);
  });

  it("si llama al modelo, la reserva se gasta y no se devuelve", async () => {
    m.presupuesto.mockResolvedValue({ exceeded: false, reserva: { clave: "ia:prueba:t", ventanas: [123] } });
    respuesta({ tipo: "consulta_estado", resumen: "Pregunta cómo va." });

    await atender();

    expect(m.gemini).toHaveBeenCalled();
    expect(m.soltar).not.toHaveBeenCalled();
  });

  it("si no se puede contar el cupo, tampoco llama al modelo", async () => {
    m.cupo.mockRejectedValue(new Error("db down"));

    await atender();

    expect(m.gemini).not.toHaveBeenCalled();
    expect(m.avisar).toHaveBeenCalledWith(expect.objectContaining({ tipo: null }));
  });

  it("un envío masivo no se reserva: no le borra la clase al mensaje de antes", async () => {
    m.ultimo = [[MSG_ID, CUERPO, [{ name: "Auto-Submitted", value: "auto-replied" }]]];

    await atender();

    expect(reservaSql()).toBeUndefined();
    expect(guardadoSql()).toBeUndefined();
    expect(m.gemini).not.toHaveBeenCalled();
    expect(m.avisar).not.toHaveBeenCalled();
    expect(m.auditar).not.toHaveBeenCalled();
  });

  it("un mensaje de WhatsApp, que guarda los encabezados como {}, se clasifica y se avisa", async () => {
    m.ultimo = [[MSG_ID, CUERPO, {}]];

    await atender();

    expect(m.logError).not.toHaveBeenCalled();
    expect(guardadoSql()!.params.slice(0, 2)).toEqual(["consulta_estado", "Pregunta cómo va su denuncia"]);
    expect(m.avisar).toHaveBeenCalledWith(expect.objectContaining({ messageId: MSG_ID, tipo: "consulta_estado" }));
  });
});

describe("lo que no hace", () => {
  it("el agente no le contesta al denunciante", async () => {
    await atender();

    expect(m.despacharMail).not.toHaveBeenCalled();
    expect(m.despacharWhatsApp).not.toHaveBeenCalled();
  });

  it("el texto crudo no llega a la auditoría, a los registros ni al aviso", async () => {
    m.auditar.mockRejectedValue(new Error("audit caído"));

    await atender();

    const todo = JSON.stringify([
      m.auditar.mock.calls,
      m.avisar.mock.calls,
      m.logError.mock.calls,
      m.logInfo.mock.calls,
    ]);
    expect(todo).not.toContain("30111222");
    expect(todo).not.toContain("juan@correo.test");
    expect(todo).not.toContain("cómo va mi denuncia");
    expect(m.logError).toHaveBeenCalledWith(expect.objectContaining({ case_id: CASE_ID }), "mensaje_tardio.error");
  });

  it("si la base falla no tira: el mensaje ya está guardado y el caso ya está marcado", async () => {
    m.enTenant.mockRejectedValue(new Error("neon"));

    await expect(atender()).resolves.toEqual({ casoNuevo: null });
    expect(m.logError).toHaveBeenCalledWith(expect.objectContaining({ case_id: CASE_ID }), "mensaje_tardio.error");
  });
});

// Un WhatsApp que cuenta otro siniestro abre un caso nuevo: ni clase ni aviso al equipo.
describe("el siniestro nuevo por WhatsApp", () => {
  const otroChoque = () => respuesta({ tipo: "siniestro_nuevo", resumen: "Cuenta otro choque" });

  it.each(["whatsapp", "whatsapp_sim"])("en %s abre el caso nuevo y lo devuelve, sin clase, sin auditoría y sin aviso", async (canal) => {
    m.reserva = [[CASE_ID, canal]];
    otroChoque();
    m.cortar.mockResolvedValue({ tipo: "abierto", casoNuevo: NUEVO, movidos: 1 });

    await expect(atender()).resolves.toEqual({ casoNuevo: NUEVO });

    expect(m.cortar).toHaveBeenCalledWith({ tenantId: TENANT_ID, caseId: CASE_ID, messageId: MSG_ID });
    expect(guardadoSql()).toBeUndefined();
    expect(m.auditar).not.toHaveBeenCalled();
    expect(m.avisar).not.toHaveBeenCalled();
  });

  it("si otra corrida ya lo mudó, no hace nada: ni clase, ni auditoría ni aviso", async () => {
    m.reserva = [[CASE_ID, "whatsapp"]];
    otroChoque();
    m.cortar.mockResolvedValue({ tipo: "ya_movido" });

    await expect(atender()).resolves.toEqual({ casoNuevo: null });

    expect(guardadoSql()).toBeUndefined();
    expect(m.auditar).not.toHaveBeenCalled();
    expect(m.avisar).not.toHaveBeenCalled();
  });

  it("si no se pudo abrir, sigue como siempre: guarda la clase, audita y avisa", async () => {
    m.reserva = [[CASE_ID, "whatsapp"]];
    otroChoque();
    m.cortar.mockResolvedValue({ tipo: "sigue" });

    await expect(atender()).resolves.toEqual({ casoNuevo: null });

    expect(guardadoSql()!.params).toEqual(expect.arrayContaining(["siniestro_nuevo", "Cuenta otro choque"]));
    expect(m.auditar.mock.calls[0][0].payload).toEqual({ message_id: MSG_ID, tipo: "siniestro_nuevo" });
    expect(m.avisar).toHaveBeenCalledWith(expect.objectContaining({ tipo: "siniestro_nuevo" }));
  });

  it("por correo no se parte: el hilo es la conversación", async () => {
    otroChoque();

    await atender();

    expect(m.cortar).not.toHaveBeenCalled();
    expect(m.avisar).toHaveBeenCalledWith(expect.objectContaining({ tipo: "siniestro_nuevo" }));
  });

  it("una novedad del mismo siniestro no se parte", async () => {
    m.reserva = [[CASE_ID, "whatsapp"]];
    respuesta({ tipo: "novedad_mismo_siniestro", resumen: "Manda otra foto" });

    await atender();

    expect(m.cortar).not.toHaveBeenCalled();
    expect(m.avisar).toHaveBeenCalledWith(expect.objectContaining({ tipo: "novedad_mismo_siniestro" }));
  });

  it("sin clase (motor mock) no se parte y el aviso sale sin clase", async () => {
    m.reserva = [[CASE_ID, "whatsapp"]];
    m.motor.mockResolvedValue("mock");

    await atender();

    expect(m.cortar).not.toHaveBeenCalled();
    expect(m.avisar).toHaveBeenCalledWith(expect.objectContaining({ tipo: null }));
  });

  it("si el guardado no pegó porque el mensaje ya está en otro caso, no audita ni avisa", async () => {
    m.reserva = [[CASE_ID, "whatsapp"]];
    m.guardado = [];
    m.dondeEsta = [["otro-caso"]];

    await expect(atender()).resolves.toEqual({ casoNuevo: null });

    expect(m.auditar).not.toHaveBeenCalled();
    expect(m.avisar).not.toHaveBeenCalled();
    expect(m.logInfo).toHaveBeenCalledWith({ case_id: CASE_ID, message_id: MSG_ID }, "mensaje_tardio.se_mudo");
  });

  it("si el guardado no pegó pero el mensaje sigue acá, audita y avisa como siempre", async () => {
    m.reserva = [[CASE_ID, "whatsapp"]];
    m.guardado = [];
    m.dondeEsta = [[CASE_ID]];

    await atender();

    expect(m.auditar).toHaveBeenCalled();
    expect(m.avisar).toHaveBeenCalled();
  });
});
