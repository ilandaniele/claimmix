/**
 * El `state` de la vuelta de OAuth de Gmail.
 *
 * ── Qué se podía hacer antes ────────────────────────────────────────────────
 *
 * El `state` era `base64(JSON({ tenantId, userId }))` y el callback comprobaba
 * que esos dos coincidieran con la sesión. Eso alcanza para que nadie enganche
 * una casilla a la aseguradora de OTRO.
 *
 * Lo que no cubría es el CSRF clásico de OAuth: un admin ve el padrón de su
 * aseguradora en `/api/admin/users`, así que conoce el `userId` de sus colegas.
 * Con eso podía armar un `state` válido para un colega, conseguir un `code` de
 * SU PROPIA casilla, y lograr que el colega abriera la URL del callback. La
 * casilla del atacante quedaba enganchada a la aseguradora, y todos los
 * siniestros que entran pasaban por ahí.
 *
 * El nonce lo arregla porque viaja por dos caminos: adentro del `state`, que va
 * y vuelve por Google, y en una cookie `HttpOnly` que el atacante no puede
 * escribirle al navegador de la víctima.
 */

import { describe, it, expect } from "vitest";

import {
  codificarEstado,
  decodificarEstado,
  estadoEsValido,
  nuevoNonce,
} from "@/lib/auth/oauth-state";

const SESION = { tenantId: "tenant-1", userId: "user-1" };

describe("nuevoNonce", () => {
  it("no se repite", () => {
    const muchos = new Set(Array.from({ length: 200 }, () => nuevoNonce()));
    expect(muchos.size).toBe(200);
  });

  it("es largo: no se adivina probando", () => {
    // 32 bytes en base64url son 43 caracteres.
    expect(nuevoNonce().length).toBeGreaterThanOrEqual(43);
  });
});

describe("codificar y decodificar", () => {
  it("da la vuelta entero", () => {
    const estado = { ...SESION, nonce: "abc" };
    expect(decodificarEstado(codificarEstado(estado))).toEqual(estado);
  });

  it("un state roto no rompe: devuelve vacío", () => {
    // Lo manda quien vuelve de Google, o quien quiera. No puede tirar la ruta.
    expect(decodificarEstado("no-es-base64-de-json")).toEqual({});
    expect(decodificarEstado(null)).toEqual({});
    expect(decodificarEstado("")).toEqual({});
  });
});

describe("estadoEsValido", () => {
  const nonce = nuevoNonce();
  const estado = { ...SESION, nonce };

  it("con el nonce que quedó en la cookie, pasa", () => {
    expect(estadoEsValido(estado, SESION, nonce)).toBe(true);
  });

  it("sin cookie no pasa, aunque el state venga perfecto", () => {
    /*
     * Éste es el ataque. El atacante puede fabricar un `state` con el inquilino
     * y el usuario de la víctima —los conoce— pero no puede escribirle una
     * cookie a su navegador.
     */
    expect(estadoEsValido(estado, SESION, undefined)).toBe(false);
    expect(estadoEsValido(estado, SESION, "")).toBe(false);
  });

  it("con otro nonce no pasa", () => {
    expect(estadoEsValido(estado, SESION, nuevoNonce())).toBe(false);
  });

  it("un state sin nonce no pasa", () => {
    // El formato viejo, sin nonce, tiene que quedar afuera: si pasara, el
    // arreglo no serviría de nada.
    expect(estadoEsValido({ ...SESION }, SESION, nonce)).toBe(false);
  });

  it("sigue exigiendo que el inquilino y el usuario sean los de la sesión", () => {
    // La comprobación que ya existía no se reemplazó, se sumó.
    expect(estadoEsValido(estado, { ...SESION, tenantId: "otra" }, nonce)).toBe(false);
    expect(estadoEsValido(estado, { ...SESION, userId: "otro" }, nonce)).toBe(false);
  });

  it("un state vacío no pasa", () => {
    expect(estadoEsValido({}, SESION, nonce)).toBe(false);
  });
});
