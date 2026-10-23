/**
 * POST /api/admin/users invita, no crea.
 *
 * Antes la ruta creaba la cuenta y el perfil de la persona con una contraseña que
 * ponía el admin, y saltaba la lista de altas. Ahora sólo manda un enlace sellado:
 * no escribe ninguna cuenta ni ningún perfil, la respuesta no cambia según la
 * dirección tenga cuenta o no, y cada intento gasta cupo del espacio.
 *
 * Tampoco hay forma de averiguar desde acá quién opera la plataforma: la dirección
 * de un operador contesta igual que cualquier otra, después del cupo.
 */
import { readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  signUp: vi.fn(),
  insert: vi.fn(),
  rateLimit: vi.fn(),
  writeAuditLog: vi.fn(),
  enviar: vi.fn(),
  remitente: vi.fn(),
  locale: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth/require-admin", () => ({ requireAdmin: h.requireAdmin }));
vi.mock("@/lib/auth", () => ({ auth: { api: { signUpEmail: h.signUp } } }));
vi.mock("@/lib/db", () => ({ db: { insert: h.insert } }));
vi.mock("@/data/scope", async () => (await import("../mocks/puente-de-alcance")).puenteDeAlcance(() => ({})));
vi.mock("@/lib/i18n/locale", () => ({ resolveAccountLocale: h.locale }));
vi.mock("@/lib/audit/log", async (original) => ({
  ...(await original<typeof import("@/lib/audit/log")>()),
  writeAuditLog: h.writeAuditLog,
}));
vi.mock("@/lib/rate-limit/index", async (original) => ({
  ...(await original<typeof import("@/lib/rate-limit/index")>()),
  rateLimit: h.rateLimit,
}));
vi.mock("@/server/notify/remitente-sistema", () => ({
  enviarCorreoDelSistema: h.enviar,
  remitenteDelSistema: h.remitente,
}));

import { NextRequest } from "next/server";

import { POST } from "@/app/api/admin/users/route";
import { enUSServidor } from "@/lib/i18n/en-US.servidor";
import { esARServidor } from "@/lib/i18n/es-AR.servidor";
import { abrirInvitacion } from "@/server/alta/invitacion";

const ESPACIO = "aaaaaaaa-0000-4000-8000-00000000000a";
const ADMIN_ID = "bbbbbbbb-0000-4000-8000-00000000000b";

const SAVED = { ...process.env };

const admin = (over: Record<string, unknown> = {}) => ({
  userRow: { id: ADMIN_ID, tenant_id: ESPACIO, role: "admin", locale: "es-AR", ...over },
  user: { id: ADMIN_ID, email: "jefa@seguros.com.ar" },
});

function pedido(over: Record<string, unknown> = {}) {
  return new NextRequest("http://localhost/api/admin/users", {
    method: "POST",
    headers: { "Content-Type": "application/json", "user-agent": "vitest" },
    body: JSON.stringify({
      full_name: "Lucía Fernández",
      email: "lucia@seguros.com.ar",
      role: "analyst",
      ...over,
    }),
  });
}

/** El enlace del mail que salió, abierto: lo que la pantalla va a leer. */
function invitacionEnviada() {
  const [{ texto }] = h.enviar.mock.calls.at(-1)!;
  const token = /\/invitacion\?t=([A-Za-z0-9_.-]+)/.exec(texto)?.[1];
  return abrirInvitacion(token);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("BETTER_AUTH_SECRET", "test-better-auth-secret-key");
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://claimmix.test");
  delete process.env.ADMIN_EMAILS;
  delete process.env.ALTA_TOPE_INVITACIONES_DIA;
  h.requireAdmin.mockResolvedValue(admin());
  h.locale.mockResolvedValue("es-AR");
  h.remitente.mockReturnValue({ de: "no-responder@example.com" });
  h.rateLimit.mockResolvedValue({ allowed: true, remaining: 19, resetAt: 0, retryAfterSeconds: 0, ventana: 1 });
  h.enviar.mockResolvedValue({ enviado: true });
  h.writeAuditLog.mockResolvedValue(undefined);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  process.env = { ...SAVED };
});

