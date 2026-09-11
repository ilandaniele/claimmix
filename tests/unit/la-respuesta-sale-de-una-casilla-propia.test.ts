/**
 * La respuesta sale de una casilla del inquilino que responde, y de ninguna
 * otra.
 *
 * `resolveReplyContext` elige desde qué casilla contestar mirando el `To:` del
 * primer mail entrante del caso. Ese encabezado lo escribe quien manda el mail
 * y no tiene por qué coincidir con el sobre: un mensaje puede entregarse en la
 * casilla del inquilino A con un `To: siniestros@inquilino-b.com`. La búsqueda
 * por dirección corre con el rol que saltea RLS, así que encontraba la casilla
 * de B —con su token— y la respuesta salía de la casilla de B, firmada por B y
 * con copia en los enviados de B.
 *
 * Lo que se afirma acá: con un `To:` ajeno se responde desde la casilla por
 * omisión del inquilino, y con un `To:` propio se sigue respondiendo desde la
 * casilla a la que escribieron.
 */

const gmail = vi.hoisted(() => ({
  send: vi.fn(),
  porDireccion: vi.fn(),
  porInquilino: vi.fn(),
  Sender: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ db: {} }));

vi.mock("@/data/scope", async () => {
  const mod = await import("@/lib/db");
  return {
    enTenant: (_ctx: unknown, armar: (d: unknown) => unknown) =>
      Promise.resolve(armar(mod.db)),
    enTenantVarias: (_ctx: unknown, armar: (d: unknown) => unknown[]) =>
      Promise.all(armar(mod.db)),
  };
});

vi.mock("@/lib/audit/log", () => ({
  writeAuditLog: vi.fn().mockResolvedValue(undefined),
  AuditEvent: { OUTBOUND_EMAIL_SENT: "sent", OUTBOUND_EMAIL_FAILED: "failed" },
}));

vi.mock("@/server/email/gmail/accounts", () => ({
  getGmailAccountForTenant: gmail.porInquilino,
  getGmailAccountByEmail: gmail.porDireccion,
}));

vi.mock("@/server/email/gmail/gmail-sender", () => ({ GmailSender: gmail.Sender }));

import { describe, it, expect, vi, beforeEach } from "vitest";
import { db } from "@/lib/db";
import { dispatchOutboundEmail } from "@/server/email/dispatch";

const CASO = "11111111-1111-1111-1111-111111111111";
const INQUILINO_A = "10000000-0000-0000-0000-00000000000a";
const INQUILINO_B = "10000000-0000-0000-0000-00000000000b";
/** No es @example.*: a esas direcciones el despachador no les manda nada. */
const ASEGURADO = "asegurado@acme-seguros.com.ar";

const POR_OMISION_DE_A = {
  id: "a-1",
  tenantId: INQUILINO_A,
  email: "reclamos@inquilino-a.com",
  refreshToken: "token-reclamos-a",
  enabled: true,
};
const SINIESTROS_DE_A = {
  id: "a-2",
  tenantId: INQUILINO_A,
  email: "siniestros@inquilino-a.com",
  refreshToken: "token-siniestros-a",
  enabled: true,
};
const CASILLA_DE_B = {
  id: "b-1",
  tenantId: INQUILINO_B,
  email: "siniestros@inquilino-b.com",
  refreshToken: "token-de-b",
  enabled: true,
};

/** El primer mail entrante del caso, con el `To:` que escribió quien lo mandó. */
function entrante(toAddr: string) {
  Object.assign(db, {
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: () => [{ to_addr: toAddr, thread_id: null, headers: [], subject: "Siniestro" }],
          }),
        }),
      }),
    }),
    insert: () => ({
      values: () => ({ returning: () => Promise.resolve([{ id: "fila-1" }]) }),
    }),
    update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  gmail.Sender.mockImplementation(function GmailSender() {
    return { name: "gmail", send: gmail.send };
  });
  gmail.send.mockResolvedValue({ providerMessageId: "out-1", rfcMessageId: "<out-1@x>" });
  gmail.porInquilino.mockResolvedValue(POR_OMISION_DE_A);
});

/** Responde como inquilino A y devuelve desde qué casilla y con qué token salió. */
async function responder(toAddr: string) {
  entrante(toAddr);
  await dispatchOutboundEmail({
    caseId: CASO,
    tenantId: INQUILINO_A,
    to: ASEGURADO,
    template: "confirmation_received",
    data: { caseId: CASO },
  });
  return {
    from: gmail.send.mock.calls[0][0].from as string,
    token: gmail.Sender.mock.calls[0][0] as string,
  };
}

describe("desde qué casilla se responde", () => {
  it("con un To: que nombra la casilla de otro inquilino, responde desde la propia", async () => {
    gmail.porDireccion.mockResolvedValue(CASILLA_DE_B);

    const { from, token } = await responder(`Siniestros <${CASILLA_DE_B.email}>`);

    expect(from).toBe(POR_OMISION_DE_A.email);
    expect(token).toBe(POR_OMISION_DE_A.refreshToken);
    expect(gmail.porInquilino).toHaveBeenCalledWith(INQUILINO_A);
  });

  it("con un To: propio, sigue respondiendo desde la casilla a la que escribieron", async () => {
    gmail.porDireccion.mockResolvedValue(SINIESTROS_DE_A);

    const { from, token } = await responder(`Siniestros <${SINIESTROS_DE_A.email}>`);

    expect(from).toBe(SINIESTROS_DE_A.email);
    expect(token).toBe(SINIESTROS_DE_A.refreshToken);
    expect(gmail.porInquilino).not.toHaveBeenCalled();
  });
});
