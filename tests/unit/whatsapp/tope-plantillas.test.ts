/**
 * El tope de plantillas de WhatsApp de una prueba (P10).
 *
 * Una plantilla fuera de la ventana de 24 h es lo único que Meta cobra por
 * envío. `sendWhatsAppTemplate` toma el cupo ANTES de llamar a Meta, y el
 * limitador corre de verdad (en memoria, o contra una base que se cae): lo que
 * se mockea es Meta, para contar cuántas veces se la llamó.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { execute } = vi.hoisted(() => ({ execute: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ db: { execute: (...a: unknown[]) => execute(...a) } }));
vi.mock("@/lib/observability/logger", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));
vi.mock("@/lib/rate-limit", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/rate-limit")>();
  return { ...real, rateLimit: vi.fn(real.rateLimit) };
});

import { rateLimit } from "@/lib/rate-limit";
import { clearAllRateLimits } from "@/lib/rate-limit/memory";
import {
  quedaCupoDePlantilla,
  sendWhatsAppTemplate,
  TOPE_DE_PLANTILLAS,
  topeDePlantillasDePrueba,
  type CredencialesDePlantilla,
} from "@/server/whatsapp/cloud-api";

const DIA = 24 * 60 * 60_000;
const PRUEBA_A = "10000000-0000-0000-0000-0000000000a1";
const PRUEBA_B = "10000000-0000-0000-0000-0000000000b2";
const PLATAFORMA = "10000000-0000-0000-0000-0000000000c3";

function cred(o: Partial<CredencialesDePlantilla> = {}): CredencialesDePlantilla {
  return { accessToken: "test-token", phoneNumberId: "123456", tenantId: PRUEBA_A, enPrueba: true, vencida: false, ...o };
}

function mandar(c: CredencialesDePlantilla) {
  return sendWhatsAppTemplate("5491100000000", "reabrir_denuncia", "es_AR", ["abc-123", "la foto"], c);
}

describe("sendWhatsAppTemplate — tope de la prueba", () => {
  const realFetch = globalThis.fetch;
  let aMeta: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    clearAllRateLimits();
    aMeta = vi.fn(async () => new Response(JSON.stringify({ messages: [{ id: "wamid.tpl" }] }), { status: 200 }));
    globalThis.fetch = aMeta as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.unstubAllEnvs();
  });

  it("la cuarta plantilla del día de una prueba no llega a Meta", async () => {
    for (let i = 0; i < 3; i++) expect(await mandar(cred())).toEqual({ ok: true, messageId: "wamid.tpl" });
    expect(aMeta).toHaveBeenCalledTimes(3);

    expect(await mandar(cred())).toEqual({ ok: false, error: TOPE_DE_PLANTILLAS });
    expect(aMeta).toHaveBeenCalledTimes(3);
  });

  it("cuenta por inquilino, con la clave wa:plantilla:<tenant> y falla cerrada", async () => {
    for (let i = 0; i < 4; i++) await mandar(cred());

    expect(rateLimit).toHaveBeenCalledWith(`wa:plantilla:${PRUEBA_A}`, { limit: 3, windowMs: DIA, fallaCerrada: true });

    // Otra prueba tiene su propio cupo entero.
    expect((await mandar(cred({ tenantId: PRUEBA_B }))).ok).toBe(true);
    expect(rateLimit).toHaveBeenLastCalledWith(`wa:plantilla:${PRUEBA_B}`, expect.anything());
  });

  it("con la prueba vencida el tope es 0: ni la primera sale", async () => {
    vi.stubEnv("ALTA_TOPE_PLANTILLAS_PRUEBA_DIA", "50");

    const r = await mandar(cred({ vencida: true }));

    expect(r).toEqual({ ok: false, error: TOPE_DE_PLANTILLAS });
    expect(rateLimit).toHaveBeenCalledWith(`wa:plantilla:${PRUEBA_A}`, { limit: 0, windowMs: DIA, fallaCerrada: true });
    expect(aMeta).not.toHaveBeenCalled();
  });

  it("la plataforma no tiene tope, y no cuenta nada", async () => {
    for (let i = 0; i < 10; i++) {
      expect((await mandar(cred({ tenantId: PLATAFORMA, enPrueba: false }))).ok).toBe(true);
    }

    expect(aMeta).toHaveBeenCalledTimes(10);
    expect(rateLimit).not.toHaveBeenCalled();
  });

  it("un alta automática que ya paga deja de estar topeada, aunque la prueba haya vencido", async () => {
    for (let i = 0; i < 5; i++) {
      expect((await mandar(cred({ enPrueba: false, vencida: false }))).ok).toBe(true);
    }

    expect(aMeta).toHaveBeenCalledTimes(5);
    expect(rateLimit).not.toHaveBeenCalled();
  });

  describe("si el contador no contesta", () => {
    beforeEach(() => {
      vi.stubEnv("RATE_LIMIT_PROVIDER", "postgres");
      execute.mockRejectedValue(new Error("connection reset"));
    });

    it("la plantilla de una prueba no sale", async () => {
      const r = await mandar(cred());

      expect(r).toEqual({ ok: false, error: TOPE_DE_PLANTILLAS });
      expect(aMeta).not.toHaveBeenCalled();
    });

    it("quien no está en prueba no depende del contador: sale igual", async () => {
      expect((await mandar(cred({ enPrueba: false }))).ok).toBe(true);
      expect(execute).not.toHaveBeenCalled();
    });
  });

  describe("quedaCupoDePlantilla — mirar sin gastar", () => {
    it("con lugar dice que sí, y lo devuelve: las tres plantillas siguen saliendo", async () => {
      for (let i = 0; i < 10; i++) expect(await quedaCupoDePlantilla(PRUEBA_A)).toBe(true);

      for (let i = 0; i < 3; i++) expect((await mandar(cred())).ok).toBe(true);
      expect((await mandar(cred())).ok).toBe(false);
    });

    it("con el tope del día gastado dice que no, y mirar no lo agranda", async () => {
      for (let i = 0; i < 3; i++) await mandar(cred());

      for (let i = 0; i < 10; i++) expect(await quedaCupoDePlantilla(PRUEBA_A)).toBe(false);
      expect(aMeta).toHaveBeenCalledTimes(3);
    });

    it("mira el cupo de esa prueba, con la misma clave y falla cerrada", async () => {
      await quedaCupoDePlantilla(PRUEBA_A);

      expect(rateLimit).toHaveBeenCalledWith(`wa:plantilla:${PRUEBA_A}`, { limit: 3, windowMs: DIA, fallaCerrada: true });
    });

    it("si el contador no contesta, no hay lugar y no tira", async () => {
      vi.stubEnv("RATE_LIMIT_PROVIDER", "postgres");
      execute.mockRejectedValue(new Error("connection reset"));

      await expect(quedaCupoDePlantilla(PRUEBA_A)).resolves.toBe(false);
    });
  });

  describe("ALTA_TOPE_PLANTILLAS_PRUEBA_DIA", () => {
    it("vale 3 si falta", () => {
      expect(topeDePlantillasDePrueba()).toBe(3);
    });

    it("cambia el tope", async () => {
      vi.stubEnv("ALTA_TOPE_PLANTILLAS_PRUEBA_DIA", "1");

      expect((await mandar(cred())).ok).toBe(true);
      expect((await mandar(cred())).ok).toBe(false);
      expect(aMeta).toHaveBeenCalledTimes(1);
    });

    it("0 corta las plantillas de toda prueba", async () => {
      vi.stubEnv("ALTA_TOPE_PLANTILLAS_PRUEBA_DIA", "0");

      expect((await mandar(cred())).ok).toBe(false);
      expect(aMeta).not.toHaveBeenCalled();
    });

    it.each(["", "abc", "3.5", "-2", "99999"])("un valor inválido (%j) vuelve a 3, nunca a «sin tope»", (valor) => {
      vi.stubEnv("ALTA_TOPE_PLANTILLAS_PRUEBA_DIA", valor);

      expect(topeDePlantillasDePrueba()).toBe(3);
    });
  });
});
