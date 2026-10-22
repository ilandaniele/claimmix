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

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { interpretarSalud, pedirSalud } from "../../scripts/lib/salud.mjs";

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

describe("interpretarSalud sin detalle (log público de Actions)", () => {
  const cuerpo = {
    status: "degraded",
    checks: [
      { name: "whatsapp", status: "ok", detail: "+54 9 11 5555-0000 operativo" },
      { name: "gmail", status: "down", detail: "alguien@example.com: el token guardado no descifra" },
      { name: "migraciones", status: "degraded", detail: "faltan: 0099_secreta" },
    ],
  };

  it("deja el nombre y el estado de cada chequeo, y nada del detalle", () => {
    const l = interpretarSalud(503, cuerpo, { sinDetalle: true });

    expect(l.lineas).toEqual(["✓ whatsapp", "✗ gmail", "! migraciones"]);
    expect(l.errores).toEqual(["gmail — down"]);
    expect(l.avisos).toEqual(["migraciones — degraded"]);
    expect(JSON.stringify(l)).not.toMatch(/5555|example.com|0099|descifra/);
  });

  it("el veredicto no cambia: mismo estado y mismos errores", () => {
    const entero = interpretarSalud(503, cuerpo);
    const corto = interpretarSalud(503, cuerpo, { sinDetalle: true });

    expect(corto.estado).toBe(entero.estado);
    expect(corto.errores).toHaveLength(entero.errores.length);
    expect(corto.avisos).toHaveLength(entero.avisos.length);
    expect(entero.lineas[0]).toContain("5555");
  });
});

describe("pedirSalud: el pedido que comparten mirar-salud y paridad", () => {
  const SECRETO = "secreto-de-prueba-que-no-sale";
  const INFORME = { status: "ok", checks: [] };
  const informe = () => Response.json(INFORME);
  // El 503 de la plataforma (FUNCTION_THROTTLED, un deploy pausado) no trae el informe.
  const plataforma503 = () => new Response("<html>Service Unavailable</html>", { status: 503 });

  // Un paso por intento; el último se repite. Un paso que tira simula un corte de red.
  const simular = (...pasos: Array<() => Response>) => {
    let i = 0;
    const falso = vi.fn(async (_url: string, _init?: RequestInit) => pasos[Math.min(i++, pasos.length - 1)]());
    vi.stubGlobal("fetch", falso);
    return falso;
  };
  const silenciar = () => vi.spyOn(console, "log").mockImplementation(() => {});

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("pide /api/health con el Bearer", async () => {
    const falso = simular(informe);
    silenciar();

    expect(await pedirSalud("https://x.example", SECRETO, { esperaMs: 0 })).toEqual({ codigo: 200, cuerpo: INFORME });
    const [url, init] = falso.mock.calls[0];
    expect(url).toBe("https://x.example/api/health");
    expect(init?.headers).toEqual({ Authorization: `Bearer ${SECRETO}` });
  });

  it("un 503 con HTML (la plataforma, no la ruta) se reintenta", async () => {
    const falso = simular(plataforma503, informe);
    silenciar();

    expect(await pedirSalud("https://x.example", SECRETO, { esperaMs: 0 })).toEqual({ codigo: 200, cuerpo: INFORME });
    expect(falso).toHaveBeenCalledTimes(2);
  });

  it("un 503 con el informe de la ruta (algo está `down`) vale y no se reintenta", async () => {
    const caido = { status: "down", checks: [{ name: "db", status: "down", detail: "x" }] };
    const falso = simular(() => Response.json(caido, { status: 503 }));
    silenciar();

    expect(await pedirSalud("https://x.example", SECRETO, { esperaMs: 0 })).toEqual({ codigo: 503, cuerpo: caido });
    expect(falso).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["cortado a la mitad", "{\"status\":\"ok\",\"chec"],
    ["null", "null"],
    ["una lista", "[]"],
    ["un número", "42"],
  ])("un 200 con el cuerpo %s no es el informe y se reintenta", async (_caso, cuerpo) => {
    const falso = simular(() => new Response(cuerpo, { status: 200 }), informe);
    silenciar();

    expect(await pedirSalud("https://x.example", SECRETO, { esperaMs: 0 })).toEqual({ codigo: 200, cuerpo: INFORME });
    expect(falso).toHaveBeenCalledTimes(2);
  });

  it("un 401 vuelve enseguida: reintentar no cambia la llave", async () => {
    const falso = simular(() => new Response("", { status: 401 }));
    silenciar();

    expect(await pedirSalud("https://x.example", SECRETO, { esperaMs: 0 })).toEqual({ codigo: 401, cuerpo: null });
    expect(falso).toHaveBeenCalledTimes(1);
  });

  it("agota tres intentos y devuelve el último código sin cuerpo", async () => {
    const falso = simular(plataforma503);
    silenciar();

    expect(await pedirSalud("https://x.example", SECRETO, { esperaMs: 0 })).toEqual({ codigo: 503, cuerpo: null });
    expect(falso).toHaveBeenCalledTimes(3);
  });

  it("si nunca contestó, el código es 0", async () => {
    const falso = simular(() => {
      throw new Error("fetch failed");
    });
    silenciar();

    expect(await pedirSalud("https://x.example", SECRETO, { esperaMs: 0 })).toEqual({ codigo: 0, cuerpo: null });
    expect(falso).toHaveBeenCalledTimes(3);
  });

  it("si el último intento se corta por la red, no pierde el código HTTP que ya vio", async () => {
    const falso = simular(
      () => new Response("", { status: 502 }),
      () => {
        throw new Error("fetch failed");
      },
    );
    silenciar();

    expect(await pedirSalud("https://x.example", SECRETO, { esperaMs: 0 })).toEqual({ codigo: 502, cuerpo: null });
    expect(falso).toHaveBeenCalledTimes(3);
  });

  it("estricto: no sigue redirecciones y el log no lleva nada del error", async () => {
    const falso = simular(() => {
      throw new Error(`https://x.example redirigió, Bearer ${SECRETO}`);
    });
    const log = silenciar();

    await pedirSalud("https://x.example", SECRETO, { etiqueta: "prd", estricto: true, esperaMs: 0 });

    expect(falso.mock.calls[0][1]?.redirect).toBe("error");
    const salida = log.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(salida).toContain("prd: intento 1: sin respuesta");
    expect(salida).not.toMatch(/redirigió|Bearer|secreto-de-prueba/);
  });

  it("sin `estricto`: sigue redirecciones y el log dice qué falló", async () => {
    const falso = simular(() => {
      throw new Error("fetch failed");
    });
    const log = silenciar();

    await pedirSalud("https://x.example", SECRETO, { esperaMs: 0 });

    expect(falso.mock.calls[0][1]?.redirect).toBe("follow");
    expect(log.mock.calls.map((c) => c.join(" ")).join("\n")).toContain("intento 1: fetch failed");
  });
});

describe("barrer-trabados.yml no imprime la respuesta entera del barredor", () => {
  const yml = readFileSync(resolve(process.cwd(), ".github/workflows/barrer-trabados.yml"), "utf8");

  it("ningún paso hace `cat respuesta.json`: trae los caseIds", () => {
    expect(yml).not.toMatch(/\bcat respuesta\.json/);
  });
});