describe("el pedido", () => {
  it("no acepta contraseña: el esquema es estricto", async () => {
    const res = await POST(pedido({ password: "fake-password-de-prueba-1234" }));

    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("VALIDATION_FAILED");
    expect(h.enviar).not.toHaveBeenCalled();
    expect(h.rateLimit).not.toHaveBeenCalled();
  });

  it("rechaza un rol que no existe", async () => {
    const res = await POST(pedido({ role: "superusuario" }));

    expect(res.status).toBe(400);
    expect(h.enviar).not.toHaveBeenCalled();
  });

  it("no invita si quien pide no es admin", async () => {
    const { AppError } = await import("@/lib/errors");
    h.requireAdmin.mockRejectedValue(new AppError("FORBIDDEN_ROLE"));

    const res = await POST(pedido());

    expect(res.status).toBe(403);
    expect(h.enviar).not.toHaveBeenCalled();
    expect(h.rateLimit).not.toHaveBeenCalled();
  });

  it("un admin no invita a un owner; un owner sí", async () => {
    const denegado = await POST(pedido({ role: "owner" }));
    expect(denegado.status).toBe(403);
    expect(h.enviar).not.toHaveBeenCalled();

    h.requireAdmin.mockResolvedValue(admin({ role: "owner" }));
    const permitido = await POST(pedido({ role: "owner" }));
    expect(permitido.status).toBe(202);
    expect(invitacionEnviada()?.r).toBe("owner");
  });

  it("la dirección del operador no se invita, con otra capitalización tampoco, pero contesta como cualquier otra y gasta cupo", async () => {
    process.env.ADMIN_EMAILS = "operador@example.com";

    const delOperador = await POST(pedido({ email: "Operador@Example.com", role: "admin" }));
    const comun = await POST(pedido({ email: "lucia@seguros.com.ar", role: "admin" }));

    expect(delOperador.status).toBe(202);
    expect(delOperador.status).toBe(comun.status);
    expect(await delOperador.json()).toEqual(await comun.json());
    expect(h.rateLimit).toHaveBeenCalledTimes(2);
    // Sólo salió el mail de la dirección común: al operador no se le sella ni se le manda nada.
    expect(h.enviar).toHaveBeenCalledOnce();
    expect(h.enviar.mock.calls[0][0].to).toBe("lucia@seguros.com.ar");
  });

  it("la invitación a un operador queda asentada como bloqueada, sin la dirección", async () => {
    process.env.ADMIN_EMAILS = "operador@example.com";

    await POST(pedido({ email: "operador@example.com", role: "admin" }));

    expect(h.writeAuditLog).toHaveBeenCalledOnce();
    const asiento = h.writeAuditLog.mock.calls[0][0];
    expect(asiento).toMatchObject({ tenant_id: ESPACIO, event_type: "auth.user_invited", payload: { rol: "admin", bloqueada: true } });
    expect(JSON.stringify(asiento)).not.toContain("operador@example.com");
  });

  it("en una prueba, la dirección de un operador de otro dominio cae en el filtro de dominio como cualquiera, no en un error propio", async () => {
    process.env.ADMIN_EMAILS = "operador@example.com";
    h.requireAdmin.mockResolvedValue(admin({ billing_status: "trial", autoalta: true }));

    const delOperador = await POST(pedido({ email: "operador@example.com" }));
    const comun = await POST(pedido({ email: "otra@example.com" }));

    expect(delOperador.status).toBe(422);
    expect(delOperador.status).toBe(comun.status);
    expect(await delOperador.json()).toEqual(await comun.json());
  });
});

