/**
 * El aviso de que la revisión nocturna encontró desvíos nuevos (B22).
 *
 * Sin él la lista de /desvios es la única huella y nadie la abre. Es un correo
 * por día y por inquilino, con los conteos por regla y el enlace a la pantalla:
 * nunca un caso, un nombre ni una póliza. Y nunca puede romper al cron que lo
 * llama.
 */

const m = vi.hoisted(() => ({
  enTenant: vi.fn(),
  principal: vi.fn(),
  cuenta: vi.fn(),
  enviar: vi.fn(),
  auditar: vi.fn(),
  logError: vi.fn(),
  logInfo: vi.fn(),
  constructor: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/data/scope", () => ({ enTenant: m.enTenant }));
vi.mock("@/lib/auth/provision", () => ({ resolveDefaultTenantId: m.principal }));
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
  AuditEvent: { DESVIOS_ALERTED: "quality.desvios_alerted" },
}));
vi.mock("@/lib/observability/logger", () => ({
  logger: { error: m.logError, warn: vi.fn(), info: m.logInfo },
}));

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { avisarDesvios } from "@/server/notify/specialist-alert";

/** El limitador de memoria guarda su estado entre tests: un inquilino por test. */
let n = 0;
const nuevoInquilino = () => `30000000-0000-0000-0000-${String(++n).padStart(12, "0")}`;

const LISTA = "analista@aseguradora.example.com";
const DESVIOS = { doc_sin_recibir: 2, plazo_vencido: 1 } as const;

/** La lista de /configuracion. Los roles, si hiciera falta, leen filas sin `email` y no suman a nadie. */
function destinatarios(lista: string[]) {
  m.enTenant.mockImplementation(async () => [{ emails: lista }]);
}

/**
 * Sin lista del tenant: las consultas siguen el orden de `recipientsFor`
 * (la lista, los especialistas, el respaldo de owners).
 */
function porRoles({ especialistas = [], owners = [] }: { especialistas?: string[]; owners?: string[] }) {
  const respuestas = [[{ emails: [] }], especialistas.map((email) => ({ email })), owners.map((email) => ({ email }))];
  let i = 0;
  m.enTenant.mockImplementation(async () => respuestas[i++] ?? []);
}

