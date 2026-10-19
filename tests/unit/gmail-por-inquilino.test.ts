/**
 * Correo por inquilino: al conectar, la URL de Google lleva el correo de la
 * sesión como `login_hint` y pide sólo `gmail.modify` y `gmail.send`; mientras la
 * base del espacio se arma no se conecta nada, y el poller no lee la casilla de
 * un inquilino sin servicio.
 *
 * La base de `listEnabledGmailAccounts` es un drizzle sobre un proxy que anota el
 * SQL y devuelve las filas armadas a mano: así se ve el join de verdad, en la
 * misma consulta, y no un encadenado simulado.
 */

import { drizzle } from "drizzle-orm/pg-proxy";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  consultas: [] as string[],
  filas: [] as unknown[][],
  falla: null as Error | null,
  requireRole: vi.fn(),
  baseLista: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth/require-role", () => ({
  requireRole: h.requireRole,
  ADMIN_ROLES: ["owner", "admin"],
}));
vi.mock("@/lib/db", () => ({
  db: drizzle(async (sql) => {
    h.consultas.push(sql);
    if (h.falla) throw h.falla;
    return { rows: h.filas };
  }),
}));
vi.mock("@/data/scope", () => ({ enControl: vi.fn() }));
vi.mock("@/server/bases/base-lista", () => ({ baseLista: h.baseLista }));
vi.mock("@/lib/security/cifrado", () => ({
  cifrar: (valor: string) => `cifrado:${valor}`,
  descifrar: (sobre: string) => sobre.replace(/^cifrado:/, ""),
}));
vi.mock("@/lib/observability/logger", () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

import { COOKIE_ESTADO_OAUTH } from "@/lib/auth/oauth-state";
import { urlDeVueltaDeGmail } from "@/lib/auth/base-url";
import { GET } from "@/app/api/admin/gmail-accounts/connect/route";
import { listEnabledGmailAccounts } from "@/server/email/gmail/accounts";

const TENANT = "10000000-0000-0000-0000-000000000001";

beforeEach(() => {
  vi.clearAllMocks();
  h.consultas.length = 0;
  h.filas = [];
  h.falla = null;
  h.baseLista.mockResolvedValue(true);
  vi.stubEnv("GMAIL_CLIENT_ID", "fake-client-id");
  vi.stubEnv("GMAIL_CLIENT_SECRET", "fake-client-secret");
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://app.example.com");
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://otro-ambiente.example.com");
});

describe("conectar Gmail: login_hint", () => {
  function sesion(email?: string) {
    h.requireRole.mockResolvedValue({
      user: { id: "u-1", email },
      userRow: { id: "u-1", tenant_id: TENANT, role: "admin" },
    });
  }

  it("la URL de Google lleva el correo de la sesión", async () => {
    sesion("ana@example.com");

    const res = await GET();

    const url = new URL(res.headers.get("location") ?? "");
    expect(url.origin).toBe("https://accounts.google.com");
    expect(url.searchParams.get("login_hint")).toBe("ana@example.com");
  });

  it("sigue pidiendo lo de siempre: acceso offline, consentimiento y el state con su cookie", async () => {
    sesion("ana@example.com");

    const res = await GET();

    const url = new URL(res.headers.get("location") ?? "");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent select_account");
    expect(url.searchParams.get("state")).toBeTruthy();
    expect(res.cookies.get(COOKIE_ESTADO_OAUTH)?.value).toBeTruthy();
  });

  it("sin correo en la sesión no manda un login_hint vacío", async () => {
    sesion(undefined);

    const res = await GET();

    const url = new URL(res.headers.get("location") ?? "");
    expect(url.searchParams.has("login_hint")).toBe(false);
  });

  it("sin sesión vuelve al login y no arma ninguna URL de Google", async () => {
    h.requireRole.mockRejectedValue(new Error("MISSING_SESSION"));

    const res = await GET();

    expect(new URL(res.headers.get("location") ?? "").pathname).toBe("/login");
    expect(h.baseLista).not.toHaveBeenCalled();
  });
});

describe("conectar Gmail: lo que se le pide a Google", () => {
  beforeEach(() => {
    h.requireRole.mockResolvedValue({
      user: { id: "u-1", email: "ana@example.com" },
      userRow: { id: "u-1", tenant_id: TENANT, role: "admin" },
    });
  });

  it("sólo gmail.modify y gmail.send: sin el permiso de sólo lectura, que modify ya cubre", async () => {
    const res = await GET();

    const permisos = (new URL(res.headers.get("location") ?? "").searchParams.get("scope") ?? "").split(" ").sort();
    expect(permisos).toEqual([
      "https://www.googleapis.com/auth/gmail.modify",
      "https://www.googleapis.com/auth/gmail.send",
    ]);
    expect(permisos.join(" ")).not.toContain("readonly");
  });

  it("vuelve al origen del sitio, no al de NEXT_PUBLIC_APP_URL: el mismo redirect_uri que arma el callback", async () => {
    const res = await GET();

    const vuelta = new URL(res.headers.get("location") ?? "").searchParams.get("redirect_uri");
    expect(vuelta).toBe("https://app.example.com/api/admin/gmail-accounts/callback");
    expect(vuelta).toBe(urlDeVueltaDeGmail());
  });
});

describe("conectar Gmail: mientras la base del espacio se arma", () => {
  function sesion() {
    h.requireRole.mockResolvedValue({
      user: { id: "u-1", email: "ana@example.com" },
      userRow: { id: "u-1", tenant_id: TENANT, role: "admin" },
    });
  }

  it("con la base lista sigue a Google como siempre", async () => {
    sesion();

    const res = await GET();

    expect(h.baseLista).toHaveBeenCalledWith("u-1");
    expect(new URL(res.headers.get("location") ?? "").origin).toBe("https://accounts.google.com");
  });

  it("con la base todavía en marcha vuelve a /preparando, sin URL de Google ni cookie de estado", async () => {
    sesion();
    h.baseLista.mockResolvedValue(false);

    const res = await GET();

    expect(res.headers.get("location")).toBe("https://app.example.com/preparando");
    expect(res.cookies.get(COOKIE_ESTADO_OAUTH)).toBeUndefined();
  });

  it("lo mira con el usuario de la sesión, nunca con algo del pedido", async () => {
    sesion();

    await GET();

    expect(h.baseLista).toHaveBeenCalledTimes(1);
    expect(h.baseLista.mock.calls[0]).toEqual(["u-1"]);
  });

  it("antes de eso pide el rol: sin rol no se llega a mirar la base", async () => {
    h.requireRole.mockRejectedValue(new Error("FORBIDDEN_ROLE"));

    await GET();

    expect(h.baseLista).not.toHaveBeenCalled();
  });

  it("si no se puede saber, no deja conectar: vuelve al login como cualquier otra falla", async () => {
    sesion();
    h.baseLista.mockRejectedValue(new Error("la base no contesta"));

    const res = await GET();

    expect(new URL(res.headers.get("location") ?? "").pathname).toBe("/login");
    expect(res.cookies.get(COOKIE_ESTADO_OAUTH)).toBeUndefined();
  });
});

describe("listEnabledGmailAccounts: inquilinos sin servicio", () => {
  // [id, tenant_id, email, refresh_token_encrypted, enabled, billing_status]
  const fila = (id: string, billing: string) => [id, TENANT, `${id}@example.com`, `cifrado:fake-token-${id}`, true, billing];

  it("las junta con su inquilino en la misma consulta", async () => {
    h.filas = [fila("a", "active")];

    await listEnabledGmailAccounts();

    expect(h.consultas).toHaveLength(1);
    expect(h.consultas[0]).toContain('inner join "tenants" on "tenants"."id" = "gmail_accounts"."tenant_id"');
    expect(h.consultas[0]).toContain('"tenants"."billing_status"');
  });

  it.each(["trial", "active"])("una casilla de un inquilino en %s se lee", async (estado) => {
    h.filas = [fila("a", estado)];

    const casillas = await listEnabledGmailAccounts();

    expect(casillas).toEqual([
      { id: "a", tenantId: TENANT, email: "a@example.com", refreshToken: "fake-token-a", enabled: true },
    ]);
  });

  it.each(["suspended", "churned"])("una casilla de un inquilino %s queda fuera", async (estado) => {
    h.filas = [fila("a", estado)];

    await expect(listEnabledGmailAccounts()).resolves.toEqual([]);
  });

  it("deja fuera sólo al suspendido: las demás casillas siguen, en el mismo orden", async () => {
    h.filas = [fila("a", "active"), fila("b", "suspended"), fila("c", "trial"), fila("d", "churned")];

    const casillas = await listEnabledGmailAccounts();

    expect(casillas.map((c) => c.id)).toEqual(["a", "c"]);
  });

  it("si la base falla devuelve vacío, como antes", async () => {
    h.falla = Object.assign(new Error("relation does not exist"), { code: "42P01" });

    await expect(listEnabledGmailAccounts()).resolves.toEqual([]);
  });
});
