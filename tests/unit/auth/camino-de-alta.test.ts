/**
 * La puerta del alta contra Better Auth de verdad (1.7.7): sus rutas, sus
 * ganchos y su callback de OAuth.
 *
 * Lo que `caminoDeAlta` da por sentado de la librería y no se puede probar con un
 * simulacro: con `autoSignIn: false`, un 403 del gancho se vuelve un usuario de
 * mentira con 200 (el alta parecería hecha), y el callback de OAuth redirige con
 * el `code` de un APIError. Por eso la regla lanza 422 y no devuelve `false`.
 *
 * Sólo se sustituye el almacenamiento (`memoryAdapter` en lugar de Drizzle), la
 * base que miran los ganchos, el envío del mail y la respuesta de Google.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const TENANT_POR_OMISION = "00000000-0000-4000-8000-0000000000aa";

const h = vi.hoisted(() => ({
  store: { user: [] as any[], session: [] as any[], account: [] as any[], verification: [] as any[] },
  perfiles: [] as any[],
  inserts: vi.fn(),
  exigeSso: vi.fn(),
  claims: {} as Record<string, unknown>,
  log: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("better-auth/adapters/drizzle", async () => {
  const { memoryAdapter } = await import("better-auth/adapters/memory");
  return { drizzleAdapter: () => memoryAdapter(h.store) };
});
vi.mock("@/lib/db", () => ({
  // Ni `provision` ni `onPasswordReset` encuentran un perfil: es un alta nueva.
  db: {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }),
    insert: h.inserts,
    update: () => ({ set: () => ({ where: async () => undefined }) }),
  },
}));
vi.mock("@/data/scope", () => ({
  enControl: async (_ctx: unknown, armar: (db: unknown) => unknown) =>
    armar({ insert: () => ({ values: async (v: unknown) => void h.perfiles.push(v) }) }),
  enTenantVarias: vi.fn(),
}));
vi.mock("@/lib/observability/logger", () => ({
  logger: { debug: h.log, info: h.log, warn: h.log, error: h.log },
}));
vi.mock("@/lib/audit/log", async (original) => ({
  ...(await original<typeof import("@/lib/audit/log")>()),
  writeAuditLog: vi.fn(),
}));
vi.mock("@/lib/auth/sesiones", () => ({ cerrarSesiones: vi.fn(async () => 0) }));
vi.mock("@/server/notify/remitente-sistema", () => ({ remitenteDelSistema: () => ({ de: "no-responder@example.com" }) }));
vi.mock("@/server/sso/usuarios", () => ({
  duenoDelMail: vi.fn(),
  inquilinoDelUsuario: vi.fn(),
  dominioExigeSso: vi.fn(),
  correoExigeSso: vi.fn(),
  dominioExigeSsoEnAlgunInquilino: h.exigeSso,
}));
vi.mock("@/server/sso/config", async (original) => ({
  ...(await original<typeof import("@/server/sso/config")>()),
  configVigentePorDominio: vi.fn(),
  configVigenteDelInquilino: vi.fn(),
}));
vi.mock("@/server/notify/password-reset", () => ({ sendPasswordResetEmail: vi.fn() }));

import { caminoDeAlta } from "@/lib/auth/alta-nueva";
import { onPasswordReset } from "@/lib/auth/on-password-reset";
import { enAlta, enIngresoPorSso } from "@/lib/auth/registro-permitido";
import {
  COOKIE_DE_INVITACION,
  DURACION_DE_LA_INVITACION_MS,
  sellarInvitacion,
} from "@/server/alta/invitacion";

let auth: typeof import("@/lib/auth").auth;

beforeAll(async () => {
  vi.stubEnv("BETTER_AUTH_SECRET", "test-better-auth-secret-key");
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://claimmix.test");
  vi.stubEnv("GOOGLE_CLIENT_ID", "fake-google-client-id");
  vi.stubEnv("GOOGLE_CLIENT_SECRET", "fake-google-client-secret");
  ({ auth } = await import("@/lib/auth"));
});

beforeEach(() => {
  vi.clearAllMocks();
  for (const tabla of Object.values(h.store)) tabla.length = 0;
  h.perfiles.length = 0;
  h.exigeSso.mockResolvedValue(false);
  vi.stubEnv("GOOGLE_DEFAULT_TENANT_ID", TENANT_POR_OMISION);
  vi.stubEnv("SIGNUP_ALLOWED_EMAILS", "");
  vi.stubEnv("ADMIN_EMAILS", "");
  vi.stubEnv("ALTA_AUTOMATICA", "");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const jwtSinFirma = (claims: Record<string, unknown>) => {
  const parte = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${parte({ alg: "RS256", typ: "JWT" })}.${parte(claims)}.fake-signature`;
};

/** Google contesta el canje del código con un id token de este correo. */
function googleContesta() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (entrada: RequestInfo | URL) => {
      const url = entrada instanceof Request ? entrada.url : String(entrada);
      if (url !== "https://oauth2.googleapis.com/token") throw new Error(`fetch inesperado: ${url}`);
      return Response.json({
        access_token: "fake-access-token",
        id_token: jwtSinFirma(h.claims),
        token_type: "Bearer",
        expires_in: 3600,
      });
    })
  );
}