describe("un espacio sin servicio", () => {
  it.each(["suspended", "churned"])("%s no invita: 403 antes del cupo y de mandar nada", async (billing_status) => {
    h.requireAdmin.mockResolvedValue(admin({ billing_status }));

    const res = await POST(pedido());

    expect(res.status).toBe(403);
    expect((await res.json()).error.message).toBe(esARServidor["usuarios.error.suspendido"]);
    expect(h.rateLimit).not.toHaveBeenCalled();
    expect(h.enviar).not.toHaveBeenCalled();
    expect(h.writeAuditLog).not.toHaveBeenCalled();
  });

  it("un espacio activo o en prueba sí", async () => {
    h.requireAdmin.mockResolvedValue(admin({ billing_status: "active" }));

    expect((await POST(pedido())).status).toBe(202);
  });
});

describe("los textos de error salen en el idioma de la cuenta", () => {
  beforeEach(() => h.locale.mockResolvedValue("en-US"));

  it("un admin que invita a un owner", async () => {
    const res = await POST(pedido({ role: "owner" }));

    expect(res.status).toBe(403);
    expect((await res.json()).error.message).toBe(enUSServidor["usuarios.error.soloOwner"]);
  });

  it("un espacio suspendido", async () => {
    h.requireAdmin.mockResolvedValue(admin({ billing_status: "suspended", locale: "en-US" }));

    const res = await POST(pedido());

    expect((await res.json()).error.message).toBe(enUSServidor["usuarios.error.suspendido"]);
  });

  it("sin remitente del sistema", async () => {
    h.remitente.mockReturnValue(null);

    const res = await POST(pedido());

    expect(res.status).toBe(502);
    expect((await res.json()).error.message).toBe(enUSServidor["usuarios.error.envio"]);
  });

  it("una prueba que invita fuera de su dominio", async () => {
    h.requireAdmin.mockResolvedValue(admin({ billing_status: "trial", autoalta: true }));

    const res = await POST(pedido({ email: "lucia@otra-empresa.com" }));

    expect(res.status).toBe(422);
    expect((await res.json()).error.message).toBe(enUSServidor["usuarios.error.dominio"]);
  });

  it("el mismo error, en una cuenta en español, sale en español", async () => {
    h.locale.mockResolvedValue("es-AR");

    const res = await POST(pedido({ role: "owner" }));

    expect((await res.json()).error.message).toBe(esARServidor["usuarios.error.soloOwner"]);
  });
});

describe("lo que escribe", () => {
  it("responde 202 y no crea ninguna cuenta ni ningún perfil", async () => {
    const res = await POST(pedido());

    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ estado: "invitacion_enviada" });
    expect(h.signUp).not.toHaveBeenCalled();
    expect(h.insert).not.toHaveBeenCalled();
  });

  it("el enlace lleva el espacio, la dirección, el rol, el nombre y quién invita", async () => {
    await POST(pedido({ email: "Lucia@Seguros.com.ar" }));

    expect(invitacionEnviada()).toMatchObject({
      t: ESPACIO,
      e: "lucia@seguros.com.ar",
      r: "analyst",
      n: "Lucía Fernández",
      i: ADMIN_ID,
    });
    expect(h.enviar.mock.calls.at(-1)![0].to).toBe("lucia@seguros.com.ar");
  });

  it("el mail cuenta como `invitacion` en los cupos del remitente, sin IP", async () => {
    await POST(pedido());

    expect(h.enviar.mock.calls.at(-1)![1]).toEqual({ tipo: "invitacion" });
  });

  it("el espacio sale de la sesión: un tenant_id en el cuerpo es un campo de más y se rechaza", async () => {
    const res = await POST(pedido({ tenant_id: "cccccccc-0000-4000-8000-00000000000c" }));

    expect(res.status).toBe(400);
    expect(h.enviar).not.toHaveBeenCalled();
  });

  it("el mail es fijo: no dice el nombre del espacio ni el de quien invita", async () => {
    h.requireAdmin.mockResolvedValue(admin({ full_name: "Jefa Ejemplo" }));

    await POST(pedido());

    const { asunto, texto } = h.enviar.mock.calls.at(-1)![0];
    expect(asunto).toBe(esARServidor["correo.invitacion.asunto"]);
    expect(texto).toContain(esARServidor["correo.invitacion.intro"]);
    expect(texto).not.toContain("Jefa");
    expect(texto).not.toContain("jefa@seguros.com.ar");
    expect(texto).not.toContain("Lucía");
  });

  it("audita la invitación en el espacio, sin la dirección", async () => {
    await POST(pedido());

    expect(h.writeAuditLog).toHaveBeenCalledOnce();
    const asiento = h.writeAuditLog.mock.calls[0][0];
    expect(asiento).toMatchObject({
      tenant_id: ESPACIO,
      actor_id: ADMIN_ID,
      event_type: "auth.user_invited",
      payload: { rol: "analyst" },
    });
    expect(JSON.stringify(asiento)).not.toContain("lucia@seguros.com.ar");
  });

  it("sin remitente del sistema dice que no pudo enviar, y no gasta cupo", async () => {
    h.remitente.mockReturnValue(null);

    const res = await POST(pedido());

    expect(res.status).toBe(502);
    expect(h.rateLimit).not.toHaveBeenCalled();
    expect(h.enviar).not.toHaveBeenCalled();
  });
});

