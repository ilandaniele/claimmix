/**
 * El aviso de que el alta se acerca a su tope diario.
 *
 * Una vez por día, a cada dirección de operación, sin datos de nadie, y sin
 * romper nunca el alta que lo dispara.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  rateLimit: vi.fn(),
  liberarCupo: vi.fn(),
  remitente: vi.fn(),
  enviar: vi.fn(),
  operadores: vi.fn(),
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

import {
  avisarAlOperador,
  destinatariosDeOperacion,
  FRACCION_DEL_AVISO,
  llegoAlAviso,
  mandarAlOperador,
  umbralDelTope,
} from "@/server/alta/aviso-operador";

const DIA_MS = 24 * 60 * 60_000;
const VENTANA = 1_700_000_000_000;
const CLAVE = "alta:aviso80";

beforeEach(() => {
  vi.clearAllMocks();
  h.remitente.mockReturnValue("alta@example.com");
  h.operadores.mockReturnValue(["ops@example.com", "dueno@example.com"]);
  h.rateLimit.mockResolvedValue({ allowed: true, remaining: 0, resetAt: 0, retryAfterSeconds: 0, ventana: VENTANA });
  h.liberarCupo.mockResolvedValue(undefined);
  h.enviar.mockResolvedValue({ enviado: true });
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
