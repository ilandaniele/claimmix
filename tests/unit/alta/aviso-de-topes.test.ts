/**
 * El aviso al operador cuando el uso del proyecto llega al 80 % o al 100 % de un tope.
 *
 * Cuatro topes (gasto de IA del mes, pozo de las pruebas, bases de cliente, MB de Neon), dos umbrales,
 * una sola vez por umbral, tope y mes, un solo mail por barrido, sin datos de nadie, y sin romper nunca
 * el barrido que lo dispara. La base y el remitente son de mentira: se prueba la decisión, no el SQL.
 * Las marcas viven en un `Set` que se comporta como la tabla: se leen antes de mandar y se ponen
 * después, nunca antes.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  remitente: vi.fn(),
  enviar: vi.fn(),
  operadores: vi.fn(),
  medir: vi.fn(),
  leer: vi.fn(),
  poner: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

const DEMO = "20000000-0000-0000-0000-000000000002";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth/operator-emails", () => ({ operatorEmails: h.operadores }));
vi.mock("@/server/notify/remitente-sistema", () => ({
  remitenteDelSistema: h.remitente,
  enviarCorreoDelSistema: h.enviar,
}));
vi.mock("@/lib/observability/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: h.warn, error: h.error },
}));
vi.mock("@/lib/rate-limit/postgres", () => ({ marcasPuestas: h.leer, ponerMarcas: h.poner }));
vi.mock("@/server/ai/budget", () => ({ sumaMensualDelProyecto: h.medir, getDemoTenantId: () => DEMO }));

import { avisarTopes } from "@/server/alta/aviso-de-topes";

const AHORA = new Date(2026, 9, 24, 12, 0, 0);
const VENCE = new Date(2026, 10, 1);
const OPERADORES = ["ops@example.com", "dueno@example.com"];
const TOPES = { presupuesto: 200, pruebas: 30, bases: 30, mb: 350 };

interface Medida {
  total?: number;
  pruebas?: number;
  bases?: number;
  mb?: number;
}

function medida({ total = 0, pruebas = 0, bases = 0, mb = 0 }: Medida = {}) {
  return { ok: true, total, pruebas, extras: { bases, mb } };
}

function clave(nombre: keyof typeof TOPES, umbral: 80 | 100, { tope = TOPES[nombre], periodo = "2026-10" } = {}) {
  return `aviso-tope:${nombre}:${tope}:${umbral}:${periodo}`;
}

/** Lo que salió por el remitente: un mail por dirección, todos con el mismo texto. */
function enviados() {
  return h.enviar.mock.calls.map(([correo, opciones]) => ({ ...(correo as { to: string; asunto: string; texto: string }), opciones }));
}

function textoEnviado(): string {
  return enviados()[0].texto;
}

/** Las claves de cada llamada a `ponerMarcas`, sin el vencimiento. */
function marcasPedidas(): string[][] {
  return h.poner.mock.calls.map(([claves]) => claves as string[]);
}

let marcas: Set<string>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("MONTHLY_BUDGET_USD", "200");
  vi.stubEnv("AI_PRUEBAS_MONTHLY_BUDGET_USD", "30");
  vi.stubEnv("ALTA_TOPE_BASES", "30");
  vi.stubEnv("ALTA_TOPE_MB", "350");
  h.remitente.mockReturnValue({ correo: "sistema@example.com", refreshToken: "test-refresh-key" });
  h.operadores.mockReturnValue(OPERADORES);
  h.medir.mockResolvedValue(medida());
  marcas = new Set();
  h.leer.mockImplementation(async (claves: string[]) => new Set(claves.filter((k) => marcas.has(k))));
  h.poner.mockImplementation(async (claves: string[]) => {
    for (const k of claves) marcas.add(k);
  });
  h.enviar.mockResolvedValue({ enviado: true });
});