/** Todo el recorrido: el arranque desde /login y la vuelta de Google, hasta el redirect final. */
async function entrarConGoogle(email: string, emailVerified = true, cookieExtra = "") {
  h.claims = { sub: `fake-google-sub-${email}`, email, email_verified: emailVerified, name: "Ana Pérez" };
  googleContesta();
  const inicio = await auth.api.signInSocial({
    body: { provider: "google", callbackURL: "/bandeja", newUserCallbackURL: "/alta", errorCallbackURL: "/login" },
    headers: new Headers(),
    returnHeaders: true,
  });
  const state = new URL(inicio.response.url!).searchParams.get("state")!;
  const cookie = [...inicio.headers.getSetCookie().map((c) => c.split(";")[0]), cookieExtra]
    .filter(Boolean)
    .join("; ");
  const vuelta = await auth.handler(
    new Request(`https://claimmix.test/api/auth/callback/google?code=fake-code&state=${state}`, {
      headers: { cookie },
    })
  );
  const destino = new URL(vuelta.headers.get("location") ?? "", "https://claimmix.test");
  return { status: vuelta.status, destino };
}

const INVITA = "10000000-0000-4000-8000-000000000001";
const ESPACIO = "10000000-0000-4000-8000-0000000000e1";

/** El valor sellado de una invitación para esa dirección, como lo deja la pantalla en `cm_invitacion`. */
const invitacionPara = (email: string, ahora = Date.now()) =>
  sellarInvitacion({ t: ESPACIO, e: email, r: "analyst", n: "Ana Pérez", i: INVITA }, ahora);

const altaDe = (email: string) =>
  auth.api.signUpEmail({
    body: { name: "Ana Pérez", email, password: "fake-password-de-prueba-1234" },
    headers: new Headers(),
  });

describe("el alta por correo, contra Better Auth", () => {
  it("sin que el servidor abra el alta, rechaza con 422 y no devuelve un usuario de mentira", async () => {
    vi.stubEnv("SIGNUP_ALLOWED_EMAILS", "@example.com");

    const intento = altaDe("ana@example.com");

    await expect(intento).rejects.toMatchObject({
      statusCode: 422,
      body: { code: "registro_cerrado" },
    });
    expect(h.store.user).toHaveLength(0);
  });

  it("una dirección de la lista tampoco entra por la puerta pública: el formulario no es la puerta", async () => {
    vi.stubEnv("SIGNUP_ALLOWED_EMAILS", "ana@example.com");

    await expect(altaDe("ana@example.com")).rejects.toMatchObject({ body: { code: "registro_cerrado" } });
    expect(h.store.user).toHaveLength(0);
  });

  it("dentro de enAlta('correo') crea la cuenta sin sesión y sin perfil", async () => {
    const r = await enAlta("correo", () => altaDe("ana@example.com"));

    expect(r.token).toBeNull();
    expect(h.store.user).toHaveLength(1);
    expect(h.store.user[0].emailVerified).toBe(false);
    expect(h.store.session).toHaveLength(0);
    expect(h.perfiles).toHaveLength(0);
  });

  it("dentro de enAlta('correo'), un dominio que algún inquilino reserva con SSO rechaza con sso_requerido", async () => {
    h.exigeSso.mockResolvedValue(true);

    await expect(enAlta("correo", () => altaDe("ana@example.com"))).rejects.toMatchObject({
      statusCode: 422,
      body: { code: "sso_requerido" },
    });
    expect(h.exigeSso).toHaveBeenCalledWith("ana@example.com");
    expect(h.store.user).toHaveLength(0);
  });

  it("dentro de enAlta('invitacion') crea la cuenta sin perfil", async () => {
    await enAlta("invitacion", () => altaDe("ana@example.com"));

    expect(h.store.user).toHaveLength(1);
    expect(h.perfiles).toHaveLength(0);
  });
});

