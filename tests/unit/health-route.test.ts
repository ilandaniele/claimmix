/**
 * Who may ask the deployment how it is wired.
 *
 * /api/health lists every dependency, whether each one is configured, and
 * which agent behaviours are switched on. None of that is a secret on its own
 * and together it is a map: which cloud storage, which model transport,
 * whether a mailbox is connected, whether the safety switches are off today.
 * There is no reason for it to be readable by anyone who finds the URL.
 *
 * The smoke check verifies on every run that production still refuses
 * anonymous callers. This verifies it before it ships.
 */

const { mockExecute, mockSelect, mockGetWatchExpiration } = vi.hoisted(() => ({
  mockExecute: vi.fn(),
  mockSelect: vi.fn(),
  mockGetWatchExpiration: vi.fn(),
}));

vi.mock("@/server/email/gmail/poll-state", () => ({
  getWatchExpiration: mockGetWatchExpiration,
}));

// La capa de datos, corriendo contra el db que este test ya simula.
//
// Se lee `mod.db` en CADA llamada y no se desestructura: hay tests que
// intercambian la base simulada entre casos, y un `const { db } = ...`
// congelaría el valor de la primera.
vi.mock("@/data/scope", () => import("../mocks/puente-de-alcance").then((m) => m.puenteSobreLibDb()));

vi.mock("@/lib/db", () => ({
  db: { execute: mockExecute, select: mockSelect },
  // La ruta lee `tables.cases` para el chequeo de la capa de datos. Los
  // nombres no importan —la cadena está simulada— pero el objeto sí: sin él
  // se rompe al leer la propiedad, no al consultar.
  tables: { cases: { id: "id" } },
}));

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "@/app/api/health/route";
import { cifrar } from "@/lib/security/cifrado";

/** Lo que el chequeo de presupuesto va a ver como gastado este mes. */
let gastadoUsd = 0;

const SECRET = "un-secreto-largo-y-aburrido";

function request(auth?: string, query = ""): NextRequest {
  return new NextRequest(`https://claimmix.vercel.app/api/health${query}`, {
    headers: auth ? { authorization: auth } : {},
  });
}

/** A deployment with everything wired, so each test can break one thing. */
const CONFIGURED: Record<string, string> = {
  CRON_SECRET: SECRET,
  R2_ACCOUNT_ID: "acct",
  R2_ACCESS_KEY_ID: "key",
  R2_SECRET_ACCESS_KEY: "secret",
  R2_BUCKET: "bucket",
  GEMINI_API_KEY: "gemini",
  GMAIL_TENANT_ID: "10000000-0000-0000-0000-000000000001",
  GMAIL_TOKEN_ENCRYPTION_KEY: "una-clave-de-prueba-para-los-tests-largos",
};

