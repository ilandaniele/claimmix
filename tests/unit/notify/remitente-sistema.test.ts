/**
 * El remitente de los mails de autenticación y sus topes.
 *
 * Los dos riesgos de este módulo no son que falle —falla y se pide otro mail—
 * sino que sirva para llenarle la bandeja a alguien (tope por destinatario) o
 * para quemar la reputación de la casilla (tope global). Los topes cuentan en
 * el limitador de verdad, el de memoria; lo único que se reemplaza es Gmail.
 */

const { mockSend, mockCrear, mockCasillas } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  mockCrear: vi.fn(),
  mockCasillas: { listar: vi.fn(), porInquilino: vi.fn(), porCorreo: vi.fn() },
}));

vi.mock("@/server/email/gmail/accounts", () => ({
  listEnabledGmailAccounts: mockCasillas.listar,
  getGmailAccountForTenant: mockCasillas.porInquilino,
  getGmailAccountByEmail: mockCasillas.porCorreo,
}));

vi.mock("@/server/email/gmail/gmail-sender", () => ({
  GmailSender: class {
    constructor(refreshToken?: string) {
      mockCrear(refreshToken);
    }
    send = mockSend;
  },
}));

vi.mock("@/lib/rate-limit", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/rate-limit")>();
  return { ...real, rateLimit: vi.fn(real.rateLimit), liberarCupo: vi.fn(real.liberarCupo) };
});

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { clearAllRateLimits, rateLimit } from "@/lib/rate-limit";
import {
  enviarCorreoDelSistema,
  huellaDeLaDireccion,
  remitenteDelSistema,
  type OpcionesDeCorreo,
} from "@/server/notify/remitente-sistema";

const DIA_MS = 24 * 60 * 60_000;
/** Armada aparte: el chequeo de datos personales marca cualquier dirección entera de Gmail, y acá son de mentira. */
const GMAIL = "gmail.com";
const TOKEN_DEL_ENLACE = "fake-tok-9f8e7d-no-deberia-aparecer-en-ningun-registro";

function correo(to: string) {
  return { to, asunto: "Asunto", texto: `Abrí https://claimmix.example.com/r/${TOKEN_DEL_ENLACE}` };
}

/** Sin IP y de tipo `invitacion`: el cupo por dirección cuenta sólo la dirección. */
function enviar(to: string, opciones: OpcionesDeCorreo = { tipo: "invitacion" }) {
  return enviarCorreoDelSistema(correo(to), opciones);
}

let logs: string[] = [];
let spies: ReturnType<typeof vi.spyOn>[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  clearAllRateLimits();
  logs = [];
  spies = (["info", "warn", "error"] as const).map((nivel) =>
    vi.spyOn(console, nivel).mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    })
  );
  vi.stubEnv("ALTA_REMITENTE_CORREO", "sistema@example.com");
  vi.stubEnv("ALTA_REMITENTE_REFRESH_TOKEN", "test-refresh-key");
  vi.stubEnv("GMAIL_CLIENT_ID", "fake-client-id");
  vi.stubEnv("GMAIL_CLIENT_SECRET", "fake-client-secret");
  vi.stubEnv("ALTA_TOPE_CORREOS_DIA", "");
  vi.stubEnv("ALTA_TOPE_POR_DESTINATARIO_DIA", "");
  mockSend.mockResolvedValue({ providerMessageId: "sent-1" });
});

afterEach(() => {
  for (const s of spies) s.mockRestore();
  vi.unstubAllEnvs();
});

