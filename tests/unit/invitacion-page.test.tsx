/**
 * /invitacion: lo que ve quien abre el enlace de una invitación.
 *
 * Mirar la pantalla no escribe nada. Un enlace bueno muestra de quién es el
 * espacio y las opciones que correspondan a la sesión que haya; uno vencido,
 * adulterado o de una invitación que ya no sirve muestra «invitación vencida» y
 * ningún formulario.
 */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  locale: vi.fn(),
  sesion: vi.fn(),
  filaDeUsuario: vi.fn(),
  resumen: vi.fn(),
  cookie: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ cookies: async () => ({}) }));
vi.mock("@/data/scope", () => ({ enTenant: vi.fn() }));
vi.mock("@/lib/i18n/locale", () => ({ getServerLocale: h.locale }));
vi.mock("@/lib/auth/session", () => ({ getSessionContext: h.sesion }));
vi.mock("@/lib/auth/user-row", () => ({ getUserRowOrThrow: h.filaDeUsuario }));
vi.mock("@/app/login/actions", () => ({ signOut: vi.fn(), signInSso: vi.fn() }));
vi.mock("@/app/invitacion/actions", () => ({
  aceptarConClave: vi.fn(),
  aceptarConGoogle: vi.fn(),
  aceptarConSesion: vi.fn(),
  rechazarInvitacion: vi.fn(),
}));
vi.mock("@/server/alta/invitacion", async (original) => ({
  ...(await original<typeof import("@/server/alta/invitacion")>()),
  resumenDeInvitacion: h.resumen,
  leerCookieDeInvitacion: h.cookie,
}));

import InvitacionPage, { metadata } from "@/app/invitacion/page";
import { DURACION_DE_LA_INVITACION_MS, sellarInvitacion } from "@/server/alta/invitacion";

const base = {
  t: "aaaaaaaa-0000-4000-8000-00000000000a",
  e: "lucia@example.com",
  r: "analyst",
  n: "Lucía Fernández",
  i: "bbbbbbbb-0000-4000-8000-00000000000b",
} as const;

const enlace = (ahora = Date.now()) => sellarInvitacion(base, ahora);

async function pintar(t?: string | string[], e?: string | string[]) {
  const searchParams = { ...(t === undefined ? {} : { t }), ...(e === undefined ? {} : { e }) };
  return render(await InvitacionPage({ searchParams: Promise.resolve(searchParams) }));
}

