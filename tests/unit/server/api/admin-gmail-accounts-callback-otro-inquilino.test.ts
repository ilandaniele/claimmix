/**
 * GET /api/admin/gmail-accounts/callback — una casilla, una sola aseguradora.
 *
 * La base sólo hace única la casilla por inquilino, y el upsert corre bajo RLS:
 * no ve la fila del otro. Sin esta guarda, la misma casilla podía conectarse en
 * dos aseguradoras, y el timbre y las respuestas caían en la que devolviera el
 * heap. Lo que se prueba es que el callback mire antes, con el lector que sí ve
 * a todos, y rechace sin escribir ni pedir aviso.
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
  mockInquilinoDeLaCasilla,
  baseSimulada,
} = vi.hoisted(() => ({
  baseSimulada: { actual: null as unknown },
  mockSetupGmailWatch: vi.fn(),
  mockGetToken: vi.fn(),
  mockGetProfile: vi.fn(),
  mockInsert: vi.fn(),
  mockRequireRole: vi.fn(),
  mockInquilinoDeLaCasilla: vi.fn(),
}));

vi.mock("@/data/scope", async () =>
  (await import("../../../mocks/puente-de-alcance")).puenteDeAlcance(() => baseSimulada.actual)
);

vi.mock("@/server/email/gmail/watch", () => ({
  setupGmailWatch: mockSetupGmailWatch,
}));

vi.mock("@/server/email/gmail/accounts", () => ({
  encryptRefreshToken: (t: string) => `cifrado:${t}`,
  inquilinoDeLaCasilla: mockInquilinoDeLaCasilla,
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

vi.mock("@googleapis/gmail", () => ({
  auth: {
    OAuth2: class {
      getToken = mockGetToken;
      setCredentials = vi.fn();
    },
  },
  gmail: () => ({ users: { getProfile: mockGetProfile } }),
}));

// ── La ruta, después de los mocks ────────────────────────────────────────────

import { GET } from "@/app/api/admin/gmail-accounts/callback/route";

// ── Ayudas ───────────────────────────────────────────────────────────────────

const TENANT = "tenant-1";
const USER = "user-1";
const TOPIC = "projects/claimmix-506321/topics/gmail-push";
const REFRESH = "fake-refresh";
const EMAIL = "casilla@example.com";

const NONCE = "nonce-de-prueba-que-viaja-por-los-dos-caminos";

function makeRequest(): NextRequest {
  const state = Buffer.from(
    JSON.stringify({ tenantId: TENANT, userId: USER, nonce: NONCE }),
    "utf8"
  ).toString("base64url");

  const req = new NextRequest(
    `http://localhost/api/admin/gmail-accounts/callback?code=abc123&state=${state}`
  );
  req.cookies.set("gmail_oauth_state", NONCE);
  return req;
}

const destino = (res: Response) =>
  new URL(res.headers.get("location") ?? "").searchParams.get("gmail");

// ── Tests ────────────────────────────────────────────────────────────────────

describe("GET /api/admin/gmail-accounts/callback — casilla de otra aseguradora", () => {
  beforeEach(() => {
    process.env.GMAIL_CLIENT_ID = "client-id";
    process.env.GMAIL_CLIENT_SECRET = "fake-client-secret";
    process.env.PUBSUB_TOPIC = TOPIC;

    mockRequireRole.mockResolvedValue({
      db: (baseSimulada.actual = { insert: mockInsert }),
      user: { id: USER },
      userRow: { tenant_id: TENANT },
    });
    mockGetToken.mockResolvedValue({ tokens: { refresh_token: REFRESH } });
    mockGetProfile.mockResolvedValue({ data: { emailAddress: EMAIL } });
    mockInquilinoDeLaCasilla.mockResolvedValue(null);
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

  it("rechaza una casilla ya conectada en otra aseguradora", async () => {
    mockInquilinoDeLaCasilla.mockResolvedValue("otro-tenant");

    const res = await GET(makeRequest());

    expect(destino(res)).toBe("mailbox_taken");
    expect(mockInsert).not.toHaveBeenCalled();
    expect(mockSetupGmailWatch).not.toHaveBeenCalled();
    // El nonce se quema igual que en invalid_state.
    expect(res.headers.get("set-cookie")).toMatch(/gmail_oauth_state=;/);
  });

  it("rechaza también la casilla apagada de otra aseguradora", async () => {
    // El lector de casillas activas no la ve: sólo el que mira apagadas y
    // prendidas sabe que sigue siendo de esa aseguradora.
    mockInquilinoDeLaCasilla.mockResolvedValue("otro-tenant");

    const res = await GET(makeRequest());

    expect(destino(res)).toBe("mailbox_taken");
    expect(mockInsert).not.toHaveBeenCalled();
    expect(mockSetupGmailWatch).not.toHaveBeenCalled();
  });

  it("la misma aseguradora reconecta sin problema", async () => {
    mockInquilinoDeLaCasilla.mockResolvedValue(TENANT);

    const res = await GET(makeRequest());

    expect(destino(res)).toBe("connected");
    expect(mockInsert).toHaveBeenCalledOnce();
  });

  it("sin fila previa conecta", async () => {
    mockInquilinoDeLaCasilla.mockResolvedValue(null);

    const res = await GET(makeRequest());

    expect(destino(res)).toBe("connected");
  });

  it("consulta por la dirección en minúsculas", async () => {
    mockGetProfile.mockResolvedValue({ data: { emailAddress: "OTRA@Example.com" } });

    await GET(makeRequest());

    expect(mockInquilinoDeLaCasilla).toHaveBeenCalledWith("otra@example.com");
  });
});
