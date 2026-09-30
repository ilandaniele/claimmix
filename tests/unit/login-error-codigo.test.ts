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

import { describe, it, expect } from "vitest";
import { codigoDeError, ERRORES } from "@/app/login/page";

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
    // vincular. El texto tiene que mandar al camino que sí destraba.
    const mensaje = ERRORES.account_not_linked;
    expect(mensaje).toMatch(/contraseña/i);
    expect(mensaje).toMatch(/configuración/i);
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
 * El alta por Google negada por `user.create.before` (correo fuera de la lista, o
 * dominio con «Exigir SSO») vuelve a /login con `unable_to_create_user`. Sin texto
 * propio caía al genérico, que manda a entrar «con tu contraseña» a quien nunca
 * tuvo una.
 */
describe("el alta por Google negada", () => {
  it("tiene su texto propio y no cae al genérico", () => {
    expect(ERRORES.unable_to_create_user).toBeTruthy();
    expect(codigoDeError("unable_to_create_user")).toBe("unable_to_create_user");
  });

  it("no manda a la contraseña: lleva al SSO o a escribir", () => {
    const mensaje = ERRORES.unable_to_create_user;
    expect(mensaje).not.toMatch(/contraseña/i);
    expect(mensaje).toMatch(/SSO/);
    expect(mensaje).toMatch(/escribinos/i);
  });

  it("no distingue «dominio con SSO» de «correo no habilitado»", () => {
    expect(ERRORES.unable_to_create_user).not.toMatch(/exige|exigid|no está habilitad|lista|permitid/i);
  });
});