describe("la respuesta no depende de la dirección", () => {
  it("una dirección con cuenta, una nueva y un mail que no sale dan la misma respuesta", async () => {
    const respuestas: { status: number; cuerpo: unknown }[] = [];
    for (const salida of [
      { enviado: true },
      { enviado: true },
      { enviado: false, motivo: "tope_destinatario" },
      { enviado: false, motivo: "rebote" },
    ]) {
      h.enviar.mockResolvedValueOnce(salida);
      const res = await POST(pedido({ email: `persona${respuestas.length}@seguros.com.ar` }));
      respuestas.push({ status: res.status, cuerpo: await res.json() });
    }

    expect(new Set(respuestas.map((r) => JSON.stringify(r))).size).toBe(1);
    expect(respuestas[0].status).toBe(202);
    // Nunca se pregunta si la dirección tiene cuenta: no hay consulta ni creación.
    expect(h.signUp).not.toHaveBeenCalled();
    expect(h.insert).not.toHaveBeenCalled();
  });
});

describe("el cupo", () => {
  it("se toma en cada intento, por espacio, y si el contador no contesta no se invita", async () => {
    for (let i = 0; i < 3; i++) await POST(pedido());

    expect(h.rateLimit).toHaveBeenCalledTimes(3);
    const [clave, opciones] = h.rateLimit.mock.calls[0];
    expect(clave).toContain(ESPACIO);
    expect(clave).toContain("usuarios:inquilino");
    expect(opciones).toMatchObject({ limit: 20, windowMs: 24 * 60 * 60_000, fallaCerrada: true });
  });

  it("el tope se cambia con ALTA_TOPE_INVITACIONES_DIA", async () => {
    vi.stubEnv("ALTA_TOPE_INVITACIONES_DIA", "7");

    await POST(pedido());

    expect(h.rateLimit.mock.calls[0][1]).toMatchObject({ limit: 7 });
  });

  it("agotado, responde 429 con Retry-After y no manda ni audita nada", async () => {
    h.rateLimit.mockResolvedValue({ allowed: false, remaining: 0, resetAt: 0, retryAfterSeconds: 3600, ventana: 1 });

    const res = await POST(pedido());

    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("3600");
    expect(h.enviar).not.toHaveBeenCalled();
    expect(h.writeAuditLog).not.toHaveBeenCalled();
  });
});

