/**
 * El formulario web público de denuncias (B17), contra un servidor de verdad.
 *
 * Sin sembrar nada: un formulario vivo necesita un inquilino con `formulario_web`
 * prendido, y enviar uno despacha la extracción del agente. Lo que se prueba acá
 * es lo que un cambio en el proxy o en el enrutado rompe en silencio: que la
 * página abra sin sesión (no manda al login), que un enlace que no existe no
 * revele nada, y que la ruta no acepte un pedido armado a mano.
 */

import { test, expect } from "@playwright/test";

const SLUG_INEXISTENTE = "no-existe-este-formulario";
const CASO_INEXISTENTE = "00000000-0000-0000-0000-000000000001";

test.describe("la página pública", () => {
  test("un enlace que no existe da 404 y no manda al login", async ({ request }) => {
    const res = await request.get(`/denuncia/${SLUG_INEXISTENTE}`, {
      maxRedirects: 0,
      failOnStatusCode: false,
    });
    // Un 3xx al login diría que la ruta quedó detrás de la sesión, y la persona
    // que denuncia no tiene cuenta.
    expect(res.status()).toBe(404);
  });

  test("lleva las cabeceras de seguridad", async ({ request }) => {
    const res = await request.get(`/denuncia/${SLUG_INEXISTENTE}`, { failOnStatusCode: false });
    const cabeceras = res.headers();
    for (const c of ["content-security-policy", "x-frame-options", "x-content-type-options"]) {
      expect(cabeceras[c], `falta ${c}`).toBeTruthy();
    }
  });

  test("el 404 no nombra a ninguna aseguradora", async ({ request }) => {
    const res = await request.get(`/denuncia/${SLUG_INEXISTENTE}`, { failOnStatusCode: false });
    const cuerpo = await res.text();
    expect(cuerpo).not.toContain("Seguros del Sur");
  });
});

test.describe("la ruta que recibe la denuncia", () => {
  test("un pedido armado a mano no crea nada y no devuelve un stack", async ({ request }) => {
    const res = await request.post(`/api/denuncia/${SLUG_INEXISTENTE}`, {
      // Un token inventado y un `tenant_id` que la ruta no tiene que mirar.
      data: {
        nombre: "Ana Pérez",
        email: "ana@example.com",
        relato: "Choqué ayer en Bahía Blanca y quiero hacer la denuncia.",
        t: "inventado.0.0",
        tenant_id: CASO_INEXISTENTE,
      },
      failOnStatusCode: false,
      maxRedirects: 0,
    });

    // 400 por el token, 404 por el enlace o 429 por el tope: cualquiera menos un éxito.
    expect(res.status()).toBeGreaterThanOrEqual(400);
    expect(res.status()).toBeLessThan(500);
    const cuerpo = await res.text();
    expect(cuerpo).not.toContain("node_modules");
    expect(cuerpo).not.toContain("at async");
    expect(cuerpo).not.toContain(CASO_INEXISTENTE);
  });

  test("un cuerpo enorme se corta antes de leerse", async ({ request }) => {
    const res = await request.post(`/api/denuncia/${SLUG_INEXISTENTE}`, {
      data: { relato: "x".repeat(60_000) },
      failOnStatusCode: false,
      maxRedirects: 0,
    });
    // 413 por el tope de tamaño o 429 si el tope por IP se gastó antes.
    expect([413, 429]).toContain(res.status());
  });
});