/** Todo aplicado menos lo que se saca. */
function esquemaSin(...faltan: string[]) {
  return [
    { table_name: "missing_docs", column_name: "declined_at" },
    { table_name: "outbound_messages", column_name: "asked_keys" },
    { table_name: "cases", column_name: "extraction_lease_at" },
    { table_name: "tenants", column_name: "plan" },
    { table_name: "tenants", column_name: "monthly_fee_usd" },
    { table_name: "billing_invoices", column_name: "id" },
    { table_name: "rate_limit_counters", column_name: "key" },
    // 0037.
    { table_name: "cases", column_name: "resumen" },
    { table_name: "claim_attachments", column_name: "resumen" },
    { table_name: "claim_attachments", column_name: "util" },
    { table_name: "claim_attachments", column_name: "datos" },
    { table_name: "claim_attachments", column_name: "metadatos" },
    // 0038 y 0039.
    { table_name: "cases", column_name: "mensaje_tardio_de" },
    { table_name: "cases", column_name: "mensaje_tardio_tipo" },
    { table_name: "cases", column_name: "mensaje_tardio_resumen" },
    { table_name: "cases", column_name: "mensaje_tardio_reservado_en" },
    { table_name: "tenants", column_name: "recordatorio_horas" },
    { table_name: "case_recordatorios", column_name: "case_id" },
    // 0040.
    { table_name: "policies", column_name: "coberturas" },
    { table_name: "policies", column_name: "ambito_territorial" },
    { table_name: "policies", column_name: "condiciones_path" },
    { table_name: "policies", column_name: "condiciones_leidas_en" },
    { table_name: "cases", column_name: "monto_estimado" },
    { table_name: "tenants", column_name: "rangos_de_monto" },
    { table_name: "claim_attachments", column_name: "lectura_presupuesto" },
    // 0041.
    { table_name: "cases", column_name: "responsabilidad" },
    // 0042.
    { table_name: "cases", column_name: "puntaje_complejidad" },
    { table_name: "cases", column_name: "vence_en" },
    { table_name: "cases", column_name: "vence_plazo" },
    { table_name: "tenants", column_name: "reglas_asignacion" },
    { table_name: "tenants", column_name: "plazos" },
    { table_name: "tenants", column_name: "plan_por_tipo" },
    { table_name: "tenants", column_name: "pesos_puntaje" },
    { table_name: "case_plan_pasos", column_name: "case_id" },
    // 0043.
    { table_name: "asistente_turnos", column_name: "id" },
    { table_name: "case_desvios", column_name: "case_id" },
    // 0044.
    { table_name: "formulario_web", column_name: "tenant_id" },
    { table_name: "tenant_claim_types", column_name: "tenant_id" },
    { table_name: "cases", column_name: "canal_web" },
    // 0045.
    { table_name: "adjuntos_por_purgar", column_name: "id" },
    // 0046.
    { table_name: "ai_usage_mensual", column_name: "tenant_id" },
    // 0054.
    { table_name: "ai_usage", column_name: "case_id" },
  ].filter((f) => !faltan.includes(`${f.table_name}.${f.column_name}`) && !faltan.includes(f.table_name));
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const [k, v] of Object.entries(CONFIGURED)) process.env[k] = v;

  // A database with every migration applied, so a test that wants one missing
  // has to say so.
  // El chequeo de presupuesto consulta la MISMA `db.execute`, así que el mock
  // tiene que distinguir por la consulta: si no, le llegan filas de
  // information_schema y suma cero sin que nadie lo note.
  gastadoUsd = 0;
  mockExecute.mockImplementation((q: unknown) => {
    if (JSON.stringify(q).includes("ai_usage")) {
      return Promise.resolve({ rows: [{ total: gastadoUsd }] });
    }
    return Promise.resolve({ rows: esquemaSin() });
  });
  mockSelect.mockReturnValue({
    from: () => ({
      limit: () => Promise.resolve([]),
      where: () => ({ limit: () => Promise.resolve([]) }),
    }),
  });
});

afterEach(() => {
  for (const k of Object.keys(CONFIGURED)) delete process.env[k];
  delete process.env.AGENT_DELIBERATION;
});

describe("GET /api/health — who gets to see it", () => {
  it("refuses a caller with no credentials", async () => {
    const res = await GET(request());
    expect(res.status).toBe(401);
  });

  it("refuses the wrong secret", async () => {
    const res = await GET(request("Bearer otra-cosa-cualquiera"));
    expect(res.status).toBe(401);
  });

  it("refuses a secret that is merely a prefix of the real one", async () => {
    // The comparison is length-checked before it is timing-safe; a prefix
    // getting through would be the classic way to leak the rest a byte at a
    // time.
    const res = await GET(request(`Bearer ${SECRET.slice(0, -1)}`));
    expect(res.status).toBe(401);
  });

  it("refuses everyone when no secret is configured", async () => {
    // Fail closed. An unconfigured deployment must not answer, and must
    // especially not answer everyone.
    delete process.env.CRON_SECRET;
    const res = await GET(request(`Bearer ${SECRET}`));
    expect(res.status).toBe(401);
  });

  it("answers the right secret", async () => {
    const res = await GET(request(`Bearer ${SECRET}`));
    expect(res.status).toBeLessThan(500);

    const body = await res.json();
    expect(Array.isArray(body.checks)).toBe(true);
  });

  it("says nothing about the dependencies in the refusal", async () => {
    // A 401 that leaks the shape of the answer defeats the point of the 401.
    const res = await GET(request());
    const text = JSON.stringify(await res.json());

    expect(text).not.toContain("almacenamiento");
    expect(text).not.toContain("whatsapp");
    expect(text).not.toContain(SECRET);
  });
});