describe("remitenteDelSistema", () => {
  it("devuelve la casilla y el token sin espacios", () => {
    vi.stubEnv("ALTA_REMITENTE_CORREO", "  sistema@example.com ");
    vi.stubEnv("ALTA_REMITENTE_REFRESH_TOKEN", " test-refresh-key\n");

    expect(remitenteDelSistema()).toEqual({ correo: "sistema@example.com", refreshToken: "test-refresh-key" });
  });

  it.each([
    ["falta el correo", "ALTA_REMITENTE_CORREO"],
    ["falta el token", "ALTA_REMITENTE_REFRESH_TOKEN"],
    ["falta GMAIL_CLIENT_ID", "GMAIL_CLIENT_ID"],
    ["falta GMAIL_CLIENT_SECRET", "GMAIL_CLIENT_SECRET"],
  ])("es null si %s", (_caso, variable) => {
    vi.stubEnv(variable, "   ");

    expect(remitenteDelSistema()).toBeNull();
  });

  it.each(["GMAIL_CLIENT_ID", "GMAIL_CLIENT_SECRET"])(
    "con el correo y el token pero sin %s no hay remitente",
    (variable) => {
      vi.stubEnv(variable, undefined);

      expect(remitenteDelSistema()).toBeNull();
    }
  );
});

describe("el envío", () => {
  it("sale desde la casilla del sistema con su token, hacia la dirección tal cual vino", async () => {
    const r = await enviar("  Ana+Pruebas@Example.com ");

    expect(r).toEqual({ enviado: true });
    expect(mockCrear).toHaveBeenCalledWith("test-refresh-key");
    expect(mockSend).toHaveBeenCalledTimes(1);
    const enviado = mockSend.mock.calls[0][0];
    // La etiqueta es parte de la dirección: se ignora al contar, no al mandar.
    expect(enviado.to).toBe("Ana+Pruebas@Example.com");
    expect(enviado.from).toBe("ClaimMix <sistema@example.com>");
    expect(enviado.subject).toBe("Asunto");
    expect(enviado.textBody).toContain(TOKEN_DEL_ENLACE);
  });

  it.each([["el refresh token", "ALTA_REMITENTE_REFRESH_TOKEN"], ["el cliente OAuth", "GMAIL_CLIENT_ID"]])(
    "sin remitente (falta %s) no manda nada, no cuenta cupo y deja el motivo",
    async (_caso, variable) => {
      vi.stubEnv(variable, "");

      const r = await enviar("ana@example.com");

      expect(r).toEqual({ enviado: false, motivo: "sin_remitente" });
      expect(mockSend).not.toHaveBeenCalled();
      expect(vi.mocked(rateLimit)).not.toHaveBeenCalled();
      expect(logs.join("\n")).toContain("correo_sistema.sin_remitente");
    }
  );

  it.each([
    ["una lista", "ana@example.com, otra@example.com"],
    ["un nombre con ángulos", "Ana <ana@example.com>"],
    ["un salto de línea con otro encabezado", "ana@example.com\r\nBcc: otra@example.com"],
    ["sin arroba", "ana.example.com"],
    ["sin dominio", "ana@"],
    ["vacía", "  "],
    ["demasiado larga", `${"a".repeat(250)}@example.com`],
  ])("no manda a %s", async (_caso, to) => {
    const r = await enviar(to);

    expect(r).toEqual({ enviado: false, motivo: "destinatario_invalido" });
    expect(mockSend).not.toHaveBeenCalled();
    expect(vi.mocked(rateLimit)).not.toHaveBeenCalled();
  });
});

