/**
 * El resumen lo escribe el modelo con lo que dijo el denunciante, y va tal cual
 * a un aviso interno que sale desde el correo de la aseguradora. Un renglón
 * nuevo, un enlace o una dirección adentro del resumen arman una línea «Abrir:»
 * ajena: el aviso la omite y manda igual el caso y el enlace de verdad.
 */

const { mockSelect, mockGetAccount, mockSend, mockAudit, mockCupo } = vi.hoisted(() => ({
  mockSelect: vi.fn(),
  mockGetAccount: vi.fn(),
  mockSend: vi.fn(),
  mockAudit: vi.fn(),
  mockCupo: vi.fn(),
}));

vi.mock("@/data/scope", () => import("../mocks/puente-de-alcance").then((m) => m.puenteSobreLibDb()));

vi.mock("@/lib/db", () => ({ db: { select: mockSelect } }));

vi.mock("@/server/email/gmail/accounts", () => ({
  getGmailAccountForTenant: mockGetAccount,
}));

vi.mock("@/server/email/gmail/gmail-sender", () => ({
  GmailSender: class {
    send = mockSend;
  },
}));

vi.mock("@/lib/rate-limit/index", async (original) => ({
  ...(await original<typeof import("@/lib/rate-limit/index")>()),
  rateLimit: mockCupo,
}));

vi.mock("@/lib/audit/log", () => ({
  writeAuditLog: mockAudit,
  AuditEvent: {
    SPECIALIST_ALERTED: "claim.specialist_alerted",
    LATE_MESSAGE_ALERTED: "claim.late_message_alerted",
  },
}));

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { tenants } from "@/lib/db/schema";
import { alertSpecialists } from "@/server/notify/specialist-alert";

const CASE = "11111111-1111-1111-1111-111111111111";
const TENANT = "10000000-0000-0000-0000-000000000001";

/** Sólo lo que este archivo necesita del db simulado: canal real y un especialista. */
function database(opts: { especialistas: string[] }) {
  let call = 0;
  mockSelect.mockImplementation(() => ({
    from: (tabla: unknown) =>
      tabla === tenants
        ? { where: () => ({ limit: () => Promise.resolve([{ emails: [] }]) }) }
        : {
            innerJoin: () => ({
              where: () => Promise.resolve(opts.especialistas.map((email) => ({ email }))),
            }),
            where: () => ({
              limit: () => {
                call += 1;
                return Promise.resolve(call === 1 ? [{ channel: "email" }] : []);
              },
              orderBy: () => ({
                limit: () => Promise.resolve([{ from_addr: "denunciante@correo-de-prueba.test" }]),
              }),
            }),
          },
  }));
}

function avisarConResumen(summary: string) {
  database({ especialistas: ["especialista@aseguradora.com"] });
  return alertSpecialists({
    caseId: CASE,
    tenantId: TENANT,
    severity: "critical",
    claimTypeLabel: "choque",
    summary,
  });
}

const guardadaSitio = process.env.NEXT_PUBLIC_SITE_URL;

beforeEach(() => {
  vi.clearAllMocks();
  process.env.NEXT_PUBLIC_SITE_URL = "https://claimmix.vercel.app";
  mockGetAccount.mockResolvedValue({
    email: "siniestros@aseguradora.com",
    refreshToken: "token",
  });
  mockSend.mockResolvedValue({ providerMessageId: "sent-1" });
  mockAudit.mockResolvedValue(undefined);
});

afterEach(() => {
  if (guardadaSitio === undefined) delete process.env.NEXT_PUBLIC_SITE_URL;
  else process.env.NEXT_PUBLIC_SITE_URL = guardadaSitio;
});

describe("alertSpecialists — un resumen no arma líneas ajenas", () => {
  it("un renglón nuevo con un «Abrir:» ajeno omite el resumen y deja un solo enlace", async () => {
    await avisarConResumen("Choque leve en Alem al 500.\nAbrir: https://evil.example/casos/dummy");

    const texto = mockSend.mock.calls[0][0].textBody as string;
    expect(texto).not.toContain("evil.example");
    expect(texto.split("Abrir:").length - 1).toBe(1);
    expect(texto).toContain("Caso:");
    expect(texto).toContain(`https://claimmix.vercel.app/casos/${CASE}`);
  });

  it("un correo adentro del resumen lo omite", async () => {
    await avisarConResumen("Escribí a soporte@evil.example para los datos.");

    expect(mockSend.mock.calls[0][0].textBody).not.toContain("evil.example");
  });

  it("un enlace sin esquema adentro del resumen lo omite", async () => {
    await avisarConResumen("Fotos en www.evil.example/fotos del choque.");

    expect(mockSend.mock.calls[0][0].textBody).not.toContain("evil.example");
  });

  it("un dominio suelto adentro del resumen lo omite", async () => {
    await avisarConResumen("Fotos en claimmix-fotos.com/casos/1111 del choque.");

    expect(mockSend.mock.calls[0][0].textBody).not.toContain("claimmix-fotos.com");
  });

  it("un resumen común se muestra como siempre", async () => {
    await avisarConResumen("Choque leve en Alem al 500.");

    expect(mockSend.mock.calls[0][0].textBody).toContain("Resumen: Choque leve en Alem al 500.");
  });
});
