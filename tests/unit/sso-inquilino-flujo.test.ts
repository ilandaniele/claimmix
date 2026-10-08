// @vitest-environment node
/**
 * El SSO de punta a punta: Better Auth de verdad (sus rutas, sus ganchos, su
 * state en cookie), nuestro plugin, y un IdP de mentira que firma tokens con jose.
 *
 * Lo único sustituido es el almacenamiento —`memoryAdapter` en lugar de Drizzle—
 * y las consultas de inquilino, que se resuelven con mapas en memoria.
 */

import { exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  store: { user: [] as any[], session: [] as any[], account: [] as any[], verification: [] as any[] },
  perfiles: new Map<string, { tenant: string; role: string }>(),
  exigen: new Set<string>(),
  fallaElPerfil: false,
  config: null as null | Record<string, string>,
  audit: vi.fn(),
  log: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("better-auth/adapters/drizzle", async () => {
  const { memoryAdapter } = await import("better-auth/adapters/memory");
  return { drizzleAdapter: () => memoryAdapter(h.store) };
});
vi.mock("@/lib/db", () => ({
  // provision.ts pregunta si el perfil ya existe: en un alta nueva, nunca.
  db: { select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }) },
}));
vi.mock("@/data/scope", () => ({
  enTenant: async (_ctx: unknown, armar: (db: unknown) => unknown) =>
    armar({
      insert: () => ({
        values: async (v: { id: string; tenant_id: string; role: string }) => {
          if (h.fallaElPerfil) throw new Error("connection terminated");
          h.perfiles.set(v.id, { tenant: v.tenant_id, role: v.role });
        },
      }),
    }),
  enTenantVarias: vi.fn(),
}));
vi.mock("@/lib/observability/logger", () => ({
  logger: { debug: h.log, info: h.log, warn: h.log, error: h.log },
}));
vi.mock("@/lib/audit/log", async (original) => ({
  ...(await original<typeof import("@/lib/audit/log")>()),
  writeAuditLog: h.audit,
}));
vi.mock("@/server/sso/usuarios", () => ({
  duenoDelMail: async (email: string, tenantId: string) => {
    const u = h.store.user.find((x) => x.email === email);
    if (!u) return { existe: false };
    const tenant = h.perfiles.get(u.id)?.tenant ?? null;
    // Como la consulta: sin perfil, y con cuentas que son todas la del SSO de este inquilino.
    const cuentas = h.store.account.filter((a) => a.userId === u.id);
    const huerfanaDeSso = tenant === null && cuentas.length > 0 && cuentas.every((a) => a.providerId === `sso:${tenantId}`);
    return { existe: true, userId: u.id, tenantId: tenant, huerfanaDeSso };
  },
  inquilinoDelUsuario: async (id: string) => h.perfiles.get(id)?.tenant ?? null,
  dominioExigeSso: async (id: string) => {
    const u = h.store.user.find((x) => x.id === id);
    return !!u && h.exigen.has(String(u.email).split("@")[1]);
  },
  correoExigeSso: async (email: string, tenantId: string) =>
    tenantId === h.config?.tenant_id && h.exigen.has(email.split("@")[1]!),
  dominioExigeSsoEnAlgunInquilino: async (email: string) => h.exigen.has(email.split("@")[1]!),
}));
vi.mock("@/server/sso/config", async (original) => ({
  ...(await original<typeof import("@/server/sso/config")>()),
  configVigentePorDominio: async (d: string) => (h.config?.dominio === d ? h.config : null),
  configVigenteDelInquilino: async (t: string) => (h.config?.tenant_id === t ? h.config : null),
}));

const pedirFijado = vi.fn();
vi.mock("@/server/red/https-fijado", () => ({ pedirFijado: (...a: unknown[]) => pedirFijado(...a) }));

import { enAlta } from "@/lib/auth/registro-permitido";
import { urlDeVueltaDelSso } from "@/lib/auth/base-url";
import { cifrar } from "@/lib/security/cifrado";
import { olvidarLosIdps } from "@/server/sso/config";

