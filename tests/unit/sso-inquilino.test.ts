// @vitest-environment node
/**
 * El lado del IdP del SSO, contra un IdP de mentira: un par de claves de verdad,
 * tokens firmados con jose y `pedirFijado` respondiendo el documento de
 * configuración, las claves y el token endpoint. No sale ni un pedido a la red.
 */

import { createHash } from "node:crypto";

import { exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ db: {} }));

const enControl = vi.fn();
vi.mock("@/data/scope", () => ({ enControl: (...a: unknown[]) => enControl(...a), enTenantVarias: vi.fn() }));

const pedirFijado = vi.fn();
vi.mock("@/server/red/https-fijado", () => ({ pedirFijado: (...a: unknown[]) => pedirFijado(...a) }));

import { identificarConElIdp, urlDeAutorizacion, ALGORITMOS_ADMITIDOS } from "@/server/sso/callback";
import {
  clavesDe,
  configVigenteDelInquilino,
  descubrir,
  olvidarLosIdps,
  type ConfigSso,
} from "@/server/sso/config";
import { cifrar } from "@/lib/security/cifrado";

const ISSUER = "https://idp.empresa.test";
const CLIENT_ID = "claimmix-cliente";
const SECRETO = "s3cr3t0-del-cliente-que-no-debe-salir";
const TENANT = "11111111-1111-4111-8111-111111111111";
const NONCE = "nonce-de-este-navegador";
const VERIFICADOR = "verificador-pkce-de-este-navegador";
const REDIRECT = "https://claimmix.test/api/auth/sso-inquilino/callback";

type Par = { privateKey: CryptoKey; publicJwk: JWK };

async function par(kid: string, alg = "RS256"): Promise<Par> {
  const { publicKey, privateKey } = await generateKeyPair(alg, { extractable: true });
  const publicJwk = { ...(await exportJWK(publicKey)), kid, alg, use: "sig" };
  return { privateKey, publicJwk };
}

let clave: Par;
let ajena: Par;

// Lo que el IdP de mentira sirve en este momento.
let documento: Record<string, unknown>;
let jwks: { keys: JWK[] };
let tokenQueDa: string | null;
let cuerpoDelToken: string | null;
const pedidos: { url: string; metodo?: string; cuerpo?: string; encabezados?: Record<string, string> }[] = [];

type Opciones = {
  reclamos?: Record<string, unknown>;
  con?: Par;
  kid?: string;
  alg?: string;
  iat?: number;
  exp?: number;
};

const ahora = () => Math.floor(Date.now() / 1000);

async function firmar({ reclamos = {}, con = clave, kid, alg = "RS256", iat = ahora(), exp = ahora() + 300 }: Opciones = {}) {
  const cuerpo: Record<string, unknown> = {
    sub: "sub-ana",
    email: "ana@empresa.com",
    email_verified: true,
    name: "Ana Pérez",
    nonce: NONCE,
    ...reclamos,
  };
  for (const k of Object.keys(cuerpo)) if (cuerpo[k] === undefined) delete cuerpo[k];
  return new SignJWT(cuerpo)
    .setProtectedHeader({ alg, kid: kid ?? con.publicJwk.kid })
    .setIssuer(ISSUER)
    .setAudience(CLIENT_ID)
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .sign(con.privateKey);
}

/** Igual que `firmar`, pero con `iss` o `aud` a elección. */
async function firmarCon(cambios: { iss?: string; aud?: string | string[]; azp?: string }) {
  return new SignJWT({ sub: "sub-ana", email: "ana@empresa.com", email_verified: true, nonce: NONCE, azp: cambios.azp })
    .setProtectedHeader({ alg: "RS256", kid: clave.publicJwk.kid })
    .setIssuer(cambios.iss ?? ISSUER)
    .setAudience(cambios.aud ?? CLIENT_ID)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(clave.privateKey);
}

function config(cambios: Partial<ConfigSso> = {}): ConfigSso {
  return {
    tenant_id: TENANT,
    issuer: ISSUER,
    client_id: CLIENT_ID,
    client_secret_cifrado: cifrar(SECRETO),
    dominio: "empresa.com",
    ...cambios,
  };
}

