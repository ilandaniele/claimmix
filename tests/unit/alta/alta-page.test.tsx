/**
 * /alta: qué se muestra y en qué orden.
 *
 * Con perfil va a /bandeja; sin el correo verificado, «revisá tu correo»; una
 * cuenta de operación no crea espacios; con el alta cerrada, el texto neutro; y
 * si no, el formulario, precargado si hay cookie `cm_alta`. El envío solo es un
 * script con el nonce del CSP, y nunca después de un error.
 */

import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  sesion: vi.fn(),
  fila: vi.fn(),
  cookie: vi.fn(),
  locale: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error("REDIRECT:" + url);
  },
}));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-csp-nonce": "nonce-de-prueba" }),
}));
vi.mock("@/lib/auth/session", () => ({ getSessionContext: h.sesion }));
vi.mock("@/lib/auth/user-row", () => ({ getUserRowOrThrow: h.fila }));
vi.mock("@/lib/auth/require-operator", () => ({
  isOperatorEmail: (e: string | null | undefined) => e === "ops@example.com",
}));
vi.mock("@/lib/i18n/locale", () => ({ getServerLocale: h.locale }));
vi.mock("@/server/alta/cookie", () => ({ leerCookieDeAlta: h.cookie, PARAMETRO_DE_VUELTA: "v" }));
vi.mock("@/app/login/actions", () => ({ signOut: vi.fn() }));
vi.mock("@/app/alta/actions", () => ({ crearMiEspacio: vi.fn() }));

import AltaPage from "@/app/alta/page";

const V = "aBcDeFgHiJkLmNoPqRsTuV";
const DATOS = { empresa: "Seguros del Sur", numero: "+5492916426930", locale: "es-AR", origen: "google", v: V, exp: 1 };

function sesion(extra: Record<string, unknown> = {}) {
  h.sesion.mockResolvedValue({ user: { id: "u-1", email: "ana@example.com", emailVerified: true, ...extra } });
}

async function pintar(e?: string | string[], v?: string | string[]) {
  const searchParams = { ...(e === undefined ? {} : { e }), ...(v === undefined ? {} : { v }) };
  return render(await AltaPage({ searchParams: Promise.resolve(searchParams) }));
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.ALTA_AUTOMATICA = "1";
  delete process.env.ALTA_NUMERO_AUTOMATICO;
  delete process.env.SIGNUP_ALLOWED_EMAILS;
  sesion();
  h.fila.mockResolvedValue(null);
  h.cookie.mockResolvedValue(null);
  h.locale.mockResolvedValue("es-AR");
});

describe("/alta antes del formulario", () => {
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

  it("sin el correo verificado dice «revisá tu correo» y no ofrece crear nada", async () => {
    sesion({ emailVerified: false });
    const { container } = await pintar();

    expect(screen.getByRole("heading", { name: "Revisá tu correo" })).toBeInTheDocument();
    expect(container.querySelector("#alta-form")).toBeNull();
    expect(screen.getByRole("button", { name: "Cerrar sesión" })).toBeInTheDocument();
  });

  it("una cuenta de operación no crea espacios", async () => {
    sesion({ email: "ops@example.com" });
    const { container } = await pintar();

    expect(screen.getByText(/Las cuentas de operación no crean espacios/)).toBeInTheDocument();
    expect(container.querySelector("#alta-form")).toBeNull();
  });

  it("con el alta cerrada para la dirección, el texto neutro", async () => {
    delete process.env.ALTA_AUTOMATICA;
    const { container } = await pintar();

    expect(screen.getByText(/Todavía no abrimos el alta para esta dirección/)).toBeInTheDocument();
    expect(container.querySelector("#alta-form")).toBeNull();
  });

  it("el orden: sin verificar gana a operación, y operación gana a alta cerrada", async () => {
    delete process.env.ALTA_AUTOMATICA;
    sesion({ email: "ops@example.com", emailVerified: false });
    await pintar();
    expect(screen.getByRole("heading", { name: "Revisá tu correo" })).toBeInTheDocument();
  });
});

