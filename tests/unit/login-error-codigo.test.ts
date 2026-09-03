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