describe("la vuelta de Google, contra Better Auth", () => {
  it("con el alta apagada y la dirección fuera de la lista, vuelve a /login?error=registro_cerrado y no crea nada", async () => {
    const { destino } = await entrarConGoogle("ana@example.com");

    expect(destino.pathname).toBe("/login");
    expect(destino.searchParams.get("error")).toBe("registro_cerrado");
    expect(h.store.user).toHaveLength(0);
    expect(h.store.account).toHaveLength(0);
    expect(h.perfiles).toHaveLength(0);
  });

  it("con un dominio que exige SSO vuelve a /login?error=sso_requerido", async () => {
    vi.stubEnv("ALTA_AUTOMATICA", "1");
    h.exigeSso.mockResolvedValue(true);

    const { destino } = await entrarConGoogle("ana@example.com");

    expect(destino.pathname).toBe("/login");
    expect(destino.searchParams.get("error")).toBe("sso_requerido");
    expect(h.store.user).toHaveLength(0);
  });

  it("con ALTA_AUTOMATICA=1 crea el usuario sin perfil y lo manda a /alta", async () => {
    vi.stubEnv("ALTA_AUTOMATICA", "1");

    const { destino } = await entrarConGoogle("ana@example.com");

    expect(destino.pathname).toBe("/alta");
    expect(h.store.user).toHaveLength(1);
    expect(h.store.user[0].emailVerified).toBe(true);
    expect(h.store.session).toHaveLength(1);
    expect(h.perfiles).toHaveLength(0);
  });

  it("con el alta apagada, una dirección de la lista entra igual y va a /alta", async () => {
    vi.stubEnv("SIGNUP_ALLOWED_EMAILS", "@example.com");

    const { destino } = await entrarConGoogle("ana@example.com");

    expect(destino.pathname).toBe("/alta");
    expect(h.store.user).toHaveLength(1);
    expect(h.perfiles).toHaveLength(0);
  });

  it("quien ya tiene cuenta no pasa por la puerta: entra a /bandeja", async () => {
    vi.stubEnv("ALTA_AUTOMATICA", "1");
    await entrarConGoogle("ana@example.com");
    vi.stubEnv("ALTA_AUTOMATICA", "");

    const { destino } = await entrarConGoogle("ana@example.com");

    expect(destino.pathname).toBe("/bandeja");
    expect(h.store.user).toHaveLength(1);
  });

  it("con la cookie de la invitación de esa dirección crea la cuenta sin perfil, aun con el alta apagada", async () => {
    const cookie = `${COOKIE_DE_INVITACION}=${invitacionPara("ana@example.com")}`;

    const { status } = await entrarConGoogle("ana@example.com", true, cookie);

    expect(status).toBe(302);
    expect(h.store.user).toHaveLength(1);
    expect(h.store.user[0].email).toBe("ana@example.com");
    expect(h.perfiles).toHaveLength(0);
  });

  it("la cookie de la invitación de otra dirección no abre el alta", async () => {
    const cookie = `${COOKIE_DE_INVITACION}=${invitacionPara("beto@example.com")}`;

    const { destino } = await entrarConGoogle("ana@example.com", true, cookie);

    expect(destino.pathname).toBe("/login");
    expect(destino.searchParams.get("error")).toBe("registro_cerrado");
    expect(h.store.user).toHaveLength(0);
  });

  it("el operador entra por Google con el alta apagada y queda admin del inquilino de la plataforma", async () => {
    vi.stubEnv("ADMIN_EMAILS", "operador@example.com");

    await entrarConGoogle("operador@example.com");

    expect(h.perfiles).toHaveLength(1);
    expect(h.perfiles[0]).toMatchObject({ tenant_id: TENANT_POR_OMISION, role: "admin" });
  });

  it("un Google nuevo comun nunca cae en el inquilino por omision", async () => {
    vi.stubEnv("ALTA_AUTOMATICA", "1");

    await entrarConGoogle("ana@example.com");
    await entrarConGoogle("beto@example.com");

    expect(h.store.user).toHaveLength(2);
    expect(h.perfiles.filter((p) => p.tenant_id === TENANT_POR_OMISION)).toHaveLength(0);
  });
});

