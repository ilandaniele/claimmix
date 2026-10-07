/**
 * El tope por remitente en el correo: del mensaje 21 en 10 minutos, el mail se
 * guarda y se marca en «Para responder», pero no lo lee el agente.
 *
 * Es el mismo techo que ya tiene WhatsApp. Sin él, un remitente que escribe en
 * ráfaga gasta una extracción por mensaje y el cupo de todos los demás.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  threadLookup: vi.fn(),
  reabrir: vi.fn(),
  marcar: vi.fn(),
  marcarAunqueSiga: vi.fn(),
  insert: vi.fn(),
  enTenantVarias: vi.fn(),
  auditar: vi.fn(),
  logError: vi.fn(),
  claves: [] as string[],
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/data/scope", async () => ({
  enTenant: (await import("../../../mocks/puente-de-alcance")).puenteDeAlcance(() => ({ insert: m.insert })).enTenant,
  enTenantVarias: m.enTenantVarias,
}));
vi.mock("@/lib/observability/logger", () => ({
  logger: { warn: vi.fn(), error: m.logError, info: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/server/email/thread-lookup", () => ({ threadLookup: m.threadLookup }));
vi.mock("@/server/email/relevance-prefilter", async (original) => ({
  ...(await original<typeof import("@/server/email/relevance-prefilter")>()),
  classifyInboundEmailForIntake: () => ({ action: "allow" }),
}));
vi.mock("@/server/cases/reabrir-no-relevante", () => ({ reabrirSiEraNoRelevante: m.reabrir }));
vi.mock("@/server/cases/para-responder", () => ({
  marcarParaResponder: m.marcar,
  marcarParaResponderAunqueSigaElAgente: m.marcarAunqueSiga,
}));
vi.mock("@/lib/audit/log", () => ({
  writeAuditLog: m.auditar,
  AuditEvent: {
    EMAIL_RECEIVED: "email.received",
    EMAIL_FILTERED: "email.filtered",
    MESSAGE_NOT_READ: "claim.message_not_read",
  },
}));
// El limitador es el de verdad (en memoria bajo test); sólo se anotan las claves.
vi.mock("@/lib/rate-limit/index", async (original) => {
  const real = await original<typeof import("@/lib/rate-limit/index")>();
  return {
    ...real,
    rateLimit: (clave: string, config: Parameters<typeof real.rateLimit>[1]) => {
      m.claves.push(clave);
      return real.rateLimit(clave, config);
    },
  };
});

import { ingestInboundEmail, type InboundEmail } from "@/server/email/inbound-email";

const TENANT = "10000000-0000-0000-0000-000000000001";
const OTRO_TENANT = "10000000-0000-0000-0000-000000000002";
const TOPE = 20;

/** El limitador de memoria guarda su estado entre tests: un remitente por test. */
let n = 0;
const nuevoRemitente = () => `persona${++n}@example.com`;

const correo = (fromAddr: string, extra: Partial<InboundEmail> = {}): InboundEmail => ({
  tenantId: TENANT,
  channel: "email",
  fromAddr,
  subject: "Re: mi siniestro",
  bodyText: "Les mando lo que faltaba.",
  messageId: `<m${++n}@example.com>`,
  ...extra,
});

async function mandar(veces: number, fromAddr: string, extra: Partial<InboundEmail> = {}) {
  const resultados = [];
  for (let i = 0; i < veces; i++) resultados.push(await ingestInboundEmail(correo(fromAddr, extra)));
  return resultados;
}

const excedente = (r: Awaited<ReturnType<typeof ingestInboundEmail>>) => r.outcome === "processed" && r.excedente;
const auditoriasDelTope = () =>
  m.auditar.mock.calls.map((c) => c[0]).filter((e) => e.event_type === "claim.message_not_read");

beforeEach(() => {
  vi.clearAllMocks();
  m.claves.length = 0;
  m.insert.mockImplementation(() => ({
    values: () => ({ returning: () => Promise.resolve([{ id: "fila-1" }]) }),
  }));
  m.threadLookup.mockResolvedValue({ existingCaseId: "caso-viejo" });
  m.reabrir.mockResolvedValue("listo");
  m.marcar.mockResolvedValue(undefined);
  m.marcarAunqueSiga.mockResolvedValue(undefined);
  m.auditar.mockResolvedValue(undefined);
});

