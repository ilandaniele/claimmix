/**
 * Las acciones de /invitacion: lo que pasa cuando alguien acepta o rechaza.
 *
 * Better Auth, la base y la sesión son simulacros; el sellado del enlace es el
 * de verdad. Lo que se mira es el orden de las puertas: un enlace adulterado o
 * vencido, o una sesión de otra dirección, no llegan nunca a crear nada.
 */
import { APIError } from "better-auth/api";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  signInSocial: vi.fn(),
  signUpEmail: vi.fn(),
  signInEmail: vi.fn(),
  findUserById: vi.fn(),
  sesion: vi.fn(),
  filaDeUsuario: vi.fn(),
  verificar: vi.fn(),
  topePorIp: vi.fn(),
  writeAuditLog: vi.fn(),
  aceptar: vi.fn(),
  resumen: vi.fn(),
  ponerCookie: vi.fn(),
  borrarCookie: vi.fn(),
  puertaAlSignUp: [] as (string | undefined)[],
}));

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
}));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "user-agent": "vitest", "x-forwarded-for": "203.0.113.9" }),
  cookies: async () => ({ get: () => undefined, set: vi.fn(), delete: vi.fn() }),
}));
vi.mock("@/data/scope", () => ({ enTenant: vi.fn() }));
vi.mock("@/lib/auth", () => ({
  auth: {
    api: { signInSocial: h.signInSocial, signUpEmail: h.signUpEmail, signInEmail: h.signInEmail },
    $context: Promise.resolve({ internalAdapter: { findUserById: h.findUserById } }),
  },
}));
vi.mock("@/lib/auth/session", () => ({ getSessionContext: h.sesion }));
vi.mock("@/lib/auth/user-row", () => ({ getUserRowOrThrow: h.filaDeUsuario }));
vi.mock("@/lib/auth/on-password-reset", () => ({ marcarCorreoVerificado: h.verificar }));
vi.mock("@/lib/rate-limit/index", async (original) => ({
  ...(await original<typeof import("@/lib/rate-limit/index")>()),
  topePorIp: h.topePorIp,
}));
vi.mock("@/lib/audit/log", async (original) => ({
  ...(await original<typeof import("@/lib/audit/log")>()),
  writeAuditLog: h.writeAuditLog,
}));
vi.mock("@/lib/observability/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@/server/alta/invitacion", async (original) => ({
  ...(await original<typeof import("@/server/alta/invitacion")>()),
  aceptarInvitacion: h.aceptar,
  resumenDeInvitacion: h.resumen,
  ponerCookieDeInvitacion: h.ponerCookie,
  borrarCookieDeInvitacion: h.borrarCookie,
}));

import {
  aceptarConClave,
  aceptarConGoogle,
  aceptarConSesion,
  rechazarInvitacion,
} from "@/app/invitacion/actions";
import { altaEnCursoPorServidor } from "@/lib/auth/registro-permitido";
import { DURACION_DE_LA_INVITACION_MS, sellarInvitacion } from "@/server/alta/invitacion";

const ESPACIO = "aaaaaaaa-0000-4000-8000-00000000000a";
const ADMIN = "bbbbbbbb-0000-4000-8000-00000000000b";
const PERSONA = "dddddddd-0000-4000-8000-00000000000d";
const CLAVE = "fake-clave-larga-y-unica-123";

const base = { t: ESPACIO, e: "lucia@example.com", r: "analyst", n: "Lucía Fernández", i: ADMIN } as const;

const enlace = (ahora = Date.now()) => sellarInvitacion(base, ahora);

function formulario(campos: Record<string, string>) {
  const f = new FormData();
  for (const [k, v] of Object.entries(campos)) f.set(k, v);
  return f;
}

/** A dónde manda la acción: `redirect` simulado tira con la ruta. */
async function destino(accion: Promise<void>): Promise<string> {
  try {
    await accion;
  } catch (e) {
    const m = /^REDIRECT:(.*)$/.exec(e instanceof Error ? e.message : "");
    if (m) return m[1];
    throw e;
  }
  throw new Error("la acción no redirigió");
}

const sesionDe = (email: string, emailVerified = true) => ({ user: { id: PERSONA, email, emailVerified } });

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("BETTER_AUTH_SECRET", "test-better-auth-secret-key");
  h.puertaAlSignUp.length = 0;
  h.topePorIp.mockResolvedValue({ allowed: true });
  h.sesion.mockResolvedValue(null);
  h.filaDeUsuario.mockResolvedValue(null);
  h.aceptar.mockResolvedValue(true);
  h.resumen.mockResolvedValue({ espacio: "Seguros Ejemplo", quien: "Jefa Ejemplo", exigeSso: false });
  h.signUpEmail.mockImplementation(async () => {
    h.puertaAlSignUp.push(altaEnCursoPorServidor());
    return { user: { id: PERSONA } };
  });
  h.findUserById.mockResolvedValue({ id: PERSONA });
  h.signInEmail.mockResolvedValue({});
  h.signInSocial.mockResolvedValue({ url: "https://accounts.google.test/auth" });
});

