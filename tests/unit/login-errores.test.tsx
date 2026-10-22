/**
 * Lo que la pantalla de entrada dice cuando algo falló antes de llegar, en los
 * dos idiomas.
 *
 * Se renderiza la página de verdad, con el código en la URL como lo deja
 * Better Auth, y se lee lo que aparece. Que el diccionario tenga la clave no
 * alcanza: lo que importa es que la persona vea ese texto y no el genérico, y
 * que nunca vea el `error_description` que la librería agrega en inglés.
 */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ locale: "es-AR" as "es-AR" | "en-US" }));

vi.mock("@/app/login/actions", () => ({ signInSso: vi.fn() }));
vi.mock("@/app/login/SignInForm", () => ({ SignInForm: () => null }));
vi.mock("@/lib/i18n/locale", () => ({ getServerLocale: async () => h.locale }));

import LoginPage, { CODIGOS_DE_ERROR } from "@/app/login/page";
import { getT } from "@/lib/i18n";
import { enUSServidor } from "@/lib/i18n/en-US.servidor";
import { esARServidor } from "@/lib/i18n/es-AR.servidor";

const DICCIONARIO = { "es-AR": esARServidor, "en-US": enUSServidor } as const;
const IDIOMAS = ["es-AR", "en-US"] as const;

async function pintar(
  searchParams: { aviso?: string; error?: string | string[]; error_description?: string },
  locale: (typeof IDIOMAS)[number]
) {
  h.locale = locale;
  render(await LoginPage({ searchParams: Promise.resolve(searchParams) }));
}

