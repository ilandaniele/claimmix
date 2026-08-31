/**
 * Telling a person a claim needs them — and not telling them about a rehearsal.
 *
 * This is the one path in the product that reaches a human directly, and until
 * today it was the only one with no tests. It showed: a batch simulation
 * escalated thirty-five invented claims in four minutes and seventeen real
 * emails landed in a real inbox. "[Urgente] Siniestro de incendio derivado a
 * especialista", seventeen times, about fires that never happened.
 *
 * Everything else already knew. The WhatsApp messenger refuses to write to an
 * invented number; the email dispatcher refuses to send to @example.com. This
 * had simply never been told, and it was the one that mattered most.
 */

const { mockSelect, mockGetAccount, mockSend, mockAudit } = vi.hoisted(() => ({
  mockSelect: vi.fn(),
  mockGetAccount: vi.fn(),
  mockSend: vi.fn(),
  mockAudit: vi.fn(),
}));

// La capa de datos, corriendo contra el db que este test ya simula.
//
// Se lee `mod.db` en CADA llamada y no se desestructura: el mock de @/lib/db
// suele exponer `db` con un getter para que los tests puedan intercambiar la
// base simulada entre corridas, y un `const { db } = ...` congelaría el valor
// de la primera llamada.
//
// Lo que NO se prueba acá es que el contexto de inquilino llegue a la base:
// eso se verifica en tests/unit/data-scope-sin-rol.test.ts y, contra bases de
// verdad, en `pnpm capa-datos` y `pnpm tenancy`.
vi.mock("@/data/scope", async () => {
  const mod = await import("@/lib/db");
  return {
    enTenant: (_ctx: unknown, armar: (d: unknown) => unknown) =>
      Promise.resolve(armar(mod.db)),
    enTenantVarias: (_ctx: unknown, armar: (d: unknown) => unknown[]) =>
      Promise.all(armar(mod.db)),
  };
});

vi.mock("@/lib/db", () => ({ db: { select: mockSelect } }));

vi.mock("@/server/email/gmail/accounts", () => ({
  getGmailAccountForTenant: mockGetAccount,
}));

vi.mock("@/server/email/gmail/gmail-sender", () => ({
  GmailSender: class {
    send = mockSend;
  },
}));

vi.mock("@/lib/audit/log", () => ({
  writeAuditLog: mockAudit,
  AuditEvent: { SPECIALIST_ALERTED: "claim.specialist_alerted" },
}));

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { alertSpecialists } from "@/server/notify/specialist-alert";

/** El `where` con el que se preguntó «¿ya se avisó?», para poder compilarlo. */
const condicionesDeYaSeAviso: unknown[] = [];

const CASE = "11111111-1111-1111-1111-111111111111";
const TENANT = "10000000-0000-0000-0000-000000000001";

/**
 * The module makes three different selects. They are told apart by the shape
 * of the chain, which is the only thing distinguishing them from outside:
 *   channel  → select().from().where().limit()
 *   already  → select().from().where().limit()  (audit_log)
 *   people   → select().from().innerJoin().where()
 */