describe("cuándo avisa", () => {
  it("con todo por debajo del 80 % no manda nada ni marca", async () => {
    h.medir.mockResolvedValue(medida({ total: 159.99, pruebas: 23.99, bases: 23, mb: 279 }));

    expect(await avisarTopes(AHORA)).toBe(0);

    expect(h.leer).not.toHaveBeenCalled();
    expect(h.poner).not.toHaveBeenCalled();
    expect(h.enviar).not.toHaveBeenCalled();
  });

  it("con cero uso no avisa de nada", async () => {
    expect(await avisarTopes(AHORA)).toBe(0);

    expect(h.enviar).not.toHaveBeenCalled();
  });

  it.each([
    ["presupuesto", { total: 160 }, "160.00", "200.00"],
    ["pruebas", { pruebas: 24 }, "24.00", "30.00"],
    ["bases", { bases: 24 }, "24", "30"],
    ["mb", { mb: 280 }, "280", "350"],
  ] as const)("%s al 80 %%: marca ese umbral y avisa con el uso y el tope", async (nombre, uso, usado, tope) => {
    h.medir.mockResolvedValue(medida(uso));

    expect(await avisarTopes(AHORA)).toBe(1);

    expect(h.poner).toHaveBeenCalledTimes(1);
    expect(h.poner).toHaveBeenCalledWith([clave(nombre, 80)], VENCE);
    expect(textoEnviado()).toContain(`${usado} de ${tope}. Ya pasó el 80 %.`);
  });

  it.each([
    ["presupuesto", { total: 200 }],
    ["pruebas", { pruebas: 30 }],
    ["bases", { bases: 30 }],
    ["mb", { mb: 350 }],
  ] as const)("%s al 100 %%: avisa el tope lleno y marca también el 80, aunque nunca haya pasado por él", async (nombre, uso) => {
    h.medir.mockResolvedValue(medida(uso));

    expect(await avisarTopes(AHORA)).toBe(1);

    expect(h.poner).toHaveBeenCalledTimes(1);
    expect(h.poner).toHaveBeenCalledWith([clave(nombre, 80), clave(nombre, 100)], VENCE);
    expect(textoEnviado()).toContain("Llegó al tope.");
    expect(textoEnviado()).not.toContain("Ya pasó el 80 %");
  });

  it("después del 100 el uso puede volver al tramo del 80 y no avisa un «80» tardío", async () => {
    h.medir.mockResolvedValue(medida({ mb: 350 }));
    expect(await avisarTopes(AHORA)).toBe(1);

    h.medir.mockResolvedValue(medida({ mb: 290 }));
    expect(await avisarTopes(AHORA)).toBe(0);

    h.medir.mockResolvedValue(medida({ mb: 350 }));
    expect(await avisarTopes(AHORA)).toBe(0);

    expect(h.enviar).toHaveBeenCalledTimes(OPERADORES.length);
  });

  it("pasado el tope sigue siendo el umbral 100, no uno nuevo", async () => {
    h.medir.mockResolvedValue(medida({ total: 350.5 }));

    await avisarTopes(AHORA);

    expect(h.poner).toHaveBeenCalledWith([clave("presupuesto", 80), clave("presupuesto", 100)], VENCE);
    expect(textoEnviado()).toContain("350.50 de 200.00");
  });

  it("el tope que se cambia por variable es el que se mide", async () => {
    vi.stubEnv("ALTA_TOPE_BASES", "10");
    h.medir.mockResolvedValue(medida({ bases: 8 }));

    await avisarTopes(AHORA);

    expect(h.poner).toHaveBeenCalledWith([clave("bases", 80, { tope: 10 })], VENCE);
    expect(textoEnviado()).toContain("8 de 10");
  });
});