describe("aceptar con la sesión que ya tiene", () => {
  it("con la sesión de la dirección invitada y sin perfil, crea el perfil y va a /bandeja", async () => {
    h.sesion.mockResolvedValue(sesionDe("lucia@example.com"));

    const ruta = await destino(aceptarConSesion(formulario({ t: enlace() })));

    expect(ruta).toBe("/bandeja");
    expect(h.aceptar).toHaveBeenCalledOnce();
    expect(h.aceptar).toHaveBeenCalledWith(
      expect.objectContaining({ ...base }),
      expect.objectContaining({ userId: PERSONA, ua: "vitest" })
    );
    expect(h.borrarCookie).toHaveBeenCalledOnce();
  });

  it("la dirección de la sesión se compara sin mayúsculas", async () => {
    h.sesion.mockResolvedValue(sesionDe("Lucia@Example.com"));

    expect(await destino(aceptarConSesion(formulario({ t: enlace() })))).toBe("/bandeja");
  });

  it("un enlace adulterado no crea nada", async () => {
    h.sesion.mockResolvedValue(sesionDe("lucia@example.com"));
    const valor = enlace();
    const adulterado = `${valor.slice(0, -2)}${valor.endsWith("AA") ? "BB" : "AA"}`;

    expect(await destino(aceptarConSesion(formulario({ t: adulterado })))).toBe("/invitacion");
    expect(h.aceptar).not.toHaveBeenCalled();
  });

  it("un enlace vencido no crea nada", async () => {
    h.sesion.mockResolvedValue(sesionDe("lucia@example.com"));
    const vencido = enlace(Date.now() - DURACION_DE_LA_INVITACION_MS - 1000);

    expect(await destino(aceptarConSesion(formulario({ t: vencido })))).toBe("/invitacion");
    expect(h.aceptar).not.toHaveBeenCalled();
  });

  it("sin enlace en el formulario no crea nada", async () => {
    h.sesion.mockResolvedValue(sesionDe("lucia@example.com"));

    expect(await destino(aceptarConSesion(formulario({})))).toBe("/invitacion");
    expect(h.aceptar).not.toHaveBeenCalled();
  });

  it("la sesión de otra dirección no acepta: vuelve a la pantalla, que lo explica", async () => {
    h.sesion.mockResolvedValue(sesionDe("victima@example.com"));
    const valor = enlace();

    expect(await destino(aceptarConSesion(formulario({ t: valor })))).toBe(`/invitacion?t=${encodeURIComponent(valor)}`);
    expect(h.aceptar).not.toHaveBeenCalled();
    expect(h.filaDeUsuario).not.toHaveBeenCalled();
  });

  it("una sesión con el correo sin verificar no acepta", async () => {
    h.sesion.mockResolvedValue(sesionDe("lucia@example.com", false));

    await destino(aceptarConSesion(formulario({ t: enlace() })));

    expect(h.aceptar).not.toHaveBeenCalled();
  });

  it("sin sesión no acepta", async () => {
    await destino(aceptarConSesion(formulario({ t: enlace() })));

    expect(h.aceptar).not.toHaveBeenCalled();
  });

  it("quien ya tiene perfil —en este espacio o en otro— no acepta ni gasta la invitación", async () => {
    h.sesion.mockResolvedValue(sesionDe("lucia@example.com"));
    h.filaDeUsuario.mockResolvedValue({ id: PERSONA, tenant_id: "cccccccc-0000-4000-8000-00000000000c" });

    await destino(aceptarConSesion(formulario({ t: enlace() })));

    expect(h.aceptar).not.toHaveBeenCalled();
    expect(h.borrarCookie).not.toHaveBeenCalled();
  });

  it("si quien invitó ya no es admin, no queda perfil y la cookie sigue ahí", async () => {
    h.sesion.mockResolvedValue(sesionDe("lucia@example.com"));
    h.aceptar.mockResolvedValue(false);
    const valor = enlace();

    const ruta = await destino(aceptarConSesion(formulario({ t: valor })));

    expect(ruta).toBe(`/invitacion?t=${encodeURIComponent(valor)}`);
    expect(h.borrarCookie).not.toHaveBeenCalled();
  });

  it("si la base falla vuelve con el error y no dice que aceptó", async () => {
    h.sesion.mockResolvedValue(sesionDe("lucia@example.com"));
    h.aceptar.mockRejectedValue(new Error("base caída"));

    expect(await destino(aceptarConSesion(formulario({ t: enlace() })))).toContain("&e=falla");
  });

  it("con el tope de la IP agotado no llega a la base", async () => {
    h.sesion.mockResolvedValue(sesionDe("lucia@example.com"));
    h.topePorIp.mockResolvedValue({ allowed: false });

    expect(await destino(aceptarConSesion(formulario({ t: enlace() })))).toContain("&e=intentos");
    expect(h.aceptar).not.toHaveBeenCalled();
  });
});

