/**
 * Receiving the photo the agent asked for.
 *
 * The reply tells people to send damage photos through the chat, and for
 * months the file was thrown away: the webhook payload names the media, the
 * bytes sit behind a second Graph call nobody made, so a photo of a crumpled
 * bumper was stored as the string "[Imagen adjunta sin texto]".
 *
 * Two failures matter. Losing the file, which is the claim's central evidence.
 * And letting a download problem take the whole message down with it — the
 * text of a claim must survive a photo that will not fetch.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { parseCloudApiMessages, downloadWhatsAppMedia } from "@/server/whatsapp/cloud-api";

function payloadWith(message: Record<string, unknown>) {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        changes: [
          {
            value: {
              contacts: [{ wa_id: "5491100000000", profile: { name: "Laura" } }],
              messages: [message],
            },
          },
        ],
      },
    ],
  };
}

describe("parseCloudApiMessages — media", () => {
  it("keeps a photo that came with no caption at all", () => {
    // The message used to be dropped or reduced to a placeholder; the photo is
    // the most valuable thing in it.
    const [msg] = parseCloudApiMessages(
      payloadWith({
        from: "5491100000000",
        id: "wamid.1",
        type: "image",
        image: { id: "media-1", mime_type: "image/jpeg" },
      })
    );

    expect(msg).toBeDefined();
    expect(msg.media).toHaveLength(1);
    expect(msg.media?.[0]).toMatchObject({ id: "media-1", mimeType: "image/jpeg" });
  });

  it("names an unnamed photo so two in one claim do not collide", () => {
    const [msg] = parseCloudApiMessages(
      payloadWith({
        from: "5491100000000",
        id: "wamid.2",
        type: "image",
        image: { id: "media-abc", mime_type: "image/jpeg", caption: "el paragolpes" },
      })
    );

    expect(msg.body).toBe("el paragolpes");
    expect(msg.media?.[0].filename).toBe("image-media-abc.jpg");
  });

  it("uses the filename Meta gives a document", () => {
    const [msg] = parseCloudApiMessages(
      payloadWith({
        from: "5491100000000",
        id: "wamid.3",
        type: "document",
        document: { id: "media-2", mime_type: "application/pdf", filename: "denuncia.pdf" },
      })
    );

    expect(msg.media?.[0].filename).toBe("denuncia.pdf");
  });

  it("leaves a plain text message without media", () => {
    const [msg] = parseCloudApiMessages(
      payloadWith({
        from: "5491100000000",
        id: "wamid.4",
        type: "text",
        text: { body: "Choqué en Bahía Blanca" },
      })
    );

    expect(msg.media).toBeUndefined();
  });
});

describe("downloadWhatsAppMedia", () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    process.env.WHATSAPP_ACCESS_TOKEN = "test-token";
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    delete process.env.WHATSAPP_ACCESS_TOKEN;
  });

  it("resolves the id to a URL and fetches it with the token", async () => {
    // The CDN URL needs the same bearer token: fetching it unauthenticated
    // returns HTML rather than the file.
    const calls: Array<{ url: string; auth?: string }> = [];
    globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      calls.push({
        url: u,
        auth: (init?.headers as Record<string, string> | undefined)?.Authorization,
      });
      if (u.includes("/media-1")) {
        return new Response(
          JSON.stringify({ url: "https://cdn.example/file", mime_type: "image/jpeg" }),
          { status: 200 }
        );
      }
      return new Response(Buffer.from("bytes"), { status: 200 });
    }) as unknown as typeof fetch;

    const file = await downloadWhatsAppMedia("media-1");

    expect(file?.mimeType).toBe("image/jpeg");
    expect(file?.data.toString()).toBe("bytes");
    expect(calls).toHaveLength(2);
    expect(calls[1].url).toBe("https://cdn.example/file");
    expect(calls[1].auth).toBe("Bearer test-token");
  });

  it("returns null instead of throwing when the download fails", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response("nope", { status: 404 })
    ) as unknown as typeof fetch;

    await expect(downloadWhatsAppMedia("media-x")).resolves.toBeNull();
  });

  it("returns null when the network itself fails", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;

    await expect(downloadWhatsAppMedia("media-x")).resolves.toBeNull();
  });

  it("returns null rather than calling Graph with no token", async () => {
    delete process.env.WHATSAPP_ACCESS_TOKEN;
    const spy = vi.fn();
    globalThis.fetch = spy as unknown as typeof fetch;

    await expect(downloadWhatsAppMedia("media-x")).resolves.toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });
});

/**
 * Un adjunto enorme no entra al proceso.
 *
 * El tope de guardado son 10 MB y se aplicaba DESPUÉS de tener los bytes en
 * memoria. La Cloud API acepta documentos de hasta 100 MB, el número es
 * público, y esto corre adentro del tiempo del webhook: un PDF de 100 MB
 * pasaba por el Buffer (100 MB), por el base64 del intake (~133 MB) y por el
 * Buffer que rehost vuelve a decodificar. Unos 330 MB de pico para un archivo
 * que nunca se iba a guardar — repetible sin credencial, con sólo escribirle
 * al número.
 */
describe("downloadWhatsAppMedia — el tope se aplica antes de bajar", () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    process.env.WHATSAPP_ACCESS_TOKEN = "test-token";
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    delete process.env.WHATSAPP_ACCESS_TOKEN;
  });

  /** Las URL que se pidieron, para ver si la del CDN llegó a abrirse. */
  function espiar(fileSize: number | undefined, bytes = "bytes") {
    const urls: string[] = [];
    globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      urls.push(u);
      if (u.includes("/media-1")) {
        return new Response(
          JSON.stringify({
            url: "https://cdn.example/file",
            mime_type: "application/pdf",
            ...(fileSize === undefined ? {} : { file_size: fileSize }),
          }),
          { status: 200 }
        );
      }
      return new Response(Buffer.from(bytes), { status: 200 });
    }) as unknown as typeof fetch;
    return urls;
  }

  it("con file_size de 100 MB ni abre la conexión con el CDN", async () => {
    const urls = espiar(100 * 1024 * 1024);

    const file = await downloadWhatsAppMedia("media-1");

    expect(file).toBeNull();
    // La que importa: una sola llamada, la de la metadata. La del archivo no.
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain("/media-1");
  });

  it("uno que entra en el tope se baja como siempre", async () => {
    // El control que impide que el arreglo sea «rechazar todo».
    const urls = espiar(1024);

    const file = await downloadWhatsAppMedia("media-1");

    expect(file?.data.toString()).toBe("bytes");
    expect(urls).toHaveLength(2);
  });

  it("y sin file_size, el cuerpo se corta igual al pasarse", async () => {
    // El cinturón además de los tiradores: si Meta deja de mandar el campo,
    // `arrayBuffer()` no tiene forma de rendirse a la mitad.
    const enorme = "x".repeat(11 * 1024 * 1024);
    const urls = espiar(undefined, enorme);

    const file = await downloadWhatsAppMedia("media-1");

    expect(file).toBeNull();
    // Acá sí se abrió: no había con qué saberlo antes. Lo que no pasó es que
    // los once megas terminaran en un Buffer.
    expect(urls).toHaveLength(2);
  });
});
