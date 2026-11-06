/**
 * El aviso de que el alta se acerca a su tope diario.
 *
 * Una vez por día, a cada dirección de operación, sin datos de nadie, y sin
 * romper nunca el alta que lo dispara.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  rateLimit: vi.fn(),
  liberarCupo: vi.fn(),
  remitente: vi.fn(),
  enviar: vi.fn(),
  operadores: vi.fn(),
  listar: vi.fn(),
  lugares: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth/operator-emails", () => ({ operatorEmails: h.operadores }));
vi.mock("@/server/notify/remitente-sistema", () => ({
  remitenteDelSistema: h.remitente,
  enviarCorreoDelSistema: h.enviar,
}));
vi.mock("@/lib/observability/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: h.warn, error: h.error },
}));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: h.rateLimit, liberarCupo: h.liberarCupo }));
vi.mock("@/server/alta/panel-operador", () => ({ listarAltas: h.listar, FILAS_MAXIMAS: 200 }));
vi.mock("@/server/alta/lugares-de-la-waba", () => ({ lugaresDeLaWaba: h.lugares }));

import type { FilaDeAlta, PanelDeAltas } from "@/server/alta/panel-operador";
import {
  avisarAlOperador,
  DIAS_DE_AVISO_DE_PRUEBA,
  destinatariosDeOperacion,
  FRACCION_DEL_AVISO,
  llegoAlAviso,
  mandarAlOperador,
  resumenDeAltas,
  umbralDelTope,
} from "@/server/alta/aviso-operador";

const DIA_MS = 24 * 60 * 60_000;
const VENTANA = 1_700_000_000_000;
const CLAVE = "alta:aviso80";
const CLAVE_RESUMEN = "alta:resumen";
const AHORA = new Date("2026-11-05T04:10:00Z");

function numero(estado: string): NonNullable<FilaDeAlta["numero"]> {
  return { id: "n1", e164: "+5491100000000", estado, phoneNumberId: null, wabaId: null };
}

/** Una fila con todo en orden: número conectado y sin prueba por vencer. */
function fila(sobre: Partial<FilaDeAlta> = {}): FilaDeAlta {
  return {
    tenantId: "t1",
    nombre: "Aseguradora Secreta",
    contactEmail: "secreto@example.com",
    creadoEn: null,
    plan: "basic",
    estadoDeFacturacion: "trial",
    pruebaHasta: null,
    activadoEn: null,
    numero: numero("conectado"),
    waba: null,
    numeroEnRevision: false,
    repetidoEn: [],
    usuariosActivos: 1,
    admin: { nombre: "Ada", email: "admin@example.com" },
    ...sobre,
  };
}