function database(opts: {
  channel?: string;
  alreadySent?: boolean;
  staff?: string[];
  /** Los que tienen rol `specialist`. Vacío = la aseguradora no nombró ninguno. */
  especialistas?: string[];
  /** El respaldo: owners. */
  owners?: string[];
  /** Con qué dirección o teléfono entró el denunciante. */
  remitente?: string;
}) {
  const channel = opts.channel ?? "email";
  // Una persona de verdad, salvo que el test diga otra cosa.
  const remitente = opts.remitente ?? "denunciante@correo-de-prueba.test";
  const staff = opts.staff ?? ["analista@aseguradora.com"];
  let call = 0;
  // El módulo pregunta por roles hasta dos veces: primero `specialist`, y sólo
  // si no hay ninguno, `owner`. Se cuentan las llamadas para poder devolver
  // listas distintas y probar cuál gana.
  let porRol = 0;
  condicionesDeYaSeAviso.length = 0;

  mockSelect.mockImplementation(() => ({
    from: () => ({
      innerJoin: () => ({
        where: () => {
          porRol += 1;
          if (opts.especialistas !== undefined || opts.owners !== undefined) {
            const lista = porRol === 1 ? (opts.especialistas ?? []) : (opts.owners ?? []);
            return Promise.resolve(lista.map((email) => ({ email })));
          }
          return Promise.resolve(staff.map((email) => ({ email })));
        },
      }),
      where: (cond: unknown) => ({
        limit: () => {
          call += 1;
          // First: the case's channel. Second: has an alert already gone out.
          if (call === 1) return Promise.resolve([{ channel }]);
          // El `where` de la segunda se guarda: es lo único que distingue «ya se
          // avisó» de «ya se avisó Y SE ENTREGÓ», y el mock devuelve filas sin
          // mirarlo.
          condicionesDeYaSeAviso.push(cond);
          return Promise.resolve(opts.alreadySent ? [{ id: 1 }] : []);
        },
        // El contacto del denunciante, que es lo único que distingue a un
        // asegurado inventado cuando el canal es de verdad:
        //   select().from().where().orderBy().limit()
        orderBy: () => ({
          limit: () => Promise.resolve([{ from_addr: remitente }]),
        }),
      }),
    }),
  }));
}

