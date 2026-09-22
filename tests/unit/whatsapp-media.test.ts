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

/*
 * El camino completo necesita al que llama, y al que llama hay que sostenerlo.
 *
 * `createWhatsAppIntake` es el que convierte «demasiado grande» en un adjunto:
 * sin él sólo se comprueba la forma del retorno de la descarga, que es
 * justamente lo que pasaba —nadie cubría los tres pasos que cierran el agujero,
 * y alguien podía volver a poner el `continue` con la suite en verde.
 *
 * La descarga se espía DELEGANDO en la real, porque los casos de más arriba de
 * este mismo archivo la ejercitan de verdad; sólo el caso nuevo le pone una
 * respuesta con `mockResolvedValueOnce`, que se consume sola.
 */
const { espiaDeDescarga, espiaDeRehost, mockEnTenant } = vi.hoisted(() => ({
  espiaDeDescarga: vi.fn(),
  espiaDeRehost: vi.fn(),
  mockEnTenant: vi.fn(),
}));

vi.mock("server-only", () => ({}));

vi.mock("@/server/whatsapp/cloud-api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/server/whatsapp/cloud-api")>();
  espiaDeDescarga.mockImplementation(real.downloadWhatsAppMedia);
  return {
    ...real,
    downloadWhatsAppMedia: (...args: Parameters<typeof real.downloadWhatsAppMedia>) =>
      espiaDeDescarga(...args),
  };
});

vi.mock("@/server/email/rehost-attachments", () => ({
  rehostAndRecordAttachments: espiaDeRehost,
}));

vi.mock("@/data/scope", () => ({
  enTenant: mockEnTenant,
  enTenantVarias: vi.fn().mockResolvedValue([[], []]),
}));

vi.mock("@/lib/audit/log", () => ({
  writeAuditLog: vi.fn().mockResolvedValue(undefined),
  AuditEvent: { EMAIL_RECEIVED: "email.received" },
}));

import { parseCloudApiMessages, downloadWhatsAppMedia } from "@/server/whatsapp/cloud-api";
import { createWhatsAppIntake } from "@/server/agents/intake-agent";

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

/**
 * Lo que se bajó, acotando el tipo.
 *
 * `downloadWhatsAppMedia` ahora puede devolver «demasiado grande», que no es lo
 * mismo que «no se pudo»: uno deja fila rechazada en la pantalla del analista y
 * el otro es una falla nuestra. Estos casos esperan bytes, así que si vuelve
 * cualquier otra cosa el test tiene que decir cuál.
 */
function loBajado(
  file: Awaited<ReturnType<typeof downloadWhatsAppMedia>>
): { data: Buffer; mimeType: string } {
  if (!file || "demasiadoGrande" in file) {
    throw new Error(`se esperaban bytes y vino: ${JSON.stringify(file)}`);
  }
  return file;
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

    const bajado = loBajado(file);
    expect(bajado.mimeType).toBe("image/jpeg");
    expect(bajado.data.toString()).toBe("bytes");
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

    // Con los bytes que declaro Meta: el analista ve cuanto pesaba.
    expect(file).toEqual({ demasiadoGrande: true, bytes: 100 * 1024 * 1024 });
    // La que importa: una sola llamada, la de la metadata. La del archivo no.
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain("/media-1");
  });

  it("uno que entra en el tope se baja como siempre", async () => {
    // El control que impide que el arreglo sea «rechazar todo».
    const urls = espiar(1024);

    const file = await downloadWhatsAppMedia("media-1");

    expect(loBajado(file).data.toString()).toBe("bytes");
    expect(urls).toHaveLength(2);
  });

  it("y sin file_size, el cuerpo se corta igual al pasarse", async () => {
    // El cinturón además de los tiradores: si Meta deja de mandar el campo,
    // `arrayBuffer()` no tiene forma de rendirse a la mitad.
    const enorme = "x".repeat(11 * 1024 * 1024);
    const urls = espiar(undefined, enorme);

    const file = await downloadWhatsAppMedia("media-1");

    // Esto comprueba la FORMA del retorno y nada más: «demasiado grande» y no
    // `null`, que es «no se pudo bajar». Que de esa forma salga después un
    // adjunto rechazado que el analista ve no se prueba acá — lo prueba el
    // describe del intake, más abajo.
    expect(file).toEqual({ demasiadoGrande: true, bytes: null });
    // Acá sí se abrió: no había con qué saberlo antes. Lo que no pasó es que
    // los once megas terminaran en un Buffer.
    expect(urls).toHaveLength(2);
  });
});

/**
 * De la descarga cortada a la fila que el analista ve.
 *
 * Los tres pasos que cierran el agujero son: la descarga que dice «demasiado
 * grande» en vez de `null`, el intake que lo convierte en un adjunto sin bytes
 * con su motivo, y rehost que le escribe la fila. El primero ya estaba
 * cubierto; los otros dos no tenían ningún test, así que volver a poner el
 * `continue` del intake dejaba la suite entera en verde y al asegurado
 * creyendo que había mandado el video.
 */
