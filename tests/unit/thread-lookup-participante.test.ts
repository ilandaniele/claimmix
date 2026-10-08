/**
 * Whose case an inbound email joins.
 *
 * The headers and the subject say which conversation a mail claims to belong
 * to; they do not say who sent it, and anyone can type them. A WhatsApp case
 * keeps the claimant's phone number as its thread id, and every outbound mail
 * prints the case number in its subject — so without asking who is writing, a
 * stranger who knows a phone number or a case id could file mail and
 * attachments onto someone else's claim, skip the prefilter, reopen a closed
 * case, and become the address the agent answers next.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("@/lib/observability/logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/lib/db", () => ({ db: {} }));

vi.mock("@/lib/db/helpers", () => ({
  firstRow: <T>(rows: T[]): T | null => rows[0] ?? null,
}));

// Each column is its own name; `__table` says which fixture it reads.
vi.mock("@/lib/db/schema", () => ({
  cases: {
    __table: "cases",
    id: "id",
    channel: "channel",
    email_thread_id: "email_thread_id",
  },
  claimMessages: {
    __table: "claim_messages",
    case_id: "case_id",
    direction: "direction",
    provider_message_id: "provider_message_id",
    headers: "headers",
    provider: "provider",
    thread_id: "thread_id",
    received_at: "received_at",
    from_addr: "from_addr",
    to_addr: "to_addr",
  },
}));

// Conditions stay as data and the fake db below evaluates them, so the test
// checks what each query asks, not merely that it asked something.
type Cond =
  | { op: "eq"; col: string; val: unknown }
  | { op: "in"; col: string; vals: unknown[] }
  | { op: "and"; conds: Cond[] };

vi.mock("drizzle-orm", () => ({
  eq: (col: string, val: unknown): Cond => ({ op: "eq", col, val }),
  inArray: (col: string, vals: unknown[]): Cond => ({ op: "in", col, vals }),
  and: (...conds: Cond[]): Cond => ({ op: "and", conds }),
}));

type Row = Record<string, unknown>;
const tables: Record<string, Row[]> = { cases: [], claim_messages: [] };
let participantsUnreadable = false;
let threadUnreadable = false;

// Whether the condition (or any it is made of) looks at `col`.
function mentions(cond: Cond, col: string): boolean {
  return cond.op === "and" ? cond.conds.some((c) => mentions(c, col)) : cond.col === col;
}

function matches(row: Row, cond: Cond): boolean {
  switch (cond.op) {
    case "eq":
      return row[cond.col] === cond.val;
    case "in":
      return cond.vals.includes(row[cond.col]);
    case "and":
      return cond.conds.every((c) => matches(row, c));
  }
}

const fakeDb = {
  select: (proj: Record<string, string>) => ({
    from: (table: { __table: string }) => ({
      where: (cond: Cond) => {
        // The participants query is the only one on claim_messages keyed by
        // case alone.
        if (participantsUnreadable && table.__table === "claim_messages" && cond.op === "eq") {
          throw Object.assign(new Error("connection lost"), { code: "57P01" });
        }
        if (threadUnreadable && mentions(cond, "thread_id")) {
          throw Object.assign(new Error("terminating connection"), { code: "57P01" });
        }
        const out = tables[table.__table]
          .filter((r) => matches(r, cond))
          .map((r) => Object.fromEntries(Object.entries(proj).map(([k, col]) => [k, r[col]])));
        return Object.assign(out, { limit: (n: number) => out.slice(0, n), orderBy: () => out });
      },
    }),
  }),
};

vi.mock("@/data/scope", async () => (await import("../mocks/puente-de-alcance")).puenteDeAlcance(() => fakeDb));

import { threadLookup } from "@/server/email/thread-lookup";
import { logger } from "@/lib/observability/logger";

const TENANT = "8a3f2c1e-5b6d-4e7f-9a0b-1c2d3e4f5a6b";
const CASO_WHATSAPP = "2b8b1f0e-9c4d-4a5b-8e6f-7a8b9c0d1e2f";
const CASO_MAIL = "151bf83d-a9c2-43fe-bd57-55ee0b5c3ed8";
const TELEFONO = "5491100000000";
const CASILLA = "siniestros@aseguradora.com";
const ASEGURADO = "Martín Sosa <martin.sosa@example.com>";
const EXTRANO = "alguien@evil.example";
const HILO = "18c1a2b3d4e5f6";
const REMITENTE = "martin.sosa@example.com";
// Message-ID RFC del primer mail del asegurado: sólo vive en las cabeceras de su fila.
const MENSAJE_PROPIO = "<CAJx.fake-propio@mail.gmail.com>";

const FALLIDA = [
  {
    name: "Authentication-Results",
    value: "mx.google.com; spf=fail smtp.mailfrom=martin.sosa@example.com; dkim=fail header.i=@example.com",
  },
];
const NO_ALINEADA = [
  { name: "Authentication-Results", value: "mx.google.com; spf=pass smtp.mailfrom=bounce@otro.example" },
];
const ALINEADA = [
  { name: "Authentication-Results", value: `mx.google.com; spf=pass smtp.mailfrom=${REMITENTE}` },
];

beforeEach(() => {
  participantsUnreadable = false;
  threadUnreadable = false;
  tables.cases = [
    { id: CASO_WHATSAPP, channel: "whatsapp", email_thread_id: TELEFONO },
    { id: CASO_MAIL, channel: "email", email_thread_id: HILO },
  ];
  tables.claim_messages = [
    { case_id: CASO_WHATSAPP, direction: "inbound", provider: "whatsapp", thread_id: TELEFONO, provider_message_id: "wamid.HBgN", from_addr: TELEFONO, to_addr: null },
    { case_id: CASO_MAIL, direction: "inbound", provider: "gmail", thread_id: HILO, received_at: "2026-09-01T10:00:00.000Z", provider_message_id: "gmail-1", headers: [{ name: "Message-ID", value: MENSAJE_PROPIO }], from_addr: ASEGURADO, to_addr: CASILLA },
    { case_id: CASO_MAIL, direction: "outbound", provider: "gmail", thread_id: HILO, provider_message_id: "out-abc123", from_addr: CASILLA, to_addr: ASEGURADO },
  ];
});

describe("threadLookup: a stranger's mail", () => {
  it("does not land on a WhatsApp case by putting its phone number in In-Reply-To", async () => {
    const r = await threadLookup(TENANT, `<${TELEFONO}>`, "", "consulta", EXTRANO);
    expect(r.existingCaseId).toBeUndefined();
  });

  it("does not land on someone else's case by quoting its number in the subject", async () => {
    const r = await threadLookup(TENANT, "", "", `Re: Recibimos tu reclamo - Caso #${CASO_MAIL}`, EXTRANO);
    expect(r.existingCaseId).toBeUndefined();
  });

  it("does not land on it by naming a message we sent the claimant, either", async () => {
    const r = await threadLookup(TENANT, "", "<out-abc123> <gmail-1>", "Re: consulta", EXTRANO);
    expect(r.existingCaseId).toBeUndefined();
  });

  it("finds no email thread behind a phone number, whoever is writing", async () => {
    // A real WhatsApp case only knows phone numbers, so this sender cannot
    // exist; it pins that the channel rule stands on its own.
    tables.claim_messages.push({ case_id: CASO_WHATSAPP, direction: "inbound", provider_message_id: "x", from_addr: EXTRANO, to_addr: null });
    const r = await threadLookup(TENANT, `<${TELEFONO}>`, "", "consulta", EXTRANO);
    expect(r.existingCaseId).toBeUndefined();
  });

  it("opens its own case when it comes with no sender at all", async () => {
    const r = await threadLookup(TENANT, "<out-abc123>", "", "Re: Caso", "");
    expect(r.existingCaseId).toBeUndefined();
  });

  it("opens its own case when the participants cannot be read", async () => {
    participantsUnreadable = true;
    const r = await threadLookup(TENANT, "<out-abc123>", "", "Re: Caso", "martin.sosa@example.com");
    expect(r.existingCaseId).toBeUndefined();
  });
});

describe("threadLookup: the claimant's reply", () => {
  it("lands on their case when it answers a mail we sent them", async () => {
    // Stored with display name; replied to bare and in another case.
    const r = await threadLookup(TENANT, "<out-abc123>", "", "Re: Caso", "Martin.Sosa@example.com");
    expect(r.existingCaseId).toBe(CASO_MAIL);
  });

  it("lands on it when only the case number in the subject survived", async () => {
    const r = await threadLookup(TENANT, "", "", `Re: Denuncia de siniestro — caso #${CASO_MAIL}`, ASEGURADO);
    expect(r.existingCaseId).toBe(CASO_MAIL);
  });

  it("lands on it through the case's own thread id when the case came by mail", async () => {
    const r = await threadLookup(TENANT, "<18c1a2b3d4e5f6>", "", "Re: Caso", "martin.sosa@example.com");
    expect(r.existingCaseId).toBe(CASO_MAIL);
  });

  it("counts an address we wrote to as a participant, even if it never wrote in", async () => {
    tables.claim_messages = [
      { case_id: CASO_MAIL, direction: "outbound", provider_message_id: "out-first", from_addr: CASILLA, to_addr: "Juan <juan@example.org>" },
    ];
    const r = await threadLookup(TENANT, "<out-first>", "", "Re: Caso", "juan@example.org");
    expect(r.existingCaseId).toBe(CASO_MAIL);
  });
});

describe("el remitente que el servidor de correo dio por falso", () => {
  const APROBADA = [
    {
      name: "Authentication-Results",
      value: "mx.google.com; spf=pass smtp.mailfrom=martin.sosa@example.com; dkim=pass header.i=@example.com",
    },
  ];
  const SOLO_SPF_FALLIDO = [
    { name: "Authentication-Results", value: "mx.google.com; spf=softfail smtp.mailfrom=martin.sosa@example.com" },
  ];
  const SOLO_DKIM_FALLIDO = [
    { name: "Authentication-Results", value: "mx.google.com; dkim=fail header.i=@example.com" },
  ];

  it("no se pega por la respuesta a un mail nuestro aunque participe", async () => {
    const r = await threadLookup(TENANT, "<out-abc123>", "", "Re: Caso", "martin.sosa@example.com", FALLIDA);
    expect(r.existingCaseId).toBeUndefined();
  });

  it("no se pega por el hilo del caso", async () => {
    const r = await threadLookup(TENANT, "<18c1a2b3d4e5f6>", "", "Re: Caso", "martin.sosa@example.com", FALLIDA);
    expect(r.existingCaseId).toBeUndefined();
  });

  it("no se pega por el asunto", async () => {
    const r = await threadLookup(TENANT, "", "", `Re: Denuncia de siniestro — caso #${CASO_MAIL}`, ASEGURADO, FALLIDA);
    expect(r.existingCaseId).toBeUndefined();
  });

  it("un spf=softfail solo alcanza para no pegarse", async () => {
    const r = await threadLookup(TENANT, "<out-abc123>", "", "Re: Caso", "martin.sosa@example.com", SOLO_SPF_FALLIDO);
    expect(r.existingCaseId).toBeUndefined();
  });

  it("un dkim=fail solo alcanza para no pegarse", async () => {
    const r = await threadLookup(TENANT, "<out-abc123>", "", "Re: Caso", "martin.sosa@example.com", SOLO_DKIM_FALLIDO);
    expect(r.existingCaseId).toBeUndefined();
  });

  it("un mensaje del formulario web tampoco se pega a un caso ajeno", async () => {
    const delFormulario = [{ name: "X-ClaimMix-Origen", value: "web" }];
    const r = await threadLookup(TENANT, "", "", `Caso #${CASO_MAIL}`, ASEGURADO, delFormulario);
    expect(r.existingCaseId).toBeUndefined();
  });

  it("con SPF y DKIM aprobados sigue pegándose", async () => {
    const porMensaje = await threadLookup(TENANT, "<out-abc123>", "", "Re: Caso", "martin.sosa@example.com", APROBADA);
    const porAsunto = await threadLookup(TENANT, "", "", `Re: Denuncia de siniestro — caso #${CASO_MAIL}`, ASEGURADO, APROBADA);
    expect(porMensaje.existingCaseId).toBe(CASO_MAIL);
    expect(porAsunto.existingCaseId).toBe(CASO_MAIL);
  });

  it("un reenvío con softfail pero DMARC aprobado sigue pegándose", async () => {
    const reenviado = [
      {
        name: "Authentication-Results",
        value: "mx.google.com; spf=softfail smtp.mailfrom=bounce@relay.example; dkim=pass header.i=@example.com; dmarc=pass header.from=example.com",
      },
    ];
    const r = await threadLookup(TENANT, "<out-abc123>", "", "Re: Caso", "martin.sosa@example.com", reenviado);
    expect(r.existingCaseId).toBe(CASO_MAIL);
  });

  it("sin la cabecera (simulado, WhatsApp) sigue pegándose", async () => {
    for (const headers of [[], {}, undefined]) {
      const r = await threadLookup(TENANT, "<out-abc123>", "", "Re: Caso", "martin.sosa@example.com", headers);
      expect(r.existingCaseId).toBe(CASO_MAIL);
    }
  });
});

describe("canal email: el remitente se prueba contra Gmail", () => {
  const ASUNTO = `Re: Denuncia de siniestro — caso #${CASO_MAIL}`;

  it("un spf=pass que no alinea con el From no se suma al hilo", async () => {
    const porMensaje = await threadLookup(TENANT, "<out-abc123>", "", "Re: Caso", REMITENTE, NO_ALINEADA, "email");
    const porHilo = await threadLookup(TENANT, "<18c1a2b3d4e5f6>", "", "Re: Caso", REMITENTE, NO_ALINEADA, "email");
    const porAsunto = await threadLookup(TENANT, "", "", ASUNTO, ASEGURADO, NO_ALINEADA, "email");
    expect(porMensaje.existingCaseId).toBeUndefined();
    expect(porHilo.existingCaseId).toBeUndefined();
    expect(porAsunto.existingCaseId).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(expect.anything(), "thread_lookup.sender_not_verified");
  });

  it("sin la cabecera de Gmail tampoco se suma, aunque no haya fallado nada", async () => {
    for (const headers of [[], {}, undefined]) {
      const r = await threadLookup(TENANT, "<out-abc123>", "", "Re: Caso", REMITENTE, headers, "email");
      expect(r.existingCaseId).toBeUndefined();
    }
  });

  it("con el spf=pass alineado se suma, por el mensaje, el hilo y el asunto", async () => {
    const porMensaje = await threadLookup(TENANT, "<out-abc123>", "", "Re: Caso", REMITENTE, ALINEADA, "email");
    const porHilo = await threadLookup(TENANT, "<18c1a2b3d4e5f6>", "", "Re: Caso", REMITENTE, ALINEADA, "email");
    const porAsunto = await threadLookup(TENANT, "", "", ASUNTO, ASEGURADO, ALINEADA, "email");
    expect(porMensaje.existingCaseId).toBe(CASO_MAIL);
    expect(porHilo.existingCaseId).toBe(CASO_MAIL);
    expect(porAsunto.existingCaseId).toBe(CASO_MAIL);
  });

  it("un From que imita al del caso en un comentario no se suma, aunque comparta dominio y dmarc=pass", async () => {
    // Gmail autentica la cuenta del atacante (dmarc=pass para example.com); el código no
    // debe leer la dirección de la víctima que va entre paréntesis.
    const delMismoDominio = [
      { name: "Authentication-Results", value: "mx.google.com; dmarc=pass header.from=example.com" },
    ];
    const imitador = `atacante@example.com (<${REMITENTE}>)`;
    const porMensaje = await threadLookup(TENANT, "<out-abc123>", "", "Re: Caso", imitador, delMismoDominio, "email");
    const porHilo = await threadLookup(TENANT, "<18c1a2b3d4e5f6>", "", "Re: Caso", imitador, delMismoDominio, "email");
    const porAsunto = await threadLookup(TENANT, "", "", ASUNTO, imitador, delMismoDominio, "email");
    expect(porMensaje.existingCaseId).toBeUndefined();
    expect(porHilo.existingCaseId).toBeUndefined();
    expect(porAsunto.existingCaseId).toBeUndefined();
  });

  it("el participante que firma con un comentario al lado de su dirección sí se suma", async () => {
    const r = await threadLookup(
      TENANT,
      "<out-abc123>",
      "",
      "Re: Caso",
      `${REMITENTE} (Martín)`,
      ALINEADA,
      "email"
    );
    expect(r.existingCaseId).toBe(CASO_MAIL);
  });

  it("alineado pero ajeno al caso, no se suma: verificado no es participante", async () => {
    const delExtrano = [
      { name: "Authentication-Results", value: "mx.google.com; dmarc=pass header.from=evil.example" },
    ];
    const r = await threadLookup(TENANT, "<out-abc123>", "", "Re: Caso", EXTRANO, delExtrano, "email");
    expect(r.existingCaseId).toBeUndefined();
  });

  it("el simulado, sin cabeceras, se suma, por omisión y diciéndolo", async () => {
    const porOmision = await threadLookup(TENANT, "<out-abc123>", "", "Re: Caso", REMITENTE, []);
    const diciendolo = await threadLookup(TENANT, "<out-abc123>", "", "Re: Caso", REMITENTE, [], "email_sim");
    expect(porOmision.existingCaseId).toBe(CASO_MAIL);
    expect(diciendolo.existingCaseId).toBe(CASO_MAIL);
  });

  it("el simulado con una falla explícita no se suma", async () => {
    const fallida = [{ name: "Authentication-Results", value: "mx.google.com; spf=fail smtp.mailfrom=x@y" }];
    const r = await threadLookup(TENANT, "<out-abc123>", "", "Re: Caso", REMITENTE, fallida, "email_sim");
    expect(r.existingCaseId).toBeUndefined();
  });
});

describe("el hilo del proveedor (respuesta a su propio mail)", () => {
  const RESPUESTA = MENSAJE_PROPIO;
  const ASUNTO = "Re: Denuncia";
  const DEL_EXTRANO = [
    {
      name: "Authentication-Results",
      value: "mx.google.com; spf=pass smtp.mailfrom=alguien@evil.example; dmarc=pass header.from=evil.example",
    },
  ];

  it("la respuesta a su propio mail, sin Caso # en el asunto, se suma a su caso", async () => {
    const r = await threadLookup(TENANT, RESPUESTA, "", ASUNTO, ASEGURADO, ALINEADA, "email", HILO);
    expect(r.existingCaseId).toBe(CASO_MAIL);
  });

  it("el simulado se suma por el hilo del ensayo", async () => {
    const hiloDelEnsayo = "thread.fake-run.mail-tardio";
    tables.claim_messages.push({
      case_id: CASO_MAIL,
      direction: "inbound",
      provider: "simulated",
      thread_id: hiloDelEnsayo,
      provider_message_id: "sim-1",
      from_addr: ASEGURADO,
      to_addr: CASILLA,
    });
    // El simulado no manda cabeceras: el ensayo contesta con el id que puso en provider_message_id.
    const r = await threadLookup(TENANT, "<sim-1>", "", ASUNTO, ASEGURADO, [], "email_sim", hiloDelEnsayo);
    expect(r.existingCaseId).toBe(CASO_MAIL);
  });

  it("sin id de hilo no se suma: es el hilo lo que lo junta", async () => {
    const r = await threadLookup(TENANT, RESPUESTA, "", ASUNTO, ASEGURADO, ALINEADA, "email", null);
    expect(r.existingCaseId).toBeUndefined();
  });

  it("sin cabeceras de respuesta no es una respuesta, aunque Gmail lo agrupe por asunto", async () => {
    const r = await threadLookup(TENANT, "", "", ASUNTO, ASEGURADO, ALINEADA, "email", HILO);
    expect(r.existingCaseId).toBeUndefined();
  });

  it("un extraño verificado, en el mismo hilo y con las mismas cabeceras, no entra al caso", async () => {
    const r = await threadLookup(TENANT, RESPUESTA, RESPUESTA, ASUNTO, EXTRANO, DEL_EXTRANO, "email", HILO);
    expect(r.existingCaseId).not.toBe(CASO_MAIL);
    expect(r.existingCaseId).toBeUndefined();
  });

  it("un remitente sin verificar no se suma por el hilo", async () => {
    vi.mocked(logger.warn).mockClear();
    for (const headers of [NO_ALINEADA, FALLIDA]) {
      const r = await threadLookup(TENANT, RESPUESTA, "", ASUNTO, ASEGURADO, headers, "email", HILO);
      expect(r.existingCaseId).toBeUndefined();
    }
    expect(logger.warn).toHaveBeenCalledWith(expect.anything(), "thread_lookup.sender_not_verified");
  });

  it("un From que imita al del caso no se suma por el hilo, aunque comparta dominio y dmarc=pass", async () => {
    const delMismoDominio = [
      { name: "Authentication-Results", value: "mx.google.com; dmarc=pass header.from=example.com" },
    ];
    const imitador = `atacante@example.com (<${REMITENTE}>)`;
    const r = await threadLookup(TENANT, RESPUESTA, "", ASUNTO, imitador, delMismoDominio, "email", HILO);
    expect(r.existingCaseId).toBeUndefined();
  });

  it("con dos remitentes en el hilo, cada uno va a su caso y ninguno al del otro", async () => {
    const CASO_AJENO = "4d0d3b2a-1e6f-4c7d-8a81-9c0d1e2f3a4b";
    tables.cases.push({ id: CASO_AJENO, channel: "email", email_thread_id: "18ffffffffffff" });
    // Primero, como lo devuelve el orden por fecha descendente.
    tables.claim_messages.unshift({
      case_id: CASO_AJENO,
      direction: "inbound",
      provider: "gmail",
      thread_id: HILO,
      received_at: "2026-09-02T10:00:00.000Z",
      provider_message_id: "gmail-ajeno",
      headers: [{ name: "Message-ID", value: "<CAJx.fake-ajeno@mail.gmail.com>" }],
      from_addr: EXTRANO,
      to_addr: CASILLA,
    });
    const delAsegurado = await threadLookup(TENANT, RESPUESTA, "", ASUNTO, ASEGURADO, ALINEADA, "email", HILO);
    const delExtrano = await threadLookup(TENANT, "<CAJx.fake-ajeno@mail.gmail.com>", "", ASUNTO, EXTRANO, DEL_EXTRANO, "email", HILO);
    expect(delAsegurado.existingCaseId).toBe(CASO_MAIL);
    expect(delExtrano.existingCaseId).toBe(CASO_AJENO);
  });

  describe("un mismo remitente con dos casos en el mismo hilo", () => {
    const CASO_SEGUNDO = "5e1e4c3b-2f70-4d8e-9b92-0d1e2f3a4b5c";
    const SEGUNDO_MENSAJE = "<CAJx.fake-segundo@mail.gmail.com>";

    beforeEach(() => {
      tables.cases.push({ id: CASO_SEGUNDO, channel: "email", email_thread_id: "18eeeeeeeeeeee" });
      // Más nuevo que el primero, y con la cabecera escrita como la manda otro cliente.
      tables.claim_messages.unshift({
        case_id: CASO_SEGUNDO,
        direction: "inbound",
        provider: "gmail",
        thread_id: HILO,
        received_at: "2026-09-05T10:00:00.000Z",
        provider_message_id: "gmail-2",
        headers: [{ name: "Message-Id", value: SEGUNDO_MENSAJE }],
        from_addr: ASEGURADO,
        to_addr: CASILLA,
      });
    });

    it("la respuesta al primer mail vuelve al primer caso, aunque el segundo sea más nuevo", async () => {
      const r = await threadLookup(TENANT, RESPUESTA, RESPUESTA, ASUNTO, ASEGURADO, ALINEADA, "email", HILO);
      expect(r.existingCaseId).toBe(CASO_MAIL);
    });

    it("la respuesta al segundo mail va al segundo caso", async () => {
      const r = await threadLookup(TENANT, SEGUNDO_MENSAJE, SEGUNDO_MENSAJE, ASUNTO, ASEGURADO, ALINEADA, "email", HILO);
      expect(r.existingCaseId).toBe(CASO_SEGUNDO);
    });

    it("el mensaje que contesta puede venir sólo en References", async () => {
      const r = await threadLookup(TENANT, "<CAJx.fake-ninguno@mail.gmail.com>", RESPUESTA, ASUNTO, ASEGURADO, ALINEADA, "email", HILO);
      expect(r.existingCaseId).toBe(CASO_MAIL);
    });

    it("si no contesta a ningún mail suyo del hilo no se suma a ninguno", async () => {
      const r = await threadLookup(TENANT, "<CAJx.fake-ninguno@mail.gmail.com>", "", ASUNTO, ASEGURADO, ALINEADA, "email", HILO);
      expect(r.existingCaseId).toBeUndefined();
    });

    it("si nombra mails de los dos casos no elige: sigue el asunto", async () => {
      const sinAsunto = await threadLookup(TENANT, SEGUNDO_MENSAJE, RESPUESTA, ASUNTO, ASEGURADO, ALINEADA, "email", HILO);
      const conAsunto = await threadLookup(TENANT, SEGUNDO_MENSAJE, RESPUESTA, `Re: Caso #${CASO_MAIL}`, ASEGURADO, ALINEADA, "email", HILO);
      expect(sinAsunto.existingCaseId).toBeUndefined();
      expect(conAsunto.existingCaseId).toBe(CASO_MAIL);
    });
  });

  it("un teléfono de WhatsApp como id de hilo no junta nada: el proveedor tiene que ser el del canal", async () => {
    // Sin el filtro por proveedor, la guardia de participante lo dejaría pasar.
    const r = await threadLookup(TENANT, RESPUESTA, "", ASUNTO, TELEFONO, [], "email_sim", TELEFONO);
    expect(r.existingCaseId).toBeUndefined();
  });

  it("una fila de Gmail no cuenta para el canal simulado", async () => {
    const r = await threadLookup(TENANT, RESPUESTA, "", ASUNTO, ASEGURADO, [], "email_sim", HILO);
    expect(r.existingCaseId).toBeUndefined();
  });

  it("con los participantes ilegibles abre su propio caso", async () => {
    participantsUnreadable = true;
    const r = await threadLookup(TENANT, RESPUESTA, "", ASUNTO, ASEGURADO, ALINEADA, "email", HILO);
    expect(r.existingCaseId).toBeUndefined();
  });

  it("si el hilo no se puede leer sigue el asunto, y lo dice", async () => {
    threadUnreadable = true;
    const r = await threadLookup(TENANT, RESPUESTA, "", `Re: Caso #${CASO_MAIL}`, ASEGURADO, ALINEADA, "email", HILO);
    expect(r.existingCaseId).toBe(CASO_MAIL);
    expect(logger.error).toHaveBeenCalledWith(expect.anything(), "thread_lookup.provider_thread_error");
  });

  it("si el hilo no se puede leer y el asunto no ayuda, abre su propio caso sin propagar el error", async () => {
    threadUnreadable = true;
    const r = await threadLookup(TENANT, RESPUESTA, "", ASUNTO, ASEGURADO, ALINEADA, "email", HILO);
    expect(r.existingCaseId).toBeUndefined();
  });
});

describe("el camino por asunto", () => {
  it("un caso de WhatsApp no se pega por el asunto ni cuando el remitente participa", async () => {
    tables.claim_messages.push({
      case_id: CASO_WHATSAPP,
      direction: "outbound",
      provider_message_id: "wa-out-1",
      from_addr: CASILLA,
      to_addr: "algo@example.com",
    });
    const r = await threadLookup(
      TENANT,
      "",
      "",
      `Re: Recibimos tu reclamo - Caso #${CASO_WHATSAPP}`,
      "algo@example.com"
    );
    expect(r.existingCaseId).toBeUndefined();
  });
});

describe("un caso del formulario web", () => {
  const CASO_WEB = "3c9c2a1f-0d5e-4b6c-9f70-8b9c0d1e2f3a";
  const DENUNCIANTE = "ana@example.com";

  beforeEach(() => {
    tables.cases.push({ id: CASO_WEB, channel: "web", email_thread_id: null });
    tables.claim_messages.push(
      { case_id: CASO_WEB, direction: "inbound", provider_message_id: `web:${CASO_WEB}`, from_addr: DENUNCIANTE, to_addr: null },
      { case_id: CASO_WEB, direction: "outbound", provider_message_id: "out-web-1", from_addr: CASILLA, to_addr: DENUNCIANTE }
    );
  });

  it("recibe la respuesta de quien denunció, por el asunto", async () => {
    const r = await threadLookup(TENANT, "", "", `Re: Recibimos tu reclamo - Caso #${CASO_WEB}`, DENUNCIANTE);
    expect(r.existingCaseId).toBe(CASO_WEB);
  });

  it("recibe la respuesta por el mensaje que le mandamos (paso 1)", async () => {
    const r = await threadLookup(TENANT, "<out-web-1>", "", "Re: consulta", DENUNCIANTE);
    expect(r.existingCaseId).toBe(CASO_WEB);
  });

  it("no lo recibe un extraño que cita el número de caso: sólo participa quien escribió en el formulario o recibió el mail", async () => {
    const r = await threadLookup(TENANT, "", "", `Re: Caso #${CASO_WEB}`, EXTRANO);
    expect(r.existingCaseId).toBeUndefined();
  });
});
