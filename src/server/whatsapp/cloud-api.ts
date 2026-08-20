/**
 * WhatsApp Business **Cloud API** (official Meta Graph API) helpers.
 *
 * This is the ban-safe integration path: it uses Meta's sanctioned Business
 * Platform (graph.facebook.com), NOT the unofficial WhatsApp-Web / whatsmeow
 * protocol that risks account bans when automated.
 *
 * Responsibilities:
 *  - verifyMetaSignature(): validate the X-Hub-Signature-256 HMAC Meta sends
 *    with every webhook POST, using the App Secret.
 *  - parseCloudApiMessages(): turn a Cloud API webhook payload into the
 *    normalized shape ClaimMix's intake pipeline already understands.
 *  - sendWhatsAppText(): send an outbound text via the Cloud API (e.g. an
 *    acknowledgement that the claim was received).
 *
 * Inbound docs:  https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks/payload-examples
 * Outbound docs: https://developers.facebook.com/docs/whatsapp/cloud-api/reference/messages
 */

import "server-only";
import { createHmac, timingSafeEqual } from "crypto";
import { timingSafeStringEqual } from "@/lib/security/compare";

const GRAPH_API_BASE = "https://graph.facebook.com";

/** Default Graph API version; override with WHATSAPP_API_VERSION. */
function apiVersion(): string {
  return process.env.WHATSAPP_API_VERSION?.trim() || "v22.0";
}

// ── Webhook signature validation ─────────────────────────────────────────────

/**
 * Validates Meta's `X-Hub-Signature-256` header against the raw request body.
 *
 * Meta signs every webhook POST with HMAC-SHA256 keyed by the App Secret:
 *   header value = "sha256=" + hex(hmac_sha256(appSecret, rawBody))
 *
 * MUST be computed over the EXACT raw bytes Meta sent — re-serializing parsed
 * JSON would change whitespace and break the comparison. Pass `request.text()`.
 *
 * Returns false (fail-closed) when the secret is unset or the header is malformed.
 */
export function verifyMetaSignature(
  rawBody: string,
  signatureHeader: string | null,
  appSecret: string | undefined = process.env.WHATSAPP_APP_SECRET
): boolean {
  if (!appSecret) return false;
  if (!signatureHeader || !signatureHeader.startsWith("sha256=")) return false;

  const expected = createHmac("sha256", appSecret).update(rawBody).digest("hex");
  const received = signatureHeader.slice("sha256=".length);

  // Length guard before timingSafeEqual (it throws on length mismatch).
  if (expected.length !== received.length) return false;
  try {
    return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(received, "hex"));
  } catch {
    return false;
  }
}

// ── Webhook verification (GET handshake) ─────────────────────────────────────

/**
 * Handles Meta's webhook verification GET handshake. When you register the
 * callback URL, Meta calls it with hub.mode=subscribe, hub.verify_token, and
 * hub.challenge. Echo the challenge back iff the token matches.
 *
 * Returns the challenge string to echo (200) or null (respond 403).
 */
export function resolveWebhookChallenge(
  params: URLSearchParams,
  verifyToken: string | undefined = process.env.WHATSAPP_VERIFY_TOKEN
): string | null {
  const mode = params.get("hub.mode");
  const token = params.get("hub.verify_token");
  const challenge = params.get("hub.challenge");
  if (mode === "subscribe" && token && verifyToken && timingSafeStringEqual(token, verifyToken)) {
    return challenge ?? "";
  }
  return null;
}

// ── Inbound payload parsing ──────────────────────────────────────────────────

export interface NormalizedWhatsAppMessage {
  /** Sender wa_id (phone number, digits only, no '+'). */
  from: string;
  /** Message text (caption for media; a placeholder note for unsupported types). */
  body: string;
  /** Meta message id (wamid...) — used for idempotency. */
  providerMessageId: string;
  /** Sender display name from the contacts block, if present. */
  name?: string;
  /**
   * Media the message carried, if any.
   *
   * The payload only names the file; the bytes live behind a second Graph call.
   * Until this existed a photo of a crumpled bumper arrived as the string
   * "[Imagen adjunta sin texto]" and the file was gone — while the agent's own
   * reply was telling people to send exactly that.
   */
  media?: WhatsAppMediaRef[];
}