const BASE = "https://claimmix.test";
const ISSUER = "https://idp.empresa.test";
const CLIENT_ID = "claimmix-cliente";
const SECRETO = "s3cr3t0-del-cliente-que-no-debe-salir";
const T1 = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";

let auth: typeof import("@/lib/auth").auth;
let clave: { privateKey: CryptoKey; publicJwk: JWK };

// Lo que dice el IdP de mentira de quien se presenta.
let identidad: Record<string, unknown>;
let nonceActual = "";
let idTokenEmitido = "";

async function emitir() {
  const cuerpo: Record<string, unknown> = { nonce: nonceActual, ...identidad };
  for (const k of Object.keys(cuerpo)) if (cuerpo[k] === undefined) delete cuerpo[k];
  idTokenEmitido = await new SignJWT(cuerpo)
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(ISSUER)
    .setAudience(CLIENT_ID)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(clave.privateKey);
  return idTokenEmitido;
}

function cookiesDe(res: Response): string {
  return res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
}

// `extra` con una clave en `undefined` la saca del cuerpo: así se prueba el ingreso sin `errorCallbackURL`.
async function iniciar(email = "ana@empresa.com", extra: Record<string, unknown> = {}) {
  const res = await auth.handler(
    new Request(`${BASE}/api/auth/sso-inquilino/sign-in`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE },
      body: JSON.stringify({ email, callbackURL: "/bandeja", errorCallbackURL: "/login", ...extra }),
    })
  );
  const cuerpo = (await res.json()) as { url: string | null };
  return { res, cuerpo, cookie: cookiesDe(res) };
}

async function volver(cookie: string, consulta: string) {
  return auth.handler(new Request(`${BASE}/api/auth/sso-inquilino/callback?${consulta}`, { headers: { cookie } }));
}

/** Empieza el ingreso, el IdP responde con `identidad` y vuelve el navegador. */
async function entrar(opciones: { email?: string; consultaExtra?: string; sinErrorCallback?: boolean } = {}) {
  const { cuerpo, cookie } = await iniciar(opciones.email, opciones.sinErrorCallback ? { errorCallbackURL: undefined } : {});
  if (!cuerpo.url) throw new Error("el ingreso no arrancó");
  const destino = new URL(cuerpo.url);
  nonceActual = destino.searchParams.get("nonce") ?? "";
  const state = destino.searchParams.get("state") ?? "";
  const res = await volver(cookie, `code=codigo-1&state=${encodeURIComponent(state)}${opciones.consultaExtra ?? ""}`);
  return { res, destino, cookie, state, location: res.headers.get("location") };
}

function sembrarUsuario(id: string, email: string, tenant: string | null, extra: Record<string, unknown> = {}) {
  h.store.user.push({
    id, email, name: email, emailVerified: true, image: null, createdAt: new Date(), updatedAt: new Date(), ...extra,
  });
  if (tenant) h.perfiles.set(id, { tenant, role: "analyst" });
}

