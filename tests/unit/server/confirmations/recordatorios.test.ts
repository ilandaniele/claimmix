/**
 * Recordatorios de lo que falta (B4): cuándo sale uno, por dónde y cuántas
 * veces.
 *
 * El cliente de drizzle es `pg-proxy`: arma el SQL de verdad y no se conecta,
 * así que la reserva y la ancla se prueban por la consulta que sale.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  consultas: [] as { sql: string; params: unknown[] }[],
  enviar: vi.fn(),
  despachar: vi.fn(),
  plantilla: vi.fn(),
  credenciales: vi.fn(),
  auditar: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
}));

vi.mock("server-only", () => ({}));

vi.mock("@/lib/db", async () => {
  const { drizzle } = await import("drizzle-orm/pg-proxy");
  return {
    db: drizzle(async (sql, params) => {
      m.consultas.push({ sql, params });
      return { rows: filasPara(sql) };
    }),
  };
});

vi.mock("@/data/scope", async () => {
  const { puenteSobreLibDb } = await import("../../../mocks/puente-de-alcance");
  const puente = await puenteSobreLibDb();
  return { enTenant: puente.enTenant, enTenantVarias: puente.enTenantVarias };
});

vi.mock("@/server/confirmations/messenger", () => ({ messengerFor: () => ({ send: m.enviar }) }));
vi.mock("@/server/whatsapp/cloud-api", () => ({ estadoDePlantilla: m.plantilla }));
vi.mock("@/server/whatsapp/numeros", () => ({ credencialesWhatsApp: m.credenciales }));
vi.mock("@/server/email/dispatch", () => ({
  dispatchOutboundEmail: m.despachar,
  seEntrego: (r: { error?: string }) => !r.error,
}));
vi.mock("@/lib/audit/log", () => ({
  writeAuditLog: m.auditar,
  AuditEvent: {
    CASE_CLOSED: "case.closed",
    CASE_CLOSED_ABANDONED: "claim.closed_abandoned",
    CLAIM_REMINDER_SENT: "claim.reminder_sent",
    CLAIM_REMINDER_SKIPPED: "claim.reminder_skipped",
    CLAIM_REMINDER_FAILED: "claim.reminder_failed",
    CASE_CLOSURE_NOTICE_SENT: "claim.closure_notice_sent",
    CASE_CLOSURE_NOTICE_SKIPPED: "claim.closure_notice_skipped",
    CASE_CLOSURE_NOTICE_FAILED: "claim.closure_notice_failed",
  },
}));
vi.mock("@/lib/observability/logger", () => ({
  logger: { error: m.logError, warn: m.logWarn, info: vi.fn() },
}));

import { avisarCierres, recordarCaso, recordarPendientes } from "@/server/confirmations/recordatorios";
import { renderTemplate } from "@/server/email/render";

const CASE_ID = "123e4567-e89b-12d3-a456-426614174001";
const TENANT_ID = "10000000-0000-0000-0000-000000000001";
const ANCLA = "2026-09-01 12:00:00.123456+00";
const LEIDO = "2026-09-01 12:00:00.5+00";
const HORA = 60 * 60 * 1000;
const tras = (horas: number) => new Date(new Date(ANCLA).getTime() + horas * HORA);

type Estado = {
  canal: string;
  destinatario: string | null;
  entrante: string;
  pedido: string;
  horas: number[];
  ancla: string | null;
  reservas: unknown[][][];
  candidatos: unknown[][];
  cerrados: unknown[][];
};
let s: Estado;

function filasPara(sql: string): unknown[][] {
  if (sql.startsWith('insert into "case_recordatorios"')) return s.reservas.shift() ?? [];
  if (sql.includes("audit_log a")) return s.cerrados;
  if (sql.includes('inner join "tenants"')) return s.candidatos;
  if (sql.includes("min(")) return [[s.ancla]];
  if (sql.includes('from "cases"')) return [[CASE_ID, "info_faltante", s.canal, null, LEIDO, null]];
  if (sql.includes('from "claim_messages"')) return s.destinatario ? [[s.destinatario, s.entrante]] : [];
  if (sql.includes('from "outbound_messages"')) return [[["policy_number"], s.pedido]];
  if (sql.includes('from "tenants"')) return [[s.horas]];
  return [];
}

const reservas = () => m.consultas.filter((c) => c.sql.startsWith('insert into "case_recordatorios"'));
const recordar = (horas: number) => recordarCaso(CASE_ID, { tenantId: TENANT_ID, ahora: tras(horas) });

beforeEach(() => {
  vi.clearAllMocks();
  m.consultas.length = 0;
  m.enviar.mockResolvedValue(true);
  m.despachar.mockResolvedValue({ providerMessageId: "m-1" });
  m.auditar.mockResolvedValue(undefined);
  m.plantilla.mockResolvedValue("no_disponible");
  m.credenciales.mockResolvedValue({
    accessToken: "test-token",
    phoneNumberId: "123456",
    wabaId: "654321",
    autoalta: false,
    vencida: false,
  });
  s = {
    canal: "email",
    destinatario: "juan@correo.test",
    entrante: "2026-09-01 11:00:00+00",
    pedido: ANCLA,
    horas: [48, 120],
    ancla: ANCLA,
    reservas: [[[1]]],
    candidatos: [],
    cerrados: [],
  };
});

describe("recordarCaso", () => {
  it("mail a las 48 h: manda las claves abiertas y audita con actor null", async () => {
    await expect(recordar(48)).resolves.toBe("enviado");

    expect(m.enviar).toHaveBeenCalledOnce();
    expect(m.enviar.mock.calls[0][0]).toMatchObject({
      caseId: CASE_ID,
      tenantId: TENANT_ID,
      to: "juan@correo.test",
      template: "missing_information_request",
      data: { missingFields: ["policy_number"], isFollowUp: true },
    });
    expect(m.auditar).toHaveBeenCalledWith({
      tenant_id: TENANT_ID,
      actor_id: null,
      target_type: "case",
      target_id: CASE_ID,
      event_type: "claim.reminder_sent",
      payload: { etapa: 1, horas: 48, canal: "email", via: "texto" },
    });
  });

  it("antes de las 48 h no reserva nada", async () => {
    await expect(recordar(47)).resolves.toBeNull();
    expect(reservas()).toHaveLength(0);
    expect(m.enviar).not.toHaveBeenCalled();
  });

  it("paralelo y doble corrida: la misma etapa sale una sola vez", async () => {
    s.reservas = [[[1]], [], []];

    const [a, b] = await Promise.all([recordar(49), recordar(49)]);
    const c = await recordar(50);

    expect([a, b, c].filter((r) => r === "enviado")).toHaveLength(1);
    expect(m.enviar).toHaveBeenCalledOnce();
    for (const r of reservas()) expect(r.sql).toContain("on conflict do nothing");
  });

  it("pedido reciente: no reserva la etapa ni manda", async () => {
    s.pedido = tras(47).toISOString();

    await expect(recordar(48)).resolves.toBeNull();
    expect(reservas()).toHaveLength(0);
    expect(m.enviar).not.toHaveBeenCalled();
  });

  it("WhatsApp dentro de 24 h del último entrante: texto libre, sin preguntarle a Meta", async () => {
    s.canal = "whatsapp";
    s.entrante = tras(40).toISOString();

    await expect(recordar(48)).resolves.toBe("enviado");
    expect(m.plantilla).not.toHaveBeenCalled();
    expect(m.enviar.mock.calls[0][0].data).not.toHaveProperty("porPlantilla");
    expect(m.auditar.mock.calls[0][0].payload).toMatchObject({ canal: "whatsapp", via: "texto" });
  });

  it("WhatsApp fuera de ventana con la plantilla PENDING: salteado, sin outbound", async () => {
    s.canal = "whatsapp";
    m.plantilla.mockResolvedValue("pendiente");

    await expect(recordar(48)).resolves.toBe("salteado");
    expect(m.enviar).not.toHaveBeenCalled();
    expect(reservas()[0].params).toContain("plantilla_sin_aprobar");
    expect(m.auditar).toHaveBeenCalledWith(
      expect.objectContaining({
        actor_id: null,
        event_type: "claim.reminder_skipped",
        payload: { etapa: 1, reason: "plantilla_sin_aprobar" },
      })
    );
    expect(m.consultas.some((c) => /insert into "outbound_messages"/.test(c.sql))).toBe(false);
  });

  it("WhatsApp fuera de ventana y Meta sin contestar: no gasta la etapa", async () => {
    s.canal = "whatsapp";
    m.plantilla.mockResolvedValue("sin_respuesta");

    await expect(recordar(48)).resolves.toBeNull();
    expect(reservas()).toHaveLength(0);
    expect(m.enviar).not.toHaveBeenCalled();
    expect(m.auditar).not.toHaveBeenCalled();
    // Sin auditoría, esta línea es el único rastro de que se salteó.
    expect(m.logWarn).toHaveBeenCalledWith({ case_id: expect.any(String) }, "recordatorio.plantilla_sin_respuesta");
  });

  it("WhatsApp fuera de ventana con la plantilla APPROVED: manda por plantilla", async () => {
    s.canal = "whatsapp";
    m.plantilla.mockResolvedValue("aprobada");

    await expect(recordar(48)).resolves.toBe("enviado");
    expect(m.enviar.mock.calls[0][0].data).toMatchObject({ porPlantilla: true });
    expect(m.auditar.mock.calls[0][0].payload).toMatchObject({ via: "plantilla" });
  });

  it("nunca hace UPDATE sobre cases", async () => {
    await recordar(48);
    s.canal = "whatsapp";
    m.plantilla.mockResolvedValue("pendiente");
    s.reservas = [[[2]]];
    await recordar(120);

    expect(m.consultas.every((c) => /^(select|insert into "case_recordatorios")/.test(c.sql))).toBe(true);
  });

  it("caso que cambió entre la lectura y la reserva: la reserva exige el updated_at leído y, sin fila, no manda", async () => {
    s.reservas = [[]];

    await expect(recordar(48)).resolves.toBeNull();
    const { sql, params } = reservas()[0];
    expect(sql).toContain("where exists (select 1 from \"cases\" where \"cases\".\"id\" = $");
    expect(sql).toContain("\"cases\".\"status\" = 'info_faltante'");
    expect(sql).toMatch(/"cases"\."updated_at" is not distinct from \$\d+::timestamptz/);
    expect(params).toContain(LEIDO);
    expect(m.enviar).not.toHaveBeenCalled();
    expect(m.auditar).not.toHaveBeenCalled();
  });

  it("inquilino apagado: con recordatorio_horas vacío no hace nada", async () => {
    s.horas = [];

    await expect(recordar(500)).resolves.toBeNull();
    expect(reservas()).toHaveLength(0);
    expect(m.enviar).not.toHaveBeenCalled();
  });

  it("la ancla es el primer mensaje después del último entrante, acuse incluido, no el último recordatorio", async () => {
    s.pedido = tras(48).toISOString();
    s.reservas = [[[2]]];

    await expect(recordar(120)).resolves.toBe("enviado");

    const ancla = m.consultas.find((c) => c.sql.includes("min("))!;
    expect(ancla.sql).toContain("min(o.created_at)");
    // Un acuse sin pedido (el caso en espera) también arranca el ciclo.
    expect(ancla.sql).not.toContain("asked_keys");
    expect(ancla.sql).toMatch(/> coalesce\(\s*\(select max\(cm\.received_at\) from claim_messages cm where cm\.case_id = \$\d+ and cm\.direction = 'inbound'\)/);
    expect(ancla.sql).toContain("select max(rm.received_at) from raw_messages rm");
    expect(reservas()[0].params).toContain(ANCLA);
  });

  it("sin pedido después del último entrante no hay ancla ni recordatorio", async () => {
    s.ancla = null;

    await expect(recordar(500)).resolves.toBeNull();
    expect(reservas()).toHaveLength(0);
  });

  it("etapa 2 vencida sin haber hecho la 1: manda la 2 y la 1 queda salteada en la misma sentencia", async () => {
    s.reservas = [[[1], [2]]];

    await expect(recordar(121)).resolves.toBe("enviado");

    const { sql, params } = reservas()[0];
    expect(sql).toContain("generate_series(");
    expect(sql).toContain("else 'salteado' end");
    expect(params).toEqual(expect.arrayContaining([1, 2, "enviar"]));
    expect(m.enviar).toHaveBeenCalledOnce();
    expect(m.auditar.mock.calls[0][0].payload).toMatchObject({ etapa: 2, horas: 120 });
  });

  it("un salteo no escribe en outbound_messages, así leLlegoLaPregunta sigue en true", async () => {
    s.canal = "whatsapp";
    m.plantilla.mockResolvedValue("no_disponible");

    await expect(recordar(48)).resolves.toBe("salteado");
    expect(m.auditar.mock.calls[0][0].payload).toEqual({ etapa: 1, reason: "ventana_cerrada" });
    expect(m.enviar).not.toHaveBeenCalled();
    expect(m.consultas.some((c) => c.sql.includes("outbound_messages") && !c.sql.startsWith("select"))).toBe(false);
  });

  it("falla del envío: audita CLAIM_REMINDER_FAILED y no reintenta la etapa", async () => {
    // El mensajero no tira: devuelve false.
    m.enviar.mockResolvedValueOnce(false);
    s.reservas = [[[1]], []];

    await expect(recordar(48)).resolves.toBeNull();
    await expect(recordar(49)).resolves.toBeNull();

    expect(m.enviar).toHaveBeenCalledOnce();
    expect(m.auditar).toHaveBeenCalledOnce();
    expect(m.auditar.mock.calls[0][0]).toMatchObject({
      event_type: "claim.reminder_failed",
      payload: { etapa: 1, canal: "email" },
    });
    expect(m.logError).toHaveBeenCalledWith(expect.anything(), "recordatorio.envio_fallo");
  });
});

describe("recordarPendientes", () => {
  const candidatosSql = () => m.consultas.find((c) => c.sql.includes('inner join "tenants"'))!;

  it("saltea los canales simulados, sólo toma inquilinos prendidos y respeta el tope de 20", async () => {
    await recordarPendientes({ hasta: Date.now() + 60_000 });

    const { sql, params } = candidatosSql();
    expect(sql).toContain('"cases"."channel" not in ($');
    expect(params).toEqual(expect.arrayContaining(["email_sim", "whatsapp_sim"]));
    expect(sql).toContain('cardinality("tenants"."recordatorio_horas") > 0');
    expect(sql).toMatch(/limit \$\d+$/);
    expect(params.at(-1)).toBe(20);
  });

  it("sólo entra un caso con una etapa vencida y sin reservar, y sin pedido de las últimas 24 h", async () => {
    await recordarPendientes({ hasta: Date.now() + 60_000 });

    const { sql } = candidatosSql();
    expect(sql).toContain('generate_subscripts("tenants"."recordatorio_horas", 1) k');
    expect(sql).toContain(`x.a + "tenants"."recordatorio_horas"[k] * interval '1 hour' <= now()`);
    expect(sql).toContain("r.ancla = x.a and r.etapa >= k");
    expect(sql).toContain("o.created_at > now() - interval '24 hours'");
    // La ancla sale de la misma consulta que usa recordarCaso.
    expect(sql).toContain("select min(o.created_at) from outbound_messages o");
    expect(sql).not.toContain('"cases"."updated_at" <');
  });

  it("atiende a cada candidato en su inquilino y cuenta los enviados", async () => {
    s.candidatos = [[CASE_ID, TENANT_ID]];
    s.ancla = s.pedido = new Date(Date.now() - 50 * HORA).toISOString();
    s.entrante = new Date(Date.now() - 51 * HORA).toISOString();

    await expect(recordarPendientes({ hasta: Date.now() + 60_000 })).resolves.toEqual({ enviados: 1, salteados: 0 });
    expect(m.enviar).toHaveBeenCalledOnce();
  });

  it("corta por hasta", async () => {
    s.candidatos = [[CASE_ID, TENANT_ID], [CASE_ID, TENANT_ID]];

    await expect(recordarPendientes({ hasta: Date.now() - 1 })).resolves.toEqual({ enviados: 0, salteados: 0 });
    expect(m.consultas).toHaveLength(1);
  });
});

/**
 * El aviso de cierre (B4): a quien se le cerró el caso por silencio se le dice,
 * una vez, con un texto fijo. Es un barrido propio y no una cola del cierre: un
 * caso que el cierre dejó afuera por plazo o por un error se avisa en la corrida
 * siguiente.
 */