const correo = () => m.enviar.mock.calls[0][0] as { to: string; from: string; subject: string; textBody: string };

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://claimmix.example.com");
  vi.stubEnv("SPECIALIST_ALERT_EMAILS", "");
  m.principal.mockReturnValue(null);
  destinatarios([LISTA]);
  m.cuenta.mockResolvedValue({ email: "siniestros@aseguradora.example.com", refreshToken: "fake-refresh-token" });
  m.enviar.mockResolvedValue({ providerMessageId: "sent-1" });
  m.auditar.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("avisarDesvios", () => {
  it("manda sólo los conteos por regla y el enlace a /desvios", async () => {
    const salio = await avisarDesvios({ tenantId: nuevoInquilino(), porRegla: { ...DESVIOS } });

    expect(salio).toBe(true);
    expect(m.constructor).toHaveBeenCalledWith("fake-refresh-token");
    expect(m.enviar).toHaveBeenCalledTimes(1);
    const c = correo();
    expect(c.to).toBe(LISTA);
    expect(c.from).toBe("siniestros@aseguradora.example.com");
    expect(c.subject).toBe("La revisión de anoche encontró 3 desvíos nuevos");
    expect(c.textBody.split("\n")).toEqual([
      "Son casos de canal real que se salieron de lo esperado. Los simulados no cuentan.",
      "",
      "Documentación sin recibir: 2",
      "Plazo vencido: 1",
      "",
      "Ver los desvíos: https://claimmix.example.com/desvios",
    ]);
    expect(c.textBody).not.toContain("{");
    // Ni un caso: el enlace es el de la pantalla, no el de una ficha.
    expect(c.textBody).not.toContain("/casos/");
  });

  it("las reglas sin desvíos nuevos no salen en el correo", async () => {
    await avisarDesvios({
      tenantId: nuevoInquilino(),
      porRegla: { doc_sin_recibir: 0, cierre_sin_listo: 4 },
    });

    const { textBody, subject } = correo();
    expect(subject).toContain("4 desvíos nuevos");
    expect(textBody).toContain("Cerró sin haber estado listo: 4");
    expect(textBody).not.toContain("Documentación sin recibir");
  });

  it("sin la URL del sitio manda los conteos y no inventa un enlace", async () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "");

    await avisarDesvios({ tenantId: nuevoInquilino(), porRegla: { ...DESVIOS } });

    const { textBody } = correo();
    expect(textBody).toContain("Documentación sin recibir: 2");
    expect(textBody).not.toContain("Ver los desvíos");
    expect(textBody).not.toContain("http");
  });

  it("deja asentado en la auditoría un aviso del inquilino, con números y nada más", async () => {
    const tenantId = nuevoInquilino();

    await avisarDesvios({ tenantId, porRegla: { ...DESVIOS } });

    expect(m.auditar).toHaveBeenCalledTimes(1);
    const evento = m.auditar.mock.calls[0][0];
    expect(evento).toMatchObject({
      tenant_id: tenantId,
      actor_id: null,
      event_type: "quality.desvios_alerted",
      target_type: "tenant",
      target_id: tenantId,
      payload: { nuevos: 3, doc_sin_recibir: 2, plazo_vencido: 1, recipients: 1, delivered: true },
    });
    for (const valor of Object.values(evento.payload)) {
      expect(["number", "boolean"]).toContain(typeof valor);
    }
    expect(JSON.stringify(evento.payload)).not.toContain("@");
  });

  it("con total cero no manda, no audita y ni siquiera lee la lista", async () => {
    expect(await avisarDesvios({ tenantId: nuevoInquilino(), porRegla: {} })).toBe(false);
    expect(
      await avisarDesvios({ tenantId: nuevoInquilino(), porRegla: { doc_sin_recibir: 0, plan_sin_terminar: 0 } })
    ).toBe(false);

    expect(m.enTenant).not.toHaveBeenCalled();
    expect(m.enviar).not.toHaveBeenCalled();
    expect(m.auditar).not.toHaveBeenCalled();
  });

  it("el segundo aviso del día no manda ni audita", async () => {
    const tenantId = nuevoInquilino();

    expect(await avisarDesvios({ tenantId, porRegla: { ...DESVIOS } })).toBe(true);
    expect(await avisarDesvios({ tenantId, porRegla: { plan_sin_terminar: 5 } })).toBe(false);

    expect(m.enviar).toHaveBeenCalledTimes(1);
    expect(m.auditar).toHaveBeenCalledTimes(1);
  });

  it("el cupo es de cada inquilino: avisar a uno no calla al otro", async () => {
    await avisarDesvios({ tenantId: nuevoInquilino(), porRegla: { ...DESVIOS } });
    await avisarDesvios({ tenantId: nuevoInquilino(), porRegla: { ...DESVIOS } });

    expect(m.enviar).toHaveBeenCalledTimes(2);
  });

  it("sin destinatarios no manda, no audita y no gasta el cupo del día", async () => {
    const tenantId = nuevoInquilino();
    destinatarios([]);

    expect(await avisarDesvios({ tenantId, porRegla: { ...DESVIOS } })).toBe(false);

    expect(m.enviar).not.toHaveBeenCalled();
    expect(m.auditar).not.toHaveBeenCalled();
    expect(m.logError).toHaveBeenCalledWith({ tenant_id: tenantId }, "desvios_alert.no_recipients");

    destinatarios([LISTA]);
    await avisarDesvios({ tenantId, porRegla: { ...DESVIOS } });

    expect(m.enviar).toHaveBeenCalledTimes(1);
  });

  it("sin casilla de correo conectada no manda y tampoco gasta el cupo", async () => {
    const tenantId = nuevoInquilino();
    m.cuenta.mockResolvedValueOnce(null);

    expect(await avisarDesvios({ tenantId, porRegla: { ...DESVIOS } })).toBe(false);

    expect(m.enviar).not.toHaveBeenCalled();
    expect(m.logError).toHaveBeenCalledWith({ tenant_id: tenantId }, "desvios_alert.no_mailbox");

    await avisarDesvios({ tenantId, porRegla: { ...DESVIOS } });

    expect(m.enviar).toHaveBeenCalledTimes(1);
  });

  it("un envío que falla no gasta el cupo del día: el aviso siguiente sale", async () => {
    const tenantId = nuevoInquilino();
    m.enviar.mockResolvedValueOnce({ error: "rechazado" });

    expect(await avisarDesvios({ tenantId, porRegla: { ...DESVIOS } })).toBe(false);
    expect(await avisarDesvios({ tenantId, porRegla: { ...DESVIOS } })).toBe(true);
    // Y una vez entregado sí se gasta: el tercero no manda.
    expect(await avisarDesvios({ tenantId, porRegla: { ...DESVIOS } })).toBe(false);

    expect(m.enviar).toHaveBeenCalledTimes(2);
    expect(m.auditar.mock.calls.map((c) => c[0].payload.delivered)).toEqual([false, true]);
  });

  it("un envío que revienta no tira, no deja el error crudo en el registro y no gasta el cupo", async () => {
    const tenantId = nuevoInquilino();
    m.enviar.mockRejectedValueOnce(new Error(`token fake-refresh-token vencido para ${LISTA}`));

    await expect(avisarDesvios({ tenantId, porRegla: { ...DESVIOS } })).resolves.toBe(false);

    expect(m.auditar).not.toHaveBeenCalled();
    const registro = JSON.stringify(m.logError.mock.calls);
    expect(registro).toContain("desvios_alert.error");
    expect(registro).not.toContain("fake-refresh-token");
    expect(registro).not.toContain("@");

    await avisarDesvios({ tenantId, porRegla: { ...DESVIOS } });

    expect(m.enviar).toHaveBeenCalledTimes(2);
  });

  it("si la base de la lista revienta, tampoco tira", async () => {
    m.enTenant.mockRejectedValue(new Error("connection reset"));

    await expect(avisarDesvios({ tenantId: nuevoInquilino(), porRegla: { ...DESVIOS } })).resolves.toBe(false);

    expect(m.enviar).not.toHaveBeenCalled();
  });

  it("la auditoría no lista a quién se le avisó", async () => {
    destinatarios(["a@aseguradora.example.com", "b@aseguradora.example.com"]);

    await avisarDesvios({ tenantId: nuevoInquilino(), porRegla: { ...DESVIOS } });

    const { payload } = m.auditar.mock.calls[0][0];
    expect(payload.recipients).toBe(2);
    expect(JSON.stringify(payload)).not.toContain("@");
  });

  describe("en el idioma de cada uno", () => {
    const CASTELLANO = "especialista@aseguradora.example.com";
    const INGLES = "specialist@insurer.example.com";

    /** Sin lista: los especialistas, cada uno con el idioma de su perfil. */
    function especialistasConIdioma() {
      const respuestas = [[{ emails: [] }], [{ email: CASTELLANO, locale: null }, { email: INGLES, locale: "en-US" }]];
      let i = 0;
      m.enTenant.mockImplementation(async () => respuestas[i++] ?? []);
    }

    it("un especialista en inglés lo recibe en inglés, en un correo aparte", async () => {
      especialistasConIdioma();

      expect(await avisarDesvios({ tenantId: nuevoInquilino(), porRegla: { ...DESVIOS } })).toBe(true);

      expect(m.enviar).toHaveBeenCalledTimes(2);
      const [castellano, ingles] = m.enviar.mock.calls.map(([c]) => c);
      expect(castellano).toMatchObject({ to: CASTELLANO, subject: "La revisión de anoche encontró 3 desvíos nuevos" });
      expect(ingles).toMatchObject({ to: INGLES, subject: "Last night's review found 3 new deviations" });
      expect(ingles.textBody).toContain("See the deviations: https://claimmix.example.com/desvios");
      expect(ingles.textBody).not.toContain("{");
      expect(m.auditar.mock.calls[0][0].payload).toMatchObject({ recipients: 2, delivered: true });
    });

    it("si uno de los dos no sale, el aviso no cuenta como entregado", async () => {
      especialistasConIdioma();
      m.enviar.mockResolvedValueOnce({ providerMessageId: "sent-1" }).mockResolvedValueOnce({ error: "rechazado" });

      expect(await avisarDesvios({ tenantId: nuevoInquilino(), porRegla: { ...DESVIOS } })).toBe(false);

      expect(m.auditar.mock.calls[0][0].payload).toMatchObject({ recipients: 2, delivered: false });
    });
  });

  describe("la dirección vedada no recibe nunca", () => {
    // googlemail.com: mismo alias que gmail.com para vedadaParaAlertas,
    // sin repetir la dirección real con otra ortografía (scripts/check-personal-data.sh).
    const casos: Array<[string, (tenantId: string) => void]> = [
      ["la lista del tenant", () => destinatarios(["Ilan.Daniele@googlemail.com", "guardia@aseguradora.example.com"])],
      [
        "la variable, en el tenant principal",
        (tenantId) => {
          m.principal.mockReturnValue(tenantId);
          vi.stubEnv("SPECIALIST_ALERT_EMAILS", "ilandaniele+x@googlemail.com, guardia@aseguradora.example.com");
          porRoles({});
        },
      ],
      [
        "los especialistas",
        () => porRoles({ especialistas: ["Ilan.Daniele@googlemail.com", "peritaje@aseguradora.example.com"] }),
      ],
      [
        "el respaldo de owners",
        () => porRoles({ owners: ["ilandaniele+x@googlemail.com", "dueña@aseguradora.example.com"] }),
      ],
    ];

    it.each(casos)("nunca desde %s", async (_nombre, preparar) => {
      const tenantId = nuevoInquilino();
      preparar(tenantId);

      await avisarDesvios({ tenantId, porRegla: { ...DESVIOS } });

      expect(m.enviar).toHaveBeenCalledTimes(1);
      expect(correo().to).not.toMatch(/ilan\.?daniele/i);
    });

    it("si sólo queda la vedada, no manda nada", async () => {
      const tenantId = nuevoInquilino();
      destinatarios(["Ilan.Daniele@googlemail.com"]);

      await avisarDesvios({ tenantId, porRegla: { ...DESVIOS } });

      expect(m.enviar).not.toHaveBeenCalled();
      expect(m.auditar).not.toHaveBeenCalled();
    });
  });
});