async function identificar(token: string, cambios: Partial<ConfigSso> = {}) {
  tokenQueDa = token;
  const cfg = config(cambios);
  const d = await descubrir(cfg.issuer);
  if (!d.ok) throw new Error(`descubrimiento: ${d.motivo}`);
  return identificarConElIdp({
    config: cfg,
    descubierto: d.datos,
    code: "codigo-de-un-solo-uso",
    codeVerifier: VERIFICADOR,
    redirectUri: REDIRECT,
    nonce: NONCE,
  });
}

beforeAll(async () => {
  clave = await par("k1");
  ajena = await par("k1");
});

beforeEach(() => {
  vi.stubEnv("GMAIL_TOKEN_ENCRYPTION_KEY", "test-sso-encryption-key-0123456789");
  olvidarLosIdps();
  pedidos.length = 0;
  enControl.mockReset();
  documento = {
    issuer: ISSUER,
    authorization_endpoint: `${ISSUER}/authorize`,
    token_endpoint: `${ISSUER}/token`,
    jwks_uri: `${ISSUER}/jwks`,
  };
  jwks = { keys: [clave.publicJwk] };
  tokenQueDa = null;
  cuerpoDelToken = null;

  pedirFijado.mockReset();
  pedirFijado.mockImplementation(async (p: { url: string; metodo?: string; cuerpo?: string; encabezados?: Record<string, string> }) => {
    pedidos.push({ url: p.url, metodo: p.metodo, cuerpo: p.cuerpo, encabezados: p.encabezados });
    const { pathname } = new URL(p.url);
    if (pathname === "/.well-known/openid-configuration") return { ok: true, estado: 200, cuerpo: JSON.stringify(documento) };
    if (pathname === "/jwks") return { ok: true, estado: 200, cuerpo: JSON.stringify(jwks) };
    if (pathname === "/token") {
      return { ok: true, estado: 200, cuerpo: cuerpoDelToken ?? JSON.stringify({ id_token: tokenQueDa }) };
    }
    return { ok: false, motivo: "http_404" };
  });
});

afterEach(() => vi.unstubAllEnvs());

