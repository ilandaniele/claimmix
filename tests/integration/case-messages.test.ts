/**
 * Integration tests for GET /api/cases/[id]/messages — la conversación entera.
 *
 * AC8: Returns 200 + messages array with all required fields, oldest first.
 * AC9: Returns 404 NOT_FOUND when case belongs to a different tenant (IDOR safe).
 * AC10: Returns 200 + { messages: [], recortada: false } when the case has no messages.
 * AC13: body_text is truncated to 2000 chars server-side, after masking.
 * AC14: attachment_count comes from the count in the inbound query.
 *
 * Uses vi.mock("@/lib/db") and vi.mock("@/lib/auth/require-role") to exercise
 * route handler logic without a live DB or server. The batch is always four
 * selects, in order: case, claim_messages (both directions), the simulated
 * intake in raw_messages, outbound_messages.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { type NextRequest } from "next/server";

// ── Mocks must be hoisted before any imports that use them ────────────────────

// La capa de datos, corriendo contra el db que este test ya simula.
//
// Se lee `mod.db` en CADA llamada y no se desestructura: el mock de @/lib/db
// suele exponer `db` con un getter para que los tests puedan intercambiar la
// base simulada entre corridas, y un `const { db } = ...` congelaría el valor
// de la primera llamada.
//
// Lo que NO se prueba acá es que el contexto de inquilino llegue a la base:
// eso se verifica en tests/unit/data-scope-sin-rol.test.ts y, contra bases de
// verdad, en `pnpm capa-datos` y `pnpm tenancy`.
vi.mock("@/data/scope", async () => {
  const mod = await import("@/lib/db");
  return {
    enTenant: (_ctx: unknown, armar: (d: unknown) => unknown) =>
      Promise.resolve(armar(mod.db)),
    enTenantVarias: (_ctx: unknown, armar: (d: unknown) => unknown[]) =>
      Promise.all(armar(mod.db)),
  };
});

vi.mock("@/lib/db", () => {
  const mockDb = {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  };
  return { db: mockDb };
});

/*
 * La sesión, que ahora la ruta mira antes que nada.
 *
 * `entrar()` la pide una sola vez y con ella lanza EN PARALELO la fila de
 * `users` y el cupo: las dos necesitan el id del usuario y nada más. Antes iban
 * en fila, tres viajes a Neon antes del primer byte útil.
 *
 * Acá se simula porque el mock de `require-role` ya no la arrastra: la lectura
 * de la sesión salió de adentro suyo.
 */
vi.mock("@/lib/auth/session", () => ({
  getSessionContext: vi.fn().mockResolvedValue({ user: { id: "user-1" } }),
}));

vi.mock("@/lib/auth/require-role", () => ({
  requireRole: vi.fn(),
  ALL_ROLES: ["owner", "admin", "specialist", "analyst", "viewer"],
}));

// Mock rate-limit to always allow (not testing rate-limit in this suite).
vi.mock("@/lib/rate-limit/index", async () => {
  const actual = await vi.importActual<typeof import("@/lib/rate-limit/index")>(
    "@/lib/rate-limit/index"
  );
  return {
    ...actual,
    rateLimit: vi.fn().mockResolvedValue({
      allowed: true,
      remaining: 99,
      resetAt: 0,
      retryAfterSeconds: 0,
    }),
  };
});

import { db } from "@/lib/db";
import { requireRole, type UserRole } from "@/lib/auth/require-role";
import { GET } from "@/app/api/cases/[id]/messages/route";
import { OCULTO } from "@/server/cases/pii";

// ── Test fixtures ─────────────────────────────────────────────────────────────

const TENANT_ID = "tenant-001";
const USER_ID = "user-uuid-001";
const CASE_ID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
const OTHER_CASE_ID = "b2c3d4e5-f6a7-8901-bcde-f12345678901";

const DNI = "27.654.321";
const POLIZA = "POL-8812-R";

/** A row of the claim_messages select (+ the attachment count), inbound by default. */
function makeMessage(overrides: Partial<{
  id: string;
  direction: string;
  provider: string;
  subject: string | null;
  from_addr: string | null;
  body_text: string | null;
  received_at: string;
  status: string;
  attachment_count: number;
}> = {}) {
  return {
    id: "msg-uuid-001",
    direction: "inbound",
    provider: "gmail",
    subject: "Test subject",
    from_addr: "claimant@example.com",
    body_text: "Hello, this is the body of the email.",
    received_at: "2026-06-01T10:00:00Z",
    status: "received",
    attachment_count: 0,
    ...overrides,
  };
}

/** Build a fake NextRequest for the route handler. */
function buildRequest(): NextRequest {
  return new Request("http://localhost/api/cases/" + CASE_ID + "/messages") as NextRequest;
}

/** Build the route context with params as a Promise (Next.js 16 convention). */
function buildContext(id: string) {
  return {
    params: Promise.resolve({ id }),
  };
}

/**
 * Set up requireRole to return a valid session context.
 */
function setupAuth(role: UserRole = "analyst") {
  vi.mocked(requireRole).mockResolvedValue({
    user: { id: USER_ID, email: "test@example.com" },
    userRow: { id: USER_ID, tenant_id: TENANT_ID, role },
  });
}