export interface WhatsAppMediaRef {
  /** Graph media id — resolves to a short-lived download URL. */
  id: string;
  mimeType: string;
  /** Best available name; media other than documents does not carry one. */
  filename: string;
  /**
   * The bytes, when the caller already has them.
   *
   * The Cloud API never fills this — a real message names the media and the
   * file lives behind a second Graph call. The rehearsal and the BSP adapter
   * do: they have a file and no Graph id to fetch it by, and inventing one
   * only earns a 400. When it is set, the download is skipped.
   */
  data?: Buffer;
}

interface CloudApiTextMessage {
  from: string;
  id: string;
  type: string;
  text?: { body?: string };
  image?: { caption?: string; id?: string; mime_type?: string };
  video?: { caption?: string; id?: string; mime_type?: string };
  document?: { caption?: string; filename?: string; id?: string; mime_type?: string };
  audio?: { id?: string; mime_type?: string };
  button?: { text?: string };
  interactive?: {
    button_reply?: { title?: string };
    list_reply?: { title?: string };
  };
}

/** Extract a usable text body from a Cloud API message of any supported type. */
function messageBody(msg: CloudApiTextMessage): string {
  switch (msg.type) {
    case "text":
      return msg.text?.body?.trim() || "";
    case "image":
      return msg.image?.caption?.trim() || "[Imagen adjunta sin texto]";
    case "video":
      return msg.video?.caption?.trim() || "[Video adjunto sin texto]";
    case "document":
      return (
        msg.document?.caption?.trim() ||
        (msg.document?.filename ? `[Documento adjunto: ${msg.document.filename}]` : "[Documento adjunto]")
      );
    case "audio":
      return "[Mensaje de audio adjunto]";
    case "button":
      return msg.button?.text?.trim() || "";
    case "interactive":
      return (
        msg.interactive?.button_reply?.title?.trim() ||
        msg.interactive?.list_reply?.title?.trim() ||
        ""
      );
    default:
      return "";
  }
}

/** The media a message carries, named but not yet downloaded. */
function messageMedia(msg: CloudApiTextMessage): WhatsAppMediaRef[] {
  const part =
    msg.type === "image"
      ? msg.image
      : msg.type === "video"
        ? msg.video
        : msg.type === "document"
          ? msg.document
          : msg.type === "audio"
            ? msg.audio
            : undefined;

  if (!part?.id) return [];

  const mimeType = part.mime_type || "application/octet-stream";
  const named = msg.type === "document" ? msg.document?.filename?.trim() : undefined;

  return [
    {
      id: part.id,
      mimeType,
      // Meta names only documents. Everything else gets the media id plus an
      // extension guessed from the type, so two photos in one claim do not
      // collide in storage and an analyst sees something openable.
      filename: named || `${msg.type}-${part.id}${extensionFor(mimeType)}`,
    },
  ];
}

function extensionFor(mimeType: string): string {
  const known: Record<string, string> = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "video/mp4": ".mp4",
    "audio/ogg": ".ogg",
    "audio/mpeg": ".mp3",
    "application/pdf": ".pdf",
  };
  return known[mimeType.split(";")[0].trim()] ?? "";
}

/**
 * Download one media file from the Graph API.
 *
 * Two calls: the id resolves to a short-lived URL on a Meta CDN, and that URL
 * needs the same bearer token — fetching it unauthenticated returns HTML, not
 * the file.
 *
 * Returns null rather than throwing. A photo that fails to download is a gap
 * in the claim, not a reason to lose the message that carried it.
 */
