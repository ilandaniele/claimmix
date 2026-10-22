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
  leerHastaElTope,
  parseEventosDeCuenta,
  resolveWebhookChallenge,
  sendWhatsAppTemplate,
  sendWhatsAppText,
  urlDeGraph,
  verificarFirmaDeApp,
  verifyMetaSignature,
} from "@/server/whatsapp/cloud-api";
import { logger } from "@/lib/observability/logger";

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

  it("una ubicación compartida llega al agente como texto", () => {
    const [msg] = parseCloudApiMessages(
      metaPayload([
        {
          from: "549111",
          id: "m4",
          type: "location",
          location: { latitude: -38.7183, longitude: -62.2663, name: "YPF Alem", address: "Av. Alem 1200, Bahía Blanca" },
        },
      ])
    );
    expect(msg.body).toBe("[Ubicación compartida: YPF Alem, Av. Alem 1200, Bahía Blanca, -38.7183, -62.2663]");

    const [soloCoordenadas] = parseCloudApiMessages(
      metaPayload([{ from: "549111", id: "m5", type: "location", location: { latitude: -38.7, longitude: -62.2 } }])
    );
    expect(soloCoordenadas.body).toBe("[Ubicación compartida: -38.7, -62.2]");
  });

  it("un contacto compartido llega con el nombre y los teléfonos", () => {
    const [msg] = parseCloudApiMessages(
      metaPayload([
        {
          from: "549111",
          id: "m6",
          type: "contacts",
          contacts: [
            { name: { formatted_name: "Juan Pérez" }, phones: [{ phone: "+54 9 291 555-0000" }] },
            { name: { formatted_name: "Taller Sur" }, phones: [] },
          ],
        },
      ])
    );
    expect(msg.body).toBe("[Contacto compartido: Juan Pérez, +54 9 291 555-0000; Taller Sur]");
  });

  it("stickers y reacciones se anotan con el tipo y no se contestan", () => {
    const info = vi.spyOn(logger, "info").mockImplementation(() => {});
    try {
      const out = parseCloudApiMessages(
        metaPayload([
          { from: "549111", id: "m7", type: "sticker", sticker: { id: "123", mime_type: "image/webp" } },
          { from: "549111", id: "m8", type: "reaction", reaction: { message_id: "wamid.1", emoji: "\u{1F44D}" } },
        ])
      );
      expect(out).toEqual([]);
      expect(info).toHaveBeenCalledWith({ tipo: "sticker" }, "whatsapp.mensaje_ignorado");
      expect(info).toHaveBeenCalledWith({ tipo: "reaction" }, "whatsapp.mensaje_ignorado");
    } finally {
      info.mockRestore();
    }
  });
});

function cambioDeCuenta(entry: Record<string, unknown>, field: string, value: unknown): unknown {
  return { object: "whatsapp_business_account", entry: [{ ...entry, changes: [{ field, value }] }] };
}