function panel(sobre: Partial<PanelDeAltas> = {}): PanelDeAltas {
  return {
    migracionPendiente: false,
    altas: [],
    creadas24h: 0,
    tope: 20,
    demoraDeAlta: { mediana: null, p95: null },
    ...sobre,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.remitente.mockReturnValue("alta@example.com");
  h.operadores.mockReturnValue(["ops@example.com", "dueno@example.com"]);
  h.rateLimit.mockResolvedValue({ allowed: true, remaining: 0, resetAt: 0, retryAfterSeconds: 0, ventana: VENTANA });
  h.liberarCupo.mockResolvedValue(undefined);
  h.enviar.mockResolvedValue({ enviado: true });
  h.listar.mockResolvedValue(panel());
  h.lugares.mockResolvedValue(null);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("llegoAlAviso", () => {
  it("el aviso es al 80 % del tope", () => {
    expect(FRACCION_DEL_AVISO).toBe(0.8);
  });

  it.each([
    [15, 20, false],
    [16, 20, true],
    [20, 20, true],
    [25, 20, true],
    [0, 20, false],
    [3, 4, false],
    [4, 5, true],
    [28, 35, true],
    [27, 35, false],
    [0, 0, false],
    [5, 0, false],
  ])("%i altas con tope %i da %s", (creadas, tope, esperado) => {
    expect(llegoAlAviso(creadas, tope)).toBe(esperado);
  });
});

describe("umbralDelTope", () => {
  it.each([
    [0, 200, null],
    [159.99, 200, null],
    [160, 200, 80],
    [199.99, 200, 80],
    [200, 200, 100],
    [350, 200, 100],
    // Con 30 bases el 80 % son 24: la cuenta es la misma, sin redondeos.
    [23, 30, null],
    [24, 30, 80],
    [30, 30, 100],
  ])("%d con tope %d da %s", (usado, tope, esperado) => {
    expect(umbralDelTope(usado, tope)).toBe(esperado);
  });

  it.each([0, -1, Number.NaN])("con el tope en %d no hay umbral: es «sin límite» o «parado a propósito»", (tope) => {
    expect(umbralDelTope(0, tope)).toBeNull();
    expect(umbralDelTope(5, tope)).toBeNull();
  });

  it("un uso que no es un número no cruza nada", () => {
    expect(umbralDelTope(Number.NaN, 200)).toBeNull();
  });
});

describe("destinatariosDeOperacion", () => {
  it("son las direcciones de operación", () => {
    expect(destinatariosDeOperacion()).toEqual(["ops@example.com", "dueno@example.com"]);
  });

  it("sin casilla remitente no hay por dónde escribirles: ninguna", () => {
    h.remitente.mockReturnValue(null);

    expect(destinatariosDeOperacion()).toEqual([]);
  });
});

describe("mandarAlOperador", () => {
  const DESTINOS = ["ops@example.com", "dueno@example.com"];

  it("manda el mismo mail a cada dirección, con el tipo de correo que se le pide", async () => {
    expect(await mandarAlOperador(DESTINOS, "Asunto", "Texto", "topes")).toBe(true);

    expect(h.enviar.mock.calls).toEqual(
      DESTINOS.map((to) => [{ to, asunto: "Asunto", texto: "Texto" }, { tipo: "topes" }])
    );
  });

  it("con que salga a una alcanza: el aviso se dio", async () => {
    h.enviar.mockResolvedValueOnce({ enviado: false, motivo: "no_salio" }).mockResolvedValueOnce({ enviado: true });

    expect(await mandarAlOperador(DESTINOS, "Asunto", "Texto", "topes")).toBe(true);
  });

  it("si no salió a ninguna, el aviso no se dio", async () => {
    h.enviar.mockResolvedValue({ enviado: false, motivo: "sin_cupo" });

    expect(await mandarAlOperador(DESTINOS, "Asunto", "Texto", "topes")).toBe(false);
  });
});

describe("avisarAlOperador", () => {
  it("toma un solo cupo por día y manda un mail a cada operador, con los números", async () => {
    await avisarAlOperador(17, 20);

    expect(h.rateLimit).toHaveBeenCalledWith(CLAVE, { limit: 1, windowMs: DIA_MS, fallaCerrada: true });
    expect(h.enviar).toHaveBeenCalledTimes(2);
    expect(h.enviar.mock.calls.map(([m]) => m.to)).toEqual(["ops@example.com", "dueno@example.com"]);
    // Cupo propio en el remitente: el aviso no compite con los mails de las personas.
    expect(h.enviar.mock.calls.map(([, opciones]) => opciones)).toEqual([{ tipo: "operador" }, { tipo: "operador" }]);
    for (const [mail] of h.enviar.mock.calls) {
      expect(mail.asunto).toContain("17");
      expect(mail.asunto).toContain("20");
      expect(mail.texto).toContain("17");
      expect(mail.texto).toContain("20");
      expect(`${mail.asunto}${mail.texto}`).not.toMatch(/\{(creadas|tope)\}/);
    }
    expect(h.liberarCupo).not.toHaveBeenCalled();
  });

  it("si hoy ya se avisó, no manda y devuelve el intento que el contador rechazó", async () => {
    h.rateLimit.mockResolvedValue({ allowed: false, remaining: 0, resetAt: 0, retryAfterSeconds: 60, ventana: VENTANA });

    await avisarAlOperador(17, 20);

    expect(h.enviar).not.toHaveBeenCalled();
    expect(h.liberarCupo).toHaveBeenCalledWith(CLAVE, DIA_MS, VENTANA);
  });

  it("sin remitente del sistema no toma el cupo", async () => {
    h.remitente.mockReturnValue(null);

    await avisarAlOperador(17, 20);

    expect(h.rateLimit).not.toHaveBeenCalled();
    expect(h.enviar).not.toHaveBeenCalled();
  });

  it("sin direcciones de operación no toma el cupo", async () => {
    h.operadores.mockReturnValue([]);

    await avisarAlOperador(17, 20);

    expect(h.rateLimit).not.toHaveBeenCalled();
    expect(h.enviar).not.toHaveBeenCalled();
  });

  it("si no salió ninguno, devuelve el cupo para que la próxima alta del día pueda avisar", async () => {
    h.enviar.mockResolvedValue({ enviado: false, motivo: "tope" });

    await avisarAlOperador(17, 20);

    expect(h.liberarCupo).toHaveBeenCalledWith(CLAVE, DIA_MS, VENTANA);
  });

  it("si salió a alguno, el cupo queda gastado", async () => {
    h.enviar.mockResolvedValueOnce({ enviado: false, motivo: "tope" }).mockResolvedValueOnce({ enviado: true });

    await avisarAlOperador(17, 20);

    expect(h.liberarCupo).not.toHaveBeenCalled();
  });

  it("nunca lanza: una falla se anota", async () => {
    h.rateLimit.mockRejectedValue(new Error("sin base"));

    await expect(avisarAlOperador(17, 20)).resolves.toBeUndefined();

    expect(h.error).toHaveBeenCalledWith({ error: "Error" }, "alta.aviso_operador_fallo");
  });

  it("anota que el alta está cerca del tope aunque no pueda mandar el mail", async () => {
    h.remitente.mockReturnValue(null);

    await avisarAlOperador(17, 20);

    expect(h.warn).toHaveBeenCalledWith({ creadas24h: 17, tope: 20 }, "alta.cerca_del_tope");
  });
});

describe("resumenDeAltas", () => {
  const ASUNTO = "ClaimMix: resumen diario de altas";
  const SECRETOS = ["Aseguradora Secreta", "secreto@example.com", "+5491100000000", "admin@example.com"];

  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://claimmix.example.com");
  });

  const textoEnviado = () => (h.enviar.mock.calls[0][0] as { texto: string }).texto;
  const enDias = (n: number) => new Date(AHORA.getTime() + n * DIA_MS).toISOString();

  it.each([
    ["sin remitente", () => h.remitente.mockReturnValue(null)],
    ["sin direcciones de operación", () => h.operadores.mockReturnValue([])],
  ])("%s no toca nada", async (_caso, preparar) => {
    h.listar.mockResolvedValue(panel({ creadas24h: 5 }));
    preparar();

    await expect(resumenDeAltas(AHORA)).resolves.toBe(false);

    expect(h.listar).not.toHaveBeenCalled();
    expect(h.lugares).not.toHaveBeenCalled();
    expect(h.rateLimit).not.toHaveBeenCalled();
    expect(h.enviar).not.toHaveBeenCalled();
  });

  it("con la migración pendiente no manda", async () => {
    h.listar.mockResolvedValue(panel({ migracionPendiente: true, creadas24h: 5 }));

    await expect(resumenDeAltas(AHORA)).resolves.toBe(false);

    expect(h.enviar).not.toHaveBeenCalled();
    expect(h.liberarCupo).toHaveBeenCalledWith(CLAVE_RESUMEN, DIA_MS, VENTANA);
  });

  it.each([null, { usados: 1, tope: 3, libres: 2 }])("un día vacío no manda y devuelve el cupo (WABA %j)", async (lugares) => {
    h.lugares.mockResolvedValue(lugares);

    await expect(resumenDeAltas(AHORA)).resolves.toBe(false);

    expect(h.enviar).not.toHaveBeenCalled();
    expect(h.liberarCupo).toHaveBeenCalledWith(CLAVE_RESUMEN, DIA_MS, VENTANA);
  });

  it("la WABA al 80 % alcanza para mandar", async () => {
    h.lugares.mockResolvedValue({ usados: 4, tope: 5, libres: 1 });

    await expect(resumenDeAltas(AHORA)).resolves.toBe(true);

    expect(textoEnviado()).toContain("- WABA de la plataforma: 4 de 5 números, quedan 1 lugares.");
  });

  it("asunto y cuerpo textuales, una vez por día", async () => {
    h.listar.mockResolvedValue(
      panel({
        creadas24h: 3,
        altas: [fila({ numero: null }), fila({ pruebaHasta: enDias(2) })],
      })
    );
    h.lugares.mockResolvedValue({ usados: 2, tope: 2, libres: 0 });

    await expect(resumenDeAltas(AHORA)).resolves.toBe(true);

    expect(h.enviar.mock.calls.map(([c, o]) => [c.to, c.asunto, o])).toEqual([
      ["ops@example.com", ASUNTO, { tipo: "resumen" }],
      ["dueno@example.com", ASUNTO, { tipo: "resumen" }],
    ]);
    expect(textoEnviado()).toBe(
      [
        "Resumen de las altas automáticas de las últimas 24 horas:",
        "- Altas nuevas: 3 (tope diario 20).",
        "- Espacios con el número en revisión o sin número: 1.",
        "- Pruebas que vencen en 3 días o menos: 1.",
        "- WABA de la plataforma: 2 de 2 números, quedan 0 lugares.",
        "",
        "El detalle está en https://claimmix.example.com/admin/altas. El resumen sale una vez por día y sólo si hay algo que mirar.",
      ].join("\n")
    );
    expect(h.rateLimit).toHaveBeenCalledWith(CLAVE_RESUMEN, { limit: 1, windowMs: DIA_MS, fallaCerrada: true });
    expect(h.liberarCupo).not.toHaveBeenCalled();
  });

  it("cuenta como «en revisión o sin número» sólo lo que hay que mirar", async () => {
    h.listar.mockResolvedValue(
      panel({
        altas: [
          fila({ numero: null }),
          fila({ numeroEnRevision: true, numero: numero("pedido") }),
          fila({ numeroEnRevision: true, numero: numero("conectado") }),
          fila({ numero: numero("pedido") }),
          fila({ numero: numero("baja") }),
          fila({ numero: null, estadoDeFacturacion: "churned" }),
          fila({ numero: null, estadoDeFacturacion: "suspended" }),
        ],
      })
    );

    await resumenDeAltas(AHORA);

    expect(textoEnviado()).toContain("o sin número: 2.");
  });

  it("una prueba vencida no cuenta como viva: el abandonado sin número no hace salir el resumen", async () => {
    h.listar.mockResolvedValue(
      panel({
        altas: [fila({ numero: null, pruebaHasta: enDias(-1) }), fila({ numeroEnRevision: true, numero: numero("pedido"), pruebaHasta: enDias(-10) })],
      })
    );

    await expect(resumenDeAltas(AHORA)).resolves.toBe(false);

    expect(h.enviar).not.toHaveBeenCalled();

    h.listar.mockResolvedValue(
      panel({ altas: [fila({ numero: null, pruebaHasta: enDias(-1) }), fila({ numero: null, pruebaHasta: enDias(10) })] })
    );
    await resumenDeAltas(AHORA);
    expect(textoEnviado()).toContain("o sin número: 1.");
  });

  it("los días del texto y de la ventana salen de la misma constante", async () => {
    h.listar.mockResolvedValue(
      panel({ altas: [fila({ pruebaHasta: enDias(DIAS_DE_AVISO_DE_PRUEBA) }), fila({ pruebaHasta: enDias(DIAS_DE_AVISO_DE_PRUEBA + 1) })] })
    );

    await resumenDeAltas(AHORA);

    expect(textoEnviado()).toContain(`Pruebas que vencen en ${DIAS_DE_AVISO_DE_PRUEBA} días o menos: 1.`);
  });

  it("cuenta las pruebas que vencen en 3 días o menos, y no las vencidas ni las lejanas", async () => {
    h.listar.mockResolvedValue(
      panel({
        altas: [
          fila({ pruebaHasta: enDias(2) }),
          fila({ pruebaHasta: enDias(3) }),
          fila({ pruebaHasta: enDias(-1) }),
          fila({ pruebaHasta: enDias(5) }),
          fila({ estadoDeFacturacion: "active", pruebaHasta: enDias(2) }),
          fila({ pruebaHasta: null }),
        ],
      })
    );

    await resumenDeAltas(AHORA);

    expect(textoEnviado()).toContain("Pruebas que vencen en 3 días o menos: 2.");
  });

  it("con la lista llena marca «+» en lo que sale de ella, y sin línea de WABA si no hay dato", async () => {
    const sinNumero = (n: number) => Array.from({ length: n }, (_, i) => fila({ tenantId: `t${i}`, numero: null }));

    h.listar.mockResolvedValue(panel({ altas: sinNumero(200), creadas24h: 250 }));
    await resumenDeAltas(AHORA);
    expect(textoEnviado()).toContain("o sin número: 200+.");
    expect(textoEnviado()).toContain("Pruebas que vencen en 3 días o menos: 0+.");
    expect(textoEnviado()).toContain("Altas nuevas: 250 (tope diario 20).");
    expect(textoEnviado()).not.toContain("WABA");

    h.enviar.mockClear();
    h.listar.mockResolvedValue(panel({ altas: [...sinNumero(150), ...Array.from({ length: 50 }, () => fila())] }));
    await resumenDeAltas(AHORA);
    expect(textoEnviado()).toContain("o sin número: 150+.");

    h.enviar.mockClear();
    h.listar.mockResolvedValue(panel({ altas: sinNumero(199) }));
    await resumenDeAltas(AHORA);
    expect(textoEnviado()).toContain("o sin número: 199.");
    expect(textoEnviado()).toContain("Pruebas que vencen en 3 días o menos: 0.");
  });

  it("cupo tomado: no consulta ni manda, y lo devuelve", async () => {
    h.listar.mockResolvedValue(panel({ creadas24h: 1 }));
    h.rateLimit.mockResolvedValue({ allowed: false, ventana: VENTANA });

    await expect(resumenDeAltas(AHORA)).resolves.toBe(false);

    expect(h.listar).not.toHaveBeenCalled();
    expect(h.lugares).not.toHaveBeenCalled();
    expect(h.enviar).not.toHaveBeenCalled();
    expect(h.liberarCupo).toHaveBeenCalledWith(CLAVE_RESUMEN, DIA_MS, VENTANA);
  });

  it("si el correo no sale a nadie, devuelve el cupo", async () => {
    h.listar.mockResolvedValue(panel({ creadas24h: 1 }));
    h.enviar.mockResolvedValue({ enviado: false, motivo: "no_salio" });

    await expect(resumenDeAltas(AHORA)).resolves.toBe(false);

    expect(h.liberarCupo).toHaveBeenCalledWith(CLAVE_RESUMEN, DIA_MS, VENTANA);
  });

  it("si sale a uno solo, el cupo queda gastado", async () => {
    h.listar.mockResolvedValue(panel({ creadas24h: 1 }));
    h.enviar.mockResolvedValueOnce({ enviado: false, motivo: "no_salio" }).mockResolvedValueOnce({ enviado: true });

    await expect(resumenDeAltas(AHORA)).resolves.toBe(true);

    expect(h.liberarCupo).not.toHaveBeenCalled();
  });

  it.each([
    ["la lista", () => h.listar.mockRejectedValue(new Error("dato-secreto"))],
    ["Graph", () => h.lugares.mockRejectedValue(new Error("dato-secreto"))],
    ["el contador", () => h.rateLimit.mockRejectedValue(new Error("dato-secreto"))],
  ])("nunca lanza, aunque falle %s, y el log no trae el mensaje", async (_caso, preparar) => {
    h.listar.mockResolvedValue(panel({ creadas24h: 1 }));
    preparar();

    await expect(resumenDeAltas(AHORA)).resolves.toBe(false);

    expect(h.error).toHaveBeenCalledWith({ error: "Error" }, "alta.resumen_fallo");
  });

  it.each([
    ["la lista", () => h.listar.mockRejectedValue(new Error("x"))],
    ["Graph", () => h.lugares.mockRejectedValue(new Error("x"))],
  ])("si falla %s después de tomar el cupo, lo devuelve", async (_caso, preparar) => {
    preparar();

    await resumenDeAltas(AHORA);

    expect(h.liberarCupo).toHaveBeenCalledWith(CLAVE_RESUMEN, DIA_MS, VENTANA);
  });

  it("no lleva datos de nadie y consulta una sola vez la lista y la WABA", async () => {
    h.listar.mockResolvedValue(panel({ creadas24h: 1, altas: [fila({ numero: null })] }));

    await resumenDeAltas(AHORA);

    const [{ asunto, texto }] = h.enviar.mock.calls[0];
    for (const secreto of SECRETOS) {
      expect(asunto).not.toContain(secreto);
      expect(texto).not.toContain(secreto);
    }
    expect(h.listar).toHaveBeenCalledTimes(1);
    expect(h.lugares).toHaveBeenCalledTimes(1);
  });
});