function alert() {
  return alertSpecialists({
    caseId: CASE,
    tenantId: TENANT,
    severity: "critical",
    claimTypeLabel: "incendio",
    summary: "Se prendió fuego el auto en la ruta 3.",
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetAccount.mockResolvedValue({
    email: "siniestros@aseguradora.com",
    refreshToken: "token",
  });
  mockSend.mockResolvedValue({ providerMessageId: "sent-1" });
  mockAudit.mockResolvedValue(undefined);
});

describe("alertSpecialists — a real claim", () => {
  it("emails the people who can act on it", async () => {
    database({ channel: "email" });

    await alert();

    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend.mock.calls[0][0].to).toContain("analista@aseguradora.com");
  });

  it("does it for WhatsApp claims too", async () => {
    database({ channel: "whatsapp" });

    await alert();

    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it("records that someone was told, without listing who", async () => {
    // An audit trail should prove a person was informed without becoming a
    // directory of staff email addresses.
    database({ channel: "email", staff: ["a@x.com", "b@x.com"] });

    await alert();

    const entry = mockAudit.mock.calls[0][0];
    expect(entry.payload).toMatchObject({ recipients: 2, delivered: true });
    expect(JSON.stringify(entry.payload)).not.toContain("@x.com");
  });

  it("does not tell them twice about the same case", async () => {
    database({ channel: "email", alreadySent: true });

    await alert();

    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe("alertSpecialists — a simulation", () => {
  it("does not email anyone about a simulated email case", async () => {
    // The bug, exactly: seventeen of these reached a real inbox.
    database({ channel: "email_sim" });

    await alert();

    expect(mockSend).not.toHaveBeenCalled();
    expect(mockAudit).not.toHaveBeenCalled();
  });

  it("does not email anyone about a simulated WhatsApp case", async () => {
    database({ channel: "whatsapp_sim" });

    await alert();

    expect(mockSend).not.toHaveBeenCalled();
  });

  it("stays quiet when it cannot tell what the case is", async () => {
    // Fail towards silence. A missed alert on a real claim leaves a case
    // sitting in requiere_especialista that somebody finds; a flood of urgent
    // emails about fires that did not happen is how an insurer stops trusting
    // the product.
    mockSelect.mockImplementation(() => {
      throw new Error("connection lost");
    });

    await alert();

    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe("alertSpecialists — when it cannot do its job", () => {
  it("says so loudly when nobody is configured to receive it", async () => {
    // The claimant has been promised a specialist will call. If no address
    // exists, that promise has no owner and the only trace is this line.
    database({ channel: "email", staff: [] });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    await alert();

    expect(mockSend).not.toHaveBeenCalled();
    expect(spy.mock.calls.flat().join(" ")).toContain("no_recipients");
    spy.mockRestore();
  });

  it("says so loudly when there is no mailbox to send from", async () => {
    database({ channel: "email" });
    mockGetAccount.mockResolvedValue(null);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    await alert();

    expect(spy.mock.calls.flat().join(" ")).toContain("no_mailbox");
    spy.mockRestore();
  });

  it("never throws — the claim is already escalated", async () => {
    database({ channel: "email" });
    mockSend.mockRejectedValue(new Error("gmail down"));

    await expect(alert()).resolves.toBeUndefined();
  });
});

/**
 * A quién se le manda, que es lo que se rompió.
 *
 * El respaldo eran `owner` Y `admin`. Como ninguna aseguradora tenía usuarios
 * con rol `specialist`, TODAS las alertas caían ahí: el resumen de cada
 * siniestro —con el enlace al caso, que abre todo— se repartía a las cuatro
 * direcciones con rol de admin, entre ellas cuentas personales de Gmail que
 * nadie eligió para eso. Lo reportó la persona que las estaba recibiendo.
 *
 * El archivo tenía diez tests y ninguno miraba la lista de destinatarios.
 */
describe("a quién le llega", () => {
  const guardada = process.env.SPECIALIST_ALERT_EMAILS;
  afterEach(() => {
    if (guardada === undefined) delete process.env.SPECIALIST_ALERT_EMAILS;
    else process.env.SPECIALIST_ALERT_EMAILS = guardada;
  });

  it("la lista explícita gana sobre cualquier deducción", async () => {
    process.env.SPECIALIST_ALERT_EMAILS = "guardia@aseguradora.com, siniestros@aseguradora.com";
    database({ especialistas: ["nadie@no.com"], owners: ["tampoco@no.com"] });

    await alert();

    const para = mockSend.mock.calls[0][0].to as string;
    expect(para).toContain("guardia@aseguradora.com");
    expect(para).toContain("siniestros@aseguradora.com");
    // Es la única forma de decir "a estas y a ninguna otra" sin tocarle el rol
    // a nadie.
    expect(para).not.toContain("nadie@no.com");
    expect(para).not.toContain("tampoco@no.com");
  });

  it("con especialistas nombrados, van a ellos", async () => {
    database({
      especialistas: ["peritaje@aseguradora.com"],
      owners: ["dueña@aseguradora.com"],
    });

    await alert();

    const para = mockSend.mock.calls[0][0].to as string;
    expect(para).toContain("peritaje@aseguradora.com");
    expect(para).not.toContain("dueña@aseguradora.com");
  });

  it("sin especialistas, va a UNO solo y no a todos los admins", async () => {
    database({
      especialistas: [],
      owners: ["dueña@aseguradora.com", "admin2@aseguradora.com", "personal@example.com"],
    });

    await alert();

    const para = mockSend.mock.calls[0][0].to as string;
    // "Mejor un aviso de más que un siniestro que nadie mira" justifica UN
    // destinatario, no una lista que crece cada vez que alguien suma un admin.
    expect(para.split(",").length).toBe(1);
    expect(para).toContain("dueña@aseguradora.com");
    expect(para).not.toContain("personal@example.com");
  });

  it("avisa en los registros que nadie tiene el rol", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    database({ especialistas: [], owners: ["dueña@aseguradora.com"] });

    await alert();

    // Sin esto, la ausencia de especialistas se vuelve la normalidad y el
    // respaldo deja de ser un respaldo.
    const avisos = warn.mock.calls
      .map((c) => String(c[0]))
      .filter((t) => t.includes("sin_especialistas"));
    expect(avisos).toHaveLength(1);
    const j = JSON.parse(avisos[0]);
    expect(j.tenant_id).toBe(TENANT);
    // Cuántos, no quiénes: una dirección es un dato personal y esto es un registro.
    expect(j.destinatarios_de_respaldo).toBe(1);
    expect(JSON.stringify(j)).not.toContain("@");
  });
});

/**
 * El ensayo entra por los canales de verdad, y ahí estaba el agujero.
 *
 * `pnpm check` corre conversaciones enteras contra el agente real, y lo hace a
 * propósito por `email` y `whatsapp` en vez de `email_sim`: su razón de ser es
 * ejercitar el camino que recorre producción. Uno de sus escenarios es un
 * incendio con heridos, que se deriva a especialista por diseño.
 *
 * O sea que el filtro por canal —lo único que había— no lo tapaba. Cada
 * verificación mandaba un "[Urgente]" de verdad sobre un siniestro inventado a
 * la casilla de una persona; y como el ensayo borra sus casos al terminar, el
 * enlace del mail abría un caso que ya no existía.
 *
 * Lo que sí distingue a un asegurado inventado es cómo se lo contacta.
 */
describe("alertSpecialists — un ensayo por canal real", () => {
  it("no avisa por una dirección example.com, aunque el canal sea email", async () => {
    database({ channel: "email", remitente: "ensayo.k3x9f2.1@example.com" });

    await alert();

    expect(mockSend).not.toHaveBeenCalled();
  });

  it("tampoco cuando la dirección viene con nombre visible", async () => {
    // Como la manda un cliente de correo de verdad, que es la forma que ya se
    // le escapó una vez a la guarda del despachador.
    database({
      channel: "email",
      remitente: "Asegurado de prueba <ensayo.k3x9f2.2@example.com>",
    });

    await alert();

    expect(mockSend).not.toHaveBeenCalled();
  });

  it("no avisa por el bloque telefónico del ensayo", async () => {
    database({ channel: "whatsapp", remitente: "5490000123456" });

    await alert();

    expect(mockSend).not.toHaveBeenCalled();
  });

  it("pero un asegurado de verdad por el mismo canal sí avisa", async () => {
    // La otra mitad, y la que importa: esto no puede convertirse en una excusa
    // para no avisar nunca. Un siniestro real que se derivó y no le llegó a
    // nadie es peor que el problema que se está arreglando.
    database({ channel: "whatsapp", remitente: "5491100000000" });

    await alert();

    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it("un teléfono argentino que sólo empieza parecido sí avisa", async () => {
    // `5490000` es el bloque reservado; `549000...` con otro dígito no lo es.
    // Una guarda demasiado ancha silencia siniestros de verdad.
    database({ channel: "whatsapp", remitente: "5490001234567" });

    await alert();

    expect(mockSend).toHaveBeenCalledTimes(1);
  });
});

/**
 * Un aviso que NO se pudo entregar no cuenta como aviso.
 *
 * La fila de `claim.specialist_alerted` se escribe pase lo que pase con el
 * envío: lleva `delivered: false` cuando Gmail no lo pudo entregar. La guarda de
 * idempotencia miraba sólo que la fila existiera, así que un envío fallido
 * dejaba una marca que después se leía como «alguien ya está mirando esto», y no
 * se volvía a intentar nunca.
 *
 * La secuencia: incendio con heridos, el caso pasa a `requiere_especialista`, al
 * asegurado le sale la plantilla que le promete que «un especialista se va a
 * comunicar con vos a la brevedad», el correo al especialista falla, y nadie se
 * entera. El caso espera a una persona a la que nunca se le avisó.
 *
 * El `catch` de esa misma función ya tenía escrita la regla correcta: «un aviso
 * duplicado es ruido, uno que falta es una denuncia que nadie levanta».
 */
describe("la guarda de «ya se avisó» mira si se entregó", () => {
  it("pregunta por delivered, no sólo por la existencia de la fila", async () => {
    const { PgDialect } = await import("drizzle-orm/pg-core");
    database({ alreadySent: false });

    await alert();

    expect(condicionesDeYaSeAviso.length).toBeGreaterThan(0);
    const compilado = new PgDialect().sqlToQuery(
      condicionesDeYaSeAviso[0] as never
    ).sql;
    expect(compilado).toContain("delivered");
  });

  it("con un aviso entregado, no se manda otro", async () => {
    // La mitad que ya andaba y no se puede perder: la idempotencia sigue en pie.
    database({ alreadySent: true });

    await alert();

    expect(mockSend).not.toHaveBeenCalled();
  });

  it("sin ningún aviso previo, se manda", async () => {
    database({ alreadySent: false });

    await alert();

    expect(mockSend).toHaveBeenCalledTimes(1);
  });
});
