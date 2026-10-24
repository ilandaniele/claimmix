/**
 * /alta: el segundo paso del alta, qué se muestra y en qué orden.
 *
 * Con perfil va a /bandeja; sin el correo verificado, «revisá tu correo»; una
 * cuenta de operación no crea espacios; con el alta cerrada, el texto neutro más
 * el de «mi empresa ya usa ClaimMix»; y si no, los dos caminos. La pantalla no
 * trae nada del paso anterior (ni cookie ni parámetros), no se envía sola y no
 * consulta la base más que para el perfil: «mi empresa ya usa ClaimMix» es un
 * texto fijo que no dice qué empresas existen, y no manda al SSO: el SSO rechaza a
 * quien ya tiene cuenta sin perfil. Si este navegador trae una invitación para la
 * dirección, el enlace a /invitacion reemplaza ese texto (también con el alta
 * cerrada) y el camino arranca abierto.
 */

import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  sesion: vi.fn(),
  fila: vi.fn(),
  invitacion: vi.fn(),
  locale: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error("REDIRECT:" + url);
  },
}));
vi.mock("@/lib/auth/session", () => ({ getSessionContext: h.sesion }));
vi.mock("@/lib/auth/user-row", () => ({ getUserRowOrThrow: h.fila }));
vi.mock("@/lib/auth/require-operator", () => ({
  isOperatorEmail: (e: string | null | undefined) => e === "ops@example.com",
}));
vi.mock("@/lib/i18n/locale", () => ({ getServerLocale: h.locale }));
vi.mock("@/server/alta/invitacion", () => ({ invitacionDeLaSesion: h.invitacion }));
vi.mock("@/app/login/actions", () => ({ signOut: vi.fn() }));
vi.mock("@/app/alta/actions", () => ({ crearMiEspacio: vi.fn() }));

import { enUS, esAR } from "@/lib/i18n";
import AltaPage, { generateMetadata } from "@/app/alta/page";

const UNIRME_ES = /Pedile a un administrador de tu empresa que invite a/;
/** Lo que devuelve `invitacionDeLaSesion` cuando la cookie trae una invitación para esta dirección. */
const INVITACION = { e: "ana@example.com" };

function sesion(extra: Record<string, unknown> = {}) {
  h.sesion.mockResolvedValue({ user: { id: "u-1", email: "ana@example.com", emailVerified: true, ...extra } });
}

async function pintar(e?: string | string[]) {
  const searchParams = e === undefined ? {} : { e };
  return render(await AltaPage({ searchParams: Promise.resolve(searchParams) }));
}

const caminos = (container: HTMLElement) => [...container.querySelectorAll<HTMLDetailsElement>("details")];

beforeEach(() => {
  vi.clearAllMocks();
  process.env.ALTA_AUTOMATICA = "1";
  delete process.env.ALTA_NUMERO_AUTOMATICO;
  delete process.env.ALTA_WABA_PROPIA;
  delete process.env.SIGNUP_ALLOWED_EMAILS;
  sesion();
  h.fila.mockResolvedValue(null);
  h.invitacion.mockResolvedValue(null);
  h.locale.mockResolvedValue("es-AR");
});