describe("/alta con el formulario", () => {
  it("sin cookie, el formulario vacío, con los términos sin tildar y sin envío solo", async () => {
    const { container } = await pintar();

    expect(screen.getByLabelText("Nombre de tu empresa")).toHaveValue("");
    expect(screen.getByLabelText("WhatsApp de tu empresa")).toHaveValue("");
    expect(screen.getByRole("checkbox")).not.toBeChecked();
    expect(screen.getByRole("button", { name: "Crear mi espacio" })).toBeInTheDocument();
    expect(container.querySelector("script")).toBeNull();
  });

  it("con el número por código prendido, la ayuda del WhatsApp suma que tiene que recibir SMS o llamada", async () => {
    process.env.ALTA_NUMERO_AUTOMATICO = "1";
    const { container } = await pintar();

    const ayuda = container.querySelector("#alta-whatsapp-ayuda");
    expect(ayuda).toHaveTextContent("Con código de país, por ejemplo +54 9 11 5555 0000.");
    expect(ayuda).toHaveTextContent("Tiene que poder recibir un SMS o una llamada y no puede estar en uso en la app de WhatsApp ni en WhatsApp Business.");
    expect(screen.getByLabelText("WhatsApp de tu empresa")).toHaveAccessibleDescription(/Tiene que poder recibir un SMS/);
  });

  it("con el número por código prendido, en inglés", async () => {
    process.env.ALTA_NUMERO_AUTOMATICO = "1";
    h.locale.mockResolvedValue("en-US");
    const { container } = await pintar();

    expect(container.querySelector("#alta-whatsapp-ayuda")).toHaveTextContent(
      "It must be able to receive an SMS or a phone call, and it can't be in use in the WhatsApp or WhatsApp Business app."
    );
  });

  it("sin la bandera, la ayuda del WhatsApp es la de hoy", async () => {
    const { container } = await pintar();

    expect(container.querySelector("#alta-whatsapp-ayuda")?.textContent).toBe("Con código de país, por ejemplo +54 9 11 5555 0000.");
  });

  it("debajo del formulario, el texto fijo para quien ya tiene una empresa en ClaimMix", async () => {
    const { container } = await pintar();

    const texto = screen.getByText("¿Tu empresa ya usa ClaimMix? Pedile a un admin que te invite.");
    const formulario = container.querySelector("#alta-form")!;
    expect(formulario.contains(texto)).toBe(false);
    expect(formulario.compareDocumentPosition(texto) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(texto.querySelector("a, button, input")).toBeNull();
  });

  it("el texto fijo no consulta nada: la única lectura de la base es la del perfil", async () => {
    await pintar();

    expect(h.fila).toHaveBeenCalledTimes(1);
    expect(h.fila).toHaveBeenCalledWith("u-1");
  });

  it("el texto fijo, en inglés", async () => {
    h.locale.mockResolvedValue("en-US");
    await pintar();

    expect(screen.getByText("Does your company already use ClaimMix? Ask an admin to invite you.")).toBeInTheDocument();
  });

  it("el texto fijo es del formulario: no aparece en las pantallas sin formulario", async () => {
    sesion({ emailVerified: false });
    await pintar();

    expect(screen.queryByText(/ya usa ClaimMix/)).toBeNull();
  });

  it("pide los términos con los enlaces a /terms y /privacy", async () => {
    await pintar();

    expect(screen.getByRole("link", { name: "términos de uso" })).toHaveAttribute("href", "/terms");
    expect(screen.getByRole("link", { name: "política de privacidad" })).toHaveAttribute("href", "/privacy");
    expect(screen.getByRole("checkbox")).toBeRequired();
  });

  it("los campos van por los nombres que lee la acción", async () => {
    const { container } = await pintar();

    expect(container.querySelector('input[name="empresa"]')).not.toBeNull();
    expect(container.querySelector('input[name="whatsapp"]')).not.toBeNull();
    expect(container.querySelector('input[name="terminos"]')).not.toBeNull();
  });

  it("con cookie y llegando por su viaje, llega precargado y se envía solo con el nonce del CSP", async () => {
    h.cookie.mockResolvedValue(DATOS);
    const { container } = await pintar(undefined, V);

    expect(screen.getByLabelText("Nombre de tu empresa")).toHaveValue("Seguros del Sur");
    expect(screen.getByLabelText("WhatsApp de tu empresa")).toHaveValue("+5492916426930");
    expect(screen.getByRole("checkbox")).toBeChecked();
    const script = container.querySelector("script");
    expect(script).not.toBeNull();
    expect(script?.getAttribute("nonce") ?? script?.nonce).toBe("nonce-de-prueba");
    expect(script?.innerHTML).toContain("alta-form");
    expect(container.querySelector("#alta-form")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Crear mi espacio" })).toBeInTheDocument();
  });

  it.each([
    ["sin el número del viaje", undefined],
    ["con el de otro viaje", "otroViajeOtroViajeOtroV"],
    ["con uno vacío", ""],
  ])("con cookie pero %s: precarga, y NO se envía solo ni tilda los términos", async (_caso, v) => {
    h.cookie.mockResolvedValue(DATOS);
    const { container } = await pintar(undefined, v);

    expect(screen.getByLabelText("Nombre de tu empresa")).toHaveValue("Seguros del Sur");
    expect(screen.getByLabelText("WhatsApp de tu empresa")).toHaveValue("+5492916426930");
    expect(screen.getByRole("checkbox")).not.toBeChecked();
    expect(container.querySelector("script")).toBeNull();
  });

  it("si el número del viaje viene repetido, vale el último", async () => {
    h.cookie.mockResolvedValue(DATOS);
    const { container } = await pintar(undefined, ["otroViajeOtroViajeOtroV", V]);

    expect(container.querySelector("script")).not.toBeNull();
  });

  it.each(["datos", "cerrada", "intentos", "falla", "celular"])(
    "tras el error %s muestra su texto y NO se envía solo",
    async (motivo) => {
      h.cookie.mockResolvedValue(DATOS);
      const { container } = await pintar(motivo, V);

      expect(screen.getByRole("alert")).toBeInTheDocument();
      expect(container.querySelector("script")).toBeNull();
      expect(screen.getByLabelText("Nombre de tu empresa")).toHaveValue("Seguros del Sur");
    }
  );

  it("«cerrada» dice lo de hoy, sin contar de más", async () => {
    await pintar("cerrada");

    expect(screen.getByRole("alert")).toHaveTextContent("Por hoy no podemos crear más espacios. Probá mañana.");
  });

  it("un motivo que no está en la lista no muestra nada, ni se refleja", async () => {
    h.cookie.mockResolvedValue(DATOS);
    const { container } = await pintar("<img src=x onerror=alert(1)>", V);

    expect(screen.queryByRole("alert")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    // Sin error reconocido, la cookie sigue valiendo.
    expect(container.querySelector("script")).not.toBeNull();
  });

  it("si el motivo viene repetido, vale el último", async () => {
    await pintar(["datos", "falla"]);

    expect(screen.getByRole("alert")).toHaveTextContent("No pudimos crear tu espacio");
  });

  it("en inglés, en inglés", async () => {
    h.locale.mockResolvedValue("en-US");
    await pintar();

    expect(screen.getByRole("heading", { name: "Create your workspace" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create my workspace" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeInTheDocument();
  });
});