describe("el token del IdP", () => {
  it("un token bien firmado de este IdP y de este dominio alcanza", async () => {
    const r = await identificar(await firmar());
    expect(r).toEqual({ ok: true, email: "ana@empresa.com", sub: "sub-ana", nombre: "Ana Pérez" });
  });

  it("el mail se compara en minúsculas", async () => {
    const r = await identificar(await firmar({ reclamos: { email: "Ana@Empresa.COM" } }));
    expect(r).toMatchObject({ ok: true, email: "ana@empresa.com" });
  });

  it("acepta ES256 además de RS256", async () => {
    const es = await par("k-es", "ES256");
    jwks = { keys: [es.publicJwk] };
    expect(await identificar(await firmar({ con: es, alg: "ES256" }))).toMatchObject({ ok: true });
  });

  it("sólo se admiten firmas asimétricas", () => {
    expect(ALGORITMOS_ADMITIDOS).toEqual(["RS256", "ES256"]);
  });

  it("rechaza un iss ajeno", async () => {
    expect(await identificar(await firmarCon({ iss: "https://otro-idp.test" }))).toEqual({ ok: false, motivo: "token_invalido" });
  });

  it("rechaza una aud ajena", async () => {
    expect(await identificar(await firmarCon({ aud: "otro-cliente" }))).toEqual({ ok: false, motivo: "token_invalido" });
  });

  it("con varias audiencias exige un azp que sea el cliente", async () => {
    expect(await identificar(await firmarCon({ aud: [CLIENT_ID, "otra"] }))).toEqual({ ok: false, motivo: "azp" });
    expect(await identificar(await firmarCon({ aud: [CLIENT_ID, "otra"], azp: "otra" }))).toEqual({ ok: false, motivo: "azp" });
    expect(await identificar(await firmarCon({ aud: [CLIENT_ID, "otra"], azp: CLIENT_ID }))).toMatchObject({ ok: true });
  });

  it("un azp ajeno se rechaza aunque la audiencia sea una sola", async () => {
    expect(await identificar(await firmarCon({ azp: "otro-cliente" }))).toEqual({ ok: false, motivo: "azp" });
  });

  it("rechaza un nonce que no salió de este navegador, o ausente", async () => {
    expect(await identificar(await firmar({ reclamos: { nonce: "otro-nonce" } }))).toEqual({ ok: false, motivo: "nonce" });
    expect(await identificar(await firmar({ reclamos: { nonce: undefined } }))).toEqual({ ok: false, motivo: "nonce" });
  });

  it("rechaza alg none", async () => {
    const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const sinFirma = `${enc({ alg: "none", typ: "JWT" })}.${enc({
      iss: ISSUER, aud: CLIENT_ID, sub: "sub-ana", email: "ana@empresa.com", email_verified: true, nonce: NONCE, iat: ahora(), exp: ahora() + 300,
    })}.`;
    expect(await identificar(sinFirma)).toEqual({ ok: false, motivo: "token_invalido" });
  });

  it("rechaza HS256, aunque esté firmado con el secreto del cliente", async () => {
    const hs = await new SignJWT({ sub: "sub-ana", email: "ana@empresa.com", email_verified: true, nonce: NONCE })
      .setProtectedHeader({ alg: "HS256", kid: "k1" })
      .setIssuer(ISSUER)
      .setAudience(CLIENT_ID)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(new TextEncoder().encode(SECRETO));
    expect(await identificar(hs)).toEqual({ ok: false, motivo: "token_invalido" });
  });

  it("rechaza un token vencido", async () => {
    const viejo = ahora() - 3600;
    expect(await identificar(await firmar({ iat: viejo, exp: viejo + 300 }))).toEqual({ ok: false, motivo: "token_invalido" });
  });

  it("rechaza un token más viejo que la edad máxima aunque no haya vencido", async () => {
    expect(await identificar(await firmar({ iat: ahora() - 20 * 60, exp: ahora() + 3600 }))).toEqual({
      ok: false,
      motivo: "token_invalido",
    });
  });

  it("rechaza una firma de otra clave, con el mismo kid", async () => {
    expect(await identificar(await firmar({ con: ajena }))).toEqual({ ok: false, motivo: "token_invalido" });
  });

  it("con un kid desconocido baja las claves una vez más y después rechaza", async () => {
    const r = await identificar(await firmar({ kid: "no-existe" }));
    expect(r).toEqual({ ok: false, motivo: "token_invalido" });
    expect(pedidos.filter((p) => p.url === `${ISSUER}/jwks`)).toHaveLength(2);
  });

  it("una rotación de claves del IdP no deja afuera a nadie", async () => {
    expect(await identificar(await firmar())).toMatchObject({ ok: true });
    const nueva = await par("k2");
    jwks = { keys: [clave.publicJwk, nueva.publicJwk] };
    expect(await identificar(await firmar({ con: nueva }))).toMatchObject({ ok: true });
  });

  it("rechaza el mail de otro dominio y el de un subdominio", async () => {
    expect(await identificar(await firmar({ reclamos: { email: "ana@otra.com" } }))).toEqual({ ok: false, motivo: "dominio_ajeno" });
    expect(await identificar(await firmar({ reclamos: { email: "ana@sub.empresa.com" } }))).toEqual({ ok: false, motivo: "dominio_ajeno" });
    expect(await identificar(await firmar({ reclamos: { email: "ana@empresa.com.evil.com" } }))).toEqual({ ok: false, motivo: "dominio_ajeno" });
  });

  it("rechaza un mail sin verificar, o verificado con un texto", async () => {
    expect(await identificar(await firmar({ reclamos: { email_verified: false } }))).toEqual({ ok: false, motivo: "email_no_verificado" });
    expect(await identificar(await firmar({ reclamos: { email_verified: "true" } }))).toEqual({ ok: false, motivo: "email_no_verificado" });
    expect(await identificar(await firmar({ reclamos: { email_verified: undefined } }))).toEqual({ ok: false, motivo: "email_no_verificado" });
  });

  it("rechaza un token sin mail o sin sub", async () => {
    expect(await identificar(await firmar({ reclamos: { email: undefined } }))).toEqual({ ok: false, motivo: "sin_email" });
    expect(await identificar(await firmar({ reclamos: { sub: undefined } }))).toEqual({ ok: false, motivo: "sin_sub" });
  });
});

