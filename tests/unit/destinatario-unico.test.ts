/**
 * El destinatario de una respuesta es UNA casilla, la que pasó la guarda de
 * participantes.
 *
 * `bareAddress` tomaba el primer grupo `<...>` del encabezado crudo: un nombre
 * visible entre comillas (`"<victima@x>" <atacante@evil>`) ganaba sobre la
 * dirección real, y un `To:` con dos casillas llegaba entero a Gmail, que
 * entrega a las dos. El despachador ahora colapsa el destino a una sola
 * dirección pelada, y `bareAddress` ignora los nombres entre comillas para que
 * la guarda y la entrega coincidan.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { bareAddress } from "@/lib/email/reserved";
import { puenteDeAlcance } from "../mocks/puente-de-alcance";

const gmailMocks = vi.hoisted(() => ({
  send: vi.fn(),
  getGmailAccountForTenant: vi.fn(),
  getGmailAccountByEmail: vi.fn(),
}));

vi.mock("@/lib/audit/log", () => ({
  writeAuditLog: vi.fn().mockResolvedValue(undefined),
  AuditEvent: {
    OUTBOUND_EMAIL_SENT: "email.outbound_sent",
    OUTBOUND_EMAIL_FAILED: "email.outbound_failed",
  },
}));

vi.mock("@/server/email/gmail/accounts", () => ({
  getGmailAccountForTenant: gmailMocks.getGmailAccountForTenant,
  getGmailAccountByEmail: gmailMocks.getGmailAccountByEmail,
}));

vi.mock("@/server/email/gmail/gmail-sender", () => ({
  GmailSender: vi.fn().mockImplementation(function GmailSender() {
    return {
      name: "gmail",
      send: gmailMocks.send,
    };
  }),
}));

const CASE_ID = "case-uuid-unico-001";
const TENANT_ID = "tenant-unico-001";
const FROM_ADDR = "claims@company.com";
const CLAIM_MSG_ID = "claim-msg-uuid-out-001";
const OUTBOUND_MSG_ID = "outbound-msg-uuid-001";

describe("bareAddress — nombre visible entre comillas", () => {
  it("el nombre entre comillas no gana sobre la dirección real", () => {
    expect(bareAddress('"<victim@acme.example>" <attacker@evil.example>')).toBe(
      "attacker@evil.example",
    );
  });

  it("un nombre con coma entre comillas sigue dando la dirección", () => {
    expect(bareAddress('"Pérez, Juan" <juan@x.com>')).toBe("juan@x.com");
  });

  it("nombre sin comillas y mayúsculas: dirección en minúsculas", () => {
    expect(bareAddress("Juan <JUAN@X.com>")).toBe("juan@x.com");
  });

  it("dirección pelada, entre comillas o vacía: sin cambios", () => {
    expect(bareAddress("a@b.com")).toBe("a@b.com");
    expect(bareAddress('"a@b.com"')).toBe('"a@b.com"');
    expect(bareAddress(null)).toBe("");
    expect(bareAddress("")).toBe("");
  });
});

describe("bareAddress — comentarios RFC 5322", () => {
  it("un comentario con otra dirección adentro no gana sobre la dirección real", () => {
    expect(bareAddress("atacante@example.com (<victima@example.com>)")).toBe("atacante@example.com");
    expect(bareAddress("(<victima@example.com>) <atacante@example.com>")).toBe("atacante@example.com");
    expect(bareAddress("Ana (<victima@example.com>) <atacante@example.com>")).toBe("atacante@example.com");
  });

  it("los comentarios anidados y los paréntesis escapados no cortan antes", () => {
    expect(bareAddress("Ana (uno (dos <victima@example.com>) \\) <otra@example.com>) <ana@example.com>")).toBe(
      "ana@example.com",
    );
  });

  it("un comentario sin cerrar se come lo que sigue: no deja leer la dirección del comentario", () => {
    expect(bareAddress("atacante@example.com (<victima@example.com>")).toBe("atacante@example.com");
  });

  it("un paréntesis entre comillas es nombre visible, no abre un comentario", () => {
    expect(bareAddress('"Ana (ventas" <ana@x.com>')).toBe("ana@x.com");
    expect(bareAddress('"(" <ana@x.com> (<victima@x.com>)')).toBe("ana@x.com");
  });

  it("unas comillas sin cerrar no dejan leer la dirección que quedó adentro", () => {
    expect(bareAddress('"x <victima@example.com> <atacante@example.com>')).not.toBe("victima@example.com");
  });

  it("una dirección pelada con un comentario al lado sale sin el comentario", () => {
    expect(bareAddress("Ana@X.com (Ana Pérez)")).toBe("ana@x.com");
  });
});

function buildDbMock() {
  const inserts: Record<string, unknown[]> = {
    claim_messages: [],
    outbound_messages: [],
  };
  const tableNames = new WeakMap<object, string>();
  const tableIds = new WeakMap<object, string>();
  let seenCount = 0;
  const TABLE_SEQUENCE = [
    { name: "claim_messages", id: CLAIM_MSG_ID },
    { name: "outbound_messages", id: OUTBOUND_MSG_ID },
  ];

  function resolveTable(tableObj: object): { name: string; id: string } {
    if (!tableNames.has(tableObj)) {
      const entry = TABLE_SEQUENCE[seenCount] ?? { name: `unknown_${seenCount}`, id: `id-${seenCount}` };
      tableNames.set(tableObj, entry.name);
      tableIds.set(tableObj, entry.id);
      seenCount++;
    }
    return { name: tableNames.get(tableObj)!, id: tableIds.get(tableObj)! };
  }

  return {
    _inserts: inserts,

    select: vi.fn().mockImplementation(() => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: () => Promise.resolve([]),
          }),
        }),
      }),
    })),

    insert: vi.fn().mockImplementation((tableObj: object) => {
      const { name, id } = resolveTable(tableObj);
      return {
        values: (row: unknown) => {
          const rows = Array.isArray(row) ? row : [row];
          (inserts[name] = inserts[name] ?? []).push(...rows);
          return {
            returning: () => Promise.resolve([{ id }]),
          };
        },
      };
    }),

    update: vi.fn().mockImplementation(() => ({
      set: () => ({
        where: () => Promise.resolve(undefined),
      }),
    })),
  };
}

describe("dispatchOutboundEmail — un solo destinatario", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.GMAIL_FROM_ADDRESS = FROM_ADDR;
    process.env.DEFAULT_TENANT_ID = TENANT_ID;
    gmailMocks.getGmailAccountForTenant.mockResolvedValue({
      id: "gmail-account-unico-001",
      tenantId: TENANT_ID,
      email: FROM_ADDR,
      refreshToken: "fake-refresh-token",
      enabled: true,
    });
  });

  afterEach(() => {
    delete process.env.GMAIL_FROM_ADDRESS;
    delete process.env.DEFAULT_TENANT_ID;
    vi.resetModules();
  });

  it("un `to` con dos casillas sale y se guarda con una sola, pelada", async () => {
    gmailMocks.send.mockResolvedValue({ providerMessageId: "out-1" });

    const dbMock = buildDbMock();
    vi.doMock("@/lib/db", () => ({ db: dbMock }));
    vi.doMock("@/data/scope", () => puenteDeAlcance(() => dbMock));

    const { dispatchOutboundEmail } = await import("@/server/email/dispatch");
    await dispatchOutboundEmail({
      caseId: CASE_ID,
      tenantId: TENANT_ID,
      to: "<claimant@acme-seguros.com.ar>, <attacker@evil.example>",
      template: "confirmation_received",
      data: { caseId: CASE_ID },
    });

    expect(gmailMocks.send).toHaveBeenCalledTimes(1);
    expect(gmailMocks.send.mock.calls[0][0].to).toBe("claimant@acme-seguros.com.ar");
    expect((dbMock._inserts["claim_messages"][0] as Record<string, unknown>).to_addr).toBe(
      "claimant@acme-seguros.com.ar",
    );
  });

  it("un `to` con dos casillas adentro de los ángulos no sale ni se guarda", async () => {
    const dbMock = buildDbMock();
    vi.doMock("@/lib/db", () => ({ db: dbMock }));
    vi.doMock("@/data/scope", () => puenteDeAlcance(() => dbMock));

    const { dispatchOutboundEmail } = await import("@/server/email/dispatch");
    const result = await dispatchOutboundEmail({
      caseId: CASE_ID,
      tenantId: TENANT_ID,
      to: "<attacker@evil.example, claimant@acme-seguros.com.ar>",
      template: "confirmation_received",
      data: { caseId: CASE_ID },
    });

    expect(result).toEqual({ error: "INVALID_RECIPIENT" });
    expect(gmailMocks.send).not.toHaveBeenCalled();
    expect(dbMock.insert).not.toHaveBeenCalled();
    expect(dbMock._inserts["claim_messages"]).toHaveLength(0);
  });
});