describe("lo usado nunca se muestra por encima de lo real", () => {
  it("al 80 % los MB no se redondean hasta el tope: 349,6 de 350 dice 349, no «350 de 350»", async () => {
    h.medir.mockResolvedValue(medida({ mb: 349.6 }));

    await avisarTopes(AHORA);

    expect(textoEnviado()).toContain("349 de 350. Ya pasó el 80 %.");
    expect(textoEnviado()).not.toContain("350 de 350");
  });

  it("los dólares llevan dos decimales y tampoco suben al tope: 199,999 dice 199.99", async () => {
    h.medir.mockResolvedValue(medida({ total: 199.999 }));

    await avisarTopes(AHORA);

    expect(textoEnviado()).toContain("199.99 de 200.00. Ya pasó el 80 %.");
  });

  it("lo exacto sale tal cual y el tope lleno dice «350 de 350»", async () => {
    h.medir.mockResolvedValue(medida({ total: 161.24, mb: 350 }));

    await avisarTopes(AHORA);

    expect(textoEnviado()).toContain("161.24 de 200.00");
    expect(textoEnviado()).toContain("350 de 350. Llegó al tope.");
  });

  it("las bases con decimales de la medición también bajan al entero", async () => {
    h.medir.mockResolvedValue(medida({ bases: 24.9 }));

    await avisarTopes(AHORA);

    expect(textoEnviado()).toContain("24 de 30");
  });
});

describe("un tope en 0 no existe", () => {
  it("con MONTHLY_BUDGET_USD en 0 la IA está parada a propósito: no avisa aunque haya gasto", async () => {
    vi.stubEnv("MONTHLY_BUDGET_USD", "0");
    h.medir.mockResolvedValue(medida({ total: 5 }));

    expect(await avisarTopes(AHORA)).toBe(0);

    expect(h.poner).not.toHaveBeenCalled();
  });

  it("con AI_PRUEBAS_MONTHLY_BUDGET_USD en 0 no avisa del pozo de las pruebas", async () => {
    vi.stubEnv("AI_PRUEBAS_MONTHLY_BUDGET_USD", "0");
    h.medir.mockResolvedValue(medida({ pruebas: 5 }));

    expect(await avisarTopes(AHORA)).toBe(0);
  });

  it("sin tope de bases ni de MB el catálogo ni se consulta", async () => {
    vi.stubEnv("ALTA_TOPE_BASES", "0");
    vi.stubEnv("ALTA_TOPE_MB", "0");
    h.medir.mockResolvedValue({ ok: true, total: 0, pruebas: 0, extras: {} });

    await avisarTopes(AHORA);

    expect(h.medir).toHaveBeenCalledTimes(1);
    expect(h.medir.mock.calls[0][2]).toEqual({});
  });

  it("de las dos medidas del catálogo sólo pide la que tiene tope", async () => {
    vi.stubEnv("ALTA_TOPE_MB", "0");
    h.medir.mockResolvedValue({ ok: true, total: 0, pruebas: 0, extras: { bases: 30 } });

    await avisarTopes(AHORA);

    expect(Object.keys(h.medir.mock.calls[0][2])).toEqual(["bases"]);
    expect(h.poner).toHaveBeenCalledWith([clave("bases", 80), clave("bases", 100)], VENCE);
  });
});

describe("la consulta", () => {
  it("es una sola, desde el primero del mes, con la demo aparte y las dos medidas del catálogo", async () => {
    await avisarTopes(AHORA);

    expect(h.medir).toHaveBeenCalledTimes(1);
    const [desde, demo, extras] = h.medir.mock.calls[0];
    expect(desde).toEqual(new Date(2026, 9, 1));
    expect(demo).toBe(DEMO);
    expect(Object.keys(extras)).toEqual(["bases", "mb"]);
  });

  it("si no se pudo medir no avisa de nada y no marca", async () => {
    h.medir.mockResolvedValue({ ok: false, total: 0, pruebas: 0, extras: {} });

    expect(await avisarTopes(AHORA)).toBe(0);

    expect(h.leer).not.toHaveBeenCalled();
    expect(h.poner).not.toHaveBeenCalled();
    expect(h.enviar).not.toHaveBeenCalled();
  });

  it("si falla pide que quede registrada con un evento propio, no con el del guardia de IA", async () => {
    await avisarTopes(AHORA);

    expect(h.medir.mock.calls[0][3]).toBe("alta.aviso_topes_medicion_fallo");
  });
});