describe("el tope por destinatario", () => {
  it("el cuarto mail del día a la misma dirección no sale", async () => {
    const resultados = [];
    for (let i = 0; i < 4; i++) resultados.push(await enviar("ana@example.com"));

    expect(resultados.map((r) => r.enviado)).toEqual([true, true, true, false]);
    expect(resultados[3]).toEqual({ enviado: false, motivo: "sin_cupo" });
    expect(mockSend).toHaveBeenCalledTimes(3);
  });

  it("las mayúsculas y la etiqueta + son la misma bandeja", async () => {
    const direcciones = ["Ana@Example.com", "ana+1@example.com", " ana+otra@EXAMPLE.com", "ana+3@example.com"];
    const resultados = [];
    for (const d of direcciones) resultados.push(await enviar(d));

    expect(resultados.map((r) => r.enviado)).toEqual([true, true, true, false]);
  });

  it("otra persona no se ve afectada por el tope de la primera", async () => {
    for (let i = 0; i < 4; i++) await enviar("ana@example.com");

    const r = await enviar("beto@example.com");

    expect(r).toEqual({ enviado: true });
  });

  it("ALTA_TOPE_POR_DESTINATARIO_DIA lo cambia", async () => {
    vi.stubEnv("ALTA_TOPE_POR_DESTINATARIO_DIA", "1");

    const primero = await enviar("ana@example.com");
    const segundo = await enviar("ana@example.com");

    expect([primero.enviado, segundo.enviado]).toEqual([true, false]);
  });

  it("un valor roto vuelve al tope por omisión y no lo deja sin límite", async () => {
    vi.stubEnv("ALTA_TOPE_POR_DESTINATARIO_DIA", "mucho");

    const resultados = [];
    for (let i = 0; i < 4; i++) resultados.push((await enviar("ana@example.com")).enviado);

    expect(resultados).toEqual([true, true, true, false]);
  });
});

describe("el tope global", () => {
  it("el mail 51 del día no sale, sea para quien sea", async () => {
    for (let i = 0; i < 50; i++) {
      const r = await enviar(`persona${i}@example.com`);
      expect(r.enviado).toBe(true);
    }

    const r = await enviar("persona-nueva@example.com");

    expect(r).toEqual({ enviado: false, motivo: "sin_cupo" });
    expect(mockSend).toHaveBeenCalledTimes(50);
  });

  it("ALTA_TOPE_CORREOS_DIA lo cambia", async () => {
    vi.stubEnv("ALTA_TOPE_CORREOS_DIA", "2");

    const resultados = [];
    for (const d of ["a@example.com", "b@example.com", "c@example.com"]) {
      resultados.push((await enviar(d)).enviado);
    }

    expect(resultados).toEqual([true, true, false]);
  });

  it("los intentos rechazados por destinatario no se comen el tope global", async () => {
    // Si alguien insiste con la dirección de otra persona, el costo es de esa
    // dirección: no puede vaciar el cupo de todos.
    vi.stubEnv("ALTA_TOPE_CORREOS_DIA", "4");
    for (let i = 0; i < 3; i++) await enviar("ana@example.com");
    for (let i = 0; i < 20; i++) {
      expect(await enviar("ana@example.com")).toEqual({ enviado: false, motivo: "sin_cupo" });
    }

    const beto = await enviar("beto@example.com");
    const carla = await enviar("carla@example.com");

    expect([beto.enviado, carla.enviado]).toEqual([true, false]);
  });
});