beforeAll(async () => {
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", BASE);
  vi.stubEnv("GMAIL_TOKEN_ENCRYPTION_KEY", "test-sso-encryption-key-0123456789");
  const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
  clave = { privateKey, publicJwk: { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256", use: "sig" } };
  ({ auth } = await import("@/lib/auth"));
});

beforeEach(() => {
  olvidarLosIdps();
  h.store.user.length = 0;
  h.store.session.length = 0;
  h.store.account.length = 0;
  h.store.verification.length = 0;
  h.perfiles.clear();
  h.exigen.clear();
  h.fallaElPerfil = false;
  h.audit.mockReset();
  h.log.mockReset();
  h.config = {
    tenant_id: T1,
    issuer: ISSUER,
    client_id: CLIENT_ID,
    client_secret_cifrado: cifrar(SECRETO),
    dominio: "empresa.com",
  };
  identidad = { sub: "sub-ana", email: "ana@empresa.com", email_verified: true, name: "Ana Pérez" };

  pedirFijado.mockReset();
  pedirFijado.mockImplementation(async (p: { url: string }) => {
    const { pathname } = new URL(p.url);
    if (pathname === "/.well-known/openid-configuration") {
      return {
        ok: true, estado: 200,
        cuerpo: JSON.stringify({
          issuer: ISSUER,
          authorization_endpoint: `${ISSUER}/authorize`,
          token_endpoint: `${ISSUER}/token`,
          jwks_uri: `${ISSUER}/jwks`,
        }),
      };
    }
    if (pathname === "/jwks") return { ok: true, estado: 200, cuerpo: JSON.stringify({ keys: [clave.publicJwk] }) };
    if (pathname === "/token") return { ok: true, estado: 200, cuerpo: JSON.stringify({ id_token: await emitir() }) };
    return { ok: false, motivo: "http_404" };
  });
});

describe("arranque del ingreso", () => {
  it("devuelve la URL del IdP del dominio, con la vuelta que registra el admin", async () => {
    const { cuerpo, cookie } = await iniciar("Ana@Empresa.com");
    const url = new URL(cuerpo.url!);
    expect(url.origin + url.pathname).toBe(`${ISSUER}/authorize`);
    expect(url.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("redirect_uri")).toBe(urlDeVueltaDelSso());
    expect(url.searchParams.get("redirect_uri")).toBe(`${BASE}/api/auth/sso-inquilino/callback`);
    expect(cookie).not.toBe("");
  });

  it("un dominio sin SSO, un mail roto y un IdP caído contestan lo mismo", async () => {
    const sinSso = await iniciar("ana@otra.com");
    const roto = await iniciar("no-es-un-mail");
    pedirFijado.mockResolvedValue({ ok: false, motivo: "timeout" });
    const caido = await iniciar("ana@empresa.com");

    for (const r of [sinSso, roto, caido]) {
      expect(r.res.status).toBe(200);
      expect(r.cuerpo).toEqual({ url: null });
    }
  });
});

describe("la vuelta del IdP", () => {
  it("una persona nueva del dominio entra como viewer en el inquilino del state", async () => {
    const { location, res } = await entrar();

    expect(res.status).toBe(302);
    expect(location).toBe("/bandeja");
    expect(res.headers.getSetCookie().join(";")).toContain("session_token=");

    const usuario = h.store.user.find((u) => u.email === "ana@empresa.com");
    expect(usuario).toBeTruthy();
    expect(h.perfiles.get(usuario.id)).toEqual({ tenant: T1, role: "viewer" });
    expect(h.store.session).toHaveLength(1);

    const cuenta = h.store.account.find((a) => a.userId === usuario.id);
    expect(cuenta).toMatchObject({ providerId: `sso:${T1}`, accountId: "sub-ana" });
    expect(cuenta.accessToken ?? null).toBeNull();
    expect(cuenta.idToken ?? null).toBeNull();
    expect(cuenta.refreshToken ?? null).toBeNull();

    expect(h.audit).toHaveBeenCalledWith(
      expect.objectContaining({ tenant_id: T1, event_type: "sso.ingreso_jit", actor_id: usuario.id })
    );
  });

  it("nunca entra como admin, aunque ADMIN_EMAILS tenga a otros", async () => {
    vi.stubEnv("ADMIN_EMAILS", "jefe@veltra.com");
    try {
      await entrar();
      const usuario = h.store.user.find((u) => u.email === "ana@empresa.com");
      expect(h.perfiles.get(usuario.id)?.role).toBe("viewer");
    } finally {
      vi.unstubAllEnvs();
      vi.stubEnv("NEXT_PUBLIC_SITE_URL", BASE);
      vi.stubEnv("GMAIL_TOKEN_ENCRYPTION_KEY", "test-sso-encryption-key-0123456789");
    }
  });

  it("una dirección de operador no queda como miembro de la aseguradora", async () => {
    vi.stubEnv("ADMIN_EMAILS", "ana@empresa.com");
    try {
      await entrar();
      const usuario = h.store.user.find((u) => u.email === "ana@empresa.com");
      expect(h.perfiles.has(usuario.id)).toBe(false);
    } finally {
      vi.unstubAllEnvs();
      vi.stubEnv("NEXT_PUBLIC_SITE_URL", BASE);
      vi.stubEnv("GMAIL_TOKEN_ENCRYPTION_KEY", "test-sso-encryption-key-0123456789");
    }
  });

  it("una persona del mismo inquilino conserva su rol y suma la cuenta del SSO", async () => {
    sembrarUsuario("u-1", "ana@empresa.com", T1);
    const { location } = await entrar();

    expect(location).toBe("/bandeja");
    expect(h.perfiles.get("u-1")).toEqual({ tenant: T1, role: "analyst" });
    expect(h.store.account.filter((a) => a.userId === "u-1")).toEqual([
      expect.objectContaining({ providerId: `sso:${T1}`, accountId: "sub-ana" }),
    ]);
    expect(h.store.user).toHaveLength(1);
    expect(h.audit).not.toHaveBeenCalledWith(expect.objectContaining({ event_type: "sso.ingreso_jit" }));
  });

  it("con «Exigir SSO» prendido, el ingreso por SSO sigue abierto", async () => {
    sembrarUsuario("u-1", "ana@empresa.com", T1);
    h.exigen.add("empresa.com");
    expect((await entrar()).location).toBe("/bandeja");
  });

  it("los usuarios que el inquilino ya tenía entran por SSO aunque su mail local nunca se verificó, y después sólo por SSO", async () => {
    // Regresión: el SSO no vinculaba a nadie que existiera de antes, y «Exigir» les
    // cerraba la contraseña: el admin se quedaba afuera de su propia organización.
    // Las cuentas locales nacen con `emailVerified: false`.
    sembrarUsuario("u-admin", "ana@empresa.com", T1, { emailVerified: false });
    h.perfiles.set("u-admin", { tenant: T1, role: "admin" });
    sembrarUsuario("u-2", "luis@empresa.com", T1, { emailVerified: false });
    h.exigen.add("empresa.com");

    const { location, res } = await entrar();

    expect(location).toBe("/bandeja");
    expect(res.headers.getSetCookie().join(";")).toContain("session_token=");
    expect(h.perfiles.get("u-admin")).toEqual({ tenant: T1, role: "admin" });
    expect(h.store.user).toHaveLength(2);
    expect(h.store.account.filter((a) => a.userId === "u-admin")).toEqual([
      expect.objectContaining({ providerId: `sso:${T1}`, accountId: "sub-ana" }),
    ]);
    expect(h.audit).not.toHaveBeenCalledWith(expect.objectContaining({ event_type: "sso.ingreso_jit" }));

    identidad = { sub: "sub-luis", email: "luis@empresa.com", email_verified: true, name: "Luis" };
    expect((await entrar({ email: "luis@empresa.com" })).location).toBe("/bandeja");
  });

  it("una rechazada sin `errorCallbackURL` en el arranque igual vuelve a /login con su código", async () => {
    // El callback leía `errorURL ?? "/login"` sobre un valor que Better Auth ya rellena
    // con su página de error genérica, así que el «?? /login» no se alcanzaba nunca.
    sembrarUsuario("u-b", "ana@empresa.com", T2);
    const { location } = await entrar({ sinErrorCallback: true });

    expect(location).toBe("/login?error=sso_otro_inquilino");
  });

  it("una cuenta de otro inquilino no se crea, no se vincula y no abre sesión", async () => {
    sembrarUsuario("u-b", "ana@empresa.com", T2);
    const { location, res } = await entrar();

    expect(location).toBe("/login?error=sso_otro_inquilino");
    expect(res.headers.getSetCookie().join(";")).not.toContain("session_token=");
    expect(h.store.account).toHaveLength(0);
    expect(h.store.session).toHaveLength(0);
    expect(h.perfiles.get("u-b")).toEqual({ tenant: T2, role: "analyst" });
    expect(h.audit).toHaveBeenCalledWith(
      expect.objectContaining({ tenant_id: T1, event_type: "sso.rechazado", payload: { motivo: "sso_otro_inquilino" } })
    );
  });

  it("una cuenta sin perfil no se toca", async () => {
    sembrarUsuario("u-x", "ana@empresa.com", null);
    const { location } = await entrar();
    expect(location).toBe("/login?error=sso_fallo");
    expect(h.store.account).toHaveLength(0);
    expect(h.store.session).toHaveLength(0);
  });

  it("una cuenta sin perfil con contraseña tampoco se recupera, aunque el IdP diga el mismo mail", async () => {
    // Quien se registró antes con el mail de otro no recibe un perfil por el SSO de la empresa.
    sembrarUsuario("u-x", "ana@empresa.com", null);
    h.store.account.push({
      id: "a-pw", userId: "u-x", providerId: "credential", accountId: "u-x", password: "x", createdAt: new Date(), updatedAt: new Date(),
    });
    const { location, res } = await entrar();

    expect(location).toBe("/login?error=sso_fallo");
    expect(res.headers.getSetCookie().join(";")).not.toContain("session_token=");
    expect(h.perfiles.has("u-x")).toBe(false);
    expect(h.store.account).toHaveLength(1);
  });

  it("si el perfil falla en el primer ingreso, el reintento lo crea en vez de quedar en «sin perfil»", async () => {
    // Regresión: usuario y cuenta del SSO quedaban escritos y el perfil no; el reintento
    // encontraba un mail sin inquilino, lo rechazaba y nada volvía a crear el perfil.
    h.fallaElPerfil = true;
    const primero = await entrar();

    expect(primero.location).toBe("/login?error=sso_fallo");
    expect(primero.res.headers.getSetCookie().join(";")).not.toContain("session_token=");
    const usuario = h.store.user.find((u) => u.email === "ana@empresa.com");
    expect(usuario).toBeTruthy();
    expect(h.store.account.filter((a) => a.userId === usuario.id).map((a) => a.providerId)).toEqual([`sso:${T1}`]);
    expect(h.perfiles.has(usuario.id)).toBe(false);
    expect(h.store.session).toHaveLength(0);

    h.fallaElPerfil = false;
    h.audit.mockReset();
    const segundo = await entrar();

    expect(segundo.location).toBe("/bandeja");
    expect(segundo.res.headers.getSetCookie().join(";")).toContain("session_token=");
    expect(h.perfiles.get(usuario.id)).toEqual({ tenant: T1, role: "viewer" });
    expect(h.store.user.filter((u) => u.email === "ana@empresa.com")).toHaveLength(1);
    expect(h.store.account.filter((a) => a.userId === usuario.id)).toHaveLength(1);
    expect(h.store.session).toHaveLength(1);
    expect(h.audit).toHaveBeenCalledWith(
      expect.objectContaining({ tenant_id: T1, event_type: "sso.ingreso_jit", actor_id: usuario.id })
    );
  });

  it("una vez recuperada, el ingreso siguiente es uno común y no vuelve a anotar un alta", async () => {
    h.fallaElPerfil = true;
    await entrar();
    h.fallaElPerfil = false;
    await entrar();
    h.audit.mockReset();

    const { location } = await entrar();

    expect(location).toBe("/bandeja");
    expect(h.audit).not.toHaveBeenCalledWith(expect.objectContaining({ event_type: "sso.ingreso_jit" }));
  });

  it("la cuenta que ya está vinculada por su sub no puede ser de otro inquilino", async () => {
    // El mail del token no existe: el pedido por mail no ve nada. Lo para el gancho de sesión.
    sembrarUsuario("u-b", "otro@empresa.com", T2);
    h.store.account.push({
      id: "a-1", userId: "u-b", providerId: `sso:${T1}`, accountId: "sub-ana", createdAt: new Date(), updatedAt: new Date(),
    });
    const { location, res } = await entrar();

    expect(location).toBe("/login?error=sso_otro_inquilino");
    expect(res.headers.getSetCookie().join(";")).not.toContain("session_token=");
    expect(h.store.session).toHaveLength(0);
  });

  it("una persona del mismo inquilino con el mail sin verificar localmente se vincula por su id: el IdP verificó el mail", async () => {
    sembrarUsuario("u-1", "ana@empresa.com", T1, { emailVerified: false });
    const { location } = await entrar();

    expect(location).toBe("/bandeja");
    expect(h.store.user).toHaveLength(1);
    expect(h.store.account).toEqual([
      expect.objectContaining({ userId: "u-1", providerId: `sso:${T1}`, accountId: "sub-ana" }),
    ]);
    expect(h.store.session).toHaveLength(1);
  });

  it("el inquilino sale del state: un parámetro `tenant` en la consulta no cambia nada", async () => {
    await entrar({ consultaExtra: `&tenant=${T2}&tenantId=${T2}` });
    const usuario = h.store.user.find((u) => u.email === "ana@empresa.com");
    expect(h.perfiles.get(usuario.id)?.tenant).toBe(T1);
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({ tenant_id: T1 }));
    expect(h.audit).not.toHaveBeenCalledWith(expect.objectContaining({ tenant_id: T2 }));
  });

  it("un mail de otro dominio se rechaza y se anota sólo el motivo", async () => {
    identidad = { ...identidad, email: "ana@otra.com" };
    const { location } = await entrar();

    expect(location).toBe("/login?error=sso_fallo");
    expect(h.store.user).toHaveLength(0);
    expect(h.audit).toHaveBeenCalledWith({
      tenant_id: T1, event_type: "sso.rechazado", payload: { motivo: "dominio_ajeno" },
    });
  });

  it("un mail sin verificar por el IdP no crea a nadie", async () => {
    identidad = { ...identidad, email_verified: false };
    expect((await entrar()).location).toBe("/login?error=sso_fallo");
    expect(h.store.user).toHaveLength(0);
  });

  it("el IdP que devuelve un error, o ningún código, vuelve a /login sin tocar nada", async () => {
    const { cookie, cuerpo } = await iniciar();
    const state = encodeURIComponent(new URL(cuerpo.url!).searchParams.get("state")!);

    const conError = await volver(cookie, `error=access_denied&state=${state}`);
    expect(conError.headers.get("location")).toBe("/login?error=sso_fallo");

    const sinCodigo = await volver(cookie, `state=${state}`);
    expect(sinCodigo.headers.get("location")).toBe("/login?error=sso_fallo");

    expect(h.store.user).toHaveLength(0);
    // Sin un token que lo pruebe, no es un motivo para el registro del inquilino.
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("un SSO apagado entre el arranque y la vuelta no deja entrar", async () => {
    const { cookie, cuerpo } = await iniciar();
    const destino = new URL(cuerpo.url!);
    nonceActual = destino.searchParams.get("nonce")!;
    h.config = null;
    const res = await volver(cookie, `code=c&state=${encodeURIComponent(destino.searchParams.get("state")!)}`);
    expect(res.headers.get("location")).toBe("/login?error=sso_fallo");
    expect(h.store.user).toHaveLength(0);
  });

  it("un nonce que no es el de este navegador no deja entrar", async () => {
    const { cookie, cuerpo } = await iniciar();
    const destino = new URL(cuerpo.url!);
    nonceActual = "otro-nonce";
    const res = await volver(cookie, `code=c&state=${encodeURIComponent(destino.searchParams.get("state")!)}`);
    expect(res.headers.get("location")).toBe("/login?error=sso_fallo");
    expect(h.store.user).toHaveLength(0);
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({ payload: { motivo: "nonce" } }));
  });
});

describe("un state que no es el nuestro", () => {
  it("sin state, con un state inventado o sin la cookie del navegador: a /login, sin tocar nada", async () => {
    const { cookie, cuerpo } = await iniciar();
    const state = encodeURIComponent(new URL(cuerpo.url!).searchParams.get("state")!);

    const sinState = await volver(cookie, "code=c");
    const inventado = await volver(cookie, "code=c&state=inventado");
    const sinCookie = await volver("", `code=c&state=${state}`);

    for (const r of [sinState, inventado, sinCookie]) {
      expect(r.status).toBe(302);
      expect(r.headers.get("location")).toMatch(/error=/);
      expect(r.headers.get("location")).not.toContain("tenant");
      expect(r.headers.getSetCookie().join(";")).not.toContain("session_token=");
    }
    expect(h.store.user).toHaveLength(0);
    expect(h.store.session).toHaveLength(0);
    expect(pedirFijado.mock.calls.some(([p]) => String((p as { url: string }).url).endsWith("/token"))).toBe(false);
  });

  it("un state cuyo inquilino no tiene forma de uuid se rechaza", async () => {
    h.config = { ...h.config!, tenant_id: "no-es-un-uuid" };
    const { res } = await entrar();
    expect(res.headers.get("location")).toBe("/login?error=sso_fallo");
    expect(h.store.user).toHaveLength(0);
    expect(pedirFijado.mock.calls.some(([p]) => String((p as { url: string }).url).endsWith("/token"))).toBe(false);
  });

  it("el state se usa una sola vez por cookie: sin la cookie original, el mismo state no sirve", async () => {
    const primero = await entrar();
    expect(primero.location).toBe("/bandeja");
    const repetido = await volver("", `code=codigo-1&state=${encodeURIComponent(primero.state)}`);
    expect(repetido.headers.get("location")).toMatch(/error=/);
  });
});

describe("lo que nunca se escribe", () => {
  it("ni el secreto del cliente, ni el código, ni el token van a un log, a la auditoría o a la respuesta", async () => {
    await entrar();
    identidad = { ...identidad, email: "ana@otra.com" };
    const malo = await entrar();

    const rastro = JSON.stringify([h.log.mock.calls, h.audit.mock.calls, malo.location]);
    expect(rastro).not.toContain(SECRETO);
    expect(rastro).not.toContain("codigo-1");
    expect(rastro).not.toContain(idTokenEmitido);
    expect(rastro).not.toContain("ana@");
  });
});

describe("«Exigir SSO» en el gancho de sesión", () => {
  const CLAVE = "fake-clave-larga-y-unica-123";

  async function registrarPorClave(email: string) {
    await enAlta("invitacion", () => auth.api.signUpEmail({ body: { email, password: CLAVE, name: "Pepe" } }));
  }

  it("una persona del dominio que entra con contraseña no recibe sesión, y el error lo dice", async () => {
    await registrarPorClave("pepe@empresa.com");
    h.exigen.add("empresa.com");
    const antes = h.store.session.length;

    const error = await auth.api.signInEmail({ body: { email: "pepe@empresa.com", password: CLAVE } }).catch((e) => e);

    expect(error.body?.code).toBe("sso_requerido");
    expect(h.store.session).toHaveLength(antes);
  });

  it("la invitación a alguien del dominio con «Exigir» prendido no deja una cuenta a medias", async () => {
    // La cuenta nace sin sesión, así que el gancho de sesión no corta el alta; entrar sigue pidiendo el SSO.
    h.exigen.add("empresa.com");

    await expect(registrarPorClave("nuevo@empresa.com")).resolves.toBeUndefined();

    const usuario = h.store.user.find((u) => u.email === "nuevo@empresa.com");
    expect(usuario).toBeTruthy();
    expect(h.store.account.filter((a) => a.userId === usuario.id)).toHaveLength(1);
    // La invitación no da acceso por contraseña: entrar sigue pidiendo el SSO.
    const error = await auth.api.signInEmail({ body: { email: "nuevo@empresa.com", password: CLAVE } }).catch((e) => e);
    expect(error.body?.code).toBe("sso_requerido");
  });

  it("el registro por correo de alguien del dominio no crea nada: la cuenta no podría abrir sesión", async () => {
    const registrar = () =>
      enAlta("correo", () => auth.api.signUpEmail({ body: { email: "pepe@empresa.com", password: CLAVE, name: "Pepe" } }));
    h.exigen.add("empresa.com");

    const error = await registrar().catch((e) => e);

    expect(error.body?.code).toBe("sso_requerido");
    expect(h.store.user).toHaveLength(0);
    expect(h.store.account).toHaveLength(0);

    h.exigen.clear();
    await registrar();
    expect(h.store.user).toHaveLength(1);
  });

  it("el «exigir» de cualquier inquilino frena el alta por correo: la cuenta nueva no cae en ninguno", async () => {
    // Antes se comparaba con el inquilino donde aterrizaba la cuenta. Ahora no hay uno.
    vi.stubEnv("DEFAULT_TENANT_ID", T2);
    try {
      h.exigen.add("empresa.com");

      const error = await enAlta("correo", () =>
        auth.api.signUpEmail({ body: { email: "pepe@empresa.com", password: CLAVE, name: "Pepe" } })
      ).catch((e) => e);

      expect(error.body?.code).toBe("sso_requerido");
      expect(h.store.user).toHaveLength(0);
    } finally {
      vi.unstubAllEnvs();
      vi.stubEnv("NEXT_PUBLIC_SITE_URL", BASE);
      vi.stubEnv("GMAIL_TOKEN_ENCRYPTION_KEY", "test-sso-encryption-key-0123456789");
    }
  });

  it("quien entró por SSO y cambia su contraseña conserva su sesión, aunque el dominio exija SSO", async () => {
    // `changePassword` con `revokeOtherSessions` borra las sesiones y crea una nueva, y el
    // gancho la negaba: la persona quedaba afuera y con un error, después de cambiar la clave.
    await registrarPorClave("pepe@empresa.com");
    // El perfil lo pone `aceptarInvitacion` después del alta; acá se simula.
    h.perfiles.set(h.store.user[0].id, { tenant: T1, role: "analyst" });
    h.exigen.add("empresa.com");
    identidad = { sub: "sub-pepe", email: "pepe@empresa.com", email_verified: true, name: "Pepe" };
    const { res, location } = await entrar({ email: "pepe@empresa.com" });
    expect(location).toBe("/bandeja");

    const cambio = await auth.api
      .changePassword({
        body: { currentPassword: CLAVE, newPassword: "fake-otra-clave-larga-456", revokeOtherSessions: true },
        headers: new Headers({ cookie: cookiesDe(res) }),
      })
      .catch((e) => e);

    expect(cambio.body?.code).not.toBe("sso_requerido");
    expect(cambio.token).toEqual(expect.any(String));
    expect(h.store.session).toHaveLength(1);

    // Y cambiar la clave no reabre el ingreso por contraseña.
    const error = await auth.api
      .signInEmail({ body: { email: "pepe@empresa.com", password: "fake-otra-clave-larga-456" } })
      .catch((e) => e);
    expect(error.body?.code).toBe("sso_requerido");
  });

  it("otro dominio, o el mismo sin exigir, entra como siempre", async () => {
    await registrarPorClave("pepe@empresa.com");
    await registrarPorClave("lola@otra.com");
    h.exigen.add("empresa.com");

    expect((await auth.api.signInEmail({ body: { email: "lola@otra.com", password: CLAVE } })).user.email).toBe("lola@otra.com");

    h.exigen.clear();
    expect((await auth.api.signInEmail({ body: { email: "pepe@empresa.com", password: CLAVE } })).user.email).toBe("pepe@empresa.com");
  });
});