describe("una prueba gratuita", () => {
  const prueba = () => admin({ billing_status: "trial", autoalta: true });

  beforeEach(() => h.requireAdmin.mockResolvedValue(prueba()));

  it("invita a lo sumo a cinco por día", async () => {
    await POST(pedido());

    expect(h.rateLimit.mock.calls[0][1]).toMatchObject({ limit: 5 });
  });

  it("sólo a gente de su propio dominio", async () => {
    const res = await POST(pedido({ email: "lucia@otra-empresa.com" }));

    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("DOMINIO_NO_PERMITIDO");
    expect(h.enviar).not.toHaveBeenCalled();
    expect(h.writeAuditLog).not.toHaveBeenCalled();
    // Aun así el intento cuenta: probar direcciones ajenas no sale gratis.
    expect(h.rateLimit).toHaveBeenCalledOnce();
  });

  it("nunca a un proveedor abierto, ni aunque quien invita use uno", async () => {
    h.requireAdmin.mockResolvedValue({
      ...prueba(),
      user: { id: ADMIN_ID, email: "jefa@icloud.com" },
    });

    const res = await POST(pedido({ email: "lucia@icloud.com" }));

    expect(res.status).toBe(422);
    expect(h.enviar).not.toHaveBeenCalled();
  });

  it("el dominio propio entra", async () => {
    const res = await POST(pedido({ email: "lucia@seguros.com.ar" }));

    expect(res.status).toBe(202);
    expect(h.enviar).toHaveBeenCalledOnce();
  });

  it("un inquilino que no es una prueba invita fuera de su dominio", async () => {
    h.requireAdmin.mockResolvedValue(admin({ billing_status: "active", autoalta: true }));

    const res = await POST(pedido({ email: "lucia@otra-empresa.com" }));

    expect(res.status).toBe(202);
  });

  describe("un alias + de la propia casilla de Gmail", () => {
    const quienInvita = (user: Record<string, unknown>) =>
      h.requireAdmin.mockResolvedValue({ ...prueba(), user: { id: ADMIN_ID, ...user } });
    const propia = { email: "jefa+admin@googlemail.com", emailVerified: true };

    it("entra: sale un solo mail a esa dirección, gasta cupo y el asiento lo marca sin la dirección", async () => {
      quienInvita(propia);

      const res = await POST(pedido({ email: "jefa+analista@googlemail.com" }));

      expect(res.status).toBe(202);
      expect(h.enviar).toHaveBeenCalledOnce();
      expect(h.enviar.mock.calls[0][0].to).toBe("jefa+analista@googlemail.com");
      expect(invitacionEnviada()?.e).toBe("jefa+analista@googlemail.com");
      expect(h.rateLimit).toHaveBeenCalledOnce();
      expect(h.rateLimit.mock.calls[0][1]).toMatchObject({ limit: 5 });
      expect(h.writeAuditLog).toHaveBeenCalledOnce();
      const asiento = h.writeAuditLog.mock.calls[0][0];
      expect(asiento).toMatchObject({ event_type: "auth.user_invited", payload: { rol: "analyst", alias: true } });
      expect(asiento.payload).toEqual({ rol: "analyst", alias: true });
      expect(JSON.stringify(asiento)).not.toContain("jefa");
    });

    it.each([
      ["mayúsculas y puntos de quien invita", "Je.Fa+Admin@googlemail.com", "jefa+analista@googlemail.com"],
      ["un alias de un alias", "jefa+admin@googlemail.com", "jefa+analista+2@googlemail.com"],
      ["la base, desde un alias", "jefa+admin@googlemail.com", "jefa@googlemail.com"],
      ["un alias, desde la base", "jefa@googlemail.com", "jefa+admin@googlemail.com"],
    ])("entra: %s", async (_caso, quien, invitado) => {
      quienInvita({ email: quien, emailVerified: true });

      const res = await POST(pedido({ email: invitado }));

      expect(res.status).toBe(202);
      expect(h.enviar).toHaveBeenCalledOnce();
      expect(h.enviar.mock.calls[0][0].to).toBe(invitado);
    });

    it.each([
      ["otra casilla", propia, "lucia+analista@googlemail.com"],
      ["una casilla que sólo empieza igual", propia, "jefa2+analista@googlemail.com"],
      ["una casilla que sólo es prefijo", propia, "jef+analista@googlemail.com"],
      ["el mismo alias en otro proveedor", propia, "jefa+analista@icloud.com"],
      ["el mismo alias en otro dominio", propia, "jefa+analista@seguros.com.ar"],
      ["un alias entre dos casillas de un proveedor abierto", { email: "jefa+a@icloud.com", emailVerified: true }, "jefa+b@icloud.com"],
      ["un alias de Gmail desde una casilla de empresa", { email: "jefa@seguros.com.ar", emailVerified: true }, "jefa+x@googlemail.com"],
      ["quien invita sin dirección", { emailVerified: true }, "jefa+analista@googlemail.com"],
      ["quien invita con la dirección sin verificar", { email: propia.email, emailVerified: false }, "jefa+analista@googlemail.com"],
      ["quien invita sin saber si está verificada", { email: propia.email }, "jefa+analista@googlemail.com"],
    ])("no entra: %s", async (_caso, quien, invitado) => {
      quienInvita(quien);

      const res = await POST(pedido({ email: invitado }));

      expect(res.status).toBe(422);
      expect((await res.json()).error.code).toBe("DOMINIO_NO_PERMITIDO");
      expect(h.enviar).not.toHaveBeenCalled();
      expect(h.writeAuditLog).not.toHaveBeenCalled();
      expect(h.rateLimit).toHaveBeenCalledOnce();
    });

    it("una invitación por dominio propio no lleva la marca de alias", async () => {
      const res = await POST(pedido({ email: "lucia@seguros.com.ar" }));

      expect(res.status).toBe(202);
      expect(h.writeAuditLog.mock.calls[0][0].payload).toEqual({ rol: "analyst" });
    });

    it("la dirección exacta de un operador sigue bloqueada: 202 sin envío y asiento de bloqueo", async () => {
      process.env.ADMIN_EMAILS = "operador@googlemail.com";
      quienInvita({ email: "operador+admin@googlemail.com", emailVerified: true });

      const res = await POST(pedido({ email: "operador@googlemail.com" }));

      expect(res.status).toBe(202);
      expect(h.enviar).not.toHaveBeenCalled();
      expect(h.writeAuditLog).toHaveBeenCalledOnce();
      expect(h.writeAuditLog.mock.calls[0][0].payload).toEqual({ rol: "analyst", bloqueada: true });
    });
  });
});