beforeEach(() => {
  h.locale = "es-AR";
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("cada código de error muestra su texto", () => {
  it("la lista cerrada es la que pide el plan", () => {
    expect([...CODIGOS_DE_ERROR].sort()).toEqual(
      [
        "registro_cerrado",
        "sso_requerido",
        "sso_otro_inquilino",
        "sso_fallo",
        "usuario_de_baja",
        "alta_cerrada",
        "demasiados_intentos",
        "email_no_verificado",
        "invitacion_vencida",
        "google_signin_failed",
        "auth_callback_failed",
        "account_not_linked",
        "unable_to_create_user",
      ].sort()
    );
  });

  for (const idioma of IDIOMAS) {
    for (const codigo of CODIGOS_DE_ERROR) {
      it(`${codigo} en ${idioma}`, async () => {
        await pintar({ error: codigo }, idioma);

        const texto = DICCIONARIO[idioma][`login.errores.${codigo}`];
        expect(texto).toBeTruthy();
        expect(screen.getByRole("alert")).toHaveTextContent(texto);
        expect(screen.getByRole("alert")).not.toHaveTextContent(DICCIONARIO[idioma]["login.errores.generico"]);
      });
    }
  }

  it("cada idioma tiene textos distintos para cada código, y el inglés no es el castellano copiado", () => {
    for (const codigo of CODIGOS_DE_ERROR) {
      const clave = `login.errores.${codigo}` as const;
      expect(enUSServidor[clave], codigo).not.toBe(esARServidor[clave]);
    }
    expect(enUSServidor["login.errores.generico"]).not.toBe(esARServidor["login.errores.generico"]);
  });
});

describe("un código que no está en la lista", () => {
  for (const idioma of IDIOMAS) {
    it(`muestra el texto genérico en ${idioma}`, async () => {
      await pintar({ error: "algo_que_nadie_conoce" }, idioma);

      expect(screen.getByRole("alert")).toHaveTextContent(DICCIONARIO[idioma]["login.errores.generico"]);
    });
  }

  it("una clave del prototipo no abre nada: cae en el genérico", async () => {
    await pintar({ error: "constructor" }, "es-AR");

    expect(screen.getByRole("alert")).toHaveTextContent(esARServidor["login.errores.generico"]);
  });

  it("sin código no hay alerta", async () => {
    await pintar({}, "es-AR");

    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("el código repetido y la descripción de la librería", () => {
  it("se queda con el último código cuando la URL trae dos", async () => {
    await pintar({ error: ["auth_callback_failed", "registro_cerrado"] }, "es-AR");

    expect(screen.getByRole("alert")).toHaveTextContent(esARServidor["login.errores.registro_cerrado"]);
  });

  it("error_description nunca se muestra", async () => {
    const descripcion = "Unable to create user because fake-detalle-interno";

    await pintar({ error: "registro_cerrado", error_description: descripcion }, "en-US");

    expect(screen.getByRole("alert")).not.toHaveTextContent("fake-detalle-interno");
    expect(document.body).not.toHaveTextContent("fake-detalle-interno");
  });
});

describe("lo que cada texto cuenta", () => {
  for (const idioma of IDIOMAS) {
    it(`registro_cerrado y unable_to_create_user no mencionan el SSO en ${idioma}`, () => {
      for (const codigo of ["registro_cerrado", "unable_to_create_user"] as const) {
        expect(DICCIONARIO[idioma][`login.errores.${codigo}`], codigo).not.toMatch(/\bSSO\b|single sign|sign-on/i);
      }
    });

    it(`ningún texto nombra detalles internos en ${idioma}`, () => {
      for (const codigo of CODIGOS_DE_ERROR) {
        expect(DICCIONARIO[idioma][`login.errores.${codigo}`], codigo).not.toMatch(
          /idp|nonce|token|issuer|jwt|oidc|dns|txt|secret|stack|exception|undefined|forbidden|unprocessable/i
        );
      }
    });
  }

  it("account_not_linked manda a la contraseña o a recuperarla", () => {
    expect(esARServidor["login.errores.account_not_linked"]).toMatch(/contraseña/);
    expect(esARServidor["login.errores.account_not_linked"]).toMatch(/recuperala/);
    expect(enUSServidor["login.errores.account_not_linked"]).toMatch(/password/);
    expect(enUSServidor["login.errores.account_not_linked"]).toMatch(/reset/);
  });
});

describe("la pista del otro ambiente", () => {
  for (const idioma of IDIOMAS) {
    it(`con URL_DEL_OTRO_AMBIENTE manda allá en ${idioma}; sin ella no hay enlace`, async () => {
      await pintar({}, idioma);
      expect(screen.queryByRole("link", { name: "dev.example.com" })).toBeNull();
      cleanup();

      vi.stubEnv("URL_DEL_OTRO_AMBIENTE", "https://dev.example.com");
      await pintar({}, idioma);

      expect(screen.getByRole("link", { name: "dev.example.com" })).toHaveAttribute("href", "https://dev.example.com/login");
      expect(screen.getByRole("link", { name: "dev.example.com" }).parentElement).toHaveTextContent(
        DICCIONARIO[idioma]["login.otroAmbiente"].replace("{url}", "dev.example.com")
      );
    });
  }

  it("una URL que no es http no se pinta", async () => {
    vi.stubEnv("URL_DEL_OTRO_AMBIENTE", "javascript:alert(1)");
    await pintar({}, "es-AR");

    expect(screen.queryByText(/antes del cambio/)).toBeNull();
  });
});

describe("los avisos", () => {
  for (const idioma of IDIOMAS) {
    it(`ya_tenes_cuenta se muestra en ${idioma}`, async () => {
      await pintar({ aviso: "ya_tenes_cuenta" }, idioma);

      expect(screen.getByRole("status")).toHaveTextContent(DICCIONARIO[idioma]["login.aviso.yaTenesCuenta"]);
    });

    it(`revisa_tu_correo se muestra en ${idioma}`, async () => {
      await pintar({ aviso: "revisa_tu_correo" }, idioma);

      expect(screen.getByRole("status")).toHaveTextContent(getT(idioma)("login.aviso.revisaTuCorreo"));
    });
  }

  it("un aviso que no existe no pinta nada", async () => {
    await pintar({ aviso: "constructor" }, "es-AR");

    expect(screen.queryByRole("status")).toBeNull();
  });
});