describe("el pedido al token endpoint", () => {
  it("por omisión se autentica con Basic y el secreto no viaja en el cuerpo", async () => {
    await identificar(await firmar());
    const pedido = pedidos.find((p) => p.url === `${ISSUER}/token`)!;
    expect(pedido.metodo).toBe("POST");
    expect(pedido.encabezados?.Authorization).toBe(`Basic ${Buffer.from(`${CLIENT_ID}:${SECRETO}`).toString("base64")}`);
    const cuerpo = new URLSearchParams(pedido.cuerpo);
    expect(cuerpo.get("grant_type")).toBe("authorization_code");
    expect(cuerpo.get("code")).toBe("codigo-de-un-solo-uso");
    expect(cuerpo.get("code_verifier")).toBe(VERIFICADOR);
    expect(cuerpo.get("redirect_uri")).toBe(REDIRECT);
    expect(pedido.cuerpo).not.toContain(SECRETO);
  });

  it("codifica como formulario un secreto con caracteres reservados antes del base64", async () => {
    vi.stubEnv("GMAIL_TOKEN_ENCRYPTION_KEY", "test-sso-encryption-key-0123456789");
    await identificar(await firmar(), { client_secret_cifrado: cifrar("a:b c+d/é") });
    const pedido = pedidos.find((p) => p.url === `${ISSUER}/token`)!;
    const decodificado = Buffer.from(pedido.encabezados!.Authorization.replace("Basic ", ""), "base64").toString("utf8");
    expect(decodificado).toBe(`${CLIENT_ID}:${encodeURIComponent("a:b c+d/é")}`);
  });

  it("si el IdP sólo admite client_secret_post, va en el cuerpo y no hay Authorization", async () => {
    documento.token_endpoint_auth_methods_supported = ["client_secret_post"];
    await identificar(await firmar());
    const pedido = pedidos.find((p) => p.url === `${ISSUER}/token`)!;
    const cuerpo = new URLSearchParams(pedido.cuerpo);
    expect(cuerpo.get("client_id")).toBe(CLIENT_ID);
    expect(cuerpo.get("client_secret")).toBe(SECRETO);
    expect(pedido.encabezados?.Authorization).toBeUndefined();
  });

  it("un secreto guardado que no se puede descifrar es un rechazo, no un error", async () => {
    tokenQueDa = await firmar();
    const cfg = config({ client_secret_cifrado: "basura" });
    const d = await descubrir(cfg.issuer);
    if (!d.ok) throw new Error("descubrimiento");
    const r = await identificarConElIdp({
      config: cfg, descubierto: d.datos, code: "c", codeVerifier: VERIFICADOR, redirectUri: REDIRECT, nonce: NONCE,
    });
    expect(r).toEqual({ ok: false, motivo: "secreto_ilegible" });
    expect(pedidos.some((p) => p.url === `${ISSUER}/token`)).toBe(false);
  });

  it("un token endpoint que no contesta es un rechazo", async () => {
    tokenQueDa = await firmar();
    pedirFijado.mockImplementation(async (p: { url: string }) => {
      if (p.url.endsWith("/token")) return { ok: false, motivo: "timeout" };
      if (p.url.endsWith("/jwks")) return { ok: true, estado: 200, cuerpo: JSON.stringify(jwks) };
      return { ok: true, estado: 200, cuerpo: JSON.stringify(documento) };
    });
    expect(await identificar(tokenQueDa)).toEqual({ ok: false, motivo: "sin_respuesta" });
  });

  it("una respuesta sin id_token, o con más de lo tolerado, es un rechazo", async () => {
    cuerpoDelToken = JSON.stringify({ access_token: "x" });
    expect(await identificar("ignorado")).toEqual({ ok: false, motivo: "respuesta_ilegible" });
    cuerpoDelToken = "no es json";
    expect(await identificar("ignorado")).toEqual({ ok: false, motivo: "respuesta_ilegible" });
  });

  it("sin claves del IdP no hay identidad", async () => {
    tokenQueDa = await firmar();
    olvidarLosIdps();
    pedirFijado.mockImplementation(async (p: { url: string }) => {
      if (p.url.endsWith("/jwks")) return { ok: false, motivo: "red" };
      if (p.url.endsWith("/token")) return { ok: true, estado: 200, cuerpo: JSON.stringify({ id_token: tokenQueDa }) };
      return { ok: true, estado: 200, cuerpo: JSON.stringify(documento) };
    });
    expect(await identificar(tokenQueDa)).toEqual({ ok: false, motivo: "sin_claves" });
  });

  it("el secreto no aparece en lo que devuelve, ni en un rechazo", async () => {
    const bien = JSON.stringify(await identificar(await firmar()));
    const mal = JSON.stringify(await identificar(await firmar({ reclamos: { email: "x@otra.com" } })));
    expect(bien).not.toContain(SECRETO);
    expect(mal).not.toContain(SECRETO);
  });
});

