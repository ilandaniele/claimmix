/**
 * Cómo se lee lo que contesta `/api/health`.
 *
 * `/api/health` sólo se consultaba después de un deploy. Entre dos deploys,
 * nadie — y lo que ese endpoint sabe ver se rompe SOLO: el token de WhatsApp
 * vence, el aviso de push de Gmail se cae al reconectar la casilla, el
 * presupuesto de IA se acaba.
 *
 * La trampa está en el código HTTP: la ruta contesta 503 SÓLO cuando algo está
 * `down`. Todo lo `degraded` sale **200**. Un centinela que mirara nada más el
 * número habría dado verde la semana en que el push de Gmail estuvo caído y el
 * correo entraba por el cron en vez de en segundos: se veía sano y estaba
 * lento.
 *
 * Por eso la decisión vive en un módulo puro y se prueba acá, sin red.
 */

import { describe, expect, it } from "vitest";

import { interpretarSalud } from "../../scripts/lib/salud.mjs";

const sano = {
  status: "ok",
  checks: [{ name: "gmail_watch", status: "ok", detail: "vence en 6 días" }],
};

describe("interpretarSalud", () => {
  it("un 200 sano no dice nada", () => {
    const l = interpretarSalud(200, sano);

    expect(l.estado).toBe("ok");
    expect(l.errores).toEqual([]);
    expect(l.avisos).toEqual([]);
  });

  it("un 200 DEGRADADO avisa, que es el caso que un centinela ingenuo se pierde", () => {
    // El de verdad: reconectar la casilla se llevó puesto el push de Gmail, el
    // correo pasó a entrar por el cron, y el HTTP siguió siendo 200.
    const l = interpretarSalud(200, {
      status: "degraded",
      checks: [
        { name: "gmail_watch", status: "degraded", detail: "vencido hace 2 días" },
        { name: "db", status: "ok", detail: "12 ms" },
      ],
    });

    expect(l.estado).toBe("degraded");
    expect(l.avisos).toHaveLength(1);
    expect(l.avisos[0]).toContain("gmail_watch");
    // Degradado NO es rojo: ponerlo rojo cada quince minutos es la forma más
    // rápida de que nadie vuelva a mirar este workflow.
    expect(l.errores).toEqual([]);
  });

  it("un chequeo caído sí es rojo, y dice cuál", () => {
    const l = interpretarSalud(503, {
      status: "down",
      checks: [{ name: "whatsapp_token", status: "down", detail: "expirado" }],
    });

    expect(l.errores).toHaveLength(1);
    expect(l.errores[0]).toContain("whatsapp_token");
  });

  it("si dice `down` y no nombra a nadie, tampoco pasa por verde", () => {
    const l = interpretarSalud(503, { status: "down", checks: [] });

    expect(l.errores).toHaveLength(1);
    expect(l.errores[0]).toContain("no nombra");
  });

  it("no contestar no es estar bien", () => {
    const l = interpretarSalud(0, null);

    expect(l.estado).toBe("sin-lectura");
    expect(l.errores[0]).toContain("no contestó");
  });

  it("un 401 dice que la llave no es la de producción, no que esté caído", () => {
    // Distinguirlo importa: se arreglan de maneras muy distintas.
    const l = interpretarSalud(401, null);

    expect(l.errores[0]).toContain("CRON_SECRET");
  });

  it("un código que la ruta no sabe devolver es «no sé cómo está»", () => {
    // Un 502 de Vercel o un 404 de un alias a medio mover. No es lo mismo que
    // «está bien».
    const l = interpretarSalud(502, null);

    expect(l.errores[0]).toContain("502");
  });

  it("un cuerpo que no es el informe tampoco pasa por verde", () => {
    // La página de error de Vercel llega con 200 y no tiene `checks`.
    const l = interpretarSalud(200, { error: "algo" });

    expect(l.errores).toHaveLength(1);
    expect(l.errores[0]).toContain("no es el informe");
  });
});