describe("parseEventosDeCuenta", () => {
  it("lee un account_update: la WABA de waba_info, el evento y la hora de Meta", () => {
    const payload = cambioDeCuenta({ id: "200000000000001", time: 1_760_000_000 }, "account_update", {
      event: "PARTNER_APP_UNINSTALLED",
      waba_info: { waba_id: "200000000000002", owner_business_id: "300000000000001" },
    });

    expect(parseEventosDeCuenta(payload)).toEqual([
      {
        campo: "account_update",
        wabaId: "200000000000002",
        evento: "PARTNER_APP_UNINSTALLED",
        phoneNumberId: null,
        nombreEstado: null,
        hora: 1_760_000_000,
      },
    ]);
  });

  it("sin waba_info la WABA es el entry.id", () => {
    const payload = cambioDeCuenta({ id: "200000000000001", time: 1 }, "account_update", { event: "ACCOUNT_DELETED" });

    expect(parseEventosDeCuenta(payload)[0]).toMatchObject({ wabaId: "200000000000001", evento: "ACCOUNT_DELETED" });
  });

  it("lee el veredicto del nombre del número", () => {
    const payload = cambioDeCuenta({ id: "200000000000001", time: 5 }, "phone_number_name_update", {
      display_phone_number: "5491100000000",
      decision: "REJECTED",
      phone_number_id: "100000000000777",
      requested_verified_name: "Seguros Fake",
    });

    expect(parseEventosDeCuenta(payload)).toEqual([
      {
        campo: "phone_number_name_update",
        wabaId: "200000000000001",
        evento: null,
        phoneNumberId: "100000000000777",
        nombreEstado: "DECLINED",
        hora: 5,
      },
    ]);
  });

  it("el veredicto del webhook (`decision`) se guarda en la escala de `name_status`, que es la que lee la pantalla", () => {
    const de = (decision: unknown) =>
      parseEventosDeCuenta(cambioDeCuenta({ id: "200000000000001", time: 1 }, "phone_number_name_update", { decision }))[0]?.nombreEstado;

    expect(de("APPROVED")).toBe("APPROVED");
    expect(de("REJECTED")).toBe("DECLINED");
    expect(de("DEFERRED")).toBe("PENDING_REVIEW");
    expect(de("PENDING")).toBe("PENDING_REVIEW");
  });

  it("un veredicto que no se conoce no se guarda (tampoco las claves del prototipo)", () => {
    const de = (decision: unknown) =>
      parseEventosDeCuenta(cambioDeCuenta({ id: "200000000000001", time: 1 }, "phone_number_name_update", { decision }))[0]?.nombreEstado;

    for (const raro of ["DECLINED", "ALGO_NUEVO", "constructor", "__proto__", "", 7, null]) expect(de(raro)).toBeNull();
  });

  it("junta los eventos de varias entradas y cambios, en orden, y deja pasar los mensajes", () => {
    const payload = {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "200000000000001",
          time: 10,
          changes: [
            { field: "messages", value: { messages: [] } },
            { field: "account_update", value: { event: "DISABLED_UPDATE" } },
            { field: "account_update", value: { event: "ACCOUNT_RESTRICTION" } },
          ],
        },
        { id: "200000000000003", time: 20, changes: [{ field: "phone_number_name_update", value: { decision: "APPROVED" } }] },
      ],
    };

    expect(parseEventosDeCuenta(payload).map((e) => [e.wabaId, e.campo, e.evento ?? e.nombreEstado])).toEqual([
      ["200000000000001", "account_update", "DISABLED_UPDATE"],
      ["200000000000001", "account_update", "ACCOUNT_RESTRICTION"],
      ["200000000000003", "phone_number_name_update", "APPROVED"],
    ]);
  });

  it("los demás campos (calidad, tope, estado de plantillas) no son eventos de cuenta", () => {
    for (const field of ["messages", "phone_number_quality_update", "message_template_status_update"]) {
      expect(parseEventosDeCuenta(cambioDeCuenta({ id: "200000000000001", time: 1 }, field, { event: "X" }))).toEqual([]);
    }
  });

  it("account_review_update: la decisión va en `evento` y no se traduce a la escala del nombre", () => {
    const payload = cambioDeCuenta({ id: "200000000000001", time: 9 }, "account_review_update", { decision: "REJECTED" });

    expect(parseEventosDeCuenta(payload)).toEqual([
      { campo: "account_review_update", wabaId: "200000000000001", evento: "REJECTED", phoneNumberId: null, nombreEstado: null, hora: 9 },
    ]);
  });

  it("account_review_update ignora un `event` suelto: la revisión habla de decision", () => {
    const payload = cambioDeCuenta({ id: "200000000000001", time: 9 }, "account_review_update", { event: "REJECTED" });

    expect(parseEventosDeCuenta(payload)[0]).toMatchObject({ evento: null, nombreEstado: null });
  });

  it.each(["business_capability_update", "template_category_update", "message_template_quality_update"])(
    "%s también se lee, para que quien atiende decida ignorarlo y lo deje anotado",
    (campo) => {
      const payload = cambioDeCuenta({ id: "200000000000001", time: 3 }, campo, { event: "ALGO" });

      expect(parseEventosDeCuenta(payload)).toEqual([
        { campo, wabaId: "200000000000001", evento: "ALGO", phoneNumberId: null, nombreEstado: null, hora: 3 },
      ]);
    }
  );

  it("sin una WABA con forma de id de Graph se descarta, sin tomar nada de lo tipeado", () => {
    for (const id of [undefined, "", "abc", "1/2", "200000000000001?x=1", 200000000000001, null]) {
      expect(parseEventosDeCuenta(cambioDeCuenta({ id, time: 1 }, "account_update", { event: "ACCOUNT_DELETED" }))).toEqual([]);
    }
    const conInfoRota = cambioDeCuenta({ id: "200000000000001", time: 1 }, "account_update", { waba_info: { waba_id: "../x" } });
    expect(parseEventosDeCuenta(conInfoRota)[0]?.wabaId).toBe("200000000000001");
  });

  it("la hora sólo vale si es un número; el evento y el estado, si son un texto corto", () => {
    const raros = cambioDeCuenta({ id: "200000000000001", time: "1760000000" }, "phone_number_name_update", {
      event: { x: 1 },
      decision: "X".repeat(65),
      phone_number_id: "no-es-un-id",
    });

    expect(parseEventosDeCuenta(raros)).toEqual([
      { campo: "phone_number_name_update", wabaId: "200000000000001", evento: null, phoneNumberId: null, nombreEstado: null, hora: null },
    ]);
    expect(parseEventosDeCuenta(cambioDeCuenta({ id: "200000000000001", time: Number.NaN }, "account_update", {}))[0]?.hora).toBeNull();
  });

  it("ignora lo que no es de WhatsApp o no tiene forma, sin tirar", () => {
    expect(parseEventosDeCuenta(null)).toEqual([]);
    expect(parseEventosDeCuenta({})).toEqual([]);
    expect(parseEventosDeCuenta("x")).toEqual([]);
    expect(parseEventosDeCuenta({ object: "page", entry: [{ id: "200000000000001", changes: [{ field: "account_update", value: {} }] }] })).toEqual([]);
    expect(parseEventosDeCuenta({ object: "whatsapp_business_account", entry: "x" })).toEqual([]);
    expect(parseEventosDeCuenta({ object: "whatsapp_business_account", entry: [null, { id: "200000000000001", changes: [null, {}] }] })).toEqual([]);
  });

  it("parseCloudApiMessages sigue sin ver estos eventos como mensajes", () => {
    expect(parseCloudApiMessages(cambioDeCuenta({ id: "200000000000001", time: 1 }, "account_update", { event: "ACCOUNT_DELETED" }))).toEqual([]);
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

    await expect(downloadWhatsAppMedia("1000001", CRED)).resolves.toBeNull();
  });

  it("la metadata y la descarga de bytes reciben cada una un signal", async () => {
    const signals: unknown[] = [];
    globalThis.fetch = vi.fn(async (url, init) => {
      signals.push((init as RequestInit | undefined)?.signal);
      const u = String(url);
      if (u.includes("/1000001")) {
        return new Response(
          JSON.stringify({ url: "https://lookaside.fbsbx.com/file", mime_type: "image/jpeg" }),
          { status: 200 }
        );
      }
      return new Response(Buffer.from("bytes"), { status: 200 });
    }) as unknown as typeof fetch;

    await downloadWhatsAppMedia("1000001", CRED);

    expect(signals).toHaveLength(2);
    expect(signals[0]).toBeInstanceOf(AbortSignal);
    expect(signals[1]).toBeInstanceOf(AbortSignal);
  });
});