describe("la URL de autorización", () => {
  it("lleva PKCE S256 sin el verificador, el state, el nonce y el mail de pista", () => {
    const url = new URL(
      urlDeAutorizacion({
        config: { client_id: CLIENT_ID },
        descubierto: { authorization_endpoint: `${ISSUER}/authorize` },
        redirectUri: REDIRECT,
        state: "el-state",
        nonce: NONCE,
        codeVerifier: VERIFICADOR,
        mail: "ana@empresa.com",
      })
    );
    const q = url.searchParams;
    expect(url.origin + url.pathname).toBe(`${ISSUER}/authorize`);
    expect(q.get("response_type")).toBe("code");
    expect(q.get("client_id")).toBe(CLIENT_ID);
    expect(q.get("redirect_uri")).toBe(REDIRECT);
    expect(q.get("scope")).toBe("openid email profile");
    expect(q.get("state")).toBe("el-state");
    expect(q.get("nonce")).toBe(NONCE);
    expect(q.get("code_challenge_method")).toBe("S256");
    expect(q.get("code_challenge")).toBe(createHash("sha256").update(VERIFICADOR).digest("base64url"));
    expect(q.get("login_hint")).toBe("ana@empresa.com");
    expect(url.toString()).not.toContain(VERIFICADOR);
  });
});