describe("ingestInboundEmail — tope por remitente", () => {
  it("los primeros 20 pasan; el 21 en 10 minutos queda guardado, marcado y auditado", async () => {
    const remitente = nuevoRemitente();

    const antes = await mandar(TOPE, remitente);
    expect(antes.some(excedente)).toBe(false);
    expect(m.marcarAunqueSiga).not.toHaveBeenCalled();
    expect(auditoriasDelTope()).toEqual([]);

    const [veintiuno] = await mandar(1, remitente);

    expect(veintiuno).toMatchObject({ outcome: "processed", caseId: "caso-viejo", excedente: true });
    expect(m.marcarAunqueSiga).toHaveBeenCalledTimes(1);
    expect(m.marcarAunqueSiga).toHaveBeenCalledWith("caso-viejo", TENANT);
    expect(auditoriasDelTope()).toEqual([
      {
        tenant_id: TENANT,
        actor_id: null,
        event_type: "claim.message_not_read",
        target_type: "case",
        target_id: "caso-viejo",
        payload: { motivo: "tope_por_remitente", channel: "email" },
      },
    ]);
  });

  it("el mensaje del 21 se guarda: el tope no lo descarta", async () => {
    const remitente = nuevoRemitente();
    await mandar(TOPE, remitente);
    m.insert.mockClear();

    await mandar(1, remitente);

    expect(m.insert).toHaveBeenCalledTimes(1);
  });

  it("del 21 en adelante sigue excedido, y cada uno se marca y se audita", async () => {
    const remitente = nuevoRemitente();
    await mandar(TOPE, remitente);

    const siguientes = await mandar(3, remitente);

    expect(siguientes.every(excedente)).toBe(true);
    expect(m.marcarAunqueSiga).toHaveBeenCalledTimes(3);
    expect(auditoriasDelTope()).toHaveLength(3);
  });

  it("pasado el tope no reabre el caso: lo devolvería al agente", async () => {
    const remitente = nuevoRemitente();
    await mandar(TOPE, remitente);
    m.reabrir.mockClear();
    m.marcar.mockClear();

    await mandar(1, remitente);

    expect(m.reabrir).not.toHaveBeenCalled();
    expect(m.marcar).not.toHaveBeenCalled();
  });

  it("antes del tope sí sigue el camino de siempre", async () => {
    await mandar(1, nuevoRemitente());

    expect(m.reabrir).toHaveBeenCalledWith("caso-viejo", TENANT);
  });

  it("la cubeta es del remitente: otro puede escribir aunque el primero esté excedido", async () => {
    const ruidoso = nuevoRemitente();
    await mandar(TOPE + 1, ruidoso);

    const [otro] = await mandar(1, nuevoRemitente());

    expect(excedente(otro)).toBe(false);
  });

  it("la cubeta es de la casilla: el mismo remitente en otro inquilino empieza de cero", async () => {
    const remitente = nuevoRemitente();
    await mandar(TOPE + 1, remitente);

    const [enOtro] = await mandar(1, remitente, { tenantId: OTRO_TENANT });

    expect(excedente(enOtro)).toBe(false);
  });

  it("mayúsculas, espacios y nombre no cambian de cubeta", async () => {
    const base = nuevoRemitente();
    const variantes = [base, base.toUpperCase(), `  ${base}  `, `Nombre Apellido <${base}>`];

    for (let i = 0; i < TOPE; i++) await ingestInboundEmail(correo(variantes[i % variantes.length]));
    const [veintiuno] = await mandar(1, `"Otro nombre" <${base.toUpperCase()}>`);

    expect(excedente(veintiuno)).toBe(true);
  });

  it("en email_sim nunca excede: el ensayo no puede toparse a sí mismo", async () => {
    const remitente = nuevoRemitente();

    const resultados = await mandar(TOPE * 2, remitente, { channel: "email_sim" });

    expect(resultados.some(excedente)).toBe(false);
    expect(m.marcarAunqueSiga).not.toHaveBeenCalled();
    expect(auditoriasDelTope()).toEqual([]);
    expect(m.claves).toEqual([]);
  });

  it("un mail de un caso nuevo también cuenta y también se marca", async () => {
    m.threadLookup.mockResolvedValue({ existingCaseId: null });
    const remitente = nuevoRemitente();
    await mandar(TOPE, remitente);

    const [veintiuno] = await mandar(1, remitente);

    expect(veintiuno).toMatchObject({ outcome: "processed", isNewCase: true, excedente: true });
    expect(m.marcarAunqueSiga).toHaveBeenCalledWith("fila-1", TENANT);
  });

  it("si marcar falla, el correo igual queda procesado, auditado y con el registro del error", async () => {
    m.marcarAunqueSiga.mockRejectedValue(Object.assign(new Error("neon"), { code: "ECONNRESET" }));
    const remitente = nuevoRemitente();
    await mandar(TOPE, remitente);

    const [veintiuno] = await mandar(1, remitente);

    expect(veintiuno).toMatchObject({ outcome: "processed", excedente: true });
    expect(auditoriasDelTope()).toHaveLength(1);
    expect(m.logError).toHaveBeenCalledWith(
      expect.objectContaining({ case_id: "caso-viejo" }),
      "inbound_email.tope_por_remitente.no_se_pudo_marcar"
    );
  });

  it("un duplicado no suma al tope: salta antes de contar", async () => {
    const remitente = nuevoRemitente();
    await mandar(TOPE - 1, remitente);
    m.threadLookup.mockResolvedValueOnce({ existingCaseId: null });
    m.insert.mockImplementationOnce(() => ({
      values: () => ({ returning: () => Promise.reject(Object.assign(new Error("duplicate key"), { code: "23505" })) }),
    }));
    m.enTenantVarias.mockResolvedValueOnce([[{ id: "caso-viejo" }], [{ id: "mensaje-viejo" }]]);
    const antes = m.claves.length;

    const duplicado = await ingestInboundEmail(correo(remitente));

    expect(duplicado).toEqual({ outcome: "skipped", reason: "duplicate" });
    expect(m.claves.length).toBe(antes);
    const [siguiente] = await mandar(1, remitente);
    expect(excedente(siguiente)).toBe(false);
  });

  it("la clave del cupo no lleva la dirección, ni entera ni en pedazos", async () => {
    const remitente = nuevoRemitente();

    await mandar(1, remitente);

    expect(m.claves).toHaveLength(1);
    const [clave] = m.claves;
    expect(clave).toMatch(/^email:[0-9a-f]{32}$/);
    expect(clave).not.toContain(remitente);
    expect(clave).not.toContain("example.com");
    expect(clave).not.toContain(TENANT);
  });
});
