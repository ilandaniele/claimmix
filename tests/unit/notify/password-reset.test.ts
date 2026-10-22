/**
 * El mail que devuelve el acceso, y lo que no puede contar de más.
 *
 * Un enlace de recuperación ES la credencial mientras dura: quien lo lee, entra.
 * Así que los riesgos de este archivo no son que falle —falla y alguien pide
 * otro— sino que deje el enlace escrito en un registro, que responda distinto
 * según exista o no la cuenta, que salga por la casilla de una aseguradora o
 * que lleve texto escrito por un tercero.
 */

const { mockFila, mockGetAccount, mockSend, mockAudit, mockRemitente, mockEnviar } = vi.hoisted(() => ({
  mockFila: vi.fn(),
  mockGetAccount: vi.fn(),
  mockSend: vi.fn(),
  mockAudit: vi.fn(),
  mockRemitente: vi.fn(),
  mockEnviar: vi.fn(),
}));

vi.mock("@/lib/auth/fila-de-usuario-cacheada", () => ({ filaDeUsuario: mockFila }));

vi.mock("@/server/email/gmail/accounts", () => ({
  getGmailAccountForTenant: mockGetAccount,
}));

vi.mock("@/server/email/gmail/gmail-sender", () => ({
  GmailSender: class {
    send = mockSend;
  },
}));

vi.mock("@/server/notify/remitente-sistema", () => ({
  remitenteDelSistema: mockRemitente,
  enviarCorreoDelSistema: mockEnviar,
}));

vi.mock("@/lib/audit/log", () => ({
  writeAuditLog: mockAudit,
  AuditEvent: { PASSWORD_RESET_REQUESTED: "auth.password_reset_requested" },
}));

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getT } from "@/lib/i18n";
import { correoDeEnlace } from "@/server/notify/correos-de-alta";
import { sendPasswordResetEmail } from "@/server/notify/password-reset";

const TENANT = "10000000-0000-0000-0000-000000000001";
const TENANT_PRUEBA = "30000000-0000-0000-0000-000000000003";
const USER = "22222222-2222-2222-2222-222222222222";

/** Un enlace con una pinta reconocible, para poder buscarlo en lo que se imprima. */
const TOKEN = "fake-tok-4d5e6f-no-deberia-aparecer-en-ningun-registro";
const URL_RESET = `https://claimmix.vercel.app/api/auth/reset-password/${TOKEN}`;

const ENTRADA = {
  email: "analista@example.com",
  name: "Lucía Fernández",
  userId: USER,
  url: URL_RESET,
  duraMinutos: 60,
};

const REMITENTE = { correo: "sistema@example.com", refreshToken: "test-refresh-key" };

/** La fila de `users` de un inquilino común, con lo que el mail necesita. */
function fila(cambios: Record<string, unknown> = {}) {
  return { tenant_id: TENANT, locale: "es-AR", autoalta: false, ...cambios };
}

/** Lo que el módulo le pidió al remitente del sistema. */
function enviadoPorElSistema() {
  return mockEnviar.mock.calls[0][0] as { to: string; asunto: string; texto: string };
}

function payloadAuditado() {
  return (mockAudit.mock.calls[0][0] as { payload: Record<string, unknown> }).payload;
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
  mockFila.mockResolvedValue(fila());
  mockRemitente.mockReturnValue(REMITENTE);
  mockEnviar.mockResolvedValue({ enviado: true });
  mockGetAccount.mockResolvedValue({
    email: "siniestros@aseguradora.example.com",
    refreshToken: "test-refresh-key",
  });
  mockSend.mockResolvedValue({ providerMessageId: "sent-1" });
  mockAudit.mockResolvedValue(undefined);
});

afterEach(() => {
  for (const s of spies) s.mockRestore();
});