export async function downloadWhatsAppMedia(
  mediaId: string,
  opts?: { accessToken?: string }
): Promise<{ data: Buffer; mimeType: string } | null> {
  const accessToken = opts?.accessToken ?? process.env.WHATSAPP_ACCESS_TOKEN;
  if (!accessToken) {
    console.error("[whatsapp] media download skipped: no access token"); // crew-debug-ok
    return null;
  }

  try {
    const metaRes = await fetch(`${GRAPH_API_BASE}/${apiVersion()}/${mediaId}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!metaRes.ok) {
      console.error("[whatsapp] media metadata failed:", metaRes.status); // crew-debug-ok
      return null;
    }

    const meta = (await metaRes.json()) as { url?: string; mime_type?: string };
    if (!meta.url) return null;

    const fileRes = await fetch(meta.url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!fileRes.ok) {
      console.error("[whatsapp] media fetch failed:", fileRes.status); // crew-debug-ok
      return null;
    }

    return {
      data: Buffer.from(await fileRes.arrayBuffer()),
      mimeType: meta.mime_type || "application/octet-stream",
    };
  } catch (err) {
    const name = err instanceof Error ? err.name : "UnknownError";
    console.error("[whatsapp] media download error:", name); // crew-debug-ok
    return null;
  }
}

/**
 * Parses a WhatsApp Cloud API webhook payload into normalized messages.
 *
 * Ignores non-message events (delivery/read `statuses`, account updates) by
 * returning them as an empty list. Skips messages with no extractable body.
 */
export function parseCloudApiMessages(payload: unknown): NormalizedWhatsAppMessage[] {
  const out: NormalizedWhatsAppMessage[] = [];
  const root = payload as {
    object?: string;
    entry?: Array<{
      changes?: Array<{
        value?: {
          messages?: CloudApiTextMessage[];
          contacts?: Array<{ profile?: { name?: string }; wa_id?: string }>;
        };
      }>;
    }>;
  };

  if (root?.object !== "whatsapp_business_account" || !Array.isArray(root.entry)) {
    return out;
  }

  for (const entry of root.entry) {
    for (const change of entry.changes ?? []) {
      const value = change.value;
      const messages = value?.messages;
      if (!Array.isArray(messages)) continue; // status/other events → skip

      const nameByWaId = new Map<string, string>();
      for (const c of value?.contacts ?? []) {
        if (c.wa_id && c.profile?.name) nameByWaId.set(c.wa_id, c.profile.name);
      }

      for (const msg of messages) {
        if (!msg?.from || !msg?.id) continue;
        const body = messageBody(msg);
        const media = messageMedia(msg);
        // A photo with no caption still carries the claim's most important
        // evidence, so a message is only worthless when it has neither.
        if (!body && media.length === 0) continue;
        out.push({
          from: msg.from,
          body,
          providerMessageId: msg.id,
          name: nameByWaId.get(msg.from),
          ...(media.length > 0 ? { media } : {}),
        });
      }
    }
  }

  return out;
}

// ── Outbound (send a reply / acknowledgement) ────────────────────────────────

export interface SendResult {
  ok: boolean;
  messageId?: string;
  error?: string;
}

/**
 * Sends an outbound WhatsApp text via the Cloud API.
 *
 * Note: outside the 24-hour customer-service window, free-form text is rejected
 * by Meta — only pre-approved message templates may be sent. Acknowledging a
 * claim the customer JUST sent is always inside the window, so this is safe for
 * "we received your claim" replies.
 *
 * Never throws — returns { ok:false, error } so callers can log and continue.
 */
export async function sendWhatsAppText(
  to: string,
  body: string,
  opts?: { accessToken?: string; phoneNumberId?: string }
): Promise<SendResult> {
  const accessToken = opts?.accessToken ?? process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = opts?.phoneNumberId ?? process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!accessToken || !phoneNumberId) {
    return { ok: false, error: "WHATSAPP_ACCESS_TOKEN / WHATSAPP_PHONE_NUMBER_ID not configured" };
  }

  try {
    const res = await fetch(`${GRAPH_API_BASE}/${apiVersion()}/${phoneNumberId}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to,
        type: "text",
        text: { preview_url: false, body: body.slice(0, 4096) },
      }),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      return { ok: false, error: `Cloud API ${res.status}: ${errText.slice(0, 300)}` };
    }
    const data = (await res.json()) as { messages?: Array<{ id?: string }> };
    return { ok: true, messageId: data.messages?.[0]?.id };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "network error" };
  }
}