describe("aceptar con una contraseña", () => {
  const pedido = (over: Record<string, string> = {}) =>
    formulario({ t: enlace(), password: CLAVE, repetir: CLAVE, ...over });

  it("crea la cuenta por la puerta de la invitación, marca el correo, crea el perfil y abre la sesión", async () => {
    const ruta = await destino(aceptarConClave(pedido()));

    expect(ruta).toBe("/bandeja");
    expect(h.signUpEmail).toHaveBeenCalledOnce();
    expect(h.signUpEmail.mock.calls[0][0].body).toEqual({ name: "Lucía Fernández", email: "lucia@example.com", password: CLAVE });
    expect(h.puertaAlSignUp).toEqual(["invitacion"]);
    expect(h.verificar).toHaveBeenCalledWith(PERSONA);
    expect(h.aceptar).toHaveBeenCalledWith(expect.objectContaining({ t: ESPACIO }), expect.objectContaining({ userId: PERSONA }));
    expect(h.signInEmail).toHaveBeenCalledOnce();
  });

  it("la dirección sale del enlace, no del formulario", async () => {
    await destino(aceptarConClave(pedido({ email: "otra@example.com" })));

    expect(h.signUpEmail.mock.calls[0][0].body.email).toBe("lucia@example.com");
  });

  it("un enlace adulterado o vencido no crea nada", async () => {
    const vencido = enlace(Date.now() - DURACION_DE_LA_INVITACION_MS - 1000);

    for (const t of [vencido, "basura", ""]) {
      expect(await destino(aceptarConClave(pedido({ t })))).toBe("/invitacion");
    }
    expect(h.signUpEmail).not.toHaveBeenCalled();
  });

  it("una contraseña corta o que no coincide vuelve con el motivo, sin crear nada", async () => {
    expect(await destino(aceptarConClave(pedido({ password: "corta", repetir: "corta" })))).toContain("&e=clave");
    expect(await destino(aceptarConClave(pedido({ repetir: `${CLAVE}x` })))).toContain("&e=distintas");
    expect(h.signUpEmail).not.toHaveBeenCalled();
  });

  it("si la invitación ya no sirve, no crea la cuenta", async () => {
    h.resumen.mockResolvedValue(null);

    await destino(aceptarConClave(pedido()));

    expect(h.signUpEmail).not.toHaveBeenCalled();
    expect(h.aceptar).not.toHaveBeenCalled();
  });

  it("una dirección que ya tenía cuenta va a «ya tenés cuenta», sin perfil y sin sesión nueva, y deja el enlace en la cookie", async () => {
    h.findUserById.mockResolvedValue(null);
    const t = enlace();

    expect(await destino(aceptarConClave(pedido({ t })))).toBe("/login?aviso=ya_tenes_cuenta");
    expect(h.ponerCookie).toHaveBeenCalledWith(t);
    expect(h.aceptar).not.toHaveBeenCalled();
    expect(h.signInEmail).not.toHaveBeenCalled();
  });

  it("si Better Auth contesta que ya existe, hace lo mismo", async () => {
    h.signUpEmail.mockRejectedValue(new APIError("UNPROCESSABLE_ENTITY", { code: "USER_ALREADY_EXISTS", message: "x" }));
    const t = enlace();

    expect(await destino(aceptarConClave(pedido({ t })))).toBe("/login?aviso=ya_tenes_cuenta");
    expect(h.ponerCookie).toHaveBeenCalledWith(t);
    expect(h.aceptar).not.toHaveBeenCalled();
  });

  it("si el espacio exige el SSO para ese dominio, no crea la cuenta y vuelve a la pantalla", async () => {
    h.resumen.mockResolvedValue({ espacio: "Seguros Ejemplo", quien: "Jefa Ejemplo", exigeSso: true });

    expect(await destino(aceptarConClave(pedido()))).toContain("/invitacion?t=");
    expect(h.signUpEmail).not.toHaveBeenCalled();
    expect(h.aceptar).not.toHaveBeenCalled();
  });

  it("si la sesión se niega por el SSO, lleva a /login con ese aviso; cualquier otra falla va a /login pelado", async () => {
    h.signInEmail.mockRejectedValue(new APIError("FORBIDDEN", { code: "sso_requerido", message: "x" }));
    expect(await destino(aceptarConClave(pedido()))).toBe("/login?error=sso_requerido");

    h.signInEmail.mockRejectedValue(new Error("caído"));
    expect(await destino(aceptarConClave(pedido()))).toBe("/login");
  });

  it("si la cuenta quedó pero el perfil no (quien invitó perdió el rol), entra y la pantalla lo explica", async () => {
    h.aceptar.mockResolvedValue(false);

    const ruta = await destino(aceptarConClave(pedido()));

    expect(ruta).toContain("/invitacion?t=");
    expect(h.signInEmail).toHaveBeenCalledOnce();
    expect(h.borrarCookie).not.toHaveBeenCalled();
  });
});

