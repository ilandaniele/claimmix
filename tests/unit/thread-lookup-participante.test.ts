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
        const out = tables[table.__table]
          .filter((r) => matches(r, cond))
          .map((r) => Object.fromEntries(Object.entries(proj).map(([k, col]) => [k, r[col]])));
        return Object.assign(out, { limit: (n: number) => out.slice(0, n) });
      },
    }),
  }),
};

vi.mock("@/data/scope", () => ({
  enTenant: (_ctx: unknown, armar: (d: unknown) => unknown) => Promise.resolve(armar(fakeDb)),
}));

import { threadLookup } from "@/server/email/thread-lookup";

const TENANT = "8a3f2c1e-5b6d-4e7f-9a0b-1c2d3e4f5a6b";
const CASO_WHATSAPP = "2b8b1f0e-9c4d-4a5b-8e6f-7a8b9c0d1e2f";
const CASO_MAIL = "151bf83d-a9c2-43fe-bd57-55ee0b5c3ed8";
const TELEFONO = "5491100000000";
const CASILLA = "siniestros@aseguradora.com";
const ASEGURADO = "Martín Sosa <martin.sosa@example.com>";
const EXTRANO = "alguien@evil.example";

beforeEach(() => {
  participantsUnreadable = false;
  tables.cases = [
    { id: CASO_WHATSAPP, channel: "whatsapp", email_thread_id: TELEFONO },
    { id: CASO_MAIL, channel: "email", email_thread_id: "18c1a2b3d4e5f6" },
  ];
  tables.claim_messages = [
    { case_id: CASO_WHATSAPP, direction: "inbound", provider_message_id: "wamid.HBgN", from_addr: TELEFONO, to_addr: null },
    { case_id: CASO_MAIL, direction: "inbound", provider_message_id: "gmail-1", from_addr: ASEGURADO, to_addr: CASILLA },
    { case_id: CASO_MAIL, direction: "outbound", provider_message_id: "out-abc123", from_addr: CASILLA, to_addr: ASEGURADO },
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
    const r = await threadLookup(TENANT, "<out-abc123>", "", "Re: Caso", "Martin.Sosa@Gmail.com");
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