describe("con el remitente del sistema", () => {
  it("todo sale por ahí, hacia la persona, y nunca por la casilla de la aseguradora", async () => {
    await sendPasswordResetEmail(ENTRADA);

    expect(mockEnviar).toHaveBeenCalledTimes(1);
    expect(enviadoPorElSistema().to).toBe("analista@example.com");
    expect(enviadoPorElSistema().texto).toContain(URL_RESET);
    // Esa casilla guarda una copia del enlace en Enviados y la lee quien la administra.
    expect(mockGetAccount).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it.each([
    ["un inquilino común", fila()],
    ["un espacio de alta automática", fila({ tenant_id: TENANT_PRUEBA, autoalta: true })],
    ["una base sin la migración de alta automática", fila({ autoalta: null })],
  ])("también para %s", async (_caso, perfil) => {
    mockFila.mockResolvedValue(perfil);

    await sendPasswordResetEmail(ENTRADA);

    expect(mockEnviar).toHaveBeenCalledTimes(1);
    expect(mockGetAccount).not.toHaveBeenCalled();
  });

  it("dice cuánto dura y que sirve una sola vez", async () => {
    await sendPasswordResetEmail(ENTRADA);

    const cuerpo = enviadoPorElSistema().texto;
    // Alguien que recibe esto sin haberlo pedido tiene que poder decidir qué
    // hacer sin escribirle a nadie.
    expect(cuerpo).toContain("60 minutos");
    expect(cuerpo).toContain("una sola vez");
    expect(cuerpo).toMatch(/si no fuiste vos/i);
  });

  it("con perfil es el mail de recuperación", async () => {
    await sendPasswordResetEmail(ENTRADA);

    expect(enviadoPorElSistema().asunto).toMatch(/recuperar/i);
    expect(enviadoPorElSistema().texto).toMatch(/contraseña actual/i);
  });

  it("sin perfil también es el mail de recuperación, pero no dice que la contraseña actual sigue funcionando: la cuenta del paso 1 puede ser sólo de Google", async () => {
    mockFila.mockResolvedValue(null);

    await sendPasswordResetEmail(ENTRADA);

    const { asunto, texto } = enviadoPorElSistema();
    expect(asunto).toMatch(/recuperar/i);
    expect(asunto).not.toMatch(/activar/i);
    expect(texto).toContain(URL_RESET);
    expect(texto).toMatch(/si no fuiste vos/i);
    expect(texto).not.toMatch(/contraseña actual/i);
    // Abrir el enlace no cambia nada y nadie más lo recibe: lo que cambia la cuenta es elegir la contraseña nueva.
    expect(texto).toContain("tu cuenta no cambia hasta que se elige una contraseña nueva desde este enlace");
    expect(texto).not.toMatch(/alguien abre/i);
  });

  it("sin perfil sale igual y no hay inquilino a quien anotárselo", async () => {
    mockFila.mockResolvedValue(null);

    await sendPasswordResetEmail(ENTRADA);

    expect(mockEnviar).toHaveBeenCalledTimes(1);
    expect(mockAudit).not.toHaveBeenCalled();
  });
});

describe("los cupos del remitente", () => {
  const pedido = (cabeceras: Record<string, string>) =>
    new Request("https://claimmix.example.com/api/auth/request-password-reset", { headers: cabeceras });

  it("la recuperación de una cuenta con perfil cuenta como `recuperacion`, con la IP del pedido", async () => {
    await sendPasswordResetEmail({ ...ENTRADA, request: pedido({ "x-forwarded-for": "203.0.113.7" }) });

    expect(mockEnviar).toHaveBeenCalledWith(expect.anything(), { tipo: "recuperacion", ip: "203.0.113.7" });
  });

  it("una cuenta sin perfil también cuenta como `recuperacion`: no gasta el cupo de las altas", async () => {
    mockFila.mockResolvedValue(null);

    await sendPasswordResetEmail({ ...ENTRADA, request: pedido({ "x-forwarded-for": "203.0.113.7" }) });

    expect(mockEnviar).toHaveBeenCalledWith(expect.anything(), { tipo: "recuperacion", ip: "203.0.113.7" });
  });

  it("prefiere la cabecera de Vercel, la única que no escribe quien llama", async () => {
    await sendPasswordResetEmail({
      ...ENTRADA,
      request: pedido({ "x-vercel-forwarded-for": "198.51.100.9", "x-forwarded-for": "203.0.113.7" }),
    });

    expect(mockEnviar).toHaveBeenCalledWith(expect.anything(), { tipo: "recuperacion", ip: "198.51.100.9" });
  });

  it("fuera de una solicitud (sin pedido ni cabeceras) no lanza y cuenta con una IP anónima", async () => {
    await expect(sendPasswordResetEmail(ENTRADA)).resolves.toBeUndefined();

    expect(mockEnviar).toHaveBeenCalledWith(expect.anything(), { tipo: "recuperacion", ip: "anonymous" });
  });
});

describe("el saludo", () => {
  it("nunca lleva el nombre, que lo escribe un tercero", async () => {
    // El nombre lo controla quien administra la cuenta: con él, el mail de la
    // plataforma sería un mail de phishing con nuestro remitente.
    const nombre = "Hacé clic en https://phishing.example.com/entrar para no perder tu cuenta";

    await sendPasswordResetEmail({ ...ENTRADA, name: nombre });

    const { asunto, texto } = enviadoPorElSistema();
    expect(texto.startsWith("Hola,\n")).toBe(true);
    for (const parte of [asunto, texto]) {
      expect(parte).not.toContain("phishing");
      expect(parte).not.toContain("Lucía");
    }
    expect(texto).not.toContain("null");
  });

  it("tampoco con el nombre en blanco o ausente", async () => {
    await sendPasswordResetEmail({ ...ENTRADA, name: null });
    await sendPasswordResetEmail({ ...ENTRADA, name: undefined });

    for (const [llamada] of mockEnviar.mock.calls) {
      expect((llamada as { texto: string }).texto.startsWith("Hola,\n")).toBe(true);
    }
  });
});

describe("el idioma", () => {
  it("sale en inglés si el perfil lo tiene en inglés", async () => {
    mockFila.mockResolvedValue(fila({ locale: "en-US" }));

    await sendPasswordResetEmail(ENTRADA);

    const { asunto, texto } = enviadoPorElSistema();
    expect(asunto).toBe("Recover access to ClaimMix");
    expect(texto.startsWith("Hello,\n")).toBe(true);
    expect(texto).toContain("60 minutes");
    expect(texto).toContain(URL_RESET);
  });

  it("sin perfil no hay idioma guardado: el mail de recuperación sale en castellano aunque otra cuenta lo tenga en inglés", async () => {
    mockFila.mockResolvedValue(fila({ locale: "en-US" }));

    await sendPasswordResetEmail(ENTRADA);
    mockFila.mockResolvedValue(null);
    await sendPasswordResetEmail(ENTRADA);

    // Sin perfil no hay idioma guardado: es-AR.
    expect((mockEnviar.mock.calls[1][0] as { asunto: string }).asunto).toBe("Recuperar el acceso a ClaimMix");
  });

  it.each([
    ["sin idioma guardado", null],
    ["con uno que no existe", "fr-FR"],
    ["en castellano", "es-AR"],
  ])("sale en castellano %s", async (_caso, locale) => {
    mockFila.mockResolvedValue(fila({ locale }));

    await sendPasswordResetEmail(ENTRADA);

    expect(enviadoPorElSistema().asunto).toBe("Recuperar el acceso a ClaimMix");
  });
});

describe("el texto del mail para una cuenta sin perfil, en los dos idiomas", () => {
  it.each([
    ["en-US", "your account does not change until a new password is chosen from this link"],
    ["es-AR", "tu cuenta no cambia hasta que se elige una contraseña nueva desde este enlace"],
  ] as const)("%s dice qué cambia la cuenta, sin suponer que alguien más abre el enlace", (locale, frase) => {
    const { texto } = correoDeEnlace(getT(locale), "recuperar", URL_RESET, 60, true);

    expect(texto).toContain(frase);
    expect(texto).not.toMatch(/someone opens|alguien abre/i);
    expect(texto).not.toMatch(/current password|contraseña actual/i);
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
    mockEnviar.mockResolvedValue({ enviado: false, motivo: "sin_cupo" });

    await sendPasswordResetEmail(ENTRADA);

    const todo = logs.join("\n");
    expect(todo).not.toContain(TOKEN);
    // Y el motivo sí, porque alguien lo tiene que arreglar.
    expect(todo).toContain("password_reset.send_failed");
  });

  it("la auditoría guarda que se pidió, no a quién ni con qué enlace", async () => {
    await sendPasswordResetEmail(ENTRADA);

    expect(mockAudit).toHaveBeenCalledTimes(1);
    const anotado = JSON.stringify(mockAudit.mock.calls[0][0]);
    expect(anotado).toContain("auth.password_reset_requested");
    expect(anotado).not.toContain(TOKEN);
    expect(anotado).not.toContain("analista@example.com");
  });
});

describe("cuando el remitente no manda", () => {
  it.each(["sin_cupo", "sin_remitente", "destinatario_invalido", "no_salio"])(
    "queda asentado como no entregado con el motivo %s, en el inquilino del perfil",
    async (motivo) => {
      mockEnviar.mockResolvedValue({ enviado: false, motivo });

      await sendPasswordResetEmail(ENTRADA);

      expect(mockAudit.mock.calls[0][0]).toMatchObject({ tenant_id: TENANT, actor_id: null, target_id: USER });
      expect(payloadAuditado()).toEqual({ delivered: false, motivo });
    }
  );

  it("un envío logrado queda como entregado, sin motivo", async () => {
    await sendPasswordResetEmail(ENTRADA);

    expect(payloadAuditado()).toEqual({ delivered: true });
    expect(logs.join("\n")).toContain("password_reset.sent");
  });
});

describe("sin remitente del sistema (la transición)", () => {
  beforeEach(() => {
    mockRemitente.mockReturnValue(null);
    mockEnviar.mockResolvedValue({ enviado: false, motivo: "sin_remitente" });
  });

  it("un inquilino que no es de alta automática sigue con su casilla, como hasta ahora", async () => {
    await sendPasswordResetEmail(ENTRADA);

    expect(mockGetAccount).toHaveBeenCalledWith(TENANT);
    expect(mockEnviar).not.toHaveBeenCalled();
    expect(mockSend).toHaveBeenCalledTimes(1);
    const enviado = mockSend.mock.calls[0][0];
    expect(enviado.to).toBe("analista@example.com");
    expect(enviado.from).toBe("siniestros@aseguradora.example.com");
    expect(enviado.subject).toMatch(/recuperar/i);
    expect(enviado.textBody).toContain(URL_RESET);
    expect(enviado.textBody.startsWith("Hola,\n")).toBe(true);
    expect(payloadAuditado()).toEqual({ delivered: true });
  });

  it("una base sin la migración (autoalta null) cuenta como inquilino común", async () => {
    mockFila.mockResolvedValue(fila({ autoalta: null }));

    await sendPasswordResetEmail(ENTRADA);

    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it("una prueba no recibe nada por la casilla de nadie, y queda anotado", async () => {
    mockFila.mockResolvedValue(fila({ tenant_id: TENANT_PRUEBA, autoalta: true }));

    await sendPasswordResetEmail(ENTRADA);

    expect(mockGetAccount).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
    // Quien lo dice es el remitente del sistema, que no encuentra remitente.
    expect(mockEnviar).toHaveBeenCalledTimes(1);
    expect(mockAudit.mock.calls[0][0]).toMatchObject({ tenant_id: TENANT_PRUEBA });
    expect(payloadAuditado()).toEqual({ delivered: false, motivo: "sin_remitente" });
  });

  it("una cuenta sin perfil no recibe nada por la casilla de nadie", async () => {
    mockFila.mockResolvedValue(null);

    await sendPasswordResetEmail(ENTRADA);

    expect(mockGetAccount).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
    expect(mockAudit).not.toHaveBeenCalled();
  });

  it("sin casilla conectada no manda, y lo dice con el motivo", async () => {
    mockGetAccount.mockResolvedValue(null);

    await sendPasswordResetEmail(ENTRADA);

    expect(mockSend).not.toHaveBeenCalled();
    const todo = logs.join("\n");
    expect(todo).toContain("password_reset.sin_casilla");
    expect(todo).not.toContain(TOKEN);
  });

  it("sin casilla igual queda asentado el pedido, como no entregado", async () => {
    mockGetAccount.mockResolvedValue(null);

    await sendPasswordResetEmail(ENTRADA);

    // Sin esto, quien mire la auditoría de esa cuenta no ve nada y concluye
    // que nunca pidió recuperarla.
    expect(mockAudit).toHaveBeenCalledTimes(1);
    expect(payloadAuditado()).toEqual({ delivered: false, motivo: "sin_casilla" });
  });

  it("un envío fallido queda anotado como no entregado, no como éxito", async () => {
    mockSend.mockResolvedValue({ errorCode: "GMAIL_SEND_FAILED" });

    await sendPasswordResetEmail(ENTRADA);

    expect(payloadAuditado()).toEqual({ delivered: false, motivo: "no_salio" });
    expect(logs.join("\n")).toContain("password_reset.send_failed");
  });
});

describe("nunca lanza", () => {
  /*
   * Better Auth responde siempre lo mismo —«si ese correo existe, te llega un
   * enlace»— para no confirmar qué direcciones hay registradas. Una excepción
   * acá rompería esa simetría: el que existe fallaría distinto del que no.
   */
  it("aunque la base se caiga", async () => {
    mockFila.mockRejectedValue(new Error("la base no contesta"));

    await expect(sendPasswordResetEmail(ENTRADA)).resolves.toBeUndefined();
    expect(logs.join("\n")).toContain("password_reset.error");
    expect(mockEnviar).not.toHaveBeenCalled();
  });

  it("aunque la auditoría se caiga", async () => {
    mockAudit.mockRejectedValue(new Error("audit caído"));

    await expect(sendPasswordResetEmail(ENTRADA)).resolves.toBeUndefined();
    expect(logs.join("\n")).toContain("password_reset.error");
  });
});