describe("GET /api/health — what it reports", () => {
  it("mira la casilla que atiende, no una apagada al lado", async () => {
    // Pasó el 24 de agosto: al cambiar la casilla de entrada quedaron tres
    // filas —dos apagadas a propósito y la que trabaja— y el chequeo levantaba
    // una cualquiera. Producción sana, salud en amarillo, y el aviso apuntando
    // a una casilla que apagamos nosotros. Un chequeo que grita sin motivo se
    // deja de mirar, que es peor que no tenerlo.
    const active = Promise.resolve([
      {
        email: "siniestros@aseguradora.com",
        enabled: true,
        lastError: null,
        tokenEncrypted: "iv.tag.ciphertext",
      },
    ]);
    mockSelect.mockReturnValue({
      from: () => ({
        // El chequeo de la capa de datos va `from(...).limit(...)` sin where:
        // el filtro por inquilino lo pone la base. Sin este nivel, la cadena
        // simulada no resuelve y el chequeo sale down por culpa del mock.
        limit: () => Promise.resolve([]),
        where: () => ({
          limit: () => active,
          orderBy: () => ({ limit: () => active }),
        }),
      }),
    });

    const res = await GET(request(`Bearer ${SECRET}`));
    const body = await res.json();
    const gmail = body.checks.find((c: { name: string }) => c.name === "gmail");

    // Lo que se afirma es de QUÉ casilla habla, no si el token de la fixtura
    // descifra: eso lo cubren los tests de al lado.
    expect(gmail.detail).not.toContain("desactivada");
    expect(gmail.detail).toContain("siniestros@aseguradora.com");
  });

  it("calls a missing migration down, not merely a warning", async () => {
    // The column is absent, which means a feature is quietly broken in
    // production. That is not something to mention in passing.
    mockExecute.mockResolvedValue({ rows: [{ table_name: "cases", column_name: "id" }] });

    const res = await GET(request(`Bearer ${SECRET}`));
    const body = await res.json();

    const schema = body.checks.find((c: { name: string }) => c.name === "migraciones");
    expect(schema.status).toBe("down");
    expect(schema.detail).toContain("missing_docs.declined_at");
  });

  it("la 0044 sin aplicar da degradado con el motivo, no caído", async () => {
    for (const falta of [["formulario_web"], ["tenant_claim_types"], ["cases.canal_web"]]) {
      mockExecute.mockImplementation((q: unknown) =>
        Promise.resolve(
          JSON.stringify(q).includes("ai_usage")
            ? { rows: [{ total: 0 }] }
            : { rows: esquemaSin(...falta) }
        )
      );

      const res = await GET(request(`Bearer ${SECRET}`));
      const body = await res.json();

      const schema = body.checks.find((c: { name: string }) => c.name === "migraciones");
      expect(schema.status, falta[0]).toBe("degraded");
      expect(schema.detail).toContain("migración 0044 pendiente");
    }
  });

  it("sin la cola de purga (0045) cae, porque borrar un caso dejaría de andar; sso_settings no cuenta", async () => {
    const schemaCon = async (...falta: string[]) => {
      mockExecute.mockImplementation((q: unknown) =>
        Promise.resolve(
          JSON.stringify(q).includes("ai_usage")
            ? { rows: [{ total: 0 }] }
            : { rows: esquemaSin(...falta) }
        )
      );
      const body = await (await GET(request(`Bearer ${SECRET}`))).json();
      return body.checks.find((c: { name: string }) => c.name === "migraciones");
    };

    const sinCola = await schemaCon("adjuntos_por_purgar");
    expect(sinCola.status).toBe("down");
    expect(sinCola.detail).toContain("adjuntos_por_purgar");

    // El SSO tolera la tabla ausente (queda apagado) y el esquema no la pide.
    expect((await schemaCon("sso_settings")).status).toBe("ok");
  });

  it("sin el acumulador de uso de IA (0046) cae, porque /metricas dejaría de abrir", async () => {
    mockExecute.mockImplementation((q: unknown) =>
      Promise.resolve(
        JSON.stringify(q).includes("ai_usage")
          ? { rows: [{ total: 0 }] }
          : { rows: esquemaSin("ai_usage_mensual") }
      )
    );
    const body = await (await GET(request(`Bearer ${SECRET}`))).json();
    const migraciones = body.checks.find((c: { name: string }) => c.name === "migraciones");

    expect(migraciones.status).toBe("down");
    expect(migraciones.detail).toContain("ai_usage_mensual");
  });

  it("sin la columna de caso del uso de IA (0054) cae: cada gasto se pierde en silencio y los topes no cortan", async () => {
    mockExecute.mockImplementation((q: unknown) =>
      Promise.resolve(
        JSON.stringify(q).includes("ai_usage")
          ? { rows: [{ total: 0 }] }
          : { rows: esquemaSin("ai_usage.case_id") }
      )
    );
    const body = await (await GET(request(`Bearer ${SECRET}`))).json();
    const migraciones = body.checks.find((c: { name: string }) => c.name === "migraciones");

    expect(migraciones.status).toBe("down");
    expect(migraciones.detail).toContain("ai_usage.case_id");
  });

  it("nota que falta lo comercial, no sólo lo del camino caliente", async () => {
    // Es la falla que pasó: la 0010 figuraba aplicada en el registro y no lo
    // estaba. Nadie lo vio durante dos días porque la facturación no es lo que
    // toca una denuncia al entrar, y el chequeo sólo miraba ese camino.
    mockExecute.mockResolvedValue({
      rows: [
        { table_name: "missing_docs", column_name: "declined_at" },
        { table_name: "outbound_messages", column_name: "asked_keys" },
        { table_name: "cases", column_name: "extraction_lease_at" },
        { table_name: "billing_invoices", column_name: "id" },
        { table_name: "rate_limit_counters", column_name: "key" },
      ],
    });

    const res = await GET(request(`Bearer ${SECRET}`));
    const body = await res.json();

    const schema = body.checks.find((c: { name: string }) => c.name === "migraciones");
    expect(schema.status).toBe("down");
    expect(schema.detail).toContain("tenants.plan");
  });

  it("nota que falta la 0037, la de lo que se leyó de los adjuntos", async () => {
    // Sin estas columnas el worker falla al guardar el resumen y los datos de
    // cada archivo, y la ficha no tiene qué mostrar.
    const faltan = ["cases.resumen", "claim_attachments.resumen", "claim_attachments.util", "claim_attachments.datos", "claim_attachments.metadatos"];
    mockExecute.mockResolvedValue({ rows: esquemaSin(...faltan) });

    const res = await GET(request(`Bearer ${SECRET}`));
    const schema = (await res.json()).checks.find((c: { name: string }) => c.name === "migraciones");

    expect(schema.status).toBe("down");
    for (const col of faltan) expect(schema.detail).toContain(col);
  });

  it("nota que falta la 0038: sin ella el worker no reserva el mensaje tardío", async () => {
    mockExecute.mockResolvedValue({ rows: esquemaSin("cases.mensaje_tardio_de", "cases.mensaje_tardio_tipo", "cases.mensaje_tardio_resumen") });

    const res = await GET(request(`Bearer ${SECRET}`));
    const schema = (await res.json()).checks.find((c: { name: string }) => c.name === "migraciones");

    expect(schema.status).toBe("down");
    expect(schema.detail).toContain("cases.mensaje_tardio_de");
    expect(schema.detail).toContain("cases.mensaje_tardio_resumen");
  });

  it("nota que falta la 0039: la columna del inquilino y la tabla de recordatorios", async () => {
    mockExecute.mockResolvedValue({ rows: esquemaSin("tenants.recordatorio_horas", "case_recordatorios") });

    const res = await GET(request(`Bearer ${SECRET}`));
    const schema = (await res.json()).checks.find((c: { name: string }) => c.name === "migraciones");

    expect(schema.status).toBe("down");
    expect(schema.detail).toContain("tenants.recordatorio_horas");
    expect(schema.detail).toContain("case_recordatorios");
  });

  it("nota que falta la 0040: el monto estimado, la cobertura y el presupuesto", async () => {
    const faltan = [
      "policies.coberturas",
      "policies.ambito_territorial",
      "policies.condiciones_path",
      "policies.condiciones_leidas_en",
      "cases.monto_estimado",
      "tenants.rangos_de_monto",
      "claim_attachments.lectura_presupuesto",
    ];
    mockExecute.mockResolvedValue({ rows: esquemaSin(...faltan) });

    const res = await GET(request(`Bearer ${SECRET}`));
    const schema = (await res.json()).checks.find((c: { name: string }) => c.name === "migraciones");

    expect(schema.status).toBe("down");
    for (const col of faltan) expect(schema.detail).toContain(col);
  });

  it("nota que falta la 0041: la opinión de responsabilidad", async () => {
    mockExecute.mockResolvedValue({ rows: esquemaSin("cases.responsabilidad") });

    const res = await GET(request(`Bearer ${SECRET}`));
    const schema = (await res.json()).checks.find((c: { name: string }) => c.name === "migraciones");

    expect(schema.status).toBe("down");
    expect(schema.detail).toContain("cases.responsabilidad");
  });

  it("nota que falta la 0042: vencimientos, puntaje, reglas del inquilino y el plan de trabajo", async () => {
    const faltan = [
      "cases.puntaje_complejidad",
      "cases.vence_en",
      "cases.vence_plazo",
      "tenants.reglas_asignacion",
      "tenants.plazos",
      "tenants.plan_por_tipo",
      "tenants.pesos_puntaje",
      "case_plan_pasos",
    ];
    mockExecute.mockResolvedValue({ rows: esquemaSin(...faltan) });

    const res = await GET(request(`Bearer ${SECRET}`));
    const schema = (await res.json()).checks.find((c: { name: string }) => c.name === "migraciones");

    expect(schema.status).toBe("down");
    for (const col of faltan) expect(schema.detail).toContain(col);
  });

  it("nota que falta la 0043: la conversación del asistente y los desvíos de la revisión nocturna", async () => {
    mockExecute.mockResolvedValue({ rows: esquemaSin("asistente_turnos", "case_desvios") });

    const res = await GET(request(`Bearer ${SECRET}`));
    const schema = (await res.json()).checks.find((c: { name: string }) => c.name === "migraciones");

    expect(schema.status).toBe("down");
    expect(schema.detail).toContain("asistente_turnos");
    expect(schema.detail).toContain("case_desvios");
  });

  it("answers 503 when anything is down, so a watcher notices", async () => {
    mockExecute.mockRejectedValue(new Error("connection refused"));

    const res = await GET(request(`Bearer ${SECRET}`));
    expect(res.status).toBe(503);
    expect((await res.json()).status).toBe("down");
  });

  it("calls missing storage credentials down", async () => {
    // The exact production failure this endpoint was written for: R2 working
    // on a laptop and absent from the deployment, silently, for hours.
    delete process.env.R2_BUCKET;

    const res = await GET(request(`Bearer ${SECRET}`));
    const body = await res.json();
    const storage = body.checks.find((c: { name: string }) => c.name === "almacenamiento");

    expect(storage.status).toBe("down");
    expect(storage.detail).toContain("R2_BUCKET");
  });

  it("flags a deployment running with the agent switched off", async () => {
    // Not a failure — both switches exist on purpose — but a deployment
    // quietly behaving like the old decision tree is worth seeing rather than
    // deducing from the messages.
    process.env.AGENT_DELIBERATION = "off";

    const res = await GET(request(`Bearer ${SECRET}`));
    const body = await res.json();
    const agent = body.checks.find((c: { name: string }) => c.name === "agente");

    expect(agent.status).toBe("degraded");
    expect(agent.detail).toContain("deliberación OFF");

    delete process.env.AGENT_DELIBERATION;
  });

  it("does not touch storage or the model unless asked to go deep", async () => {
    // The shallow check has to stay free, or nobody runs it.
    const res = await GET(request(`Bearer ${SECRET}`));
    const body = await res.json();

    expect(body.deep).toBe(false);
    const storage = body.checks.find((c: { name: string }) => c.name === "almacenamiento");
    expect(storage.detail).toContain("sin probar");
  });
});