describe("las marcas", () => {
  it("las ya puestas se leen en una sola sentencia, con la clave del umbral que cruzó cada tope", async () => {
    h.medir.mockResolvedValue(medida({ total: 200, pruebas: 25, bases: 24, mb: 351 }));

    await avisarTopes(AHORA);

    expect(h.leer).toHaveBeenCalledTimes(1);
    expect(h.leer).toHaveBeenCalledWith(
      [clave("presupuesto", 100), clave("pruebas", 80), clave("bases", 80), clave("mb", 100)],
      VENCE
    );
  });

  it("las de todos los topes avisados se ponen en una sola sentencia", async () => {
    h.medir.mockResolvedValue(medida({ total: 200, pruebas: 25, bases: 24, mb: 351 }));

    await avisarTopes(AHORA);

    expect(marcasPedidas()).toEqual([
      [
        clave("presupuesto", 80),
        clave("presupuesto", 100),
        clave("pruebas", 80),
        clave("bases", 80),
        clave("mb", 80),
        clave("mb", 100),
      ],
    ]);
  });

  it("se ponen después del mail, nunca antes: una marca huérfana dejaría el umbral mudo todo el mes", async () => {
    h.medir.mockResolvedValue(medida({ total: 200 }));

    await avisarTopes(AHORA);

    expect(h.enviar.mock.invocationCallOrder[0]).toBeLessThan(h.poner.mock.invocationCallOrder[0]);
  });

  it("si no hay nada nuevo no se pone nada", async () => {
    h.medir.mockResolvedValue(medida({ total: 170 }));
    await avisarTopes(AHORA);
    h.poner.mockClear();

    expect(await avisarTopes(AHORA)).toBe(0);

    expect(h.poner).not.toHaveBeenCalled();
  });
});

describe("una sola vez por umbral, tope y mes", () => {
  it("si la marca ya estaba, no manda", async () => {
    h.medir.mockResolvedValue(medida({ total: 170 }));
    marcas.add(clave("presupuesto", 80));

    expect(await avisarTopes(AHORA)).toBe(0);

    expect(h.leer).toHaveBeenCalledTimes(1);
    expect(h.enviar).not.toHaveBeenCalled();
    expect(h.poner).not.toHaveBeenCalled();
  });

  it("dos barridos en el mismo mes miran la misma marca y el segundo no manda", async () => {
    h.medir.mockResolvedValue(medida({ total: 170 }));

    expect(await avisarTopes(new Date(2026, 9, 3, 4, 7))).toBe(1);
    expect(await avisarTopes(new Date(2026, 9, 30, 23, 59))).toBe(0);

    expect(h.leer.mock.calls).toEqual([[[clave("presupuesto", 80)], VENCE], [[clave("presupuesto", 80)], VENCE]]);
    expect(marcasPedidas()).toEqual([[clave("presupuesto", 80)]]);
    expect(h.enviar).toHaveBeenCalledTimes(OPERADORES.length);
  });

  it("el mes siguiente la marca es otra y vuelve a avisar", async () => {
    h.medir.mockResolvedValue(medida({ total: 170 }));
    await avisarTopes(AHORA);

    expect(await avisarTopes(new Date(2026, 10, 2, 4, 7))).toBe(1);

    expect(h.poner).toHaveBeenLastCalledWith([clave("presupuesto", 80, { periodo: "2026-11" })], new Date(2026, 11, 1));
  });

  it("en diciembre la marca vence el 1 de enero del año que viene", async () => {
    h.medir.mockResolvedValue(medida({ total: 170 }));

    await avisarTopes(new Date(2026, 11, 31, 22, 0));

    expect(h.poner).toHaveBeenCalledWith([clave("presupuesto", 80, { periodo: "2026-12" })], new Date(2027, 0, 1));
  });

  it("si el operador sube el tope en el mismo mes, el tope nuevo tiene sus propios avisos", async () => {
    h.medir.mockResolvedValue(medida({ mb: 350 }));
    expect(await avisarTopes(AHORA)).toBe(1);

    vi.stubEnv("ALTA_TOPE_MB", "450");
    h.medir.mockResolvedValue(medida({ mb: 450 }));
    expect(await avisarTopes(AHORA)).toBe(1);

    expect(textoEnviado()).toContain("350 de 350");
    expect(enviados().at(-1)!.texto).toContain("450 de 450. Llegó al tope.");
    expect(h.poner).toHaveBeenLastCalledWith(
      [clave("mb", 80, { tope: 450 }), clave("mb", 100, { tope: 450 })],
      VENCE
    );
  });

  it("con el 80 ya avisado y el 100 nuevo, avisa sólo el 100", async () => {
    h.medir.mockResolvedValue(medida({ total: 205 }));
    marcas.add(clave("presupuesto", 80));

    expect(await avisarTopes(AHORA)).toBe(1);

    expect(textoEnviado()).toContain("Llegó al tope.");
    expect(marcas.has(clave("presupuesto", 100))).toBe(true);
  });

  it("si de varios topes sólo uno es nuevo, el mail lleva sólo ese", async () => {
    h.medir.mockResolvedValue(medida({ total: 170, bases: 25 }));
    marcas.add(clave("presupuesto", 80));

    expect(await avisarTopes(AHORA)).toBe(1);

    expect(textoEnviado()).toContain("Bases de cliente: 25 de 30");
    expect(textoEnviado()).not.toContain("Gasto de IA");
  });
});