describe("aceptar con Google", () => {
  it("deja la cookie sellada y manda a Google con la vuelta en /invitacion", async () => {
    const valor = enlace();

    const ruta = await destino(aceptarConGoogle(formulario({ t: valor })));

    expect(ruta).toBe("https://accounts.google.test/auth");
    expect(h.ponerCookie).toHaveBeenCalledWith(valor);
    expect(h.signInSocial.mock.calls[0][0].body).toMatchObject({
      provider: "google",
      callbackURL: "/invitacion",
      newUserCallbackURL: "/invitacion",
      loginHint: "lucia@example.com",
    });
  });

  it("si el espacio exige el SSO para ese dominio, no deja cookie ni manda a Google", async () => {
    h.resumen.mockResolvedValue({ espacio: "Seguros Ejemplo", quien: "Jefa Ejemplo", exigeSso: true });

    expect(await destino(aceptarConGoogle(formulario({ t: enlace() })))).toContain("/invitacion?t=");
    expect(h.ponerCookie).not.toHaveBeenCalled();
    expect(h.signInSocial).not.toHaveBeenCalled();
  });

  it("un enlace adulterado o vencido no deja cookie ni manda a Google", async () => {
    const vencido = enlace(Date.now() - DURACION_DE_LA_INVITACION_MS - 1000);

    for (const t of [vencido, "basura"]) {
      expect(await destino(aceptarConGoogle(formulario({ t })))).toBe("/invitacion");
    }
    expect(h.ponerCookie).not.toHaveBeenCalled();
    expect(h.signInSocial).not.toHaveBeenCalled();
  });

  it("si Google no contesta una URL, vuelve a /login con el error", async () => {
    h.signInSocial.mockResolvedValue({});

    expect(await destino(aceptarConGoogle(formulario({ t: enlace() })))).toBe("/login?error=google_signin_failed");
  });
});

describe("rechazar", () => {
  it("borra la cookie, asienta el rechazo en el espacio sin la dirección y muestra «rechazada»", async () => {
    const ruta = await destino(rechazarInvitacion(formulario({ t: enlace() })));

    expect(ruta).toBe("/invitacion?e=rechazada");
    expect(h.borrarCookie).toHaveBeenCalledOnce();
    expect(h.writeAuditLog).toHaveBeenCalledOnce();
    const asiento = h.writeAuditLog.mock.calls[0][0];
    expect(asiento).toMatchObject({ tenant_id: ESPACIO, event_type: "auth.invitation_rejected" });
    expect(JSON.stringify(asiento)).not.toContain("lucia@example.com");
    expect(h.aceptar).not.toHaveBeenCalled();
    expect(h.signUpEmail).not.toHaveBeenCalled();
  });

  it("con un enlace que no sirve borra la cookie y no asienta nada, pero responde igual", async () => {
    expect(await destino(rechazarInvitacion(formulario({ t: "basura" })))).toBe("/invitacion?e=rechazada");
    expect(h.borrarCookie).toHaveBeenCalledOnce();
    expect(h.writeAuditLog).not.toHaveBeenCalled();
  });

  it("con el tope de la IP agotado no asienta, pero responde igual", async () => {
    h.topePorIp.mockResolvedValue({ allowed: false });

    expect(await destino(rechazarInvitacion(formulario({ t: enlace() })))).toBe("/invitacion?e=rechazada");
    expect(h.writeAuditLog).not.toHaveBeenCalled();
  });
});