/**
 * Set up requireRole to throw (unauthenticated).
 */
function setupNoAuth() {
  vi.mocked(requireRole).mockRejectedValue(new Error("MISSING_SESSION"));
}

/**
 * Build a chainable db.select mock that resolves with the given rows, whatever
 * the chain: from/where/leftJoin/groupBy/orderBy/limit all return the chain.
 */
function buildSelectChain(rows: unknown[]) {
  const chain: any = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    leftJoin: vi.fn().mockReturnThis(),
    groupBy: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    then: (resolve: (v: unknown) => void) => resolve(rows),
  };
  return chain;
}

/** The four selects of the batch, in the order the route builds them. */
function mockBatch({
  caso = [{ id: CASE_ID }],
  hilo = [],
  simulados = [],
  whatsapps = [],
}: {
  caso?: unknown[];
  hilo?: unknown[];
  simulados?: unknown[];
  whatsapps?: unknown[];
} = {}) {
  vi.mocked(db.select)
    .mockReturnValueOnce(buildSelectChain(caso))
    .mockReturnValueOnce(buildSelectChain(hilo))
    .mockReturnValueOnce(buildSelectChain(simulados))
    .mockReturnValueOnce(buildSelectChain(whatsapps));
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("GET /api/cases/[id]/messages", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset only the db.select queue so mockReturnValueOnce calls don't bleed between tests.
    vi.mocked(db.select).mockReset();
  });

  it("AC8: returns 200 with messages array, oldest first, when case is owned and messages exist", async () => {
    setupAuth();
    mockBatch({
      hilo: [
        makeMessage({ id: "msg-003", received_at: "2026-06-01T10:00:00Z" }),
        makeMessage({ id: "msg-002", received_at: "2026-06-01T09:00:00Z" }),
        makeMessage({ id: "msg-001", received_at: "2026-06-01T08:00:00Z" }),
      ],
    });

    const response = await GET(buildRequest(), buildContext(CASE_ID));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.messages.map((m: { id: string }) => m.id)).toEqual(["msg-001", "msg-002", "msg-003"]);
    // One batch: the four selects and nothing else.
    expect(db.select).toHaveBeenCalledTimes(4);

    // AC8: each entry has exactly the contract's fields
    expect(Object.keys(body.messages[0]).sort()).toEqual([
      "attachment_count",
      "body_text",
      "direction",
      "estado_envio",
      "from_addr",
      "id",
      "provider",
      "received_at",
      "subject",
    ]);
    expect(body.messages[0]).toMatchObject({ direction: "inbound", estado_envio: null });
  });

  it("AC9: returns 404 NOT_FOUND for case belonging to a different tenant (IDOR safe)", async () => {
    setupAuth();
    // The batch runs whole; the case select comes back empty.
    mockBatch({ caso: [], hilo: [makeMessage()] });

    const response = await GET(buildRequest(), buildContext(OTHER_CASE_ID));
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.error.code).toBe("NOT_FOUND");
    // AC9: no message data in the body
    expect(body).not.toHaveProperty("messages");
  });

  it("AC10: returns 200 with empty array when the case has no messages", async () => {
    setupAuth();
    mockBatch();

    const response = await GET(buildRequest(), buildContext(CASE_ID));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ messages: [], recortada: false });
  });

  it("returns 401 MISSING_SESSION when not authenticated", async () => {
    setupNoAuth();

    const response = await GET(buildRequest(), buildContext(CASE_ID));
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body.error.code).toBe("MISSING_SESSION");
  });

  it("returns 404 for invalid (non-UUID) case ID", async () => {
    setupAuth();

    const response = await GET(buildRequest(), buildContext("not-a-uuid"));
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("returns 500 without message data when the batch fails", async () => {
    setupAuth();
    vi.mocked(db.select).mockImplementation(() => {
      throw Object.assign(new Error("boom"), { code: "57P01" });
    });

    const response = await GET(buildRequest(), buildContext(CASE_ID));
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.error.code).toBe("INTERNAL_ERROR");
    expect(body).not.toHaveProperty("messages");
  });

  it("AC13: body_text is truncated to 2000 chars when input exceeds 2000 chars", async () => {
    setupAuth();
    mockBatch({ hilo: [makeMessage({ body_text: "x".repeat(2500) })] });

    const response = await GET(buildRequest(), buildContext(CASE_ID));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].body_text).toBe("x".repeat(2000));
  });

  it("AC13: body_text is NOT truncated when under 2000 chars", async () => {
    setupAuth();
    const shortBody = "y".repeat(200);
    mockBatch({ hilo: [makeMessage({ body_text: shortBody })] });

    const response = await GET(buildRequest(), buildContext(CASE_ID));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.messages[0].body_text).toBe(shortBody);
  });

  it("AC14: attachment_count comes from the inbound count", async () => {
    setupAuth();
    mockBatch({ hilo: [makeMessage({ attachment_count: 2 })] });

    const response = await GET(buildRequest(), buildContext(CASE_ID));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.messages[0].attachment_count).toBe(2);
  });

  it("AC14: attachment_count is 0 when no attachments exist", async () => {
    setupAuth();
    mockBatch({ hilo: [makeMessage()] });

    const response = await GET(buildRequest(), buildContext(CASE_ID));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.messages[0].attachment_count).toBe(0);
  });

  it("body_text handles null gracefully — returns null in response", async () => {
    setupAuth();
    mockBatch({ hilo: [makeMessage({ body_text: null })] });

    const response = await GET(buildRequest(), buildContext(CASE_ID));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.messages[0].body_text).toBeNull();
  });

  it("WhatsApp: lo que escribió la persona y lo que le contestó el agente, en orden", async () => {
    setupAuth();
    mockBatch({
      hilo: [
        makeMessage({
          id: "wa-in",
          provider: "whatsapp",
          subject: "WhatsApp",
          from_addr: "5491100000000",
          received_at: "2026-06-01T10:00:00Z",
        }),
      ],
      whatsapps: [
        {
          id: "wa-out",
          channel: "whatsapp",
          rendered_body: "¿Me mandás la foto del registro?",
          status: "sent",
          created_at: "2026-06-01T10:01:00Z",
        },
      ],
    });

    const response = await GET(buildRequest(), buildContext(CASE_ID));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.messages.map((m: { id: string; direction: string }) => [m.id, m.direction])).toEqual([
      ["wa-in", "inbound"],
      ["wa-out", "outbound"],
    ]);
    expect(body.messages[1]).toMatchObject({
      provider: "whatsapp",
      subject: null,
      from_addr: null,
      body_text: "¿Me mandás la foto del registro?",
      estado_envio: "sent",
    });
  });

  describe("lo que le contestó el agente repite los datos de la persona", () => {
    const respuesta = `Ana, registramos tu DNI ${DNI} y la póliza ${POLIZA}.`;

    function mockRespuestas() {
      mockBatch({
        hilo: [
          makeMessage({
            id: "mail-out",
            direction: "outbound",
            subject: `Re: Siniestro póliza ${POLIZA}`,
            from_addr: "siniestros@aseguradora.com",
            body_text: respuesta,
            received_at: "2026-06-01T10:00:00Z",
            status: "sent",
          }),
        ],
        whatsapps: [
          {
            id: "wa-out",
            channel: "whatsapp",
            rendered_body: respuesta,
            status: "sent",
            created_at: "2026-06-01T11:00:00Z",
          },
        ],
      });
    }

    it("un analista lo lee entero", async () => {
      setupAuth("analyst");
      mockRespuestas();

      const body = await (await GET(buildRequest(), buildContext(CASE_ID))).json();

      expect(body.messages[0].body_text).toBe(respuesta);
      expect(body.messages[0].from_addr).toBe("siniestros@aseguradora.com");
      expect(body.messages[1].body_text).toBe(respuesta);
    });

    it("a un viewer se le enmascara también lo saliente", async () => {
      setupAuth("viewer");
      mockRespuestas();

      const body = await (await GET(buildRequest(), buildContext(CASE_ID))).json();

      expect(body.messages).toHaveLength(2);
      for (const m of body.messages) {
        expect(m.direction).toBe("outbound");
        expect(m.body_text).not.toContain(DNI);
        expect(m.body_text).not.toContain(POLIZA);
      }
      expect(body.messages[0].subject).not.toContain(POLIZA);
      expect(body.messages[0].from_addr).toBe(OCULTO);
      // WhatsApp saliente no tiene remitente: queda null, no «[oculto]».
      expect(body.messages[1].from_addr).toBeNull();
    });

    it("a un viewer se le enmascara también el alta simulada, que sale de raw_messages", async () => {
      setupAuth("viewer");
      mockBatch({
        simulados: [
          {
            id: "raw-1",
            provider: "email_sim",
            subject: "[email_sim] Siniestro - custom",
            from_addr: "ana@example.com",
            body_text: `Soy Ana, DNI ${DNI}, póliza ${POLIZA}.`,
            received_at: "2026-06-01T09:00:00Z",
          },
        ],
      });

      const body = await (await GET(buildRequest(), buildContext(CASE_ID))).json();

      expect(body.messages).toHaveLength(1);
      expect(body.messages[0]).toMatchObject({ id: "raw-1", direction: "inbound", from_addr: OCULTO });
      expect(body.messages[0].body_text).not.toContain(DNI);
      expect(body.messages[0].body_text).not.toContain(POLIZA);
    });

    it("se enmascara antes de recortar: un DNI en el borde no deja pedazos", async () => {
      setupAuth("viewer");
      // El DNI arranca en el caracter 1994: recortar primero dejaría «27.654»,
      // que ya no parece un DNI y saldría sin tapar.
      mockBatch({ hilo: [makeMessage({ body_text: `${"a ".repeat(995)}DNI ${DNI} y sigue.` })] });

      const body = await (await GET(buildRequest(), buildContext(CASE_ID))).json();

      expect(body.messages[0].body_text).not.toContain("27.654");
      expect(body.messages[0].body_text.length).toBeLessThanOrEqual(2000);
    });
  });
});