describe("restablecer la contraseña no da perfil", () => {
  it("onPasswordReset no inserta en users, ni siquiera a una cuenta sin sesiones", async () => {
    vi.stubEnv("SIGNUP_ALLOWED_EMAILS", "@example.com");

    await onPasswordReset({ id: "u-1", email: "ana@example.com", name: "Ana Pérez" });

    expect(h.inserts).not.toHaveBeenCalled();
    expect(h.perfiles).toHaveLength(0);
  });
});

describe("caminoDeAlta", () => {
  const ctxDeGoogle = { path: "/callback/google" };

  it("el SSO de un inquilino entra, pero sólo con el dominio verificado de ese inquilino", async () => {
    const ingreso = { tenantId: "t-1", dominio: "example.com" };

    expect(await enIngresoPorSso(ingreso, () => caminoDeAlta("ana@example.com"))).toBe("sso");
    expect(await enIngresoPorSso(ingreso, () => caminoDeAlta("Ana@EXAMPLE.com"))).toBe("sso");
    await expect(enIngresoPorSso(ingreso, () => caminoDeAlta("ana@otra.com"))).rejects.toMatchObject({
      statusCode: 422,
      body: { code: "registro_cerrado" },
    });
  });

  it("con SSO, otro dominio, un subdominio o un dominio que termina igual no entran, aunque estén en la lista", async () => {
    vi.stubEnv("SIGNUP_ALLOWED_EMAILS", "@otra.example.org");
    const ingreso = { tenantId: "t-1", dominio: "example.com" };

    for (const mal of ["x@otra.example.org", "x@sub.example.com", "x@malaexample.com", "x@example.com@malicioso.example.org"]) {
      await expect(enIngresoPorSso(ingreso, () => caminoDeAlta(mal)), mal).rejects.toMatchObject({
        body: { code: "registro_cerrado" },
      });
    }
  });

  it("dos ingresos por SSO de inquilinos distintos a la vez no se contaminan", async () => {
    const intento = (mail: string) => caminoDeAlta(mail).catch((e) => e.body.code);
    const visto = await Promise.all([
      enIngresoPorSso({ tenantId: "a", dominio: "uno.example.com" }, async () => {
        await new Promise((r) => setTimeout(r, 5));
        return [await intento("x@uno.example.com"), await intento("x@dos.example.com")];
      }),
      enIngresoPorSso({ tenantId: "b", dominio: "dos.example.com" }, async () => {
        await new Promise((r) => setTimeout(r, 1));
        return [await intento("x@dos.example.com"), await intento("x@uno.example.com")];
      }),
    ]);
    expect(visto).toEqual([["sso", "registro_cerrado"], ["sso", "registro_cerrado"]]);
  });

  it("el alta que abre el servidor da 'correo' o 'invitacion'", async () => {
    expect(await enAlta("correo", () => caminoDeAlta("ana@example.com"))).toBe("correo");
    expect(await enAlta("invitacion", () => caminoDeAlta("ana@example.com"))).toBe("invitacion");
  });

  describe("la cookie de la invitación", () => {
    const ctxConCookie = (valor: string | null, path = "/callback/google") => ({
      path,
      getCookie: (clave: string) => (clave === COOKIE_DE_INVITACION ? valor : null),
    });

    it("en la vuelta de Google abre la puerta 'invitacion' para la dirección invitada, con el alta cerrada", async () => {
      const valor = invitacionPara("ana@example.com");

      expect(await caminoDeAlta("ana@example.com", ctxConCookie(valor))).toBe("invitacion");
      expect(await caminoDeAlta("Ana@EXAMPLE.com", ctxConCookie(valor))).toBe("invitacion");
      expect(h.exigeSso).not.toHaveBeenCalled();
    });

    it("no vale para otra dirección", async () => {
      const valor = invitacionPara("ana@example.com");

      await expect(caminoDeAlta("beto@example.com", ctxConCookie(valor))).rejects.toMatchObject({
        statusCode: 422,
        body: { code: "registro_cerrado" },
      });
    });

    it("adulterada, vencida o ajena a la invitación no abre nada", async () => {
      const valor = invitacionPara("ana@example.com");
      const vencida = invitacionPara("ana@example.com", Date.now() - DURACION_DE_LA_INVITACION_MS - 1000);
      const adulterada = `${valor.slice(0, -2)}${valor.endsWith("AA") ? "BB" : "AA"}`;

      for (const cookie of [adulterada, vencida, "basura", "", null]) {
        await expect(caminoDeAlta("ana@example.com", ctxConCookie(cookie)), String(cookie)).rejects.toMatchObject({
          body: { code: "registro_cerrado" },
        });
      }
    });

    it("fuera de la vuelta de Google no abre nada", async () => {
      const valor = invitacionPara("ana@example.com");

      for (const path of ["/sign-up/email", "/sign-in/social", "/sso-inquilino/callback"]) {
        await expect(caminoDeAlta("ana@example.com", ctxConCookie(valor, path)), path).rejects.toMatchObject({
          body: { code: "registro_cerrado" },
        });
      }
    });
  });

  it("la vuelta de Google da 'google' con el alta automática o con la dirección en la lista", async () => {
    vi.stubEnv("ALTA_AUTOMATICA", "1");
    expect(await caminoDeAlta("ana@example.com", ctxDeGoogle)).toBe("google");

    vi.stubEnv("ALTA_AUTOMATICA", "");
    vi.stubEnv("SIGNUP_ALLOWED_EMAILS", "@example.com");
    expect(await caminoDeAlta("ana@example.com", ctxDeGoogle)).toBe("google");
  });

  it("ALTA_AUTOMATICA sólo vale si es exactamente '1'", async () => {
    for (const valor of ["true", "0", "yes", " 1"]) {
      vi.stubEnv("ALTA_AUTOMATICA", valor);
      await expect(caminoDeAlta("ana@example.com", ctxDeGoogle), valor).rejects.toMatchObject({
        body: { code: "registro_cerrado" },
      });
    }
  });

  it("fuera de la vuelta de Google, la lista y el alta automática no abren nada", async () => {
    vi.stubEnv("ALTA_AUTOMATICA", "1");
    vi.stubEnv("SIGNUP_ALLOWED_EMAILS", "@example.com");

    for (const ctx of [undefined, null, {}, { path: "/sign-up/email" }, { path: "/sso-inquilino/callback" }]) {
      await expect(caminoDeAlta("ana@example.com", ctx), JSON.stringify(ctx)).rejects.toMatchObject({
        statusCode: 422,
        body: { code: "registro_cerrado" },
      });
    }
  });

  it("un dominio que exige SSO frena a Google antes de devolver el camino", async () => {
    vi.stubEnv("ALTA_AUTOMATICA", "1");
    h.exigeSso.mockResolvedValue(true);

    await expect(caminoDeAlta("ana@example.com", ctxDeGoogle)).rejects.toMatchObject({
      statusCode: 422,
      body: { code: "sso_requerido" },
    });
  });

  it("si la consulta del SSO falla, el alta falla: ante una falla de la base no se abre la puerta", async () => {
    vi.stubEnv("ALTA_AUTOMATICA", "1");
    h.exigeSso.mockRejectedValue(new Error("base caída"));

    await expect(caminoDeAlta("ana@example.com", ctxDeGoogle)).rejects.toThrow("base caída");
  });

  it("el rechazo se asienta sin la dirección entera", async () => {
    await expect(caminoDeAlta("ana@example.com")).rejects.toBeDefined();

    const [campos, evento] = h.log.mock.calls.at(-1)!;
    expect(evento).toBe("auth.registro.rechazado");
    expect(campos).toEqual({ dominio: "example.com", motivo: "registro_cerrado" });
  });
});