describe("el mail", () => {
  it("sale uno solo por barrido a cada dirección de operación, con varios topes en el mismo texto", async () => {
    h.medir.mockResolvedValue(medida({ total: 200, pruebas: 25, bases: 24, mb: 351 }));

    expect(await avisarTopes(AHORA)).toBe(4);

    const correos = enviados();
    expect(correos.map((c) => c.to)).toEqual(OPERADORES);
    expect(new Set(correos.map((c) => c.texto)).size).toBe(1);
    const texto = correos[0].texto;
    expect(texto).toContain("Gasto de IA del mes (USD): 200.00 de 200.00. Llegó al tope.");
    expect(texto).toContain("Gasto de IA de las pruebas en el mes (USD): 25.00 de 30.00. Ya pasó el 80 %.");
    expect(texto).toContain("Bases de cliente: 24 de 30. Ya pasó el 80 %.");
    expect(texto).toContain("Peso del proyecto en Neon (MB): 351 de 350. Llegó al tope.");
  });

  it("va por el cupo de los avisos de topes, no por el de los avisos de números", async () => {
    h.medir.mockResolvedValue(medida({ total: 170 }));

    await avisarTopes(AHORA);

    for (const c of enviados()) expect(c.opciones).toEqual({ tipo: "topes" });
  });

  it("está en es-AR, con voseo, y explica qué hacer", async () => {
    h.medir.mockResolvedValue(medida({ total: 200 }));

    await avisarTopes(AHORA);

    const [correo] = enviados();
    expect(correo.asunto).toBe("ClaimMix: aviso de topes");
    expect(correo.texto).toBe(
      [
        "Estos topes de ClaimMix llegaron a un umbral de aviso:",
        "- Gasto de IA del mes (USD): 200.00 de 200.00. Llegó al tope. La IA queda frenada hasta que empiece el mes que viene o se suba MONTHLY_BUDGET_USD.",
        "",
        "Para subir un tope, cambiá su variable en el ambiente. El aviso se manda una sola vez por umbral y por mes.",
      ].join("\n")
    );
  });

  it("no lleva datos de nadie: ni direcciones ni identificadores", async () => {
    h.medir.mockResolvedValue(medida({ total: 200, pruebas: 30, bases: 30, mb: 350 }));

    await avisarTopes(AHORA);

    const { asunto, texto } = enviados()[0];
    for (const dato of [...OPERADORES, DEMO, "sistema@example.com", "test-refresh-key"]) {
      expect(asunto).not.toContain(dato);
      expect(texto).not.toContain(dato);
    }
    expect(texto).not.toContain("@");
    expect(texto).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
  });

  it("los registros llevan el tope y el umbral, nunca las direcciones", async () => {
    h.medir.mockResolvedValue(medida({ total: 200 }));

    await avisarTopes(AHORA);

    expect(h.warn).toHaveBeenCalledWith({ tope: "presupuesto", umbral: 100 }, "alta.tope_avisado");
    expect(JSON.stringify([h.warn.mock.calls, h.error.mock.calls])).not.toContain("@");
  });
});