describe("avisarCierres", () => {
  const avisar = (hasta = Date.now() + 60_000) => avisarCierres({ hasta });
  const cerradosSql = () => m.consultas.find((c) => c.sql.includes("audit_log a"))!;

  beforeEach(() => {
    s.cerrados = [[CASE_ID, TENANT_ID, "email"]];
    s.reservas = [[[9]]];
  });

  it("por mail: plantilla fija, sin redactor ni mensajero, y audita el envío", async () => {
    await expect(avisar()).resolves.toBe(1);

    const { params } = reservas()[0];
    expect(params).toEqual(expect.arrayContaining(["1970-01-01T00:00:00Z", 9, "enviar"]));
    expect(m.despachar).toHaveBeenCalledWith({
      caseId: CASE_ID,
      tenantId: TENANT_ID,
      to: "juan@correo.test",
      template: "case_closure_notice",
      data: { caseId: CASE_ID },
    });
    expect(m.enviar).not.toHaveBeenCalled();
    expect(m.auditar).toHaveBeenCalledWith({
      tenant_id: TENANT_ID,
      actor_id: null,
      target_type: "case",
      target_id: CASE_ID,
      event_type: "claim.closure_notice_sent",
      payload: { canal: "email" },
    });

    const mail = renderTemplate("case_closure_notice", { caseId: "caso-1" });
    expect(mail.subject).toBe("Cerramos tu denuncia - Caso #caso-1");
    expect(mail.text).toContain("mandanos un correo nuevo");
  });

  it("por WhatsApp: sólo audita ventana_cerrada, sin mensaje", async () => {
    s.cerrados = [[CASE_ID, TENANT_ID, "whatsapp"]];

    await expect(avisar()).resolves.toBe(0);
    expect(reservas()[0].params).toContain("ventana_cerrada");
    expect(m.despachar).not.toHaveBeenCalled();
    expect(m.enviar).not.toHaveBeenCalled();
    expect(m.auditar.mock.calls[0][0]).toMatchObject({
      event_type: "claim.closure_notice_skipped",
      payload: { reason: "ventana_cerrada" },
    });
  });

  it("sin destinatario: se saltea con su motivo", async () => {
    s.destinatario = null;

    await expect(avisar()).resolves.toBe(0);
    expect(m.despachar).not.toHaveBeenCalled();
    expect(m.auditar.mock.calls[0][0]).toMatchObject({
      event_type: "claim.closure_notice_skipped",
      payload: { reason: "sin_destinatario" },
    });
  });

  it("un mail que no salió no se cuenta ni se audita como enviado", async () => {
    m.despachar.mockResolvedValueOnce({ error: "SEND_FAILED" });

    await expect(avisar()).resolves.toBe(0);
    expect(m.auditar).toHaveBeenCalledOnce();
    expect(m.auditar.mock.calls[0][0]).toMatchObject({
      event_type: "claim.closure_notice_failed",
      payload: { code: "SEND_FAILED" },
    });
    expect(m.logError).toHaveBeenCalledWith(expect.anything(), "aviso_de_cierre.envio_fallo");
  });

  it("la etapa 9 es idempotente: una doble corrida manda un solo aviso", async () => {
    s.reservas = [[[9]], []];

    await avisar();
    await avisar();

    expect(m.despachar).toHaveBeenCalledOnce();
  });

  it("busca los cierres por silencio de los últimos días que no tienen aviso, no los de esta corrida", async () => {
    await avisar();

    const { sql, params } = cerradosSql();
    expect(sql).toContain('cardinality("tenants"."recordatorio_horas") > 0');
    expect(sql).toContain('"cases"."channel" not in ($');
    expect(params).toEqual(expect.arrayContaining(["cerrado", "email_sim", "whatsapp_sim"]));
    expect(sql).toContain("\"cases\".\"closed_at\" > now() - interval '3 days'");
    // El cierre vigente tiene que ser el del barrido, no uno a mano.
    expect(sql).toContain('a.created_at >= "cases"."closed_at"');
    expect(params).toContain("claim.closed_abandoned");
    expect(sql).toMatch(/not exists \(select 1 from "case_recordatorios" where \("case_recordatorios"\."case_id" = "cases"\."id" and "case_recordatorios"\."etapa" = \$\d+\)\)/);
    expect(params).toContain(9);
    expect(params.at(-1)).toBe(20);
  });

  it("un error en un caso no frena al siguiente", async () => {
    s.cerrados = [[CASE_ID, TENANT_ID, "email"], [CASE_ID, TENANT_ID, "email"]];
    s.reservas = [[[9]], [[9]]];
    m.despachar.mockRejectedValueOnce(new Error("se cayó"));

    await expect(avisar()).resolves.toBe(1);
    expect(m.logError).toHaveBeenCalledWith(expect.anything(), "aviso_de_cierre.fallo");
  });

  it("corta al pasarse de hasta", async () => {
    await expect(avisar(Date.now() - 1)).resolves.toBe(0);
    expect(m.consultas).toHaveLength(1);
    expect(m.despachar).not.toHaveBeenCalled();
  });
});
