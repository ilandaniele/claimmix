/**
 * GET /api/admin/gmail-accounts/callback — conectar una casilla de Gmail.
 *
 * La ruta no tenía ni un test, y por ahí se coló un defecto que no se ve desde
 * afuera: al reconectar la casilla, el aviso de push (gmail.users.watch) queda
 * muerto del lado de Google —cuelga del permiso que se acaba de revocar— pero
 * la fila de estado en la base sigue diciendo que vence dentro de siete días.
 * El cron sólo renueva lo que ve por vencer, así que no lo renovaba; /api/health
 * seguía diciendo «casilla conectada» porque el token se lee bien; y el correo
 * seguía entrando, pero por el cron en vez de en segundos.
 *
 * Nada fallaba a la vista. Simplemente todo se volvía lento durante una semana.
 * De ahí que lo que se prueba acá sea, sobre todo, que el aviso se vuelva a
 * pedir en el único momento en que sabemos que hay permiso nuevo.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

// ── Mocks (izados antes de importar la ruta) ─────────────────────────────────

const {
  mockSetupGmailWatch,
  mockGetToken,
  mockGetProfile,
  mockInsert,
  mockRequireRole,
} = vi.hoisted(() => ({
  mockSetupGmailWatch: vi.fn(),
  mockGetToken: vi.fn(),
  mockGetProfile: vi.fn(),
  mockInsert: vi.fn(),
  mockRequireRole: vi.fn(),
}));

vi.mock("@/server/email/gmail/watch", () => ({
  setupGmailWatch: mockSetupGmailWatch,
}));

vi.mock("@/server/email/gmail/accounts", () => ({
  encryptRefreshToken: (t: string) => `cifrado:${t}`,
}));

vi.mock("@/lib/auth/require-role", () => ({
  requireRole: mockRequireRole,
  ADMIN_ROLES: ["owner", "admin"],
}));

vi.mock("@/lib/db", () => ({
  tables: {
    gmailAccounts: { tenant_id: "tenant_id", email: "email" },
  },
}));

vi.mock("googleapis", () => ({
  google: {
    auth: {
      OAuth2: class {
        getToken = mockGetToken;
        setCredentials = vi.fn();
      },
    },
    gmail: () => ({ users: { getProfile: mockGetProfile } }),
  },
}));

// ── La ruta, después de los mocks ────────────────────────────────────────────

import { GET } from "@/app/api/admin/gmail-accounts/callback/route";

// ── Ayudas ───────────────────────────────────────────────────────────────────

const TENANT = "tenant-1";
const USER = "user-1";
const TOPIC = "projects/claimmix-506321/topics/gmail-push";
const REFRESH = "refresh-token-nuevo";
const EMAIL = "casilla@example.com";

function makeRequest(): NextRequest {
  const state = Buffer.from(
    JSON.stringify({ tenantId: TENANT, userId: USER }),
    "utf8"
  ).toString("base64url");
  return new NextRequest(
    `http://localhost/api/admin/gmail-accounts/callback?code=abc123&state=${state}`
  );
}

const destino = (res: Response) =>
  new URL(res.headers.get("location") ?? "").searchParams.get("gmail");

// ── Tests ────────────────────────────────────────────────────────────────────

describe("GET /api/admin/gmail-accounts/callback", () => {
  beforeEach(() => {
    process.env.GMAIL_CLIENT_ID = "client-id";
    process.env.GMAIL_CLIENT_SECRET = "client-secret";
    process.env.PUBSUB_TOPIC = TOPIC;

    mockRequireRole.mockResolvedValue({
      db: { insert: mockInsert },
      user: { id: USER },
      userRow: { tenant_id: TENANT },
    });
    mockGetToken.mockResolvedValue({ tokens: { refresh_token: REFRESH } });
    mockGetProfile.mockResolvedValue({ data: { emailAddress: EMAIL } });
    mockInsert.mockReturnValue({
      values: () => ({ onConflictDoUpdate: () => Promise.resolve() }),
    });
    mockSetupGmailWatch.mockResolvedValue({
      historyId: "1",
      expiration: new Date(1750000000000).toISOString(),
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    delete process.env.GMAIL_CLIENT_ID;
    delete process.env.GMAIL_CLIENT_SECRET;
    delete process.env.PUBSUB_TOPIC;
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("conecta la casilla y redirige a configuración", async () => {
    const res = await GET(makeRequest());

    expect(res.status).toBe(307);
    expect(destino(res)).toBe("connected");
  });

  it("vuelve a registrar el aviso de push con el permiso recién emitido", async () => {
    await GET(makeRequest());

    expect(mockSetupGmailWatch).toHaveBeenCalledOnce();
    expect(mockSetupGmailWatch).toHaveBeenCalledWith(TOPIC, {
      email: EMAIL,
      refreshToken: REFRESH,
    });
  });

  it("registra el aviso para la casilla que se acaba de conectar", async () => {
    mockGetProfile.mockResolvedValue({ data: { emailAddress: "OTRA@Example.com" } });

    await GET(makeRequest());

    // En minúsculas, como se guarda: si acá se colara otra dirección, el aviso
    // quedaría pedido para una casilla y el correo se leería de otra.
    expect(mockSetupGmailWatch).toHaveBeenCalledWith(
      TOPIC,
      expect.objectContaining({ email: "otra@example.com" })
    );
  });

  it("si el aviso falla, la casilla igual queda conectada", async () => {
    // El push es una mejora de latencia, no la vía de entrada: si se cae, el
    // cron sigue trayendo el correo. Perder la conexión por esto sería peor.
    mockSetupGmailWatch.mockRejectedValue(new Error("GmailApiError"));

    const res = await GET(makeRequest());

    expect(destino(res)).toBe("connected");
  });

  it("sin PUBSUB_TOPIC no intenta registrar nada y conecta igual", async () => {
    delete process.env.PUBSUB_TOPIC;

    const res = await GET(makeRequest());

    expect(mockSetupGmailWatch).not.toHaveBeenCalled();
    expect(destino(res)).toBe("connected");
  });

  it("si Google no devuelve refresh token, no conecta ni pide aviso", async () => {
    mockGetToken.mockResolvedValue({ tokens: {} });

    const res = await GET(makeRequest());

    expect(destino(res)).toBe("missing_refresh_token");
    expect(mockSetupGmailWatch).not.toHaveBeenCalled();
  });

  it("rechaza un state de otro tenant", async () => {
    mockRequireRole.mockResolvedValue({
      db: { insert: mockInsert },
      user: { id: USER },
      userRow: { tenant_id: "otro-tenant" },
    });

    const res = await GET(makeRequest());

    expect(destino(res)).toBe("invalid_state");
    expect(mockInsert).not.toHaveBeenCalled();
  });
});
