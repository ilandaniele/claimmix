/**
 * Unit tests for the WhatsApp Cloud API helpers (the ban-safe, official-Meta path).
 *
 * Covers the security-critical pieces: X-Hub-Signature-256 HMAC validation,
 * the GET verification handshake, and inbound payload parsing.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { createHmac } from "crypto";
import {
  downloadWhatsAppMedia,
  estadoDePlantilla,
  olvidarEstadoDePlantilla,
  parseCloudApiMessages,
  resolveWebhookChallenge,
  sendWhatsAppTemplate,
  sendWhatsAppText,
  verifyMetaSignature,
} from "@/server/whatsapp/cloud-api";

const APP_SECRET = "test-app-secret";
const CRED = { accessToken: "test-token", phoneNumberId: "123", wabaId: "waba-1" };
const CRED_PLANTILLA = { ...CRED, tenantId: "tenant-plataforma", enPrueba: false, vencida: false };

function sign(body: string, secret = APP_SECRET): string {
  return "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
}

function metaPayload(messages: unknown[], contacts: unknown[] = []): unknown {
  return {
    object: "whatsapp_business_account",
    entry: [{ id: "WABA", changes: [{ field: "messages", value: { messaging_product: "whatsapp", contacts, messages } }] }],
  };
}

describe("verifyMetaSignature", () => {
  const body = JSON.stringify({ hello: "world" });

  it("accepts a correctly-signed body", () => {
    expect(verifyMetaSignature(body, sign(body), APP_SECRET)).toBe(true);
  });

  it("rejects a tampered body", () => {
    expect(verifyMetaSignature(body + "x", sign(body), APP_SECRET)).toBe(false);
  });

  it("rejects a signature made with the wrong secret", () => {
    expect(verifyMetaSignature(body, sign(body, "wrong"), APP_SECRET)).toBe(false);
  });

  it("fails closed when the app secret is unset", () => {
    expect(verifyMetaSignature(body, sign(body), undefined)).toBe(false);
  });

  it("rejects a missing or malformed signature header", () => {
    expect(verifyMetaSignature(body, null, APP_SECRET)).toBe(false);
    expect(verifyMetaSignature(body, "md5=abc", APP_SECRET)).toBe(false);
    expect(verifyMetaSignature(body, "sha256=notlongenough", APP_SECRET)).toBe(false);
  });
});

describe("resolveWebhookChallenge", () => {
  it("echoes the challenge when mode and token match", () => {
    const p = new URLSearchParams({ "hub.mode": "subscribe", "hub.verify_token": "tok", "hub.challenge": "12345" });
    expect(resolveWebhookChallenge(p, "tok")).toBe("12345");
  });

  it("returns null on token mismatch", () => {
    const p = new URLSearchParams({ "hub.mode": "subscribe", "hub.verify_token": "bad", "hub.challenge": "12345" });
    expect(resolveWebhookChallenge(p, "tok")).toBeNull();
  });

  it("returns null when the verify token is unset", () => {
    const p = new URLSearchParams({ "hub.mode": "subscribe", "hub.verify_token": "tok", "hub.challenge": "x" });
    expect(resolveWebhookChallenge(p, undefined)).toBeNull();
  });
});

describe("parseCloudApiMessages", () => {
  it("parses a text message and attaches the sender name", () => {
    const payload = metaPayload(
      [{ from: "5492916426930", id: "wamid.1", type: "text", text: { body: "Tuve un choque en Bahía Blanca" } }],
      [{ wa_id: "5492916426930", profile: { name: "Ilan" } }]
    );
    const out = parseCloudApiMessages(payload);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      from: "5492916426930",
      providerMessageId: "wamid.1",
      name: "Ilan",
    });
    expect(out[0].body).toContain("choque");
  });

  it("uses the caption for image messages and a placeholder when absent", () => {
    const withCaption = parseCloudApiMessages(
      metaPayload([{ from: "549111", id: "m1", type: "image", image: { caption: "Foto del auto" } }])
    );
    expect(withCaption[0].body).toBe("Foto del auto");

    const noCaption = parseCloudApiMessages(
      metaPayload([{ from: "549111", id: "m2", type: "image", image: {} }])
    );
    expect(noCaption[0].body).toContain("Imagen adjunta");
  });

  it("ignores delivery/read status events (no messages array)", () => {
    const statusPayload = {
      object: "whatsapp_business_account",
      entry: [{ changes: [{ value: { statuses: [{ id: "wamid.x", status: "delivered" }] } }] }],
    };
    expect(parseCloudApiMessages(statusPayload)).toEqual([]);
  });

  it("skips messages with no extractable body", () => {
    const out = parseCloudApiMessages(
      metaPayload([{ from: "549111", id: "m3", type: "text", text: { body: "   " } }])
    );
    expect(out).toEqual([]);
  });

  it("ignores non-WhatsApp payloads", () => {
    expect(parseCloudApiMessages({ object: "page", entry: [] })).toEqual([]);
    expect(parseCloudApiMessages(null)).toEqual([]);
    expect(parseCloudApiMessages({})).toEqual([]);
  });
});

/*
 * Sin plazo, un Meta colgado deja la función esperando hasta el `maxDuration`
 * de la ruta en vez de fallar rápido y dejar que el que llama siga.
 */
