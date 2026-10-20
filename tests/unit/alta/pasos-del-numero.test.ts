/**
 * Las piezas compartidas del alta de un número (`@/server/alta/pasos-del-numero`):
 * los cupos que se toman y se devuelven, las salidas que ve la persona y el webhook
 * propio del número. El orden de los pasos que las usa se prueba en
 * `numero-automatico.test.ts`; acá se fija lo que cada una promete sola, porque
 * otros caminos del alta se apoyan en ellas.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  rateLimit: vi.fn(),
  liberarCupo: vi.fn(),
  after: vi.fn(),
  aviso: vi.fn(),
  fijarWebhook: vi.fn(),
  leerWebhook: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  // Igual que Next: la tarea corre después; acá corre en el momento y se cuenta.
  after: (tarea: () => unknown) => {
    h.after();
    void tarea();
  },
}));
vi.mock("@/lib/observability/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: h.warn, error: h.error },
}));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: h.rateLimit, liberarCupo: h.liberarCupo }));
vi.mock("@/server/alta/aviso-operador", () => ({ avisarNumeroEnRevision: h.aviso }));
vi.mock("@/server/whatsapp/alta-de-numero", () => ({
  fijarWebhookDelNumero: h.fijarWebhook,
  webhookPropioEs: h.leerWebhook,
}));

import {
  aRevision,
  deFalla,
  fijarElWebhook,
  ponerElWebhook,
  sinDueno,
  soltar,
  tomar,
  type Cupo,
  type Entorno,
} from "@/server/alta/pasos-del-numero";

const DIA_MS = 24 * 60 * 60_000;
const VENTANA = 1_700_000_000_000;
const TENANT = "11111111-1111-4111-8111-111111111111";
const USUARIO = "22222222-2222-4222-8222-222222222222";
const ID = "100000000000777";

const cupo = (cual: string, limit = 3): Cupo => ({ cual, clave: `clave:${cual}`, limit, windowMs: DIA_MS });

const WEBHOOK = { url: "https://claimmix.example.com/api/webhooks/whatsapp", verifyToken: "fake-verify-token" };

const ENTORNO: Entorno = {
  cred: { accessToken: "fake-access-token", wabaId: "200000000000001" },
  plataforma: "100000000000001",
  webhook: WEBHOOK,
};

beforeEach(() => {
  vi.clearAllMocks();
  h.rateLimit.mockResolvedValue({ allowed: true, ventana: VENTANA });
  h.liberarCupo.mockResolvedValue(undefined);
  h.aviso.mockResolvedValue(undefined);
});

describe("tomar", () => {
  it("toma todos los cupos en orden, siempre cerrando si el contador no contesta", async () => {
    const toma = await tomar([cupo("a"), cupo("b", 5)]);

    expect(toma).toEqual({
      ok: true,
      tomados: [
        { clave: "clave:a", windowMs: DIA_MS, ventana: VENTANA },
        { clave: "clave:b", windowMs: DIA_MS, ventana: VENTANA },
      ],
    });
    expect(h.rateLimit.mock.calls).toEqual([
      ["clave:a", { limit: 3, windowMs: DIA_MS, fallaCerrada: true }],
      ["clave:b", { limit: 5, windowMs: DIA_MS, fallaCerrada: true }],
    ]);
    expect(h.liberarCupo).not.toHaveBeenCalled();
  });

  it("un límite 0 es «sin lugar»: no llama al contador y devuelve lo ya tomado", async () => {
    const toma = await tomar([cupo("a"), cupo("b", 0), cupo("c")]);

    expect(toma).toEqual({ ok: false, cual: "b" });
    expect(h.rateLimit).toHaveBeenCalledTimes(1);
    expect(h.liberarCupo).toHaveBeenCalledTimes(1);
    expect(h.liberarCupo).toHaveBeenCalledWith("clave:a", DIA_MS, VENTANA);
  });

  it("si uno rechaza, dice cuál y devuelve todo, también el intento que el contador rechazó", async () => {
    h.rateLimit
      .mockResolvedValueOnce({ allowed: true, ventana: VENTANA })
      .mockResolvedValueOnce({ allowed: false, ventana: VENTANA + 1 });

    const toma = await tomar([cupo("a"), cupo("b"), cupo("c")]);

    expect(toma).toEqual({ ok: false, cual: "b" });
    expect(h.rateLimit).toHaveBeenCalledTimes(2);
    expect(h.liberarCupo.mock.calls).toEqual([
      ["clave:a", DIA_MS, VENTANA],
      ["clave:b", DIA_MS, VENTANA + 1],
    ]);
  });

  it("si el contador tira, tira: la llamada que lo usa cierra", async () => {
    h.rateLimit.mockRejectedValueOnce(new Error("sin contador"));

    await expect(tomar([cupo("a")])).rejects.toThrow("sin contador");
  });
});

describe("soltar", () => {
  it("nunca tira: un cupo que no vuelve no rompe lo que sigue", async () => {
    h.liberarCupo.mockRejectedValueOnce(new Error("sin contador")).mockResolvedValueOnce(undefined);

    await expect(
      soltar([
        { clave: "clave:a", windowMs: DIA_MS, ventana: VENTANA },
        { clave: "clave:b", windowMs: DIA_MS, ventana: VENTANA },
      ])
    ).resolves.toBeUndefined();

    expect(h.liberarCupo).toHaveBeenCalledTimes(2);
    expect(h.warn).toHaveBeenCalledTimes(1);
  });
});

describe("las salidas", () => {
  it("aRevision avisa al operador después de contestar y devuelve «revision»", () => {
    expect(aRevision("pais", TENANT)).toBe("revision");

    expect(h.after).toHaveBeenCalledTimes(1);
    expect(h.aviso).toHaveBeenCalledWith("pais", TENANT);
  });

  it("deFalla: «esperar» y «meta» salen tal cual, un rechazo se mira a mano", () => {
    expect(deFalla("esperar", TENANT)).toBe("esperar");
    expect(deFalla("meta", TENANT)).toBe("meta");
    expect(h.aviso).not.toHaveBeenCalled();

    expect(deFalla("rechazo", TENANT)).toBe("revision");
    expect(h.aviso).toHaveBeenCalledWith("rechazo", TENANT);
  });

  it("sinDueno anota qué dijo la función, sin datos de la persona, y avisa «sin_dueno»", () => {
    const quien = { tenantId: TENANT, userId: USUARIO, ip: "203.0.113.7", idioma: "es-AR" as const };

    expect(sinDueno(quien, "conectado", "id_ocupado")).toBe("revision");

    expect(h.error).toHaveBeenCalledWith(
      { tenantId: TENANT, paso: "conectado", guardado: "id_ocupado" },
      "alta.numero_automatico_no_guardado"
    );
    expect(h.aviso).toHaveBeenCalledWith("sin_dueno", TENANT);
  });
});

describe("ponerElWebhook", () => {
  it("lo pone, lo lee de Graph y, si quedó, devuelve null", async () => {
    h.fijarWebhook.mockResolvedValue({ ok: true, valor: true });
    h.leerWebhook.mockResolvedValue({ ok: true, valor: true });

    await expect(ponerElWebhook(ENTORNO.cred, ID, WEBHOOK)).resolves.toBeNull();

    expect(h.fijarWebhook).toHaveBeenCalledWith(ENTORNO.cred, ID, WEBHOOK);
    expect(h.leerWebhook).toHaveBeenCalledWith(ENTORNO.cred, ID, WEBHOOK.url);
  });

  it("una falla al ponerlo sale tal cual y no lee", async () => {
    h.fijarWebhook.mockResolvedValue({ ok: false, falla: "meta", codigo: null });

    await expect(ponerElWebhook(ENTORNO.cred, ID, WEBHOOK)).resolves.toBe("meta");

    expect(h.leerWebhook).not.toHaveBeenCalled();
  });

  it("una falla al leerlo sale tal cual", async () => {
    h.fijarWebhook.mockResolvedValue({ ok: true, valor: true });
    h.leerWebhook.mockResolvedValue({ ok: false, falla: "esperar", codigo: 4 });

    await expect(ponerElWebhook(ENTORNO.cred, ID, WEBHOOK)).resolves.toBe("esperar");
  });

  it("si Graph devuelve otro, dice «no_quedo»", async () => {
    h.fijarWebhook.mockResolvedValue({ ok: true, valor: true });
    h.leerWebhook.mockResolvedValue({ ok: true, valor: false });

    await expect(ponerElWebhook(ENTORNO.cred, ID, WEBHOOK)).resolves.toBe("no_quedo");
  });
});

describe("fijarElWebhook", () => {
  it("lo pone, lo lee de Graph y, si quedó, no devuelve nada", async () => {
    h.fijarWebhook.mockResolvedValue({ ok: true, valor: true });
    h.leerWebhook.mockResolvedValue({ ok: true, valor: true });

    await expect(fijarElWebhook(TENANT, ID, ENTORNO)).resolves.toBeNull();

    expect(h.fijarWebhook).toHaveBeenCalledWith(ENTORNO.cred, ID, WEBHOOK);
    expect(h.leerWebhook).toHaveBeenCalledWith(ENTORNO.cred, ID, WEBHOOK.url);
    expect(h.aviso).not.toHaveBeenCalled();
  });

  it("poner no alcanza: si Graph devuelve otro, el número se mira a mano", async () => {
    h.fijarWebhook.mockResolvedValue({ ok: true, valor: true });
    h.leerWebhook.mockResolvedValue({ ok: true, valor: false });

    await expect(fijarElWebhook(TENANT, ID, ENTORNO)).resolves.toBe("revision");

    expect(h.aviso).toHaveBeenCalledWith("sin_webhook", TENANT);
  });

  it("una falla al ponerlo corta antes de leerlo", async () => {
    h.fijarWebhook.mockResolvedValue({ ok: false, falla: "esperar", codigo: 4 });

    await expect(fijarElWebhook(TENANT, ID, ENTORNO)).resolves.toBe("esperar");

    expect(h.leerWebhook).not.toHaveBeenCalled();
  });

  it("una falla al leerlo sale como la de Graph, y un rechazo se mira a mano", async () => {
    h.fijarWebhook.mockResolvedValue({ ok: true, valor: true });
    h.leerWebhook.mockResolvedValueOnce({ ok: false, falla: "meta", codigo: null });
    await expect(fijarElWebhook(TENANT, ID, ENTORNO)).resolves.toBe("meta");

    h.leerWebhook.mockResolvedValueOnce({ ok: false, falla: "rechazo", codigo: 100 });
    await expect(fijarElWebhook(TENANT, ID, ENTORNO)).resolves.toBe("revision");
    expect(h.aviso).toHaveBeenCalledWith("rechazo", TENANT);
  });
});