describe("los cupos son por tipo de mail", () => {
  it("con el cupo global de las altas lleno, la recuperación sale igual", async () => {
    vi.stubEnv("ALTA_TOPE_CORREOS_DIA", "2");
    const IP = "203.0.113.7";
    // Un anónimo llena el cupo de las altas con direcciones que no existen.
    for (const d of ["a@example.com", "b@example.com"]) await enviar(d, { tipo: "alta", ip: IP });
    expect(await enviar("c@example.com", { tipo: "alta", ip: IP })).toEqual({ enviado: false, motivo: "sin_cupo" });

    const recuperacion = await enviar("ana@example.com", { tipo: "recuperacion", ip: "198.51.100.9" });
    const invitacion = await enviar("beto@example.com", { tipo: "invitacion" });
    const aviso = await enviar("ops@example.com", { tipo: "operador" });

    expect([recuperacion.enviado, invitacion.enviado, aviso.enviado]).toEqual([true, true, true]);
  });

  it("el cupo por dirección tampoco se comparte entre tipos", async () => {
    for (let i = 0; i < 3; i++) await enviar("ana@example.com", { tipo: "alta", ip: "203.0.113.7" });

    expect(await enviar("ana@example.com", { tipo: "alta", ip: "203.0.113.7" })).toEqual({
      enviado: false,
      motivo: "sin_cupo",
    });
    expect(await enviar("ana@example.com", { tipo: "recuperacion", ip: "203.0.113.7" })).toEqual({ enviado: true });
  });

  it("la recuperación se cuenta por (IP, dirección): tres pedidos de una IP no traban el de otra", async () => {
    // Un tercero gasta el cupo del día de la víctima desde su IP...
    for (let i = 0; i < 3; i++) {
      expect((await enviar("victima@example.com", { tipo: "recuperacion", ip: "203.0.113.7" })).enviado).toBe(true);
    }
    expect(await enviar("victima@example.com", { tipo: "recuperacion", ip: "203.0.113.7" })).toEqual({
      enviado: false,
      motivo: "sin_cupo",
    });

    // ...y el pedido de ella, desde otra, sale.
    const suyo = await enviar("victima@example.com", { tipo: "recuperacion", ip: "198.51.100.9" });

    expect(suyo).toEqual({ enviado: true });
  });

  it("lo mismo vale para las altas", async () => {
    for (let i = 0; i < 3; i++) await enviar("victima@example.com", { tipo: "alta", ip: "203.0.113.7" });

    expect(await enviar("victima@example.com", { tipo: "alta", ip: "198.51.100.9" })).toEqual({ enviado: true });
  });

  it("la invitación y el aviso no cuentan por IP: es el mismo cupo desde cualquier lado", async () => {
    for (let i = 0; i < 3; i++) await enviar("ana@example.com", { tipo: "invitacion", ip: `203.0.113.${i + 1}` });

    expect(await enviar("ana@example.com", { tipo: "invitacion", ip: "198.51.100.9" })).toEqual({
      enviado: false,
      motivo: "sin_cupo",
    });
  });

  it("el aviso de los topes tiene su propio cupo: los avisos de números a la misma dirección no lo gastan", async () => {
    // El operador recibe los dos tipos en la misma casilla: tres avisos de números no le tapan el de un tope.
    for (let i = 0; i < 3; i++) await enviar("ops@example.com", { tipo: "operador" });
    expect(await enviar("ops@example.com", { tipo: "operador" })).toEqual({ enviado: false, motivo: "sin_cupo" });

    expect(await enviar("ops@example.com", { tipo: "topes" })).toEqual({ enviado: true });
  });

  it("el aviso de los topes no cuenta por dirección: el del 100 % sale aunque ese día ya hayan salido tres", async () => {
    for (let i = 0; i < 4; i++) {
      expect(await enviar("ops@example.com", { tipo: "topes" })).toEqual({ enviado: true });
    }

    const claves = vi.mocked(rateLimit).mock.calls.map(([clave]) => clave);
    expect(claves).toEqual(Array(4).fill("alta:correos:topes"));
    expect(mockSend).toHaveBeenCalledTimes(4);
  });

  it("el aviso de los topes conserva su cupo global del día", async () => {
    vi.stubEnv("ALTA_TOPE_CORREOS_DIA", "2");

    expect(await enviar("ops@example.com", { tipo: "topes" })).toEqual({ enviado: true });
    expect(await enviar("dueno@example.com", { tipo: "topes" })).toEqual({ enviado: true });
    expect(await enviar("ops@example.com", { tipo: "topes" })).toEqual({ enviado: false, motivo: "sin_cupo" });
  });

  it("las claves llevan el tipo y, en alta y recuperación, la IP", async () => {
    await enviar("ana@example.com", { tipo: "recuperacion", ip: "203.0.113.7" });

    const claves = vi.mocked(rateLimit).mock.calls.map(([clave]) => clave);
    expect(claves[0]).toBe("alta:correos:recuperacion");
    expect(claves[1]).toMatch(/^alta:destinatario:recuperacion:203\.0\.113\.7:[0-9a-f]{64}$/);
  });

  it("el pedido de acceso no tiene cupo por dirección: los cinco del tope del espacio salen al mismo administrador", async () => {
    for (let i = 0; i < 5; i++) {
      expect(await enviar("admin@example.com", { tipo: "acceso", ip: `203.0.113.${i + 1}` })).toEqual({ enviado: true });
    }

    const claves = vi.mocked(rateLimit).mock.calls.map(([clave]) => clave);
    expect(claves).toEqual(Array(5).fill("alta:correos:acceso"));
    expect(mockSend).toHaveBeenCalledTimes(5);
  });

  it("el pedido de acceso tiene su propio cupo global: llenarlo no frena las invitaciones", async () => {
    vi.stubEnv("ALTA_TOPE_CORREOS_DIA", "2");
    for (const d of ["a@example.com", "b@example.com"]) await enviar(d, { tipo: "acceso" });
    expect(await enviar("c@example.com", { tipo: "acceso" })).toEqual({ enviado: false, motivo: "sin_cupo" });

    expect(await enviar("c@example.com", { tipo: "invitacion" })).toEqual({ enviado: true });
  });

  it("los pedidos de acceso no gastan el cupo por dirección de las invitaciones al mismo administrador", async () => {
    for (let i = 0; i < 5; i++) await enviar("admin@example.com", { tipo: "acceso" });

    expect(await enviar("admin@example.com", { tipo: "invitacion" })).toEqual({ enviado: true });
  });
});