describe("sendWhatsAppText — plazo del envío", () => {
  const realFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("un fetch que rechaza con TimeoutError da ok:false y no tira", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    }) as unknown as typeof fetch;

    await expect(sendWhatsAppText("5491100000000", "hola", CRED)).resolves.toMatchObject({ ok: false });
  });

  it("manda con el número y el token de la credencial, no con el entorno", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ messages: [{ id: "wamid.out" }] }), { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await sendWhatsAppText("5491100000000", "hola", { accessToken: "fake-otro-token", phoneNumberId: "999111" });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/999111/messages");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer fake-otro-token");
  });

  it("el fetch del envío recibe un signal", async () => {
    let signalRecibido: unknown;
    globalThis.fetch = vi.fn(async (_url, init) => {
      signalRecibido = (init as RequestInit | undefined)?.signal;
      return new Response(JSON.stringify({ messages: [{ id: "wamid.out" }] }), { status: 200 });
    }) as unknown as typeof fetch;

    await sendWhatsAppText("5491100000000", "hola", CRED);

    expect(signalRecibido).toBeInstanceOf(AbortSignal);
  });
});

describe("sendWhatsAppText — el JSON no cambió", () => {
  const realFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("manda exactamente el mismo cuerpo de siempre", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ messages: [{ id: "wamid.out" }] }), { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await sendWhatsAppText("5491100000000", "hola", CRED);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: "5491100000000",
      type: "text",
      text: { preview_url: false, body: "hola" },
    });
  });
});

describe("sendWhatsAppTemplate", () => {
  const realFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("manda la plantilla con el payload exacto", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ messages: [{ id: "wamid.tpl" }] }), { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const r = await sendWhatsAppTemplate("5491100000000", "reabrir_denuncia", "es_AR", ["abc-123", "la foto"], CRED_PLANTILLA);

    expect(r).toEqual({ ok: true, messageId: "wamid.tpl" });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: "5491100000000",
      type: "template",
      template: {
        name: "reabrir_denuncia",
        language: { code: "es_AR" },
        components: [
          {
            type: "body",
            parameters: [
              { type: "text", text: "abc-123" },
              { type: "text", text: "la foto" },
            ],
          },
        ],
      },
    });
  });

  it("colapsa saltos de línea, tabs y espacios repetidos en cada parámetro", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ messages: [{ id: "wamid.tpl" }] }), { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await sendWhatsAppTemplate("5491100000000", "reabrir_denuncia", "es_AR", ["a\nb", "c\td", "e    f"], CRED_PLANTILLA);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.template.components[0].parameters).toEqual([
      { type: "text", text: "a b" },
      { type: "text", text: "c d" },
      { type: "text", text: "e f" },
    ]);
  });
});

