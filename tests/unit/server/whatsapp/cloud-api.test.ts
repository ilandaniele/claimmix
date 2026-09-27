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
  parseCloudApiMessages,
  resolveWebhookChallenge,
  sendWhatsAppText,
  verifyMetaSignature,
} from "@/server/whatsapp/cloud-api";

const APP_SECRET = "test-app-secret";

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

  beforeEach(() => {
    process.env.WHATSAPP_ACCESS_TOKEN = "test-token";
    process.env.WHATSAPP_PHONE_NUMBER_ID = "123";
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    delete process.env.WHATSAPP_ACCESS_TOKEN;
    delete process.env.WHATSAPP_PHONE_NUMBER_ID;
  });

  it("un fetch que rechaza con TimeoutError da ok:false y no tira", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    }) as unknown as typeof fetch;

    await expect(sendWhatsAppText("5491100000000", "hola")).resolves.toMatchObject({ ok: false });
  });

  it("el fetch del envío recibe un signal", async () => {
    let signalRecibido: unknown;
    globalThis.fetch = vi.fn(async (_url, init) => {
      signalRecibido = (init as RequestInit | undefined)?.signal;
      return new Response(JSON.stringify({ messages: [{ id: "wamid.out" }] }), { status: 200 });
    }) as unknown as typeof fetch;

    await sendWhatsAppText("5491100000000", "hola");

    expect(signalRecibido).toBeInstanceOf(AbortSignal);
  });
});

describe("downloadWhatsAppMedia — plazo de la descarga", () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    process.env.WHATSAPP_ACCESS_TOKEN = "test-token";
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    delete process.env.WHATSAPP_ACCESS_TOKEN;
  });

  it("un fetch que rechaza con TimeoutError da null", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    }) as unknown as typeof fetch;

    await expect(downloadWhatsAppMedia("media-1")).resolves.toBeNull();
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

    await downloadWhatsAppMedia("media-1");

    expect(signals).toHaveLength(2);
    expect(signals[0]).toBeInstanceOf(AbortSignal);
    expect(signals[1]).toBeInstanceOf(AbortSignal);
  });
});