describe("huellaDeLaDireccion", () => {
  it("es la huella con la que el limitador cuenta a la dirección en el cupo por destinatario", async () => {
    await enviar("Ana.Perez+x@Gmail.com");

    const clave = vi.mocked(rateLimit).mock.calls[1][0];
    expect(clave).toBe(`alta:destinatario:invitacion:${huellaDeLaDireccion(`ana.perez+x@${GMAIL}`)}`);
    expect(huellaDeLaDireccion(`anaperez@${GMAIL}`)).toBe(huellaDeLaDireccion("Ana.Perez+x@Gmail.com"));
  });

  it("los alias de Gmail son la misma huella y las direcciones distintas no", () => {
    const base = huellaDeLaDireccion(`ana@${GMAIL}`);

    expect(base).toMatch(/^[0-9a-f]{64}$/);
    expect(huellaDeLaDireccion("a.na+pedido@googlemail.com")).toBe(base);
    expect(huellaDeLaDireccion(`beto@${GMAIL}`)).not.toBe(base);
    expect(huellaDeLaDireccion("ana.perez@example.com")).not.toBe(huellaDeLaDireccion("anaperez@example.com"));
  });

  it("no guarda la dirección: es un hash", () => {
    expect(huellaDeLaDireccion("ana@example.com")).not.toContain("ana");
  });

  it.each(["", "no es una dirección", "a@example.com, b@example.com", "Ana <a@example.com>", "a@b", `${"a".repeat(250)}@example.com`])(
    "%j no es una dirección sola: null",
    (valor) => {
      expect(huellaDeLaDireccion(valor)).toBeNull();
    }
  );
});

describe("una misma bandeja de Gmail", () => {
  it("los puntos, la etiqueta y googlemail.com son la misma dirección", async () => {
    const dominio = "gmail.com";
    const variantes = [`ana.perez@${dominio}`, `an.a.p.erez@${dominio}`, `anaperez+x@${dominio}`, "Ana.Perez@googlemail.com"];
    const resultados = [];
    for (const d of variantes) resultados.push((await enviar(d)).enviado);

    expect(resultados).toEqual([true, true, true, false]);
  });

  it("los puntos de otro dominio sí distinguen direcciones", async () => {
    for (let i = 0; i < 3; i++) await enviar("ana.perez@example.com");

    expect(await enviar("anaperez@example.com")).toEqual({ enviado: true });
  });

  it("al mandar, la dirección va tal cual vino", async () => {
    await enviar("Ana.Perez@Gmail.com");

    expect(mockSend.mock.calls[0][0].to).toBe("Ana.Perez@Gmail.com");
  });
});

