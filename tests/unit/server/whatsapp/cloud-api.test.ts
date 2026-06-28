/**
 * Unit tests for the WhatsApp Cloud API helpers (the ban-safe, official-Meta path).
 *
 * Covers the security-critical pieces: X-Hub-Signature-256 HMAC validation,
 * the GET verification handshake, and inbound payload parsing.
 */

import { describe, expect, it } from "vitest";
import { createHmac } from "crypto";
import {
  parseCloudApiMessages,
  resolveWebhookChallenge,
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