describe("createWhatsAppIntake — el archivo que no entró queda anotado", () => {
  const TENANT = "11111111-0000-4000-8000-000000000001";
  const TELEFONO = "5492916426930";

  /** Simula la base por turnos: buscar el caso, crearlo, guardar el mensaje. */
  function guion(pasos: unknown[][]) {
    let i = 0;
    mockEnTenant.mockImplementation(async () => pasos[i++] ?? []);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    guion([[], [{ id: "caso-1" }], [{ id: "msg-1" }], []]);
    espiaDeRehost.mockResolvedValue([{ stored: false, reason: "size_exceeded" }]);
  });

  it("el adjunto llega a rehost sin bytes, con su motivo y con su nombre", async () => {
    espiaDeDescarga.mockResolvedValueOnce({ demasiadoGrande: true, bytes: null });

    await createWhatsAppIntake({
      tenantId: TENANT,
      from: TELEFONO,
      body: "te mando el video del choque",
      media: [{ id: "media-1", mimeType: "video/mp4", filename: "el-choque.mp4" }],
    });

    expect(espiaDeRehost).toHaveBeenCalledTimes(1);
    const { attachments } = espiaDeRehost.mock.calls[0][0] as {
      attachments: Array<Record<string, unknown>>;
    };

    expect(attachments).toHaveLength(1);
    expect(attachments[0]).toMatchObject({
      // El nombre con el que lo mandó el asegurado: es lo único que le permite
      // al analista pedirle ESE archivo y no «el que no entró».
      Name: "el-choque.mp4",
      // Vacío a propósito. La descarga se cortó justamente para no tenerlos.
      Content: "",
      ContentType: "video/mp4",
      // El centinela, comprobado y no supuesto. Cuando la descarga se corta a
      // mitad nadie contó los bytes, así que va `MAX_ATTACHMENT_SIZE_BYTES + 1`,
      // que quiere decir «pasaba el tope» y nada más. Dos comentarios del código
      // lo tratan como contrato —y la pantalla decide con él si muestra un peso
      // o no—, así que tiene que estar escrito en algún test.
      ContentLength: 10 * 1024 * 1024 + 1,
      rechazoPrevio: "size_exceeded",
    });
  });

  it("y cuando el peso sí se sabe, viaja el peso de verdad", async () => {
    /*
     * El otro lado del `??`. Cuando el tope se aplica por la metadata, el peso
     * declarado está: un video de 100 MB queda con 100 MB, que es una medición.
     * Sin este caso, cambiar el `file.bytes ?? …` por el centinela a secas
     * dejaba todo en verde y el analista veía «10,0 MB» sobre un archivo diez
     * veces más grande.
     */
    espiaDeDescarga.mockResolvedValueOnce({
      demasiadoGrande: true,
      bytes: 100 * 1024 * 1024,
    });

    await createWhatsAppIntake({
      tenantId: TENANT,
      from: TELEFONO,
      body: "el video largo",
      media: [{ id: "media-3", mimeType: "video/mp4", filename: "el-choque-entero.mp4" }],
    });

    const { attachments } = espiaDeRehost.mock.calls[0][0] as {
      attachments: Array<Record<string, unknown>>;
    };
    expect(attachments[0]).toMatchObject({
      Content: "",
      ContentLength: 104857600,
      rechazoPrevio: "size_exceeded",
    });
  });

  it("uno que sí se baja sigue llegando con sus bytes", async () => {
    // El control que impide que el arreglo sea «rechazar todo»: si el intake
    // marcara cualquier media como rechazada, el test de arriba pasaría igual.
    espiaDeDescarga.mockResolvedValueOnce({
      data: Buffer.from("bytes"),
      mimeType: "image/jpeg",
    });

    await createWhatsAppIntake({
      tenantId: TENANT,
      from: TELEFONO,
      body: "la foto",
      media: [{ id: "media-2", mimeType: "image/jpeg", filename: "paragolpes.jpg" }],
    });

    const { attachments } = espiaDeRehost.mock.calls[0][0] as {
      attachments: Array<Record<string, unknown>>;
    };
    expect(attachments[0]).toMatchObject({
      Name: "paragolpes.jpg",
      Content: Buffer.from("bytes").toString("base64"),
    });
    expect(attachments[0].rechazoPrevio).toBeUndefined();
  });

  it("y el comentario de cloud-api ya no dice que el rastro se pierde", async () => {
    /*
     * Afirmación sobre la fuente. El párrafo decía «Acá devolvemos null (...)
     * queda en el log y no en la pantalla» y las cuatro afirmaciones eran
     * falsas diez líneas más abajo del propio comentario. Un comentario que
     * miente sobre un agujero cerrado es el que hace que alguien lo "arregle"
     * de nuevo por otro lado.
     */
    const fuente = await import("node:fs").then((fs) =>
      fs.readFileSync("src/server/whatsapp/cloud-api.ts", "utf8")
    );
    expect(fuente).not.toContain("Acá devolvemos null");
    // Y sí dice lo contrario, con esas palabras. `toContain("demasiadoGrande")`
    // no afirmaba nada: el tipo `MediaDeWhatsApp` usa esa misma palabra, así que
    // era verdadero mientras la función existiera.
    expect(fuente).toContain("Y el rastro no se pierde");
  });
});