describe("GET /api/health — a connected mailbox that cannot be read", () => {
  /**
   * The row's existence is not the thing that matters. The refresh token is
   * stored encrypted, and if the key is missing or has been rotated, the row
   * still looks perfect while nothing can send or poll a single message.
   *
   * The first version of this check reported "conectada" on exactly that, and
   * the local script hit the real failure minutes later.
   */
  function mailboxOnFile(tokenEncrypted = "iv.tag.ciphertext") {
    const rows = Promise.resolve([
      {
        email: "siniestros@aseguradora.com",
        enabled: true,
        lastError: null,
        tokenEncrypted,
      },
    ]);

    // La consulta pide la casilla ACTIVA y ordenada: where().orderBy().limit().
    // El mock acepta las dos formas para no atarse a la escritura exacta de la
    // cadena, que es un detalle del constructor y no del comportamiento.
    mockSelect.mockReturnValue({
      from: () => ({
        // El chequeo de la capa de datos va `from(...).limit(...)` sin where:
        // el filtro por inquilino lo pone la base. Sin este nivel, la cadena
        // simulada no resuelve y el chequeo sale down por culpa del mock.
        limit: () => Promise.resolve([]),
        where: () => ({
          limit: () => rows,
          orderBy: () => ({ limit: () => rows }),
        }),
      }),
    });
  }


  async function gmailCheck() {
    const res = await GET(request(`Bearer ${SECRET}`));
    const body = await res.json();
    return body.checks.find((c: { name: string }) => c.name === "gmail");
  }

  it("calls it down when the encryption key is missing", async () => {
    mailboxOnFile();
    delete process.env.GMAIL_TOKEN_ENCRYPTION_KEY;

    const gmail = await gmailCheck();
    expect(gmail.status).toBe("down");
    expect(gmail.detail).toContain("GMAIL_TOKEN_ENCRYPTION_KEY");
  });

  it("calls it down when the stored token will not decrypt", async () => {
    // What a rotated key looks like: the row is fine, the bytes are not.
    mailboxOnFile("esto-no-es-un-payload-valido");

    const gmail = await gmailCheck();
    expect(gmail.status).toBe("down");
    expect(gmail.detail).toContain("no descifra");
  });

  it("calls it degraded, not down, when the key is merely short", async () => {
    // Descifra igual —AES no exige un largo mínimo— pero un SHA-256 sin sal
    // deriva la clave de esto, así que su fuerza es la de la cadena.
    mailboxOnFile();
    process.env.GMAIL_TOKEN_ENCRYPTION_KEY = "a".repeat(20);
    expect(process.env.GMAIL_TOKEN_ENCRYPTION_KEY).toHaveLength(20);

    const gmail = await gmailCheck();
    expect(gmail.status).toBe("degraded");
    expect(gmail.detail).toContain("corta");
  });

  describe("el aviso de push", () => {
    const enHoras = (h: number) => new Date(Date.now() + h * 60 * 60 * 1000).toISOString();

    beforeEach(() => mailboxOnFile(cifrar("fake-refresh-token")));

    it("vencido no es «push al día»: el correo entra sólo por el cron", async () => {
      mockGetWatchExpiration.mockResolvedValue(enHoras(-2));

      const gmail = await gmailCheck();
      expect(gmail.status).toBe("degraded");
      expect(gmail.detail).toContain("venció");
    });

    it("a menos de 12 h, el cron ya tendría que haberlo renovado", async () => {
      mockGetWatchExpiration.mockResolvedValue(enHoras(6));

      const gmail = await gmailCheck();
      expect(gmail.status).toBe("degraded");
      expect(gmail.detail).toContain("menos de 12 h");
    });

    it("con días por delante está al día", async () => {
      mockGetWatchExpiration.mockResolvedValue(enHoras(5 * 24));

      const gmail = await gmailCheck();
      expect(gmail.status).toBe("ok");
      expect(gmail.detail).toContain("push al día");
    });
  });

  it("still reports a mailbox nobody has connected as merely degraded", async () => {
    // Nothing is broken — the product simply has not been set up yet.
    mockSelect.mockReturnValue({
      from: () => ({
        // El chequeo de la capa de datos va `from(...).limit(...)` sin where:
        // el filtro por inquilino lo pone la base. Sin este nivel, la cadena
        // simulada no resuelve y el chequeo sale down por culpa del mock.
        limit: () => Promise.resolve([]), where: () => ({ limit: () => Promise.resolve([]) }) }),
    });

    const gmail = await gmailCheck();
    expect(gmail.status).toBe("degraded");
  });
});