describe("descubrimiento del IdP", () => {
  it("lee el documento y elige client_secret_basic por omisión", async () => {
    const r = await descubrir(ISSUER);
    expect(r).toEqual({
      ok: true,
      datos: {
        authorization_endpoint: `${ISSUER}/authorize`,
        token_endpoint: `${ISSUER}/token`,
        jwks_uri: `${ISSUER}/jwks`,
        autenticacion: "client_secret_basic",
      },
    });
  });

  it("elige post sólo si el IdP no admite basic", async () => {
    documento.token_endpoint_auth_methods_supported = ["client_secret_post", "client_secret_basic"];
    expect(await descubrir(ISSUER, { usarMemoria: false })).toMatchObject({ ok: true, datos: { autenticacion: "client_secret_basic" } });
    documento.token_endpoint_auth_methods_supported = ["client_secret_post"];
    expect(await descubrir(ISSUER, { usarMemoria: false })).toMatchObject({ ok: true, datos: { autenticacion: "client_secret_post" } });
  });

  it("guarda el documento en memoria y `usarMemoria: false` lo vuelve a pedir", async () => {
    await descubrir(ISSUER);
    await descubrir(ISSUER);
    expect(pedidos).toHaveLength(1);
    await descubrir(ISSUER, { usarMemoria: false });
    expect(pedidos).toHaveLength(2);
  });

  it("rechaza un issuer que no es https, con puerto o IP literal, sin pedir nada", async () => {
    for (const malo of ["http://idp.empresa.test", "https://idp.empresa.test:8443", "https://10.0.0.5", "https://[::1]", "no-es-url"]) {
      expect(await descubrir(malo)).toEqual({ ok: false, motivo: "issuer_invalido" });
    }
    expect(pedidos).toHaveLength(0);
  });

  it("el issuer del documento tiene que ser idéntico al guardado", async () => {
    documento.issuer = `${ISSUER}/`;
    expect(await descubrir(ISSUER)).toEqual({ ok: false, motivo: "issuer_no_coincide" });
  });

  it("rechaza un endpoint que no pasa la guarda de destinos", async () => {
    for (const campo of ["authorization_endpoint", "token_endpoint", "jwks_uri"]) {
      olvidarLosIdps();
      const original = documento[campo];
      documento[campo] = "http://169.254.169.254/latest/meta-data";
      expect(await descubrir(ISSUER)).toEqual({ ok: false, motivo: "endpoint_rechazado" });
      documento[campo] = "https://10.0.0.5/token";
      expect(await descubrir(ISSUER, { usarMemoria: false })).toEqual({ ok: false, motivo: "endpoint_rechazado" });
      documento[campo] = original;
    }
  });

  it("un documento ilegible o incompleto, o un IdP que no contesta, no descubre nada", async () => {
    documento = { issuer: ISSUER };
    expect(await descubrir(ISSUER)).toEqual({ ok: false, motivo: "documento_ilegible" });
    pedirFijado.mockResolvedValue({ ok: false, motivo: "timeout" });
    expect(await descubrir(ISSUER, { usarMemoria: false })).toEqual({ ok: false, motivo: "sin_respuesta" });
    pedirFijado.mockResolvedValue({ ok: true, estado: 200, cuerpo: null });
    expect(await descubrir(ISSUER, { usarMemoria: false })).toEqual({ ok: false, motivo: "sin_respuesta" });
  });

  it("las claves se guardan en memoria y `refrescar` las baja de nuevo", async () => {
    await clavesDe(`${ISSUER}/jwks`);
    await clavesDe(`${ISSUER}/jwks`);
    expect(pedidos).toHaveLength(1);
    await clavesDe(`${ISSUER}/jwks`, { refrescar: true });
    expect(pedidos).toHaveLength(2);
  });

  it("unas claves que no son un JWKS no se guardan", async () => {
    pedirFijado.mockResolvedValue({ ok: true, estado: 200, cuerpo: JSON.stringify({ nada: 1 }) });
    expect(await clavesDe(`${ISSUER}/jwks`)).toBeNull();
  });
});

describe("la config vigente", () => {
  it("sin la 0045 aplicada no hay SSO, y no es un error", async () => {
    for (const code of ["42P01", "42703"]) {
      enControl.mockRejectedValueOnce(Object.assign(new Error("x"), { code }));
      expect(await configVigenteDelInquilino(TENANT)).toBeNull();
    }
  });

  it("cualquier otra falla de la base se propaga", async () => {
    enControl.mockRejectedValueOnce(Object.assign(new Error("caída"), { code: "08006" }));
    await expect(configVigenteDelInquilino(TENANT)).rejects.toThrow("caída");
  });

  it("una fila con un campo vacío no es una config", async () => {
    enControl.mockResolvedValueOnce([{ ...config(), issuer: null }]);
    expect(await configVigenteDelInquilino(TENANT)).toBeNull();
    enControl.mockResolvedValueOnce([]);
    expect(await configVigenteDelInquilino(TENANT)).toBeNull();
  });

  it("una fila completa se devuelve tal cual", async () => {
    const fila = config();
    enControl.mockResolvedValueOnce([fila]);
    expect(await configVigenteDelInquilino(TENANT)).toEqual(fila);
  });
});