describe("/alta antes de los caminos", () => {
  it("sin sesión va a /login", async () => {
    h.sesion.mockResolvedValue(null);

    await expect(pintar()).rejects.toThrow("REDIRECT:/login");
  });

  it("con perfil va a /bandeja", async () => {
    h.fila.mockResolvedValue({ id: "u-1", tenant_id: "t-1" });

    await expect(pintar()).rejects.toThrow("REDIRECT:/bandeja");
  });

  it("si la base no responde, tira: no confunde la falla con «sin espacio»", async () => {
    h.fila.mockRejectedValue(new Error("timeout"));

    await expect(pintar()).rejects.toThrow("timeout");
  });

  it("sin el correo verificado dice «revisá tu correo» y no ofrece ningún camino", async () => {
    sesion({ emailVerified: false });
    const { container } = await pintar();

    expect(screen.getByRole("heading", { name: "Revisá tu correo" })).toBeInTheDocument();
    expect(container.querySelector("#alta-form")).toBeNull();
    expect(caminos(container)).toHaveLength(0);
    expect(screen.getByRole("button", { name: "Cerrar sesión" })).toBeInTheDocument();
  });

  it("una cuenta de operación no crea espacios", async () => {
    sesion({ email: "ops@example.com" });
    const { container } = await pintar();

    expect(screen.getByText(/Las cuentas de operación no crean espacios/)).toBeInTheDocument();
    expect(container.querySelector("#alta-form")).toBeNull();
    expect(caminos(container)).toHaveLength(0);
  });

  it("con el alta cerrada para la dirección, el texto neutro y el de «mi empresa ya usa ClaimMix», sin formulario", async () => {
    delete process.env.ALTA_AUTOMATICA;
    const { container } = await pintar();

    expect(screen.getByText(/Todavía no abrimos el alta para esta dirección/)).toBeInTheDocument();
    expect(screen.getByText(UNIRME_ES)).toHaveTextContent("invite a ana@example.com.");
    // «Escribinos» y «pedile a un administrador» son dos pedidos distintos: el segundo lleva su rótulo para no leerse como contradicción del primero.
    expect(screen.getByText("Mi empresa ya usa ClaimMix").compareDocumentPosition(screen.getByText(UNIRME_ES))).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    );
    expect(container.querySelector("#alta-form")).toBeNull();
    expect(caminos(container)).toHaveLength(0);
  });

  it("con el alta cerrada y una invitación en este navegador, el enlace a /invitacion reemplaza el pedido", async () => {
    delete process.env.ALTA_AUTOMATICA;
    h.invitacion.mockResolvedValue(INVITACION);
    const { container } = await pintar();

    expect(screen.getByText(/Todavía no abrimos el alta para esta dirección/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Seguir con tu invitación" })).toHaveAttribute("href", "/invitacion");
    expect(screen.getByText("Mi empresa ya usa ClaimMix")).toBeInTheDocument();
    expect(screen.queryByText(UNIRME_ES)).toBeNull();
    expect(container.querySelector("#alta-form")).toBeNull();
    expect(caminos(container)).toHaveLength(0);
  });

  it("el orden: sin verificar gana a operación, y operación gana a alta cerrada", async () => {
    delete process.env.ALTA_AUTOMATICA;
    sesion({ email: "ops@example.com", emailVerified: false });
    await pintar();
    expect(screen.getByRole("heading", { name: "Revisá tu correo" })).toBeInTheDocument();
  });
});

describe("/alta con los dos caminos", () => {
  it("pregunta qué vino a hacer, con los dos caminos en un mismo grupo de <details>", async () => {
    const { container } = await pintar();

    expect(screen.getByRole("heading", { name: "Tu cuenta está lista" })).toBeInTheDocument();
    expect(screen.getByText("¿Qué querés hacer ahora?")).toBeInTheDocument();
    const [empresa, unirme] = caminos(container);
    expect(caminos(container)).toHaveLength(2);
    expect(empresa.querySelector("summary")).toHaveTextContent("Dar de alta mi empresa");
    expect(unirme.querySelector("summary")).toHaveTextContent("Mi empresa ya usa ClaimMix");
    // Un mismo `name`: el navegador deja abierto uno solo, sin JavaScript y sin `?camino=`.
    expect(empresa.getAttribute("name")).toBe("camino");
    expect(unirme.getAttribute("name")).toBe("camino");
  });

  it("el formulario de la empresa está en el primer camino y el texto de unirme en el segundo", async () => {
    const { container } = await pintar();

    const [empresa, unirme] = caminos(container);
    expect(empresa.querySelector("#alta-form")).not.toBeNull();
    expect(unirme.querySelector("#alta-form")).toBeNull();
    expect(unirme).toHaveTextContent(UNIRME_ES);
    expect(unirme.querySelector("form, input, button")).toBeNull();
  });

  it("el formulario llega vacío, con los términos sin tildar: nada viaja del paso anterior", async () => {
    const { container } = await pintar();

    expect(screen.getByLabelText("Nombre de tu empresa")).toHaveValue("");
    expect(screen.getByLabelText("WhatsApp de tu empresa")).toHaveValue("");
    expect(screen.getByRole("checkbox")).not.toBeChecked();
    expect(screen.getByRole("button", { name: "Crear mi espacio" })).toBeInTheDocument();
    // Sin envío automático: ni script, ni nonce, ni número de viaje.
    expect(container.querySelector("script")).toBeNull();
    expect(container.innerHTML).not.toMatch(/nonce|\?v=|[?&]v=/);
  });

  it("sin error, los dos caminos arrancan cerrados", async () => {
    const { container } = await pintar();

    expect(caminos(container).map((d) => d.open)).toEqual([false, false]);
  });

  it("tras un error, el camino de la empresa se abre y el otro no", async () => {
    const { container } = await pintar("datos");

    expect(caminos(container).map((d) => d.open)).toEqual([true, false]);
  });

  it("los campos van por los nombres que lee la acción", async () => {
    const { container } = await pintar();

    expect(container.querySelector('input[name="empresa"]')).not.toBeNull();
    expect(container.querySelector('input[name="whatsapp"]')).not.toBeNull();
    expect(container.querySelector('input[name="terminos"]')).not.toBeNull();
    expect(screen.getByLabelText("Nombre de tu empresa")).toBeRequired();
    expect(screen.getByLabelText("WhatsApp de tu empresa")).toBeRequired();
  });

  it("pide los términos con los enlaces a /terms y /privacy", async () => {
    await pintar();

    expect(screen.getByRole("link", { name: "términos de uso" })).toHaveAttribute("href", "/terms");
    expect(screen.getByRole("link", { name: "política de privacidad" })).toHaveAttribute("href", "/privacy");
    expect(screen.getByRole("checkbox")).toBeRequired();
  });

  it("la ayuda del WhatsApp es la del diccionario sin ninguna bandera", async () => {
    const { container } = await pintar();

    expect(container.querySelector("#alta-whatsapp-ayuda")?.textContent).toBe(esAR["alta.whatsapp.ayuda"]);
  });

  it("la ayuda del WhatsApp aclara que no es el celular personal, da un ejemplo de otro país y cierra con punto", () => {
    expect(esAR["alta.whatsapp.ayuda"]).toContain("celular personal");
    expect(enUS["alta.whatsapp.ayuda"]).toContain("personal phone");
    for (const ayuda of [esAR["alta.whatsapp.ayuda"], enUS["alta.whatsapp.ayuda"]]) {
      expect(ayuda).toContain("+54 9 11 5555 0000");
      expect(ayuda).toContain("+1 202 555 0123");
      expect(ayuda.endsWith(".")).toBe(true);
    }
  });

  it("el campo del WhatsApp no sugiere un país: el placeholder es sólo el signo más", async () => {
    await pintar();

    const campo = screen.getByLabelText("WhatsApp de tu empresa");
    expect(campo).toHaveAttribute("placeholder", "+…");
    expect(campo.getAttribute("placeholder")).not.toMatch(/^\+54/);
  });

  it("con el número por código prendido, la ayuda del WhatsApp suma que tiene que recibir SMS o llamada", async () => {
    process.env.ALTA_NUMERO_AUTOMATICO = "1";
    const { container } = await pintar();

    const ayuda = container.querySelector("#alta-whatsapp-ayuda");
    expect(ayuda).toHaveTextContent(esAR["alta.whatsapp.ayuda"]);
    // Dice para qué hace falta poder recibir el SMS o la llamada, no sólo que hace falta.
    expect(ayuda).toHaveTextContent(
      "Meta manda un código por SMS o por llamada para verificarlo: tiene que poder recibirlo y no puede estar en uso en la app de WhatsApp ni en WhatsApp Business."
    );
    expect(screen.getByLabelText("WhatsApp de tu empresa")).toHaveAccessibleDescription(/Meta manda un código/);
  });

  it("con el número por código prendido, en inglés", async () => {
    process.env.ALTA_NUMERO_AUTOMATICO = "1";
    h.locale.mockResolvedValue("en-US");
    const { container } = await pintar();

    expect(container.querySelector("#alta-whatsapp-ayuda")).toHaveTextContent(
      `${enUS["alta.whatsapp.ayuda"]} Meta sends a code by SMS or phone call to verify it: it must be able to receive it, and it can't be in use in the WhatsApp or WhatsApp Business app.`
    );
  });

  it("con la WABA propia prendida, la ayuda avisa que el número se conecta con Facebook en el paso siguiente", async () => {
    process.env.ALTA_WABA_PROPIA = "1";
    process.env.META_APP_ID = "fake-app-id";
    process.env.META_ES_CONFIG_ID = "fake-config-id";
    process.env.WHATSAPP_APP_SECRET = "fake-app-secret-key";
    try {
      const { container } = await pintar();

      expect(container.querySelector("#alta-whatsapp-ayuda")).toHaveTextContent(
        "En el paso siguiente lo conectás con tu cuenta de Facebook. Meta manda un código por SMS o por llamada para verificarlo"
      );
    } finally {
      delete process.env.META_APP_ID;
      delete process.env.META_ES_CONFIG_ID;
      delete process.env.WHATSAPP_APP_SECRET;
    }
  });

  it("en inglés, en inglés", async () => {
    h.locale.mockResolvedValue("en-US");
    const { container } = await pintar();

    expect(screen.getByRole("heading", { name: "Your account is ready" })).toBeInTheDocument();
    expect(screen.getByText("What would you like to do?")).toBeInTheDocument();
    expect(caminos(container)[0].querySelector("summary")).toHaveTextContent("Register my company");
    expect(caminos(container)[1].querySelector("summary")).toHaveTextContent("My company already uses ClaimMix");
    expect(screen.getByRole("button", { name: "Create my workspace" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeInTheDocument();
    expect(screen.getByText(/Ask an administrator at your company to invite ana@example.com/)).toBeInTheDocument();
    // El SSO no se ofrece: la pantalla de ingreso no tiene ese botón en inglés y rechazaría esta cuenta.
    expect(document.body.textContent).not.toMatch(/SSO/);
  });
});

describe("«Mi empresa ya usa ClaimMix»", () => {
  it("es un texto fijo con la dirección de la sesión: dice qué hacer y no nombra ninguna empresa", async () => {
    await pintar();

    const texto = screen.getByText(UNIRME_ES);
    expect(texto).toHaveTextContent(
      "Pedile a un administrador de tu empresa que invite a ana@example.com. Te va a llegar un correo con el enlace de la invitación."
    );
    expect(texto.querySelector("a, button, input")).toBeNull();
  });

  it("no manda al SSO: el SSO rechaza una cuenta que ya existe sin perfil, y esta lo es", async () => {
    const { container } = await pintar();

    expect(container.textContent).not.toMatch(/SSO|inicio de sesión único|pantalla de ingreso/);
    expect(container.querySelector('a[href^="/login"]')).toBeNull();
  });

  it("no consulta nada: la única lectura de la base es la del perfil, una por pantalla", async () => {
    await pintar();

    expect(h.fila).toHaveBeenCalledTimes(1);
    expect(h.fila).toHaveBeenCalledWith("u-1");
  });

  it("dos direcciones de dominios distintos ven el mismo texto, salvo la dirección: no revela qué empresas existen", async () => {
    sesion({ email: "ana@una-aseguradora.example.com" });
    const una = await pintar();
    const textoUna = caminos(una.container)[1].innerHTML;
    una.unmount();

    sesion({ email: "luis@otra-corredora.example.org" });
    const otra = await pintar();
    const textoOtra = caminos(otra.container)[1].innerHTML;

    expect(textoUna).toContain("ana@una-aseguradora.example.com");
    expect(textoOtra).toContain("luis@otra-corredora.example.org");
    expect(textoUna.replace("ana@una-aseguradora.example.com", "{correo}")).toBe(
      textoOtra.replace("luis@otra-corredora.example.org", "{correo}")
    );
    expect(h.fila).toHaveBeenCalledTimes(2);
  });

  it("una dirección con «$&» en la parte local se muestra tal cual, sin armar otro texto", async () => {
    sesion({ email: "a$&b@example.com" });
    await pintar();

    expect(screen.getByText(UNIRME_ES)).toHaveTextContent("invite a a$&b@example.com.");
  });

  it("sin invitación en este navegador no hay enlace a /invitacion", async () => {
    const { container } = await pintar();

    expect(screen.queryByRole("link", { name: "Seguir con tu invitación" })).toBeNull();
    expect(container.querySelector('a[href^="/invitacion"]')).toBeNull();
    expect(h.invitacion).toHaveBeenCalledWith("ana@example.com");
  });

  it("con una invitación para esta dirección en este navegador, un enlace a /invitacion sin `?t=` y sin redirigir", async () => {
    h.invitacion.mockResolvedValue(INVITACION);
    const { container } = await pintar();

    const enlace = screen.getByRole("link", { name: "Seguir con tu invitación" });
    expect(enlace).toHaveAttribute("href", "/invitacion");
    expect(enlace.getAttribute("href")).not.toContain("t=");
    expect(caminos(container)[1].contains(enlace)).toBe(true);
    // El enlace es un texto: la pantalla sigue mostrando los dos caminos.
    expect(caminos(container)).toHaveLength(2);
  });

  it("con la invitación, el enlace reemplaza el pedido de que alguien invite y el camino arranca abierto", async () => {
    h.invitacion.mockResolvedValue(INVITACION);
    const { container } = await pintar();

    const [empresa, unirme] = caminos(container);
    expect(unirme).toHaveTextContent("Seguir con tu invitación");
    expect(unirme).not.toHaveTextContent(UNIRME_ES);
    expect(screen.queryByText(UNIRME_ES)).toBeNull();
    expect([empresa.open, unirme.open]).toEqual([false, true]);
  });

  it("con la invitación y un error del formulario, queda abierto el de la empresa: nunca dos abiertos en el grupo", async () => {
    h.invitacion.mockResolvedValue(INVITACION);
    const { container } = await pintar("datos");

    expect(caminos(container).map((d) => d.open)).toEqual([true, false]);
  });

  it("el enlace a la invitación, en inglés", async () => {
    h.invitacion.mockResolvedValue(INVITACION);
    h.locale.mockResolvedValue("en-US");
    await pintar();

    expect(screen.getByRole("link", { name: "Continue with your invitation" })).toHaveAttribute("href", "/invitacion");
  });

  it("la invitación se busca con la dirección de la sesión, en las dos pantallas con alta abierta o cerrada", async () => {
    await pintar();
    expect(h.invitacion).toHaveBeenLastCalledWith("ana@example.com");

    delete process.env.ALTA_AUTOMATICA;
    await pintar();
    expect(h.invitacion).toHaveBeenCalledTimes(2);
  });

  it("no consulta la invitación en las pantallas sin caminos", async () => {
    sesion({ emailVerified: false });
    await pintar();

    expect(h.invitacion).not.toHaveBeenCalled();
  });

  it("no aparece en las pantallas sin caminos", async () => {
    sesion({ emailVerified: false });
    await pintar();

    expect(screen.queryByText(/ya usa ClaimMix/)).toBeNull();
    expect(screen.queryByText(UNIRME_ES)).toBeNull();
  });
});

describe("/alta tras un error", () => {
  it.each(["datos", "cerrada", "intentos", "falla", "celular"])(
    "el motivo %s muestra su texto, abre el camino de la empresa y no se envía solo",
    async (motivo) => {
      const { container } = await pintar(motivo);

      expect(screen.getByRole("alert")).toBeInTheDocument();
      expect(container.querySelector("script")).toBeNull();
      expect(caminos(container)[0].open).toBe(true);
    }
  );

  it("«cerrada» dice lo de hoy, sin contar de más", async () => {
    await pintar("cerrada");

    expect(screen.getByRole("alert")).toHaveTextContent("Por hoy no podemos crear más espacios. Probá mañana.");
  });

  it("un motivo que no está en la lista no muestra nada, ni se refleja, ni abre nada", async () => {
    const { container } = await pintar("<img src=x onerror=alert(1)>");

    expect(screen.queryByRole("alert")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(caminos(container).map((d) => d.open)).toEqual([false, false]);
  });

  it("si el motivo viene repetido, vale el último", async () => {
    await pintar(["datos", "falla"]);

    expect(screen.getByRole("alert")).toHaveTextContent("No pudimos crear tu espacio");
  });
});

describe("el título de la pestaña", () => {
  it("sigue al idioma y no promete una cuenta lista: la pantalla también dice «revisá tu correo» o «alta cerrada»", async () => {
    expect(await generateMetadata()).toEqual({ title: "Alta — ClaimMix" });

    h.locale.mockResolvedValue("en-US");
    expect(await generateMetadata()).toEqual({ title: "Signup — ClaimMix" });
  });
});
