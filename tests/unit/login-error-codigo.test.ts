/**
 * El código de error que muestra el login.
 *
 * Este test existe por un fallo que pasó todas las verificaciones: tipos, lint,
 * build, 2708 tests y cuatro checks de CI en verde. La pantalla mostraba «No
 * pudimos completar el ingreso. Probá de nuevo.» — genérico, y encima
 * aconsejando lo único que nunca iba a andar.
 *
 * La causa: `errorCallbackURL` traía su propia query (`/login?error=…`) y
 * Better Auth appendea con `sep = errorURL.includes("?") ? "&" : "?"`, así que
 * el parámetro llegaba DOS veces. Next entrega los repetidos como array, el
 * lookup fallaba y caía al texto de reserva.
 *
 * Nada de eso lo ve un tipo ni un build. Sólo se ve apretando el botón.
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("@/app/login/actions", () => ({ signInSso: vi.fn() }));
vi.mock("@/app/login/SignInForm", () => ({ SignInForm: () => null }));
vi.mock("@/lib/i18n/locale", () => ({ getServerLocale: async () => "es-AR" }));

import { claveDeError, codigoDeError } from "@/app/login/page";
import { getT } from "@/lib/i18n";

// Los textos viven en los diccionarios: acá se leen como los lee la pantalla.
const t = getT("es-AR");
const ERRORES = new Proxy({} as Record<string, string>, {
  get: (_, codigo: string) => t(claveDeError(codigo)),
});

describe("codigoDeError", () => {
  it("un código suelto pasa tal cual", () => {
    expect(codigoDeError("account_not_linked")).toBe("account_not_linked");
  });

  it("repetido, se queda con el último — el más cercano al fallo", () => {
    // Exactamente lo que producía Better Auth sobre una errorCallbackURL con query.
    expect(codigoDeError(["auth_callback_failed", "account_not_linked"])).toBe(
      "account_not_linked"
    );
  });

  it("sin error, no hay código", () => {
    expect(codigoDeError(undefined)).toBeNull();
    expect(codigoDeError([])).toBeNull();
  });

  it("el código repetido encuentra su mensaje, que era el bug", () => {
    const codigo = codigoDeError(["auth_callback_failed", "account_not_linked"]);
    expect(codigo).not.toBeNull();
    expect(ERRORES[codigo!]).toBeDefined();
  });

  it("el mensaje de cuenta sin vincular dice qué hacer, no «probá de nuevo»", () => {
    // Reintentar es lo único que no puede funcionar: la cuenta seguirá sin
    // vincular. El texto tiene que mandar al camino que sí destraba: la
    // contraseña, o recuperarla si no se acuerda.
    const mensaje = ERRORES.account_not_linked;
    expect(mensaje).toMatch(/contraseña/i);
    expect(mensaje).toMatch(/recuperala/i);
    expect(mensaje).not.toMatch(/probá de nuevo/i);
  });
});

/**
 * Lo que se le dice a quien falla el ingreso con el SSO de su empresa (B19).
 *
 * Son sólo tres códigos los que llegan a la pantalla (el resto se colapsa en
 * `sso_fallo` antes de salir del servidor), y ninguno puede explicar por qué falló
 * por dentro: si «el dominio no tiene SSO» se dijera distinto de «el IdP no
 * contestó», se podría averiguar qué aseguradoras usan la plataforma.
 */
describe("los errores del SSO", () => {
  const CODIGOS = ["sso_requerido", "sso_otro_inquilino", "sso_fallo"] as const;

  it("los tres tienen su texto propio", () => {
    for (const codigo of CODIGOS) expect(ERRORES[codigo], codigo).toBeTruthy();
    expect(new Set(CODIGOS.map((c) => ERRORES[c])).size).toBe(CODIGOS.length);
  });

  it("ninguno cuenta cómo funciona el SSO por dentro", () => {
    for (const codigo of CODIGOS) {
      expect(ERRORES[codigo], codigo).not.toMatch(/idp|nonce|token|issuer|state|jwt|oidc|dns|txt|secret|stack|exception|undefined/i);
    }
  });

  it("dicen qué hacer: entrar con el SSO, escribir, o usar la contraseña", () => {
    expect(ERRORES.sso_requerido).toMatch(/SSO/);
    expect(ERRORES.sso_otro_inquilino).toMatch(/escribinos/i);
    expect(ERRORES.sso_fallo).toMatch(/contraseña/i);
  });

  it("el fallo genérico no dice si el dominio tiene SSO o no", () => {
    expect(ERRORES.sso_fallo).not.toMatch(/no tiene|no está configurado|no existe|sin sso/i);
  });

  it("un código repetido por la URL de error del SSO encuentra igual su texto", () => {
    const codigo = codigoDeError(["sso_fallo", "sso_requerido"]);
    expect(ERRORES[codigo!]).toBe(ERRORES.sso_requerido);
  });
});

/**
 * El alta por Google negada por `user.create.before` vuelve a /login con
 * `registro_cerrado` (o `sso_requerido`). `unable_to_create_user` queda para lo
 * que Better Auth negó por su cuenta. Ninguno de los dos explica por qué ni
 * nombra el SSO: «tu correo no está habilitado» y «tu dominio exige SSO» no
 * pueden distinguirse desde afuera.
 */
describe("el alta por Google negada", () => {
  it("los dos códigos tienen su texto propio y no caen al genérico", () => {
    for (const codigo of ["registro_cerrado", "unable_to_create_user"]) {
      expect(claveDeError(codigo)).not.toBe("login.errores.generico");
      expect(ERRORES[codigo], codigo).toBeTruthy();
      expect(codigoDeError(codigo)).toBe(codigo);
    }
  });

  it("no mandan a la contraseña ni nombran el SSO", () => {
    for (const codigo of ["registro_cerrado", "unable_to_create_user"]) {
      expect(ERRORES[codigo], codigo).not.toMatch(/contraseña|SSO/i);
    }
  });

  it("no distinguen «dominio con SSO» de «correo no habilitado»", () => {
    for (const codigo of ["registro_cerrado", "unable_to_create_user"]) {
      expect(ERRORES[codigo], codigo).not.toMatch(/exige|exigid|no está habilitad|lista|permitid/i);
    }
  });
});