describe("cuando el mail no sale", () => {
  it("un envío fallido devuelve el cupo y se puede volver a pedir", async () => {
    mockSend.mockResolvedValueOnce({ errorCode: "GMAIL_SEND_FAILED" });

    const fallido = await enviar("ana@example.com");
    const resultados = [];
    for (let i = 0; i < 4; i++) resultados.push((await enviar("ana@example.com")).enviado);

    expect(fallido).toEqual({ enviado: false, motivo: "no_salio" });
    // El que falló no gastó cupo: entran los tres del día, y el cuarto no.
    expect(resultados).toEqual([true, true, true, false]);
    expect(logs.join("\n")).toContain("correo_sistema.send_failed");
  });

  it("nunca lanza, aunque Gmail tire", async () => {
    mockSend.mockRejectedValueOnce(new Error("se cayó Gmail"));

    await expect(enviar("ana@example.com")).resolves.toEqual({
      enviado: false,
      motivo: "no_salio",
    });
    expect(logs.join("\n")).toContain("correo_sistema.error");
  });

  it("si el contador no contesta, cierra: no manda", async () => {
    // `fallaCerrada` responde «no» con ventana 0 cuando la base no contesta.
    vi.mocked(rateLimit).mockResolvedValueOnce({
      allowed: false,
      remaining: 0,
      resetAt: Date.now() + 60_000,
      retryAfterSeconds: 60,
      ventana: 0,
    });

    const r = await enviar("ana@example.com");

    expect(r).toEqual({ enviado: false, motivo: "sin_cupo" });
    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe("cómo cuenta", () => {
  it("usa los dos cupos por día y los dos cierran si el contador falla", async () => {
    await enviar("Ana@example.com");

    const llamadas = vi.mocked(rateLimit).mock.calls;
    expect(llamadas).toHaveLength(2);
    expect(llamadas[0][0]).toBe("alta:correos:invitacion");
    expect(llamadas[1][0]).toMatch(/^alta:destinatario:invitacion:[0-9a-f]{64}$/);
    for (const [, config] of llamadas) {
      expect(config).toMatchObject({ windowMs: DIA_MS, fallaCerrada: true });
    }
    expect(llamadas[0][1].limit).toBe(50);
    expect(llamadas[1][1].limit).toBe(3);
  });

  it("la clave del destinatario es un hash: la dirección no queda en el limitador", async () => {
    await enviar("ana@example.com");

    const clave = vi.mocked(rateLimit).mock.calls[1][0];
    expect(clave).not.toContain("ana");
    expect(clave).not.toContain("@");
  });

  it("ni la dirección ni el enlace aparecen en los registros", async () => {
    vi.stubEnv("ALTA_TOPE_POR_DESTINATARIO_DIA", "1");
    await enviar("ana@example.com");
    await enviar("ana@example.com");
    mockSend.mockRejectedValueOnce(new Error("ana@example.com"));
    await enviar("beto@example.com");
    await enviar("no es una dirección");

    const todo = logs.join("\n");
    expect(todo).toContain("correo_sistema.sin_cupo");
    expect(todo).not.toContain("ana@example.com");
    expect(todo).not.toContain("beto@example.com");
    expect(todo).not.toContain(TOKEN_DEL_ENLACE);
  });
});

describe("la casilla del sistema no es una casilla conectada", () => {
  it("el envío no mira ni escribe las casillas de las aseguradoras", async () => {
    await enviar("ana@example.com");

    // El poller sólo lee las filas de gmail_accounts: si el remitente no pasa
    // por ahí, no hay rebotes que abran casos ni respuestas que entren a una bandeja.
    for (const f of Object.values(mockCasillas)) expect(f).not.toHaveBeenCalled();
  });

  it("el módulo no importa ni la tabla de casillas ni la base", () => {
    const fuente = readFileSync(resolve(__dirname, "../../../src/server/notify/remitente-sistema.ts"), "utf8");
    const imports = fuente
      .split("\n")
      .filter((l) => /^\s*(import|\} from)\b/.test(l))
      .join("\n");

    expect(imports).not.toMatch(/gmail\/accounts/);
    expect(imports).not.toMatch(/@\/lib\/db/);
  });
});