describe("la ayuda junto al correo del formulario de invitar", () => {
  /*
   * El alta es en dos pasos y la cuenta se crea antes de que la persona diga a qué
   * empresa viene. Si el admin invita otra dirección que la que ella usó, la
   * invitación no le aparece: la ayuda lo dice donde se escribe la dirección. Es
   * condicional: quien invita no sabe si la persona ya tiene cuenta (puede venir
   * de otro camino), así que no se lo da por hecho.
   */
  it("está en las dos lenguas, habla de la misma dirección y no da por hecha la cuenta", () => {
    expect(esARServidor["usuarios.form.emailAyuda"]).toMatch(/^Si la persona ya .*misma dirección/);
    expect(enUSServidor["usuarios.form.emailAyuda"]).toMatch(/^If the person has already .*same address/);
  });

  it("el formulario la muestra y la liga al campo", () => {
    const pagina = readFileSync("src/app/(app)/admin/users/page.tsx", "utf8");
    const formulario = readFileSync("src/app/(app)/admin/users/AdminUsersClient.tsx", "utf8");

    expect(pagina).toContain('emailAyuda={t("usuarios.form.emailAyuda")}');
    expect(formulario).toContain("{emailAyuda}");
    expect(formulario).toContain('aria-describedby="email-ayuda"');
    expect(formulario).toContain('id="email-ayuda"');
  });
});