/**
 * El presupuesto es el único límite que, al llegar, frena las denuncias.
 *
 * `checkBudget` devuelve `exceeded` y el caso se queda esperando con un warn en
 * los registros. Nadie mira los registros hasta que algo se ve roto, y esto no
 * se ve roto: se ve quieto. Por eso el chequeo avisa antes de llegar.
 *
 * Los umbrales se prueban acá porque un `>` donde va un `>=`, o una división
 * dada vuelta, no avisaría nunca — y eso tampoco se ve.
 */
describe("cuánto queda del presupuesto de IA", () => {
  const leer = async () => {
    const res = await GET(request(`Bearer ${SECRET}`));
    const body = await res.json();
    return { ...body.checks.find((c: { name: string }) => c.name === "presupuesto"), http: res.status };
  };

  afterEach(() => {
    delete process.env.MONTHLY_BUDGET_USD;
  });

  it("lejos del tope, en verde y con el número", async () => {
    gastadoUsd = 20;
    const p = await leer();
    expect(p.status).toBe("ok");
    expect(p.detail).toContain("US$20.00 de US$200");
    expect(p.detail).toContain("10%");
  });

  it("a partir del 80% avisa, sin voltear el chequeo", async () => {
    gastadoUsd = 160;
    const p = await leer();
    // `degraded` y no `down`: todavía procesa. Es el mismo estado que usa
    // WhatsApp para "calidad amarilla, vigilalo".
    expect(p.status).toBe("degraded");
    expect(p.detail).toContain("vigilalo");
  });

  it("justo debajo del umbral sigue en verde", async () => {
    // El borde importa: con `>` en vez de `>=`, el aviso del 80% no saldría.
    gastadoUsd = 159.99;
    expect((await leer()).status).toBe("ok");
  });

  it("agotado es `down`, y dice que la extracción está frenada", async () => {
    gastadoUsd = 200;
    const p = await leer();
    expect(p.status).toBe("down");
    expect(p.detail).toContain("frenada");
  });

  it("muestra el tope que lee el guardia, no un 200 fijo", async () => {
    process.env.MONTHLY_BUDGET_USD = "50";
    gastadoUsd = 20;
    const p = await leer();
    expect(p.status).toBe("ok");
    expect(p.detail).toContain("US$20.00 de US$50 (40%)");
  });

  it("un tope con decimales sale tal cual, como en /configuracion", async () => {
    process.env.MONTHLY_BUDGET_USD = "49.5";
    gastadoUsd = 10;
    expect((await leer()).detail).toContain("de US$49.5 ");
  });

  it("con el tope en 0 la IA está frenada a propósito: avisa, no tumba el despliegue", async () => {
    process.env.MONTHLY_BUDGET_USD = "0";
    gastadoUsd = 12.5;
    const p = await leer();
    // `degraded` y no `down`: `down` da 503 y el smoke lo cuenta como falla.
    // Apagar la IA a mano no es una caída.
    expect(p.status).toBe("degraded");
    expect(p.http).toBe(200);
    expect(p.detail).toContain("US$12.50");
    expect(p.detail).toContain("frenada");
    expect(p.detail).toContain("MONTHLY_BUDGET_USD=0");
    expect(p.detail).not.toContain("US$200");
  });

  it("suma desde la medianoche argentina del primero, la misma que el guardia y el aviso de topes", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-24T15:30:00Z") });
    try {
      await leer();
    } finally {
      vi.useRealTimers();
    }
    const consulta = mockExecute.mock.calls.map(([q]) => JSON.stringify(q)).find((q) => q.includes("ai_usage"));
    expect(consulta).toContain("2026-10-01T03:00:00.000Z");
  });

  it("si la consulta falla, avisa en vez de decir que está todo bien", async () => {
    mockExecute.mockImplementation((q: unknown) => {
      if (JSON.stringify(q).includes("ai_usage")) {
        return Promise.reject(new Error("timeout"));
      }
      return Promise.resolve({ rows: [] });
    });
    const p = await leer();
    // Un cero silencioso sería peor que un error: diría "queda todo el
    // presupuesto" justo cuando no se sabe cuánto queda.
    expect(p.status).toBe("degraded");
    expect(p.detail).toContain("no se pudo consultar");
  });
});

