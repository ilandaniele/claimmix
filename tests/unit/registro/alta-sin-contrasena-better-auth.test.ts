/**
 * El alta sin contraseña contra Better Auth de verdad (sus rutas y sus ganchos).
 *
 * Lo que `signUp` da por sentado de la librería, y que no se puede probar con un
 * simulacro: con `autoSignIn: false` el alta no abre sesión, una dirección ya
 * tomada contesta como una nueva, y el enlace de restablecimiento llega a los
 * ganchos con el usuario entero (id, correo y nombre).
 *
 * Sólo se sustituye el almacenamiento (`memoryAdapter` en lugar de Drizzle), el
 * envío del mail y lo que hace `onPasswordReset`, que tiene su propia prueba.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  store: { user: [] as any[], session: [] as any[], account: [] as any[], verification: [] as any[] },
  perfiles: [] as unknown[],
  enviar: vi.fn(),
  alRestablecer: vi.fn(),
  after: vi.fn(),
  log: vi.fn(),
}));

vi.mock("server-only", () => ({}));
// `after()` de Next tira fuera de un pedido; acá se mira qué recibe.
vi.mock("next/server", async (original) => ({
  ...(await original<typeof import("next/server")>()),
  after: h.after,
}));
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
vi.mock("@/server/sso/usuarios", () => ({
  duenoDelMail: vi.fn(),
  inquilinoDelUsuario: vi.fn(),
  dominioExigeSso: vi.fn(),
  correoExigeSso: vi.fn(),
  dominioExigeSsoEnAlgunInquilino: vi.fn(async () => false),
}));
vi.mock("@/server/sso/config", async (original) => ({
  ...(await original<typeof import("@/server/sso/config")>()),
  configVigentePorDominio: vi.fn(),
  configVigenteDelInquilino: vi.fn(),
}));
vi.mock("@/server/notify/password-reset", () => ({ sendPasswordResetEmail: h.enviar }));
vi.mock("@/lib/auth/on-password-reset", () => ({ onPasswordReset: h.alRestablecer }));

let auth: typeof import("@/lib/auth").auth;
let enAlta: typeof import("@/lib/auth/registro-permitido").enAlta;

beforeAll(async () => {
  vi.stubEnv("BETTER_AUTH_SECRET", "test-better-auth-secret-key");
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://claimmix.test");
  ({ auth } = await import("@/lib/auth"));
  ({ enAlta } = await import("@/lib/auth/registro-permitido"));
});

beforeEach(() => {
  vi.clearAllMocks();
  for (const tabla of Object.values(h.store)) tabla.length = 0;
  h.perfiles.length = 0;
  vi.stubEnv("GOOGLE_DEFAULT_TENANT_ID", "00000000-0000-4000-8000-0000000000aa");
  vi.stubEnv("SIGNUP_ALLOWED_EMAILS", "@example.com");
  vi.stubEnv("ADMIN_EMAILS", "");
});

const registrar = (email: string) =>
  auth.api.signUpEmail({
    body: { name: "Ana Pérez", email, password: "fake-password-de-prueba-1234" },
    headers: new Headers(),
  });

/** El alta por el formulario: lo que abre la puerta lo pone el servidor, no el pedido. */
const altaDe = (email: string) => enAlta("correo", () => registrar(email));

describe("el alta no abre sesión", () => {
  it("autoSignIn está apagado", () => {
    expect(auth.options.emailAndPassword?.autoSignIn).toBe(false);
  });

  it("signUpEmail devuelve el usuario sin token y no crea sesión", async () => {
    const r = await altaDe("ana@example.com");

    expect(r.token).toBeNull();
    expect(r.user.email).toBe("ana@example.com");
    expect(h.store.user).toHaveLength(1);
    expect(h.store.session).toHaveLength(0);
  });

  it("la cuenta queda con el correo sin verificar y sin perfil", async () => {
    await altaDe("ana@example.com");

    expect(h.store.user[0].emailVerified).toBe(false);
    expect(h.perfiles).toHaveLength(0);
  });

  it("una dirección que ya tenía cuenta contesta igual, con un usuario que no existe", async () => {
    const primera = await altaDe("ana@example.com");

    const segunda = await altaDe("ana@example.com");

    expect(segunda.token).toBeNull();
    expect(segunda.user.id).not.toBe(primera.user.id);
    expect(h.store.user).toHaveLength(1);
    expect(h.store.user[0].id).toBe(primera.user.id);
  });

  it("un alta que ninguna puerta del servidor abrió no se crea: el gancho la niega", async () => {
    // Contesta con error, no con la respuesta de mentira: por eso `signUp` mira la
    // lista ANTES de llamar y manda a todos al mismo aviso.
    await expect(registrar("intrusa@otra-empresa.com")).rejects.toMatchObject({
      body: { code: "registro_cerrado" },
    });

    expect(h.store.user).toHaveLength(0);
  });
});

const pedirEnlace = () =>
  auth.api.requestPasswordReset({
    body: { email: "ana@example.com", redirectTo: "/restablecer" },
    headers: new Headers(),
  });