describe("verificarFirmaDeApp", () => {
  const SECRETO = "fake-client-app-secret";
  const crudo = new TextEncoder().encode(JSON.stringify({ hola: "mundo" }));
  const firmar = (bytes: Uint8Array, secreto = SECRETO) => "sha256=" + createHmac("sha256", secreto).update(bytes).digest("hex");

  it("acepta la firma hecha sobre los bytes exactos", () => {
    expect(verificarFirmaDeApp(crudo, firmar(crudo), SECRETO)).toBe(true);
  });

  it("firma los bytes que llegaron, no el JSON reordenado", () => {
    const conEspacios = new TextEncoder().encode('{ "b": 1,   "a": 2 }');
    const reordenado = new TextEncoder().encode(JSON.stringify(JSON.parse('{ "b": 1,   "a": 2 }')));

    expect(verificarFirmaDeApp(conEspacios, firmar(conEspacios), SECRETO)).toBe(true);
    expect(verificarFirmaDeApp(reordenado, firmar(conEspacios), SECRETO)).toBe(false);
  });

  it("con el secreto vacío da false aunque la firma sea la del secreto vacío (sin valor por defecto)", () => {
    expect(verificarFirmaDeApp(crudo, firmar(crudo, ""), "")).toBe(false);
  });

  it("con el secreto de otra app, o el de la plataforma, da false", () => {
    expect(verificarFirmaDeApp(crudo, firmar(crudo, "fake-platform-app-secret"), SECRETO)).toBe(false);
  });

  it("no usa WHATSAPP_APP_SECRET: sólo el secreto que se le pasa", () => {
    vi.stubEnv("WHATSAPP_APP_SECRET", "fake-platform-app-secret");
    try {
      expect(verificarFirmaDeApp(crudo, firmar(crudo, "fake-platform-app-secret"), SECRETO)).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("rechaza una cabecera ausente, sin prefijo, corta, larga o que no es hexadecimal", () => {
    const hex = firmar(crudo).slice("sha256=".length);

    expect(verificarFirmaDeApp(crudo, null, SECRETO)).toBe(false);
    expect(verificarFirmaDeApp(crudo, hex, SECRETO)).toBe(false);
    expect(verificarFirmaDeApp(crudo, `sha1=${hex}`, SECRETO)).toBe(false);
    expect(verificarFirmaDeApp(crudo, `sha256=${hex.slice(2)}`, SECRETO)).toBe(false);
    expect(verificarFirmaDeApp(crudo, `sha256=${hex}00`, SECRETO)).toBe(false);
    expect(verificarFirmaDeApp(crudo, `sha256=${"z".repeat(64)}`, SECRETO)).toBe(false);
    expect(verificarFirmaDeApp(crudo, "sha256=", SECRETO)).toBe(false);
  });

  it("un byte distinto en el cuerpo da false", () => {
    const otro = new Uint8Array(crudo);
    otro[0] ^= 1;

    expect(verificarFirmaDeApp(otro, firmar(crudo), SECRETO)).toBe(false);
  });

  it("acepta el hexadecimal en mayúsculas", () => {
    const [prefijo, hex] = firmar(crudo).split("=");

    expect(verificarFirmaDeApp(crudo, `${prefijo}=${hex.toUpperCase()}`, SECRETO)).toBe(true);
  });
});

describe("urlDeGraph (R5)", () => {
  it("sin prueba no suma nada a la consulta", () => {
    expect(urlDeGraph("123/messages")).toMatch(/^https:\/\/graph\.facebook\.com\/v[\d.]+\/123\/messages$/);
  });

  it("con prueba suma appsecret_proof a una ruta sin consulta", () => {
    const prueba = "a".repeat(64);

    expect(urlDeGraph("123/messages", prueba)).toMatch(/\/123\/messages\?appsecret_proof=a{64}$/);
  });

  it("con prueba y una ruta que ya tiene consulta la suma con &", () => {
    const url = urlDeGraph("999?fields=health_status", "b".repeat(64));

    expect(url).toMatch(/\/999\?fields=health_status&appsecret_proof=b{64}$/);
  });

  it("codifica la prueba y siempre habla con graph.facebook.com", () => {
    const url = new URL(urlDeGraph("1", "x y&z"));

    expect(url.hostname).toBe("graph.facebook.com");
    expect(url.searchParams.get("appsecret_proof")).toBe("x y&z");
    expect([...url.searchParams.keys()]).toEqual(["appsecret_proof"]);
  });
});

describe("appsecret_proof en el envío y en el estado de la plantilla (R5)", () => {
  const realFetch = globalThis.fetch;
  const PRUEBA = "c".repeat(64);

  beforeEach(() => {
    olvidarEstadoDePlantilla();
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    olvidarEstadoDePlantilla();
  });

  function espiar(cuerpo: unknown) {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(cuerpo), { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    return fetchMock;
  }

  it("el envío de texto con prueba la lleva en la URL, y el token sólo en la cabecera", async () => {
    const fetchMock = espiar({ messages: [{ id: "wamid.out" }] });

    await sendWhatsAppText("5491100000000", "hola", { accessToken: "test-client-system-token-key", phoneNumberId: "999111", prueba: PRUEBA });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toMatch(/\/999111\/messages\?appsecret_proof=c{64}$/);
    expect(url).not.toContain("test-client-system-token-key");
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer test-client-system-token-key");
    expect(String(init?.body)).not.toContain(PRUEBA);
  });

  it("sin prueba (Embedded Signup y la plataforma) el envío no lleva consulta", async () => {
    const fetchMock = espiar({ messages: [{ id: "wamid.out" }] });

    await sendWhatsAppText("5491100000000", "hola", { accessToken: "test-token", phoneNumberId: "999111" });

    expect(fetchMock.mock.calls[0][0]).not.toContain("?");
  });

  it("la plantilla enviada con prueba la lleva en la URL", async () => {
    const fetchMock = espiar({ messages: [{ id: "wamid.tpl" }] });

    await sendWhatsAppTemplate("5491100000000", "reabrir_denuncia", "es_AR", ["x"], { ...CRED_PLANTILLA, prueba: PRUEBA });

    expect(fetchMock.mock.calls[0][0]).toMatch(/\/123\/messages\?appsecret_proof=c{64}$/);
  });

  it("el estado de la plantilla con prueba suma el proof a la consulta que ya tiene", async () => {
    const fetchMock = espiar({ data: [] });

    await estadoDePlantilla("reabrir_denuncia", "es_AR", { ...CRED, prueba: PRUEBA });

    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(url.pathname).toMatch(/\/waba-1\/message_templates$/);
    expect(url.searchParams.get("name")).toBe("reabrir_denuncia");
    expect(url.searchParams.get("fields")).toBe("name,status,language");
    expect(url.searchParams.get("appsecret_proof")).toBe(PRUEBA);
  });

  it("el estado de la plantilla sin prueba no la lleva", async () => {
    const fetchMock = espiar({ data: [] });

    await estadoDePlantilla("reabrir_denuncia", "es_AR", CRED);

    expect(new URL(fetchMock.mock.calls[0][0]).searchParams.has("appsecret_proof")).toBe(false);
  });
});

describe("media: ids y host del CDN (S7)", () => {
  const realFetch = globalThis.fetch;
  const TOKEN = "test-client-system-token-key";
  const PRUEBA = "d".repeat(64);

  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.unstubAllEnvs();
  });

  function mensajeConImagen(id: unknown) {
    return parseCloudApiMessages(metaPayload([{ from: "549111", id: "wamid.7", type: "image", image: { id, mime_type: "image/jpeg" } }]));
  }

  it("un media id numérico se conserva", () => {
    expect(mensajeConImagen("1234567890")[0].media).toEqual([
      { id: "1234567890", mimeType: "image/jpeg", filename: "image-1234567890.jpg" },
    ]);
  });

  it("descarta el adjunto cuyo id no son sólo dígitos, pero deja el mensaje", () => {
    for (const id of ["media-1", "12/../34", "12?x=1", "12 34", "١٢٣", "1".repeat(33), 123, {}]) {
      const [mensaje] = mensajeConImagen(id);

      expect(mensaje).toBeDefined();
      expect(mensaje.media ?? []).toEqual([]);
    }
  });

  it("acepta un id de 32 dígitos, el máximo", () => {
    expect(mensajeConImagen("1".repeat(32))[0].media).toHaveLength(1);
  });

  const esGraph = (u: string | URL | Request) => new URL(String(u)).hostname === "graph.facebook.com";

  /** Metadata con la `url` dada y, de existir el CDN, un archivo de cinco bytes. */
  function conUrlDeMedia(url: string) {
    const fetchMock = vi.fn(async (u: string | URL | Request, _init?: RequestInit) =>
      esGraph(u)
        ? new Response(JSON.stringify({ url, mime_type: "image/jpeg" }), { status: 200 })
        : new Response(Buffer.from("bytes"), { status: 200 })
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    return fetchMock;
  }

  it("baja del host de Meta con https, sin que fetch siga redirecciones solo y con el token sólo en la cabecera", async () => {
    const fetchMock = conUrlDeMedia("https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=1");

    const archivo = await downloadWhatsAppMedia("1000001", { accessToken: TOKEN });

    expect(archivo).toMatchObject({ mimeType: "image/jpeg" });
    const [urlCdn, initCdn] = fetchMock.mock.calls[1];
    expect(String(urlCdn)).toBe("https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=1");
    expect(initCdn?.redirect).toBe("manual");
    expect((initCdn?.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("con prueba, la metadata (Graph) la lleva y el CDN no", async () => {
    const fetchMock = conUrlDeMedia("https://lookaside.fbsbx.com/file");

    await downloadWhatsAppMedia("1000001", { accessToken: TOKEN, prueba: PRUEBA });

    expect(String(fetchMock.mock.calls[0][0])).toMatch(/\/1000001\?appsecret_proof=d{64}$/);
    expect(String(fetchMock.mock.calls[1][0])).not.toContain("appsecret_proof");
    expect(String(fetchMock.mock.calls[1][0])).not.toContain(PRUEBA);
  });

  it.each([
    ["otro host", "https://cdn.example/file"],
    ["un host que contiene el permitido", "https://lookaside.fbsbx.com.example.com/file"],
    ["un subdominio del permitido", "https://x.lookaside.fbsbx.com/file"],
    ["el host permitido como usuario", "https://lookaside.fbsbx.com@example.com/file"],
    ["http", "http://lookaside.fbsbx.com/file"],
    ["un esquema que no es web", "ftp://lookaside.fbsbx.com/file"],
    ["algo que no es una URL", "no-es-una-url"],
  ])("no pide el archivo ni manda el token con %s", async (_caso, url) => {
    const fetchMock = conUrlDeMedia(url);

    await expect(downloadWhatsAppMedia("1000001", { accessToken: TOKEN })).resolves.toBeNull();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain("graph.facebook.com");
  });

  describe("el host del CDN y las redirecciones (I34 abierta)", () => {
    const META = "https://lookaside.fbsbx.com/file";

    /** Metadata con la `url` dada; cada pedido al CDN contesta lo que diga `cdn` según la URL. */
    function conCdn(cdn: (url: string, init?: RequestInit) => Response) {
      const fetchMock = vi.fn(async (u: string | URL | Request, init?: RequestInit) =>
        esGraph(u)
          ? new Response(JSON.stringify({ url: META, mime_type: "image/jpeg" }), { status: 200 })
          : cdn(String(u), init)
      );
      globalThis.fetch = fetchMock as unknown as typeof fetch;
      return fetchMock;
    }
    const redirige = (location: string) => new Response(null, { status: 302, headers: { location } });
    const cabecera = (init: RequestInit | undefined) => (init?.headers as Record<string, string>).Authorization;

    it("WHATSAPP_MEDIA_HOSTS suma hosts exactos: se baja de ahí con el token", async () => {
      vi.stubEnv("WHATSAPP_MEDIA_HOSTS", "scontent.whatsapp.net, cdn.example.com");
      const fetchMock = conUrlDeMedia("https://scontent.whatsapp.net/v/t1/file");

      await expect(downloadWhatsAppMedia("1000001", { accessToken: TOKEN })).resolves.toMatchObject({ mimeType: "image/jpeg" });

      expect(String(fetchMock.mock.calls[1][0])).toBe("https://scontent.whatsapp.net/v/t1/file");
    });

    it.each([
      ["un subdominio del sumado", "https://x.cdn.example.com/file"],
      ["el de Meta con otro dominio pegado", "https://lookaside.fbsbx.com.cdn.example.com/file"],
    ])("lo sumado no abre subdominios: %s", async (_caso, url) => {
      vi.stubEnv("WHATSAPP_MEDIA_HOSTS", "cdn.example.com");
      const fetchMock = conUrlDeMedia(url);

      await expect(downloadWhatsAppMedia("1000001", { accessToken: TOKEN })).resolves.toBeNull();

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it.each(["*", "https://cdn.example.com", "cdn", "cdn.example.com/ruta", ""])("un valor que no es un host (%j) no suma nada", async (valor) => {
      vi.stubEnv("WHATSAPP_MEDIA_HOSTS", valor);
      const fetchMock = conUrlDeMedia("https://cdn.example.com/file");

      await expect(downloadWhatsAppMedia("1000001", { accessToken: TOKEN })).resolves.toBeNull();

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("una redirección a otro host permitido se sigue un solo salto y sin el token", async () => {
      vi.stubEnv("WHATSAPP_MEDIA_HOSTS", "scontent.whatsapp.net");
      const fetchMock = conCdn((url) => (url === META ? redirige("https://scontent.whatsapp.net/firmada?sig=1") : new Response(Buffer.from("bytes"), { status: 200 })));

      await expect(downloadWhatsAppMedia("1000001", { accessToken: TOKEN })).resolves.toMatchObject({ mimeType: "image/jpeg" });

      expect(fetchMock).toHaveBeenCalledTimes(3);
      const [, [, primero], [urlSalto, salto]] = fetchMock.mock.calls;
      expect(cabecera(primero)).toBe(`Bearer ${TOKEN}`);
      expect(String(urlSalto)).toBe("https://scontent.whatsapp.net/firmada?sig=1");
      expect(salto?.redirect).toBe("manual");
      expect(JSON.stringify(salto?.headers)).not.toContain(TOKEN);
    });

    it("una redirección dentro del mismo host (relativa) se sigue y conserva el token", async () => {
      const fetchMock = conCdn((url) => (url === META ? redirige("/otra/ruta") : new Response(Buffer.from("bytes"), { status: 200 })));

      await expect(downloadWhatsAppMedia("1000001", { accessToken: TOKEN })).resolves.toMatchObject({ mimeType: "image/jpeg" });

      const [, , [urlSalto, salto]] = fetchMock.mock.calls;
      expect(String(urlSalto)).toBe("https://lookaside.fbsbx.com/otra/ruta");
      expect(cabecera(salto)).toBe(`Bearer ${TOKEN}`);
    });

    it.each([
      ["otro host", "https://evil.example.com/robado"],
      ["http", "http://lookaside.fbsbx.com/file"],
      ["sin Location", ""],
    ])("una redirección a %s da null y no se la sigue", async (_caso, location) => {
      const fetchMock = conCdn(() => new Response(null, { status: 302, headers: location ? { location } : {} }));

      await expect(downloadWhatsAppMedia("1000001", { accessToken: TOKEN })).resolves.toBeNull();

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls.map(([u]) => String(u))).not.toContain(location || "sin-location");
    });

    it("una segunda redirección da null: no se encadenan saltos", async () => {
      vi.stubEnv("WHATSAPP_MEDIA_HOSTS", "scontent.whatsapp.net");
      const fetchMock = conCdn((url) => redirige(url === META ? "https://scontent.whatsapp.net/uno" : "https://scontent.whatsapp.net/dos"));

      await expect(downloadWhatsAppMedia("1000001", { accessToken: TOKEN })).resolves.toBeNull();

      expect(fetchMock).toHaveBeenCalledTimes(3);
    });
  });
});

describe("leerHastaElTope", () => {
  it("lee el cuerpo de una Response", async () => {
    const leido = await leerHastaElTope(new Response("hola mundo"), 1024);

    expect(Buffer.isBuffer(leido) && leido.toString()).toBe("hola mundo");
  });

  it("lee el cuerpo de un Request (la ruta del webhook de una app)", async () => {
    const pedido = new Request("https://example.com/api/webhooks/whatsapp/app/x", { method: "POST", body: '{"a":1}' });

    const leido = await leerHastaElTope(pedido, 1024);

    expect(Buffer.isBuffer(leido) && leido.toString()).toBe('{"a":1}');
  });

  it("corta con demasiado_grande apenas se pasa del tope", async () => {
    await expect(leerHastaElTope(new Response("x".repeat(11)), 10)).resolves.toBe("demasiado_grande");
  });

  it("justo en el tope entra", async () => {
    const leido = await leerHastaElTope(new Response("x".repeat(10)), 10);

    expect(Buffer.isBuffer(leido) && leido.length).toBe(10);
  });

  it("un cuerpo que falla a mitad de la lectura da null", async () => {
    const roto = new ReadableStream<Uint8Array>({
      pull(controlador) {
        controlador.error(new Error("ECONNRESET"));
      },
    });

    await expect(leerHastaElTope({ body: roto }, 10)).resolves.toBeNull();
  });

  it("sin cuerpo da null", async () => {
    await expect(leerHastaElTope({ body: null }, 10)).resolves.toBeNull();
  });
});