describe("estadoDePlantilla", () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    olvidarEstadoDePlantilla();
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    olvidarEstadoDePlantilla();
  });

  it("sin WABA en la credencial: no_disponible, y no llama a fetch", async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(estadoDePlantilla("reabrir_denuncia", "es_AR", { ...CRED, wabaId: null })).resolves.toBe(
      "no_disponible"
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("APPROVED da aprobada", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ data: [{ name: "reabrir_denuncia", status: "APPROVED", language: "es_AR" }] }), { status: 200 })
    ) as unknown as typeof fetch;

    await expect(estadoDePlantilla("reabrir_denuncia", "es_AR", CRED)).resolves.toBe("aprobada");
  });

  it("PENDING da pendiente", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ data: [{ name: "reabrir_denuncia", status: "PENDING", language: "es_AR" }] }), { status: 200 })
    ) as unknown as typeof fetch;

    await expect(estadoDePlantilla("reabrir_denuncia", "es_AR", CRED)).resolves.toBe("pendiente");
  });

  it("otro idioma solamente: pendiente", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ data: [{ name: "reabrir_denuncia", status: "APPROVED", language: "en_US" }] }), { status: 200 })
    ) as unknown as typeof fetch;

    await expect(estadoDePlantilla("reabrir_denuncia", "es_AR", CRED)).resolves.toBe("pendiente");
  });

  // Un error de Graph es pasajero: no se confunde con «no hay plantilla».
  it("HTTP 500 da sin_respuesta", async () => {
    globalThis.fetch = vi.fn(async () => new Response("error", { status: 500 })) as unknown as typeof fetch;

    await expect(estadoDePlantilla("reabrir_denuncia", "es_AR", CRED)).resolves.toBe("sin_respuesta");
  });

  it("HTTP 429 da sin_respuesta", async () => {
    globalThis.fetch = vi.fn(async () => new Response("", { status: 429 })) as unknown as typeof fetch;

    await expect(estadoDePlantilla("reabrir_denuncia", "es_AR", CRED)).resolves.toBe("sin_respuesta");
  });

  // Un token vencido no se arregla reintentando: el recordatorio gasta la etapa
  // en vez de volver cada noche.
  it("HTTP 401 da no_disponible", async () => {
    globalThis.fetch = vi.fn(async () => new Response("", { status: 401 })) as unknown as typeof fetch;

    await expect(estadoDePlantilla("reabrir_denuncia", "es_AR", CRED)).resolves.toBe("no_disponible");
  });

  it("un fetch que tira da sin_respuesta", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;

    await expect(estadoDePlantilla("reabrir_denuncia", "es_AR", CRED)).resolves.toBe("sin_respuesta");
  });

  it("una segunda llamada dentro del TTL no vuelve a pedir", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ data: [{ name: "reabrir_denuncia", status: "APPROVED", language: "es_AR" }] }), { status: 200 })
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await estadoDePlantilla("reabrir_denuncia", "es_AR", CRED);
    await estadoDePlantilla("reabrir_denuncia", "es_AR", CRED);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("la caché es por WABA: otra cuenta vuelve a preguntar", async () => {
    const fetchMock = vi.fn(async (_url: string) =>
      new Response(JSON.stringify({ data: [{ name: "reabrir_denuncia", status: "APPROVED", language: "es_AR" }] }), { status: 200 })
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await estadoDePlantilla("reabrir_denuncia", "es_AR", CRED);
    await estadoDePlantilla("reabrir_denuncia", "es_AR", { ...CRED, wabaId: "waba-2" });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("/waba-2/message_templates");
  });

  it("después de olvidarEstadoDePlantilla() vuelve a pedir", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ data: [{ name: "reabrir_denuncia", status: "APPROVED", language: "es_AR" }] }), { status: 200 })
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await estadoDePlantilla("reabrir_denuncia", "es_AR", CRED);
    olvidarEstadoDePlantilla();
    await estadoDePlantilla("reabrir_denuncia", "es_AR", CRED);

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("downloadWhatsAppMedia — plazo de la descarga", () => {
  const realFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("un fetch que rechaza con TimeoutError da null", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    }) as unknown as typeof fetch;

    await expect(downloadWhatsAppMedia("media-1", CRED)).resolves.toBeNull();
  });

  it("la metadata y la descarga de bytes reciben cada una un signal", async () => {
    const signals: unknown[] = [];
    globalThis.fetch = vi.fn(async (url, init) => {
      signals.push((init as RequestInit | undefined)?.signal);
      const u = String(url);
      if (u.includes("/media-1")) {
        return new Response(
          JSON.stringify({ url: "https://cdn.example/file", mime_type: "image/jpeg" }),
          { status: 200 }
        );
      }
      return new Response(Buffer.from("bytes"), { status: 200 });
    }) as unknown as typeof fetch;

    await downloadWhatsAppMedia("media-1", CRED);

    expect(signals).toHaveLength(2);
    expect(signals[0]).toBeInstanceOf(AbortSignal);
    expect(signals[1]).toBeInstanceOf(AbortSignal);
  });
});