const sesionDe = (email: string, emailVerified = true) => ({ user: { id: "u-1", email, emailVerified } });

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("BETTER_AUTH_SECRET", "test-better-auth-secret-key");
  h.locale.mockResolvedValue("es-AR");
  h.sesion.mockResolvedValue(null);
  h.filaDeUsuario.mockResolvedValue(null);
  h.cookie.mockResolvedValue(undefined);
  h.resumen.mockResolvedValue({ espacio: "Seguros Ejemplo", quien: "Jefa Ejemplo", exigeSso: false });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("/invitacion sin sesión y con un enlace bueno", () => {
  it("dice de quién es el espacio, para qué dirección es, y no pide nada antes de aceptar", async () => {
    await pintar(enlace());

    expect(screen.getByRole("heading", { name: "Te invitaron a ClaimMix" })).toBeInTheDocument();
    expect(screen.getByText("Jefa Ejemplo te invitó a Seguros Ejemplo.")).toBeInTheDocument();
    expect(screen.getByText("Invitación para lucia@example.com")).toBeInTheDocument();
    expect(h.resumen).toHaveBeenCalledWith(expect.objectContaining({ t: base.t, e: base.e }));
  });

  it("ofrece Google, una contraseña y rechazar", async () => {
    const { container } = await pintar(enlace());

    expect(screen.getByRole("button", { name: "Aceptar con Google" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Aceptar con contraseña" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Rechazar" })).toBeInTheDocument();
    for (const nombre of ["password", "repetir"]) {
      const campo = container.querySelector(`input[name="${nombre}"]`);
      expect(campo, nombre).toHaveAttribute("type", "password");
      expect(campo).toHaveAttribute("autocomplete", "new-password");
      expect(campo).toHaveAttribute("minlength", "8");
      expect(campo).toBeRequired();
    }
  });

  it("con un alias «+» de Gmail no ofrece Google, que volvería con la casilla base: sólo la contraseña y rechazar", async () => {
    const { container } = await pintar(sellarInvitacion({ ...base, e: "jefa+analista@googlemail.com" }, Date.now()));

    expect(screen.getByText("Invitación para jefa+analista@googlemail.com")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Aceptar con Google" })).toBeNull();
    expect(screen.queryByText("o con una contraseña")).toBeNull();
    expect(screen.getByRole("button", { name: "Aceptar con contraseña" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Rechazar" })).toBeInTheDocument();
    expect(container.querySelector('input[name="password"]')).toBeRequired();
  });

  it.each(["jefa@googlemail.com", "jefa+analista@example.com"])(
    "con %s, sin alias de Gmail, sigue ofreciendo Google",
    async (direccion) => {
      await pintar(sellarInvitacion({ ...base, e: direccion }, Date.now()));

      expect(screen.getByRole("button", { name: "Aceptar con Google" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Aceptar con contraseña" })).toBeInTheDocument();
    }
  );

  it("lleva el enlace en un campo oculto de cada formulario para que la acción lo vuelva a abrir", async () => {
    const t = enlace();
    const { container } = await pintar(t);

    const ocultos = container.querySelectorAll('input[type="hidden"][name="t"]');
    expect(ocultos).toHaveLength(3);
    for (const campo of ocultos) expect(campo).toHaveValue(t);
  });

  it("sin enlace en la dirección usa la cookie que dejó «Aceptar con Google»", async () => {
    const t = enlace();
    h.cookie.mockResolvedValue(t);

    const { container } = await pintar();

    expect(screen.getByText("Jefa Ejemplo te invitó a Seguros Ejemplo.")).toBeInTheDocument();
    expect(container.querySelector('input[type="hidden"][name="t"]')).toHaveValue(t);
  });

  it("habla el idioma del navegador", async () => {
    h.locale.mockResolvedValue("en-US");
    const { container } = await pintar(enlace());

    expect(container.querySelector("main")).toHaveAttribute("lang", "en-US");
    expect(screen.getByRole("heading", { name: "You have been invited to ClaimMix" })).toBeInTheDocument();
    expect(screen.getByText("Jefa Ejemplo invited you to Seguros Ejemplo.")).toBeInTheDocument();
  });

  it.each([
    ["clave", /entre 8 y 128 caracteres/],
    ["distintas", /no coinciden/],
    ["intentos", /demasiados intentos/],
    ["falla", /No pudimos crear tu cuenta/],
  ])("tras el motivo %s lo dice, y deja el formulario", async (motivo, texto) => {
    await pintar(enlace(), motivo);

    expect(screen.getByRole("alert")).toHaveTextContent(texto);
    expect(screen.getByRole("button", { name: "Aceptar con contraseña" })).toBeInTheDocument();
  });

  it("un motivo que no está en la lista no muestra nada, ni se refleja", async () => {
    const { container } = await pintar(enlace(), "<img src=x onerror=alert(1)>");

    expect(screen.queryByRole("alert")).toBeNull();
    expect(container.innerHTML).not.toContain("onerror");
  });

  it("el enlace no viaja a otros sitios: referrer no-referrer", () => {
    expect(metadata.referrer).toBe("no-referrer");
  });
});

describe("/invitacion con un enlace que no vale", () => {
  const vencida = (container: HTMLElement) => {
    expect(screen.getByRole("heading", { name: "Invitación vencida" })).toBeInTheDocument();
    expect(container.querySelector("form")).toBeNull();
    expect(container.textContent).not.toMatch(/lucia|Jefa|Seguros Ejemplo/);
  };

  it("sin enlace ni cookie", async () => {
    vencida((await pintar()).container);
    expect(h.resumen).not.toHaveBeenCalled();
  });

  it("con basura", async () => {
    vencida((await pintar("basura")).container);
  });

  it("adulterado", async () => {
    const t = enlace();
    vencida((await pintar(`${t.slice(0, -2)}${t.endsWith("AA") ? "BB" : "AA"}`)).container);
    expect(h.resumen).not.toHaveBeenCalled();
  });

  it("vencido", async () => {
    vencida((await pintar(enlace(Date.now() - DURACION_DE_LA_INVITACION_MS - 1000))).container);
    expect(h.resumen).not.toHaveBeenCalled();
  });

  it("de una invitación que ya no sirve: quien invitó perdió el rol o el espacio se dio de baja", async () => {
    h.resumen.mockResolvedValue(null);

    vencida((await pintar(enlace())).container);
  });

  it("con URL_DEL_OTRO_AMBIENTE manda a quien tenía su cuenta allá; sin ella no dice nada", async () => {
    expect((await pintar("basura")).container.querySelector("a")).toBeNull();
    cleanup();

    vi.stubEnv("URL_DEL_OTRO_AMBIENTE", "https://dev.example.com/");
    const { container } = await pintar("basura");

    expect(container.querySelector("a")).toHaveAttribute("href", "https://dev.example.com/login");
    expect(container).toHaveTextContent("¿Tu cuenta es de antes del cambio? Entrá en dev.example.com");
  });

  it("repetido en la dirección: vale el último", async () => {
    const t = enlace();

    await pintar(["basura", t]);

    expect(screen.getByRole("heading", { name: "Te invitaron a ClaimMix" })).toBeInTheDocument();
  });
});

describe("/invitacion con sesión", () => {
  it("la sesión de otra dirección dice que la invitación es de otra y ofrece cerrar sesión", async () => {
    h.sesion.mockResolvedValue(sesionDe("victima@example.com"));

    const { container } = await pintar(enlace());

    expect(screen.getByRole("heading", { name: "Esta invitación es para otra dirección" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cerrar sesión" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Aceptar/ })).toBeNull();
    expect(container.textContent).not.toMatch(/lucia|Jefa|Seguros Ejemplo/);
    expect(h.filaDeUsuario).not.toHaveBeenCalled();
  });

  it("la sesión de la dirección invitada con perfil dice «ya tenés un espacio»", async () => {
    h.sesion.mockResolvedValue(sesionDe("Lucia@Example.com"));
    h.filaDeUsuario.mockResolvedValue({ id: "u-1", tenant_id: "cccccccc-0000-4000-8000-00000000000c" });

    await pintar(enlace());

    expect(screen.getByRole("heading", { name: "Ya tenés un espacio" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Ir a mi espacio" })).toHaveAttribute("href", "/bandeja");
    expect(screen.queryByRole("button", { name: /Aceptar/ })).toBeNull();
  });

  it("la sesión de la dirección invitada, verificada y sin perfil sólo ofrece aceptar o rechazar", async () => {
    h.sesion.mockResolvedValue(sesionDe("lucia@example.com"));

    const { container } = await pintar(enlace());

    expect(screen.getByRole("button", { name: "Aceptar la invitación" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Rechazar" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Aceptar con Google" })).toBeNull();
    expect(container.querySelector('input[name="password"]')).toBeNull();
  });

  it("con el correo sin verificar no ofrece aceptar con la sesión: vuelve a las tres opciones", async () => {
    h.sesion.mockResolvedValue(sesionDe("lucia@example.com", false));

    await pintar(enlace());

    expect(screen.queryByRole("button", { name: "Aceptar la invitación" })).toBeNull();
    expect(screen.getByRole("button", { name: "Aceptar con Google" })).toBeInTheDocument();
  });
});

describe("/invitacion de un espacio que exige el SSO para ese dominio", () => {
  beforeEach(() => {
    h.resumen.mockResolvedValue({ espacio: "Seguros Ejemplo", quien: "Jefa Ejemplo", exigeSso: true });
  });

  it("no ofrece Google ni contraseña: sólo el SSO con la dirección invitada y rechazar", async () => {
    const { container } = await pintar(enlace());

    expect(screen.getByRole("heading", { name: "Tu empresa pide el SSO" })).toBeInTheDocument();
    expect(screen.getByText(/Seguros Ejemplo exige que las cuentas de tu dominio/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Entrar con el SSO de mi empresa" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Rechazar" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Aceptar con Google" })).toBeNull();
    expect(container.querySelector('input[name="password"]')).toBeNull();
    expect(container.querySelector('input[type="hidden"][name="email"]')).toHaveValue("lucia@example.com");
  });

  it("tampoco ofrece aceptar con la sesión de esa dirección", async () => {
    h.sesion.mockResolvedValue(sesionDe("lucia@example.com"));

    await pintar(enlace());

    expect(screen.queryByRole("button", { name: "Aceptar la invitación" })).toBeNull();
    expect(screen.getByRole("button", { name: "Entrar con el SSO de mi empresa" })).toBeInTheDocument();
  });

  it("habla el idioma del navegador", async () => {
    h.locale.mockResolvedValue("en-US");

    await pintar(enlace());

    expect(screen.getByRole("heading", { name: "Your company requires SSO" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign in with my company's SSO" })).toBeInTheDocument();
  });
});

describe("/invitacion rechazada", () => {
  it("dice que no se creó nada, sin necesitar el enlace", async () => {
    const { container } = await pintar(undefined, "rechazada");

    expect(screen.getByRole("heading", { name: "Invitación rechazada" })).toBeInTheDocument();
    expect(container.querySelector("form")).toBeNull();
    expect(h.resumen).not.toHaveBeenCalled();
  });
});