/**
 * Las banderas del ambiente salen como clave de primer nivel, junto a `checks`
 * y nunca adentro: el smoke imprime el `detail` de cada chequeo en los logs
 * públicos de Actions. El Bearer es el mismo de siempre; sin él no cambia nada.
 */
describe("GET /api/health — banderas", () => {
  afterEach(() => vi.unstubAllEnvs());

  const leer = async () => (await GET(request(`Bearer ${SECRET}`))).json();

  it("sin el Bearer la respuesta pública no cambia", async () => {
    for (const auth of [undefined, "Bearer otra-cosa-cualquiera"]) {
      const res = await GET(request(auth));
      expect(res.status).toBe(401);

      const body = await res.json();
      expect(body).toEqual({ error: { code: "UNAUTHORIZED", message: "Bearer CRON_SECRET requerido." } });

      const text = JSON.stringify(body);
      expect(text).not.toContain("banderas");
      expect(text).not.toContain("ALTA_");
    }
  });

  it("con el Bearer trae banderas, aparte de checks", async () => {
    const res = await GET(request(`Bearer ${SECRET}`));
    expect(res.status).toBeLessThan(500);

    const body = await res.json();
    expect(body.banderas).not.toBeNull();
    expect(typeof body.banderas).toBe("object");
    expect(Array.isArray(body.banderas)).toBe(false);
    expect(Object.keys(body.banderas)).toHaveLength(46);
    expect(body.checks.some((c: { name: string }) => c.name === "banderas")).toBe(false);

    const modos = ["vertex", "ai-studio", "apagado", "simular", "borrar", "desconocido"];
    for (const [nombre, valor] of Object.entries(body.banderas)) {
      const valido =
        typeof valor === "boolean" ||
        typeof valor === "number" ||
        valor === null ||
        (typeof valor === "string" && modos.includes(valor));
      expect(valido, nombre).toBe(true);
    }
  });

  it("lee el entorno del deploy", async () => {
    vi.stubEnv("ALTA_TOPE_GLOBAL_DIA", "5");
    vi.stubEnv("ALTA_AUTOMATICA", "1");
    vi.stubEnv("ALTA_TOPE_MB", "3500");
    vi.stubEnv("RETENCION_MODO", "borrarr");

    const { banderas } = await leer();
    expect([
      banderas.ALTA_TOPE_GLOBAL_DIA,
      banderas.ALTA_AUTOMATICA,
      banderas.ALTA_TOPE_MB,
      banderas.RETENCION_MODO,
    ]).toEqual([5, true, null, "desconocido"]);
  });

  it("ningún secreto sale como texto", async () => {
    const valores = [
      "fake-turnstile-secret",
      "fake-remitente-refresh-token",
      "remitente@example.com",
      "fake-gmail-client-secret",
    ];
    vi.stubEnv("TURNSTILE_SECRET_KEY", valores[0]);
    vi.stubEnv("ALTA_REMITENTE_REFRESH_TOKEN", valores[1]);
    vi.stubEnv("ALTA_REMITENTE_CORREO", valores[2]);
    vi.stubEnv("GMAIL_CLIENT_SECRET", valores[3]);

    const body = await leer();
    const text = JSON.stringify(body);
    for (const prohibido of [...valores, SECRET, CONFIGURED.GMAIL_TOKEN_ENCRYPTION_KEY]) {
      expect(text).not.toContain(prohibido);
    }

    expect(body.banderas.TURNSTILE_SECRET_KEY).toBe(true);
    expect(body.banderas.ALTA_REMITENTE_CORREO).toBe(true);
    expect(body.banderas.GMAIL_TOKEN_ENCRYPTION_KEY).toBe(true);
  });
});