describe("si el mail no sale", () => {
  it("no hay remitente: no mide ni marca", async () => {
    h.remitente.mockReturnValue(null);
    h.medir.mockResolvedValue(medida({ total: 200 }));

    expect(await avisarTopes(AHORA)).toBe(0);

    expect(h.medir).not.toHaveBeenCalled();
    expect(h.poner).not.toHaveBeenCalled();
  });

  it("no hay direcciones de operación: no mide ni marca", async () => {
    h.operadores.mockReturnValue([]);
    h.medir.mockResolvedValue(medida({ total: 200 }));

    expect(await avisarTopes(AHORA)).toBe(0);

    expect(h.medir).not.toHaveBeenCalled();
    expect(h.poner).not.toHaveBeenCalled();
  });

  it("si no salió a nadie no queda marca, y el barrido siguiente lo intenta de nuevo", async () => {
    h.medir.mockResolvedValue(medida({ total: 200, bases: 24 }));
    h.enviar.mockResolvedValue({ enviado: false, motivo: "sin_cupo" });

    expect(await avisarTopes(AHORA)).toBe(0);

    expect(h.poner).not.toHaveBeenCalled();
    expect(marcas.size).toBe(0);
    expect(h.warn).not.toHaveBeenCalled();

    h.enviar.mockResolvedValue({ enviado: true });
    expect(await avisarTopes(AHORA)).toBe(2);
  });

  it("si salió a una de las dos direcciones, el aviso se dio: la marca queda", async () => {
    h.medir.mockResolvedValue(medida({ total: 170 }));
    h.enviar.mockResolvedValueOnce({ enviado: false, motivo: "no_salio" }).mockResolvedValueOnce({ enviado: true });

    expect(await avisarTopes(AHORA)).toBe(1);

    expect(marcas.has(clave("presupuesto", 80))).toBe(true);
  });

  it("nunca lanza: si el envío tira (la corrida muere o se corta) no queda marca y el barrido siguiente lo manda", async () => {
    h.medir.mockResolvedValue(medida({ total: 170, pruebas: 30 }));
    h.enviar.mockRejectedValueOnce(new Error("connection reset"));

    await expect(avisarTopes(AHORA)).resolves.toBe(0);

    expect(h.poner).not.toHaveBeenCalled();
    expect(marcas.size).toBe(0);
    expect(h.error).toHaveBeenCalledWith({ error: "Error" }, "alta.aviso_topes_fallo");

    h.enviar.mockResolvedValue({ enviado: true });
    expect(await avisarTopes(AHORA)).toBe(2);
    expect(marcas.has(clave("pruebas", 100))).toBe(true);
  });

  it("nunca lanza: si la base no contesta al leer las marcas, devuelve 0 sin mandar nada", async () => {
    h.medir.mockResolvedValue(medida({ total: 170, bases: 24 }));
    h.leer.mockRejectedValue(new Error("connection reset"));

    await expect(avisarTopes(AHORA)).resolves.toBe(0);

    expect(h.enviar).not.toHaveBeenCalled();
    expect(h.poner).not.toHaveBeenCalled();
    expect(h.error).toHaveBeenCalledWith({ error: "Error" }, "alta.aviso_topes_fallo");
  });

  it("nunca lanza: si la base no contesta al marcar, el mail ya salió y el barrido siguiente lo repite una vez", async () => {
    h.medir.mockResolvedValue(medida({ total: 170 }));
    h.poner.mockRejectedValueOnce(new Error("connection reset"));

    await expect(avisarTopes(AHORA)).resolves.toBe(0);

    expect(h.enviar).toHaveBeenCalledTimes(OPERADORES.length);
    expect(h.error).toHaveBeenCalledWith({ error: "Error" }, "alta.aviso_topes_fallo");

    expect(await avisarTopes(AHORA)).toBe(1);
    expect(await avisarTopes(AHORA)).toBe(0);
  });

  it("nunca lanza: si la medición tira, devuelve 0", async () => {
    h.medir.mockRejectedValue(new Error("boom"));

    await expect(avisarTopes(AHORA)).resolves.toBe(0);

    expect(h.enviar).not.toHaveBeenCalled();
  });
});
