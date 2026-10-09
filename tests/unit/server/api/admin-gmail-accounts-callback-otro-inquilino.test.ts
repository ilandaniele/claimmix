/**
 * GET /api/admin/gmail-accounts/callback — una casilla, una sola aseguradora.
 *
 * La base sólo hace única la casilla por inquilino, y el upsert corre bajo RLS:
 * no ve la fila del otro. Sin esta guarda, la misma casilla podía conectarse en
 * dos aseguradoras, y el timbre y las respuestas caían en la que devolviera el
 * heap. Lo que se prueba es que el callback mire antes, con el lector que sí ve
 * a todos, y rechace sin escribir ni pedir aviso.
 *
 * Ese chequeo no cubre la carrera entre dos callbacks: la que la cierra es el
 * índice único sobre lower(email) de la 0047, y lo que le toca al callback es
 * tratar su 23505 como un rechazo (`mailbox_taken`) y no como un fallo al
 * guardar (`save_failed`).
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

describe("GET /api/admin/gmail-accounts/callback — casilla del otro ambiente", () => {
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
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    delete process.env.GMAIL_CLIENT_ID;
    delete process.env.GMAIL_CLIENT_SECRET;
    delete process.env.PUBSUB_TOPIC;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("una casilla de CASILLAS_DE_DEV redirige a otro_ambiente sin guardar ni pedir aviso, y quema el nonce", async () => {
    vi.stubEnv("CASILLAS_DE_DEV", "otra@example.com, Casilla@Example.com");

    const res = await GET(makeRequest());

    expect(destino(res)).toBe("otro_ambiente");
    expect(mockInquilinoDeLaCasilla).not.toHaveBeenCalled();
    expect(mockInsert).not.toHaveBeenCalled();
    expect(mockSetupGmailWatch).not.toHaveBeenCalled();
    expect(res.headers.get("set-cookie")).toMatch(/gmail_oauth_state=;/);
  });

  it("con CASILLAS_DE_DEV una casilla que no está en la lista conecta igual", async () => {
    vi.stubEnv("CASILLAS_DE_DEV", "otra@example.com");

    const res = await GET(makeRequest());

    expect(destino(res)).toBe("connected");
    expect(mockInsert).toHaveBeenCalledOnce();
  });
});

describe("GET /api/admin/gmail-accounts/callback — el índice único de la casilla", () => {
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
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    delete process.env.GMAIL_CLIENT_ID;
    delete process.env.GMAIL_CLIENT_SECRET;
    delete process.env.PUBSUB_TOPIC;
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  const insertQueFalla = (error: unknown) =>
    mockInsert.mockReturnValue({
      values: () => ({ onConflictDoUpdate: () => Promise.reject(error) }),
    });

  it("un 23505 del INSERT (otro callback ganó la carrera) redirige a mailbox_taken y borra la cookie", async () => {
    insertQueFalla(Object.assign(new Error("duplicate key"), { code: "23505" }));

    const res = await GET(makeRequest());

    expect(destino(res)).toBe("mailbox_taken");
    expect(res.headers.get("set-cookie")).toMatch(/gmail_oauth_state=;/);
    expect(mockSetupGmailWatch).not.toHaveBeenCalled();
  });

  it("el 23505 envuelto por Drizzle en `cause` también cuenta", async () => {
    insertQueFalla(new Error("Failed query", { cause: { code: "23505" } }));

    const res = await GET(makeRequest());

    expect(destino(res)).toBe("mailbox_taken");
    expect(res.headers.get("set-cookie")).toMatch(/gmail_oauth_state=;/);
    expect(mockSetupGmailWatch).not.toHaveBeenCalled();
  });

  it.each(["40001", "42P01", undefined])("cualquier otro error del INSERT (%s) sigue siendo save_failed", async (codigo) => {
    insertQueFalla(Object.assign(new Error("falló"), { code: codigo }));

    const res = await GET(makeRequest());

    expect(destino(res)).toBe("save_failed");
    expect(mockSetupGmailWatch).not.toHaveBeenCalled();
  });
});
