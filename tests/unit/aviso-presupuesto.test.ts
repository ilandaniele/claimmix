/**
 * El aviso de que el presupuesto de IA se agotó.
 *
 * Sin él, el worker deja sin analizar cada mensaje que entra y la única huella
 * es un warn por mensaje: nadie se entera hasta que un asegurado reclama. Es un
 * correo por día y por inquilino, y nunca puede romper al worker que lo llama.
 */

const m = vi.hoisted(() => ({
  enTenant: vi.fn(),
  cuenta: vi.fn(),
  enviar: vi.fn(),
  auditar: vi.fn(),
  logError: vi.fn(),
  logInfo: vi.fn(),
  constructor: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/data/scope", () => ({ enTenant: m.enTenant }));
vi.mock("@/lib/auth/provision", () => ({ resolveDefaultTenantId: () => null }));
vi.mock("@/server/email/gmail/accounts", () => ({ getGmailAccountForTenant: m.cuenta }));
vi.mock("@/server/email/gmail/gmail-sender", () => ({
  GmailSender: class {
    constructor(token: string) {
      m.constructor(token);
    }
    send = m.enviar;
  },
}));
vi.mock("@/lib/audit/log", () => ({
  writeAuditLog: m.auditar,
  AuditEvent: { AI_BUDGET_ALERTED: "ai.budget_alerted" },
}));
vi.mock("@/lib/observability/logger", () => ({
  logger: { error: m.logError, warn: vi.fn(), info: m.logInfo },
}));

import { beforeEach, describe, expect, it, vi } from "vitest";
import { avisarPresupuestoAgotado } from "@/server/notify/specialist-alert";

/** El limitador de memoria guarda su estado entre tests: un inquilino por test. */
let n = 0;
const nuevoInquilino = () => `20000000-0000-0000-0000-${String(++n).padStart(12, "0")}`;

/** La lista de /configuracion. Los roles, si hiciera falta, leen filas sin `email` y no suman a nadie. */
function destinatarios(lista: string[]) {
  m.enTenant.mockImplementation(async () => [{ emails: lista }]);
}

beforeEach(() => {
  vi.clearAllMocks();
  destinatarios(["analista@aseguradora.example.com"]);
  m.cuenta.mockResolvedValue({ email: "siniestros@aseguradora.example.com", refreshToken: "fake-refresh-token" });
  m.enviar.mockResolvedValue({ providerMessageId: "sent-1" });
  m.auditar.mockResolvedValue(undefined);
});

describe("avisarPresupuestoAgotado", () => {
  it("manda un correo a los especialistas y lo deja asentado en la auditoría", async () => {
    const tenantId = nuevoInquilino();

    await avisarPresupuestoAgotado({ tenantId, motivo: "inquilino" });

    expect(m.constructor).toHaveBeenCalledWith("fake-refresh-token");
    expect(m.enviar).toHaveBeenCalledTimes(1);
    const correo = m.enviar.mock.calls[0][0];
    expect(correo.to).toBe("analista@aseguradora.example.com");
    expect(correo.from).toBe("siniestros@aseguradora.example.com");
    expect(correo.subject).toContain("presupuesto de IA agotado");
    expect(correo.textBody).toMatch(/Desde las \d{2}:\d{2} /);
    expect(correo.textBody).toContain("el cupo diario de la aseguradora");
    expect(correo.textBody).not.toContain("{");
    expect(m.auditar).toHaveBeenCalledTimes(1);
    expect(m.auditar.mock.calls[0][0]).toMatchObject({
      tenant_id: tenantId,
      actor_id: null,
      event_type: "ai.budget_alerted",
      target_type: "tenant",
      target_id: tenantId,
      payload: { motivo: "inquilino", recipients: 1, delivered: true },
    });
  });

  it("cada motivo tiene su frase", async () => {
    const frases = {
      mensual: "el presupuesto mensual del proyecto",
      inquilino: "el cupo diario de la aseguradora",
      anonimo: "el cupo diario de los canales sin usuario",
    } as const;

    for (const [motivo, frase] of Object.entries(frases)) {
      await avisarPresupuestoAgotado({ tenantId: nuevoInquilino(), motivo: motivo as keyof typeof frases });
      const cuerpo = m.enviar.mock.calls.at(-1)![0].textBody as string;
      expect(cuerpo).toContain(frase);
      expect(cuerpo).not.toContain("{");
    }
  });

  it("dice lo que le pasa a lo ya recibido: queda escalado, no marcado «Para responder»", async () => {
    // El worker escala el caso (extract-budget.test.ts) y no lo marca: el aviso no puede prometer otra cosa.
    await avisarPresupuestoAgotado({ tenantId: nuevoInquilino(), motivo: "inquilino" });

    const cuerpo = m.enviar.mock.calls[0][0].textBody as string;
    expect(cuerpo).toContain("escaladas");
    expect(cuerpo).not.toContain("para responder");
  });

  it("el plazo sigue al motivo: el tope diario vuelve mañana, el mensual no", async () => {
    await avisarPresupuestoAgotado({ tenantId: nuevoInquilino(), motivo: "inquilino" });
    await avisarPresupuestoAgotado({ tenantId: nuevoInquilino(), motivo: "anonimo" });
    await avisarPresupuestoAgotado({ tenantId: nuevoInquilino(), motivo: "mensual" });

    const [inquilino, anonimo, mensual] = m.enviar.mock.calls.map((c) => c[0].textBody as string);
    expect(inquilino).toContain("hasta mañana");
    expect(anonimo).toContain("hasta mañana");
    // Prometer «mañana» con el presupuesto del mes agotado deja a la guardia esperando un día que no llega.
    expect(mensual).not.toContain("mañana");
    expect(mensual).toContain("mes que viene");
  });

  it("el segundo aviso del día no manda ni audita", async () => {
    const tenantId = nuevoInquilino();

    await avisarPresupuestoAgotado({ tenantId, motivo: "inquilino" });
    await avisarPresupuestoAgotado({ tenantId, motivo: "inquilino" });
    await avisarPresupuestoAgotado({ tenantId, motivo: "anonimo" });

    expect(m.enviar).toHaveBeenCalledTimes(1);
    expect(m.auditar).toHaveBeenCalledTimes(1);
  });

  it("el cupo es de cada inquilino: avisar a uno no calla al otro", async () => {
    await avisarPresupuestoAgotado({ tenantId: nuevoInquilino(), motivo: "inquilino" });
    await avisarPresupuestoAgotado({ tenantId: nuevoInquilino(), motivo: "inquilino" });

    expect(m.enviar).toHaveBeenCalledTimes(2);
  });

  it("sin destinatarios no manda, no audita y no gasta el cupo del día", async () => {
    const tenantId = nuevoInquilino();
    destinatarios([]);

    await avisarPresupuestoAgotado({ tenantId, motivo: "inquilino" });

    expect(m.enviar).not.toHaveBeenCalled();
    expect(m.auditar).not.toHaveBeenCalled();
    expect(m.logError).toHaveBeenCalledWith({ tenant_id: tenantId }, "presupuesto_alert.no_recipients");

    // Cuando alguien carga la lista, el aviso de ese mismo día sale.
    destinatarios(["analista@aseguradora.example.com"]);
    await avisarPresupuestoAgotado({ tenantId, motivo: "inquilino" });

    expect(m.enviar).toHaveBeenCalledTimes(1);
  });

  it("sin casilla de correo conectada no manda y tampoco gasta el cupo", async () => {
    const tenantId = nuevoInquilino();
    m.cuenta.mockResolvedValueOnce(null);

    await avisarPresupuestoAgotado({ tenantId, motivo: "mensual" });

    expect(m.enviar).not.toHaveBeenCalled();
    expect(m.auditar).not.toHaveBeenCalled();
    expect(m.logError).toHaveBeenCalledWith({ tenant_id: tenantId }, "presupuesto_alert.no_mailbox");

    destinatarios(["analista@aseguradora.example.com"]);
    await avisarPresupuestoAgotado({ tenantId, motivo: "mensual" });

    expect(m.enviar).toHaveBeenCalledTimes(1);
  });

  it("si el envío falla, no tira, y la auditoría dice que no se entregó", async () => {
    m.enviar.mockResolvedValueOnce({ error: "rechazado" });

    await expect(avisarPresupuestoAgotado({ tenantId: nuevoInquilino(), motivo: "inquilino" })).resolves.toBeUndefined();

    expect(m.auditar.mock.calls[0][0].payload).toMatchObject({ delivered: false });
    expect(m.logInfo).toHaveBeenCalledWith(expect.anything(), "presupuesto_alert.send_failed");
  });

  it("un envío que falla no gasta el cupo del día: el aviso siguiente sale", async () => {
    const tenantId = nuevoInquilino();
    m.enviar.mockResolvedValueOnce({ error: "rechazado" });

    await avisarPresupuestoAgotado({ tenantId, motivo: "inquilino" });
    await avisarPresupuestoAgotado({ tenantId, motivo: "inquilino" });
    // Y una vez entregado sí se gasta: el tercero no manda.
    await avisarPresupuestoAgotado({ tenantId, motivo: "inquilino" });

    expect(m.enviar).toHaveBeenCalledTimes(2);
    expect(m.auditar.mock.calls.map((c) => c[0].payload.delivered)).toEqual([false, true]);
  });

  it("un envío que revienta tampoco gasta el cupo del día", async () => {
    const tenantId = nuevoInquilino();
    m.enviar.mockRejectedValueOnce(new Error("gmail caído"));

    await avisarPresupuestoAgotado({ tenantId, motivo: "inquilino" });
    await avisarPresupuestoAgotado({ tenantId, motivo: "inquilino" });

    expect(m.enviar).toHaveBeenCalledTimes(2);
  });

  it("si el envío revienta, no tira ni deja el error crudo en el registro", async () => {
    m.enviar.mockRejectedValueOnce(new Error("token fake-refresh-token vencido para analista@aseguradora.example.com"));

    await expect(avisarPresupuestoAgotado({ tenantId: nuevoInquilino(), motivo: "inquilino" })).resolves.toBeUndefined();

    expect(m.auditar).not.toHaveBeenCalled();
    const registro = JSON.stringify(m.logError.mock.calls);
    expect(registro).toContain("presupuesto_alert.error");
    expect(registro).not.toContain("fake-refresh-token");
    expect(registro).not.toContain("@");
  });

  it("si la auditoría falla, tampoco tira", async () => {
    m.auditar.mockRejectedValueOnce(new Error("db caída"));

    await expect(avisarPresupuestoAgotado({ tenantId: nuevoInquilino(), motivo: "inquilino" })).resolves.toBeUndefined();
  });

  it("si la base de la lista revienta, tampoco tira", async () => {
    m.enTenant.mockRejectedValue(new Error("connection reset"));

    await expect(avisarPresupuestoAgotado({ tenantId: nuevoInquilino(), motivo: "inquilino" })).resolves.toBeUndefined();

    expect(m.enviar).not.toHaveBeenCalled();
  });

  it("la auditoría no lista a quién se le avisó", async () => {
    destinatarios(["a@aseguradora.example.com", "b@aseguradora.example.com"]);

    await avisarPresupuestoAgotado({ tenantId: nuevoInquilino(), motivo: "inquilino" });

    const { payload } = m.auditar.mock.calls[0][0];
    expect(payload.recipients).toBe(2);
    expect(JSON.stringify(payload)).not.toContain("@");
  });
});
