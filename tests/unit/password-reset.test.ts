/**
 * El mail que devuelve el acceso, y lo que no puede contar de más.
 *
 * Un enlace de recuperación ES la credencial mientras dura: quien lo lee, entra.
 * Así que los dos riesgos de este archivo no son que falle —falla y alguien
 * pide otro— sino que deje el enlace escrito en un registro, o que responda
 * distinto según exista o no la cuenta.
 */

const { mockSelect, mockGetAccount, mockSend, mockAudit } = vi.hoisted(() => ({
  mockSelect: vi.fn(),
  mockGetAccount: vi.fn(),
  mockSend: vi.fn(),
  mockAudit: vi.fn(),
}));

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
  AuditEvent: { PASSWORD_RESET_REQUESTED: "auth.password_reset_requested" },
}));

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { sendPasswordResetEmail } from "@/server/notify/password-reset";

const TENANT = "10000000-0000-0000-0000-000000000001";
const USER = "22222222-2222-2222-2222-222222222222";

/** Un enlace con una pinta reconocible, para poder buscarlo en lo que se imprima. */
const TOKEN = "tok-4d5e6f-no-deberia-aparecer-en-ningun-registro";
const URL_RESET = `https://claimmix.vercel.app/api/auth/reset-password/${TOKEN}`;

const ENTRADA = {
  email: "analista@aseguradora.com",
  name: "Lucía Fernández",
  userId: USER,
  url: URL_RESET,
  duraMinutos: 60,
};

/** El perfil que devuelve la consulta de arranque, o ninguno. */
function conPerfil(hay: boolean) {
  mockSelect.mockReturnValue({
    from: () => ({
      where: () => ({
        limit: () => Promise.resolve(hay ? [{ tenant_id: TENANT }] : []),
      }),
    }),
  });
}

let logs: string[] = [];
let spies: ReturnType<typeof vi.spyOn>[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  logs = [];
  // Todo lo que el módulo imprima, junto, para poder buscar el token adentro.
  spies = (["info", "warn", "error"] as const).map((nivel) =>
    vi.spyOn(console, nivel).mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    })
  );
  conPerfil(true);
  mockGetAccount.mockResolvedValue({
    email: "siniestros@aseguradora.com",
    refreshToken: "refresh",
  });
  mockSend.mockResolvedValue({ providerMessageId: "sent-1" });
  mockAudit.mockResolvedValue(undefined);
});

afterEach(() => {
  for (const s of spies) s.mockRestore();
});

describe("el mail de recuperación", () => {
  it("sale desde la casilla de la aseguradora, hacia la persona", async () => {
    await sendPasswordResetEmail(ENTRADA);

    expect(mockSend).toHaveBeenCalledTimes(1);
    const enviado = mockSend.mock.calls[0][0];
    expect(enviado.to).toBe("analista@aseguradora.com");
    expect(enviado.from).toBe("siniestros@aseguradora.com");
    expect(enviado.textBody).toContain(URL_RESET);
  });

  it("dice cuánto dura y que sirve una sola vez", async () => {
    await sendPasswordResetEmail(ENTRADA);

    const cuerpo = mockSend.mock.calls[0][0].textBody as string;
    // Alguien que recibe esto sin haberlo pedido tiene que poder decidir qué
    // hacer sin escribirle a nadie.
    expect(cuerpo).toContain("60 minutos");
    expect(cuerpo).toContain("una sola vez");
    expect(cuerpo).toMatch(/si no fuiste vos/i);
  });

  it("saluda por el nombre de pila, y aguanta no tenerlo", async () => {
    await sendPasswordResetEmail(ENTRADA);
    expect(mockSend.mock.calls[0][0].textBody).toContain("Hola Lucía,");

    mockSend.mockClear();
    await sendPasswordResetEmail({ ...ENTRADA, name: null });
    // "Hola null," es la clase de detalle que hace que un mail parezca falso.
    expect(mockSend.mock.calls[0][0].textBody).toContain("Hola,");
    expect(mockSend.mock.calls[0][0].textBody).not.toContain("null");
  });
});