/** El envío ya no se espera para contestar: el token sale del mail cuando el mail sale. */
async function tokenDelEnlace(): Promise<string> {
  await vi.waitFor(() => expect(h.enviar).toHaveBeenCalledTimes(1));
  return new URL(h.enviar.mock.calls[0]![0].url).pathname.split("/").at(-1)!;
}

const sesionDe = (userId: string, id: string) => ({
  id,
  userId,
  token: `fake-token-${id}`,
  expiresAt: new Date(Date.now() + 86_400_000),
  createdAt: new Date(),
  updatedAt: new Date(),
});

describe("el enlace de restablecimiento de un alta nueva", () => {
  it("llega al envío con el id de la cuenta, su correo y un enlace con token", async () => {
    const { user } = await altaDe("ana@example.com");

    await pedirEnlace();

    await vi.waitFor(() => expect(h.enviar).toHaveBeenCalledTimes(1));
    expect(h.enviar.mock.calls[0]![0]).toMatchObject({
      userId: user.id,
      email: "ana@example.com",
      name: "Ana Pérez",
      url: expect.stringContaining("/reset-password/"),
    });
  });

  /*
   * Pedir el enlace contestaba después de mandar el mail, y mandarlo lleva lo
   * que tarde Gmail. Con una dirección sin cuenta no hay mail: la diferencia
   * de reloj decía quién tiene cuenta y quién no.
   */
  it("el envío queda en vuelo con `after()` y no demora la respuesta", async () => {
    await altaDe("ana@example.com");
    let liberar!: () => void;
    h.enviar.mockReturnValueOnce(new Promise<void>((r) => (liberar = r)));

    // Si la respuesta esperara el envío, esto no vuelve: el mail queda colgado a propósito.
    await pedirEnlace();

    expect(h.after).toHaveBeenCalledTimes(1);
    expect(h.after.mock.calls[0]![0]).toBeInstanceOf(Promise);
    await vi.waitFor(() => expect(h.enviar).toHaveBeenCalledTimes(1));
    liberar();
  });

  it("fuera de un pedido de Next, `after()` tira y el envío sale igual", async () => {
    await altaDe("ana@example.com");
    h.after.mockImplementationOnce(() => {
      throw new Error("`after` was called outside a request scope.");
    });

    await expect(pedirEnlace()).resolves.toMatchObject({ status: true });

    await vi.waitFor(() => expect(h.enviar).toHaveBeenCalledTimes(1));
  });

  it("al restablecer, el gancho recibe el usuario entero (id, correo y nombre)", async () => {
    const { user } = await altaDe("ana@example.com");
    await pedirEnlace();
    const token = await tokenDelEnlace();

    await auth.api.resetPassword({
      body: { newPassword: "fake-otra-contraseña-1234", token },
      headers: new Headers(),
    });

    expect(h.alRestablecer).toHaveBeenCalledTimes(1);
    expect(h.alRestablecer.mock.calls[0]![0]).toMatchObject({
      id: user.id,
      email: "ana@example.com",
      name: "Ana Pérez",
    });
  });
});

/*
 * Quien restablece cree que le entraron: las sesiones abiertas tienen que
 * desaparecer. Antes las borraba el gancho a mano y se tragaba el error; ahora
 * lo hace Better Auth antes de guardar la contraseña, y si no puede, no la guarda.
 */
describe("restablecer cierra las sesiones abiertas", () => {
  it("la opción de Better Auth está prendida", () => {
    expect(auth.options.emailAndPassword?.revokeSessionsOnPasswordReset).toBe(true);
  });

  it("borra las de esa cuenta, antes de avisarle al gancho, y deja las ajenas", async () => {
    const { user } = await altaDe("ana@example.com");
    h.store.session.push(sesionDe(user.id, "s-1"), sesionDe(user.id, "s-2"), sesionDe("otra-persona", "s-3"));
    let abiertasAlAvisar = -1;
    h.alRestablecer.mockImplementationOnce(async () => {
      abiertasAlAvisar = h.store.session.filter((s) => s.userId === user.id).length;
    });
    await pedirEnlace();
    const token = await tokenDelEnlace();

    await auth.api.resetPassword({
      body: { newPassword: "fake-otra-contraseña-1234", token },
      headers: new Headers(),
    });

    expect(abiertasAlAvisar).toBe(0);
    expect(h.store.session.map((s) => s.id)).toEqual(["s-3"]);
  });
});

/*
 * Better Auth cuenta en memoria por instancia: en serverless cada instancia
 * lleva su cuenta y el techo no es uno. Lo que consume un secreto tiene su cupo
 * en Postgres en la ruta de /api/auth y acá se apaga para no contarlo dos veces.
 */
describe("el limitador interno de Better Auth", () => {
  it("se apaga en lo que ya tiene techo en la ruta", () => {
    expect(auth.options.rateLimit?.customRules).toEqual({
      "/sign-in/*": false,
      "/request-password-reset": false,
      "/reset-password": false,
    });
  });
});