describe("lo que no se escribe en ningún lado", () => {
  it("el enlace no aparece en los registros", async () => {
    await sendPasswordResetEmail(ENTRADA);

    // Éste es el test que importa: un enlace anotado en un log no vence, y lo
    // mira más gente que la dueña de la cuenta.
    const todo = logs.join("\n");
    expect(todo).not.toContain(TOKEN);
    expect(todo).not.toContain(URL_RESET);
  });

  it("tampoco cuando no se puede mandar", async () => {
    mockGetAccount.mockResolvedValue(null);

    await sendPasswordResetEmail(ENTRADA);

    const todo = logs.join("\n");
    expect(todo).not.toContain(TOKEN);
    // Y el motivo sí, porque alguien lo tiene que arreglar.
    expect(todo).toContain("password_reset.sin_casilla");
  });

  it("la auditoría guarda que se pidió, no a quién ni con qué enlace", async () => {
    await sendPasswordResetEmail(ENTRADA);

    expect(mockAudit).toHaveBeenCalledTimes(1);
    const anotado = JSON.stringify(mockAudit.mock.calls[0][0]);
    expect(anotado).toContain("auth.password_reset_requested");
    expect(anotado).not.toContain(TOKEN);
    expect(anotado).not.toContain("analista@aseguradora.com");
  });
});

describe("cuando no se puede", () => {
  it("una cuenta sin perfil no recibe nada, y queda anotado", async () => {
    conPerfil(false);

    await sendPasswordResetEmail(ENTRADA);

    // Existe en Better Auth y no está atada a ninguna aseguradora: no hay
    // casilla desde donde escribirle, y tampoco tiene acceso que recuperar.
    expect(mockSend).not.toHaveBeenCalled();
    expect(logs.join("\n")).toContain("password_reset.sin_perfil");
  });

  it("sin casilla igual queda asentado el pedido, como no entregado", async () => {
    mockGetAccount.mockResolvedValue(null);

    await sendPasswordResetEmail(ENTRADA);

    // Sin esto, quien mire la auditoría de esa cuenta no ve nada y concluye
    // que nunca pidió recuperarla.
    expect(mockAudit).toHaveBeenCalledTimes(1);
    const p = (mockAudit.mock.calls[0][0] as { payload: Record<string, unknown> }).payload;
    expect(p.delivered).toBe(false);
    expect(p.motivo).toBe("sin_casilla");
  });

  it("sin casilla conectada no manda, y lo dice con el motivo", async () => {
    mockGetAccount.mockResolvedValue(null);

    await sendPasswordResetEmail(ENTRADA);

    expect(mockSend).not.toHaveBeenCalled();
    expect(logs.join("\n")).toContain("sin_casilla");
  });

  it("nunca lanza, aunque la base se caiga", async () => {
    mockSelect.mockImplementation(() => {
      throw new Error("la base no contesta");
    });

    /*
     * Better Auth responde siempre lo mismo —«si ese correo existe, te llega un
     * enlace»— para no confirmar qué direcciones hay registradas. Una excepción
     * acá rompería esa simetría: el que existe fallaría distinto del que no.
     */
    await expect(sendPasswordResetEmail(ENTRADA)).resolves.toBeUndefined();
    expect(logs.join("\n")).toContain("password_reset.error");
  });

  it("un envío fallido queda anotado como no entregado, no como éxito", async () => {
    mockSend.mockResolvedValue({ error: "gmail dijo que no" });

    await sendPasswordResetEmail(ENTRADA);

    const anotado = mockAudit.mock.calls[0][0] as { payload: { delivered: boolean } };
    expect(anotado.payload.delivered).toBe(false);
    expect(logs.join("\n")).toContain("password_reset.send_failed");
  });
});
