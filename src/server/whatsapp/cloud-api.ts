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
import { MAX_ATTACHMENT_SIZE_BYTES } from "@/server/email/attachment-validator";
import { logger } from "@/lib/observability/logger";
import { topeEntero } from "@/lib/topes";
import { liberarCupo, rateLimit } from "@/lib/rate-limit";
import { claveDeCupo } from "@/lib/rate-limit/clave";
import { PLACEHOLDER_AUDIO } from "@/core/adjuntos/transcripcion";

const GRAPH_API_BASE = "https://graph.facebook.com";

/**
 * Con qué número y qué token habla cada llamada a Meta. Obligatorio en todo lo
 * que sale: ningún envío cae por omisión en el .env. Lo arma `credencialesWhatsApp`
 * (numeros.ts), el único que lee esas variables.
 */
export interface CredencialesMeta {
  phoneNumberId: string;
  accessToken: string;
  wabaId: string | null;
  /**
   * El `appsecret_proof` del token, sólo para la app propia de un cliente: su app puede exigir
   * «Require App Secret» y una llamada sin prueba falla. Con la app de la plataforma no se manda.
   */
  prueba?: string;
}

/** Default Graph API version; override with WHATSAPP_API_VERSION. */
function apiVersion(): string {
  return process.env.WHATSAPP_API_VERSION?.trim() || "v22.0";
}

/**
 * La URL de un recurso de Graph con la versión vigente; para quien consulta y no manda (verificar-en-meta.ts).
 * Con `prueba` suma `appsecret_proof` a la consulta. Sólo vale para `graph.facebook.com`: la descarga del CDN no es Graph.
 */
export function urlDeGraph(ruta: string, prueba?: string): string {
  const url = `${GRAPH_API_BASE}/${apiVersion()}/${ruta}`;
  return prueba ? `${url}${ruta.includes("?") ? "&" : "?"}appsecret_proof=${encodeURIComponent(prueba)}` : url;
}

/** La versión de Graph vigente; el SDK del popup de Meta tiene que cargar la misma que usa el servidor, o el flujo y las llamadas hablan versiones distintas. */
export function versionDeGraph(): string {
  return apiVersion();
}

/*
 * Plazos de los pedidos a Graph. Sin esto, una Meta colgada deja la función
 * esperando hasta el `maxDuration` de la ruta en vez de fallar y dejar que el
 * que llama siga (ya sabe leer `null` / `ok:false`).
 */

/** Sólo resuelve una URL corta; no hay motivo para que tarde. */
const PLAZO_METADATA_MEDIA_MS = 15_000;

/** El archivo puede pesar hasta el tope de guardado; necesita más margen. */
const PLAZO_DESCARGA_MEDIA_MS = 60_000;

/** Mandar un texto es liviano; si tarda más que esto, ya no vale la pena. */
const PLAZO_ENVIO_WHATSAPP_MS = 20_000;

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

/**
 * La firma de un webhook de la app de un cliente, sobre los bytes exactos que llegaron.
 *
 * Sin valor por defecto: el secreto es el de esa app, nunca el de la plataforma. Con el secreto
 * vacío o una cabecera que no sea `sha256=<64 hex>` devuelve false. Compara en tiempo constante.
 */
export function verificarFirmaDeApp(crudo: Uint8Array, cabecera: string | null, secreto: string): boolean {
  if (!secreto || !cabecera?.startsWith("sha256=")) return false;
  const recibida = cabecera.slice("sha256=".length);
  if (!/^[0-9a-f]{64}$/i.test(recibida)) return false;

  const esperada = createHmac("sha256", secreto).update(crudo).digest();
  return timingSafeEqual(esperada, Buffer.from(recibida, "hex"));
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
  /**
   * El numero DE ESTA CASA al que le escribieron (`metadata.phone_number_id`).
   *
   * Se parseaba y se tiraba. Un webhook de Meta es de la APP, no de un numero:
   * si la app queda suscripta a dos WABA —una segunda aseguradora, una prueba,
   * un numero viejo que nadie dio de baja— los mensajes de las dos llegan a
   * esta misma ruta, con firma valida, y sin esto no habia forma de
   * distinguirlos.
   */
  toPhoneNumberId?: string;
  /**
   * La WABA con que Meta dijo que venía el evento (`entry.id`). Sólo sirve para
   * cotejarla con la fila del número: si no coincide se anota, no se descarta.
   */
  toWabaId?: string;
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
  location?: { latitude?: number; longitude?: number; name?: string; address?: string };
  contacts?: Array<{ name?: { formatted_name?: string }; phones?: Array<{ phone?: string }> }>;
  button?: { text?: string };
  interactive?: {
    button_reply?: { title?: string };
    list_reply?: { title?: string };
  };
}

/** «a, b, c» sin los vacíos: el texto de una ubicación o un contacto que vino a medias. */
function unidos(partes: Array<string | undefined>, separador = ", "): string {
  return partes.map((p) => p?.trim()).filter(Boolean).join(separador);
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
      return PLACEHOLDER_AUDIO;
    case "location": {
      const l = msg.location;
      const coordenadas =
        typeof l?.latitude === "number" && typeof l.longitude === "number" ? `${l.latitude}, ${l.longitude}` : undefined;
      const texto = unidos([l?.name, l?.address, coordenadas]);
      return texto ? `[Ubicación compartida: ${texto}]` : "";
    }
    case "contacts": {
      const texto = unidos(
        (msg.contacts ?? []).map((c) => unidos([c.name?.formatted_name, ...(c.phones ?? []).map((p) => p.phone)])),
        "; "
      );
      return texto ? `[Contacto compartido: ${texto}]` : "";
    }
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

/** El id de un adjunto de Meta son sólo dígitos. Cualquier otra cosa no se arma en una URL de Graph. */
const ID_DE_MEDIA = /^\d{1,32}$/;

/** El host del CDN de adjuntos que documenta Meta. Que sea el único es la incógnita I34: `WHATSAPP_MEDIA_HOSTS` suma los que aparezcan sin tocar el código. */
const HOST_DE_MEDIA = "lookaside.fbsbx.com";

/** Los únicos hosts a los que se manda el token de un adjunto: el de Meta y los que sume `WHATSAPP_MEDIA_HOSTS` (separados por coma o espacio, hosts exactos). */
function hostsDeMedia(): Set<string> {
  const sumados = (process.env.WHATSAPP_MEDIA_HOSTS ?? "")
    .split(/[\s,]+/)
    .map((h) => h.toLowerCase())
    .filter((h) => /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(h));
  return new Set([HOST_DE_MEDIA, ...sumados]);
}

/** Una dirección de adjunto (absoluta, o relativa a `base`), o null si no es una URL. */
function urlDeMedia(url: string, base?: string): URL | null {
  try {
    return new URL(url, base);
  } catch {
    return null;
  }
}

/** Sólo https y sólo un host permitido: a cualquier otro no se le manda el token. */
function esDeMedia(url: URL): boolean {
  return url.protocol === "https:" && hostsDeMedia().has(url.hostname);
}

/**
 * Pide el archivo sin dejar que `fetch` siga redirecciones solo. Una redirección vale si va a otro host
 * permitido, un solo salto; el token sólo viaja si el host no cambió. Cualquier otra da null y se anota el host.
 */
async function pedirAlCdn(direccion: string, accessToken: string): Promise<Response | null> {
  const pedir = (url: string, conToken: boolean) =>
    fetch(url, {
      headers: conToken ? { Authorization: `Bearer ${accessToken}` } : {},
      redirect: "manual",
      signal: AbortSignal.timeout(PLAZO_DESCARGA_MEDIA_MS),
    });
  const esRedireccion = (res: Response) => res.status >= 300 && res.status < 400;

  const primera = await pedir(direccion, true);
  if (!esRedireccion(primera)) return primera;
  await primera.body?.cancel().catch(() => undefined);

  const destinoDelSalto = primera.headers.get("location");
  const salto = destinoDelSalto ? urlDeMedia(destinoDelSalto, direccion) : null;
  if (!salto || !esDeMedia(salto)) {
    // Sólo el host: la dirección entera lleva el identificador del adjunto de quien escribió.
    logger.error({ host: salto?.hostname ?? null }, "whatsapp.media_redireccion_no_permitida");
    return null;
  }
  const segunda = await pedir(salto.href, salto.hostname === new URL(direccion).hostname);
  if (!esRedireccion(segunda)) return segunda;
  await segunda.body?.cancel().catch(() => undefined);
  logger.error({ host: salto.hostname }, "whatsapp.media_redireccion_no_permitida");
  return null;
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
  if (typeof part.id !== "string" || !ID_DE_MEDIA.test(part.id)) {
    logger.warn({ tipo: msg.type }, "whatsapp.media_id_invalido");
    return [];
  }

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
    "audio/opus": ".opus",
    "audio/mpeg": ".mp3",
    "audio/mp4": ".m4a",
    "audio/x-m4a": ".m4a",
    "audio/aac": ".aac",
    "audio/wav": ".wav",
    "audio/x-wav": ".wav",
    "application/pdf": ".pdf",
  };
  return known[mimeType.split(";")[0].trim()] ?? "";
}

/**
 * Lee el cuerpo contando bytes y corta apenas se pasa del tope.
 *
 * `file_size` es lo que Meta DICE que pesa, y con eso alcanza para el caso
 * normal. Esto es el cinturón además de los tiradores: si el campo no viene
 * —cambia la versión de la API, o el tipo de media no lo trae— nadie más
 * frena la descarga, y `arrayBuffer()` no tiene forma de rendirse a la
 * mitad.
 */
export async function leerHastaElTope(
  fuente: { body: ReadableStream<Uint8Array> | null },
  tope: number
): Promise<Buffer | "demasiado_grande" | null> {
  if (!fuente.body) return null;
  const lector = fuente.body.getReader();
  const partes: Buffer[] = [];
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await lector.read();
      if (done) break;
      total += value.byteLength;
      if (total > tope) {
        await lector.cancel();
        logger.error({
        detectado_en: "el cuerpo",
        tope_bytes: tope,
      }, "whatsapp.media.descartada_por_tamano");
        return "demasiado_grande";
      }
      partes.push(Buffer.from(value));
    }
  } catch {
    return null;
  }

  return Buffer.concat(partes);
}

/**
 * Lo que devuelve bajar un adjunto.
 *
 * `null` es «no se pudo», que ya existia. Lo nuevo es poder decir «no lo baje
 * PORQUE es demasiado grande», que no es lo mismo: uno es una falla nuestra y
 * el otro es algo que el asegurado mando y hay que contarle al analista.
 *
 * Antes los dos eran `null`, el que llama hacia `if (!file) continue`, y no
 * quedaba fila en `claim_attachments`: el asegurado mandaba la foto de los
 * daños, creia que la habia mandado, y en la pantalla el pedido de documento
 * seguia abierto sin ninguna explicacion.
 */
export type MediaDeWhatsApp =
  | { data: Buffer; mimeType: string }
  | { demasiadoGrande: true; bytes: number | null };

/**
 * Download one media file from the Graph API.
 *
 * Two calls: the id resolves to a short-lived URL on a Meta CDN, and that URL
 * needs the same bearer token — fetching it unauthenticated returns HTML, not
 * the file.
 *
 * Never throws, and no longer answers only null: it returns the bytes, or
 * `{ demasiadoGrande: true }` for a file over the storage cap, or null when the
 * download itself failed. The three are different things. A photo that fails to
 * download is a gap in the claim, not a reason to lose the message that carried
 * it; a file that is too big is something the claimant did send, and the caller
 * turns it into a rejected attachment the analyst can see.
 */
export async function downloadWhatsAppMedia(
  mediaId: string,
  cred: Pick<CredencialesMeta, "accessToken" | "prueba">
): Promise<MediaDeWhatsApp | null> {
  const { accessToken, prueba } = cred;

  try {
    const metaRes = await fetch(urlDeGraph(mediaId, prueba), {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(PLAZO_METADATA_MEDIA_MS),
    });
    if (!metaRes.ok) {
      logger.error({ detalle: metaRes.status }, "whatsapp.media_metadata_failed");
      return null;
    }

    const meta = (await metaRes.json()) as {
      url?: string;
      mime_type?: string;
      file_size?: number | string;
    };
    if (!meta.url) return null;
    const destino = urlDeMedia(meta.url);
    if (!destino || !esDeMedia(destino)) {
      // Sólo el host: la dirección entera lleva el identificador del adjunto de quien escribió.
      logger.error({ host: destino?.hostname ?? null }, "whatsapp.media_host_no_permitido");
      return null;
    }

    const mimeType = meta.mime_type || "application/octet-stream";

    /*
     * Mirar cuánto pesa ANTES de bajarlo.
     *
     * El tope de guardado son 10 MB y se aplicaba DESPUÉS de tener los bytes
     * en el proceso. La Cloud API acepta documentos de hasta 100 MB, el
     * número es público, y esto corre adentro del tiempo del webhook: un PDF
     * de 100 MB pasaba por el Buffer (100 MB), por el base64 que arma el
     * intake (~133 MB) y por el Buffer que rehost vuelve a decodificar (100
     * MB otra vez). Unos 330 MB de pico para un archivo que nunca se iba a
     * guardar, en una función de Vercel Hobby — y repetible a voluntad, sin
     * credencial, con sólo escribirle al número.
     *
     * La metadata que ya se pedía trae `file_size`; sólo no se leía. Con
     * esto el archivo grande ni siquiera abre la conexión con el CDN.
     *
     * El tope se importa de `attachment-validator` en vez de repetir el
     * número: si el de descarga y el de guardado se separan, o bajás bytes
     * que se van a rechazar o rechazás bytes que se iban a guardar.
     *
     * Y el rastro no se pierde. Frenar acá no puede significar que el archivo
     * nunca existió: el que lo mandó cree que lo mandó. El que se pasa del
     * tope vuelve como «demasiado grande» —no como `null`, que es «no se
     * pudo»—, el que llama lo convierte en un adjunto con `rechazoPrevio:
     * "size_exceeded"`, y `rehost-attachments` le escribe su fila sin bajarlo
     * ni decodificarlo. Eso es lo que le dice a un analista «mandaron algo y
     * no entró».
     */
    const declarado = Number(meta.file_size);
    if (Number.isFinite(declarado) && declarado > MAX_ATTACHMENT_SIZE_BYTES) {
      logger.error({
        detectado_en: "la metadata",
        bytes: declarado,
        tope_bytes: MAX_ATTACHMENT_SIZE_BYTES,
      }, "whatsapp.media.descartada_por_tamano");
      return { demasiadoGrande: true, bytes: declarado };
    }

    // Sin `prueba`: el CDN no es Graph.
    const fileRes = await pedirAlCdn(meta.url, accessToken);
    if (!fileRes) return null;
    if (!fileRes.ok) {
      logger.error({ detalle: fileRes.status }, "whatsapp.media_fetch_failed");
      return null;
    }

    const data = await leerHastaElTope(fileRes, MAX_ATTACHMENT_SIZE_BYTES);
    if (data === "demasiado_grande") {
      // Sin `bytes`: se corto a mitad de la descarga, asi que no sabemos cuanto
      // pesaba de verdad. Lo unico cierto es que pasaba el tope.
      return { demasiadoGrande: true, bytes: null };
    }
    if (!data) return null;

    return { data, mimeType };
  } catch (err) {
    const name = err instanceof Error ? err.name : "UnknownError";
    logger.error({ error_name: name }, "whatsapp.media_download_error");
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
      id?: string;
      changes?: Array<{
        value?: {
          messages?: CloudApiTextMessage[];
          contacts?: Array<{ profile?: { name?: string }; wa_id?: string }>;
          metadata?: { phone_number_id?: string };
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
      const toPhoneNumberId = value?.metadata?.phone_number_id;
      const toWabaId = typeof entry.id === "string" && entry.id ? entry.id : undefined;

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
        // Stickers y reacciones caen acá: se anota el tipo y no se contesta.
        if (!body && media.length === 0) {
          logger.info({ tipo: msg.type }, "whatsapp.mensaje_ignorado");
          continue;
        }
        out.push({
          from: msg.from,
          body,
          providerMessageId: msg.id,
          name: nameByWaId.get(msg.from),
          ...(media.length > 0 ? { media } : {}),
          ...(toPhoneNumberId ? { toPhoneNumberId } : {}),
          ...(toPhoneNumberId && toWabaId ? { toWabaId } : {}),
        });
      }
    }
  }

  return out;
}

/**
 * Lo que cambió en la cuenta de un cliente (la WABA), no en un mensaje: un
 * `account_update` (se desinstaló la app, se restringió la cuenta…), el veredicto de
 * Meta sobre la revisión de la cuenta (`account_review_update`, su `decision` va en
 * `evento`) o sobre el nombre del número (`nombreEstado`, ya en la escala de
 * `name_status`). Llegan por el mismo webhook y con la misma firma que los mensajes.
 *
 * Los campos de plantillas y de capacidades del negocio no se suscriben: si llegan
 * se parsean sólo para que quien atiende los anote y los ignore.
 *
 * `wabaId` es el de `waba_info` y, si falta, el `entry.id` (que en estos
 * eventos es la WABA). `hora` son los segundos de Meta, para descartar un
 * evento viejo que llega después de uno nuevo. Lo que no tiene una WABA con
 * forma de id de Graph se descarta: nada de lo que sigue la va a poder buscar.
 */
export interface EventoDeCuenta {
  campo:
    | "account_update"
    | "account_review_update"
    | "phone_number_name_update"
    | "business_capability_update"
    | "template_category_update"
    | "message_template_quality_update";
  wabaId: string;
  evento: string | null;
  phoneNumberId: string | null;
  nombreEstado: string | null;
  hora: number | null;
}

const CAMPOS_DE_CUENTA = new Set<string>([
  "account_update",
  "account_review_update",
  "phone_number_name_update",
  "business_capability_update",
  "template_category_update",
  "message_template_quality_update",
]);
// Dígitos nada más; el mismo criterio que ID_DE_GRAPH, que no se importa porque verificar-en-meta importa este módulo.
const ID_NUMERICO = /^\d{5,30}$/;

/** Un texto corto de Meta, tal cual: sirve para comparar y anotar, no para mostrar. */
function textoCorto(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 && v.length <= 64 ? v : null;
}

/**
 * El webhook del nombre habla de `decision` (APPROVED, REJECTED, DEFERRED) y el nodo del
 * número de `name_status` (APPROVED, DECLINED, PENDING_REVIEW…): lo que se guarda y lo que
 * lee la pantalla es la escala del nodo, así que se traduce acá. Lo que no se conoce no se guarda.
 */
const NOMBRE_SEGUN_DECISION: ReadonlyMap<string, string> = new Map([
  ["APPROVED", "APPROVED"],
  ["REJECTED", "DECLINED"],
  ["DEFERRED", "PENDING_REVIEW"],
  ["PENDING", "PENDING_REVIEW"],
]);

export function parseEventosDeCuenta(payload: unknown): EventoDeCuenta[] {
  const out: EventoDeCuenta[] = [];
  const root = payload as {
    object?: string;
    entry?: Array<{
      id?: unknown;
      time?: unknown;
      changes?: Array<{
        field?: unknown;
        value?: {
          event?: unknown;
          decision?: unknown;
          phone_number_id?: unknown;
          waba_info?: { waba_id?: unknown };
        };
      }>;
    }>;
  };
  if (root?.object !== "whatsapp_business_account" || !Array.isArray(root.entry)) return out;

  for (const entry of root.entry) {
    const hora = typeof entry?.time === "number" && Number.isFinite(entry.time) ? entry.time : null;
    for (const change of entry?.changes ?? []) {
      const campo = change?.field;
      if (typeof campo !== "string" || !CAMPOS_DE_CUENTA.has(campo)) continue;
      const value = change.value;
      const waba = [value?.waba_info?.waba_id, entry.id].find((v): v is string => typeof v === "string" && ID_NUMERICO.test(v));
      if (!waba) continue;
      const idDelNumero = value?.phone_number_id;
      // La `decision` de la revisión de la cuenta no es la del nombre: no se traduce a `name_status`.
      const esRevision = campo === "account_review_update";
      out.push({
        campo: campo as EventoDeCuenta["campo"],
        wabaId: waba,
        evento: textoCorto(esRevision ? value?.decision : value?.event),
        phoneNumberId: typeof idDelNumero === "string" && ID_NUMERICO.test(idDelNumero) ? idDelNumero : null,
        nombreEstado: esRevision ? null : (NOMBRE_SEGUN_DECISION.get(textoCorto(value?.decision) ?? "") ?? null),
        hora,
      });
    }
  }
  return out;
}

// ── Outbound (send a reply / acknowledgement) ────────────────────────────────

export interface SendResult {
  ok: boolean;
  messageId?: string;
  error?: string;
  /** El `error.code` que Graph contestó, si el cuerpo lo traía: dice si falla la cuenta del cliente (token, pago) y no el mensaje. */
  codigoMeta?: number;
}

/** El código de error de un cuerpo de Graph; null si no es JSON o no lo trae. */
function codigoDeGraph(cuerpo: string): number | null {
  try {
    const codigo = (JSON.parse(cuerpo) as { error?: { code?: unknown } } | null)?.error?.code;
    return typeof codigo === "number" && Number.isInteger(codigo) ? codigo : null;
  } catch {
    return null;
  }
}

/**
 * Un envío a la Cloud API, sea texto o plantilla: arma el sobre común
 * (`messaging_product`, `recipient_type`, `to`) y le agrega el contenido que
 * cada uno trae. Antes esto vivía sólo adentro de `sendWhatsAppText`;
 * `sendWhatsAppTemplate` necesita el mismo plazo, el mismo manejo de error y el
 * mismo `never throws`, no una segunda copia.
 *
 * Never throws — returns { ok:false, error } so callers can log and continue.
 */
async function enviarAMeta(
  to: string,
  contenido: Record<string, unknown>,
  cred: Pick<CredencialesMeta, "accessToken" | "phoneNumberId" | "prueba">
): Promise<SendResult> {
  const { accessToken, phoneNumberId, prueba } = cred;

  try {
    const res = await fetch(urlDeGraph(`${phoneNumberId}/messages`, prueba), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to,
        ...contenido,
      }),
      signal: AbortSignal.timeout(PLAZO_ENVIO_WHATSAPP_MS),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      const codigoMeta = codigoDeGraph(errText);
      return {
        ok: false,
        error: `Cloud API ${res.status}: ${errText.slice(0, 300)}`,
        ...(codigoMeta === null ? {} : { codigoMeta }),
      };
    }
    const data = (await res.json()) as { messages?: Array<{ id?: string }> };
    return { ok: true, messageId: data.messages?.[0]?.id };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "network error" };
  }
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
  cred: Pick<CredencialesMeta, "accessToken" | "phoneNumberId" | "prueba">
): Promise<SendResult> {
  return enviarAMeta(to, { type: "text", text: { preview_url: false, body: body.slice(0, 4096) } }, cred);
}

/** El `error` de `sendWhatsAppTemplate` cuando el tope de la prueba corta el envío antes de llegar a Meta. */
export const TOPE_DE_PLANTILLAS = "tope_de_plantillas";

const DIA_MS = 24 * 60 * 60_000;

/** Plantillas por día que puede mandar un espacio en prueba; 0 las corta del todo. */
export function topeDePlantillasDePrueba(): number {
  return topeEntero("ALTA_TOPE_PLANTILLAS_PRUEBA_DIA");
}

function cupoDePlantillas(vencida: boolean) {
  return { limit: vencida ? 0 : topeDePlantillasDePrueba(), windowMs: DIA_MS, fallaCerrada: true };
}

/**
 * Si a una prueba vigente todavía le entra una plantilla hoy, SIN gastarla: toma
 * un lugar y lo devuelve en el acto (el limitador no deja mirar sin contar). Es
 * para quien tiene que saberlo antes de escribir algo —reabrir un caso— y no
 * puede esperar a que `sendWhatsAppTemplate` diga que no. El que gasta es el
 * envío. Si el contador no contesta, no hay lugar: igual que al enviar.
 */
export async function quedaCupoDePlantilla(tenantId: string): Promise<boolean> {
  const clave = claveDeCupo("wa:plantilla", tenantId);
  const cupo = await rateLimit(clave, cupoDePlantillas(false));
  try {
    // También el intento rechazado: Postgres lo cuenta y no se libera solo.
    await liberarCupo(clave, DIA_MS, cupo.ventana);
  } catch {
    // Sin devolverlo se pierde un lugar del día, pero esto no puede tirar.
  }
  return cupo.allowed;
}

/**
 * Lo que `sendWhatsAppTemplate` necesita del número, además de con qué hablar:
 * de quién es y si cuenta contra el tope de la prueba. Lo arma
 * `credencialesWhatsApp`, sin otra consulta.
 */
export interface CredencialesDePlantilla extends Pick<CredencialesMeta, "accessToken" | "phoneNumberId" | "prueba"> {
  tenantId: string;
  enPrueba: boolean;
  vencida: boolean;
}

/**
 * Manda una plantilla aprobada por Meta — el único envío que sale fuera de la
 * ventana de 24 h. Los parámetros se colapsan a una sola línea: una plantilla
 * no admite el salto que puede traer, por ejemplo, la lista de campos que
 * faltan.
 *
 * Meta cobra cada plantilla desde la primera, también dentro de la ventana.
 * Desde el 1/10/2026 cobra además las respuestas libres, a la tarifa de
 * utility, pero cada número tiene 1.000 por mes sin cargo; las plantillas no,
 * así que una prueba tiene tope por día (`ALTA_TOPE_PLANTILLAS_PRUEBA_DIA`) y,
 * vencida, ninguna. El cupo se toma ANTES de llamar a Meta y con falla
 * cerrada: si el contador no contesta, la plantilla no sale. Quien ya paga, y
 * la plataforma, no cuentan.
 *
 * Never throws.
 */
export async function sendWhatsAppTemplate(
  to: string,
  nombre: string,
  idioma: string,
  parametros: string[],
  cred: CredencialesDePlantilla
): Promise<SendResult> {
  if (cred.enPrueba) {
    const cupo = await rateLimit(claveDeCupo("wa:plantilla", cred.tenantId), cupoDePlantillas(cred.vencida));
    if (!cupo.allowed) return { ok: false, error: TOPE_DE_PLANTILLAS };
  }

  return enviarAMeta(
    to,
    {
      type: "template",
      template: {
        name: nombre,
        language: { code: idioma },
        components: [
          {
            type: "body",
            parameters: parametros.map((p) => ({ type: "text", text: p.replace(/\s+/g, " ").trim() })),
          },
        ],
      },
    },
    cred
  );
}

/**
 * `no_disponible`: no hay cuenta configurada para preguntar, o Meta la rechazó
 * (4xx). `sin_respuesta`: Meta no contestó (5xx, 429 o plazo); pasajero, así
 * que quien decide no tiene que tratarlo como una ventana cerrada para siempre.
 */
export type EstadoDePlantilla = "aprobada" | "pendiente" | "no_disponible" | "sin_respuesta";

/** Cuánto dura cada estado en la caché antes de volver a preguntarle a Meta. */
const TTL_ESTADO_PLANTILLA_MS: Record<EstadoDePlantilla, number> = {
  aprobada: 60 * 60_000,
  pendiente: 10 * 60_000,
  no_disponible: 60_000,
  sin_respuesta: 60_000,
};

const PLAZO_ESTADO_PLANTILLA_MS = 3_000;

/**
 * Caché en memoria del estado de cada plantilla, clave `${wabaId}:${nombre}:${idioma}`
 * (las plantillas son por WABA). Sin esto, cada reenvío fuera de ventana le
 * preguntaría a Meta si la plantilla ya está aprobada — un fetch por cada caso
 * cerrado hace más de 24 h.
 */
const cacheDeEstadoDePlantilla = new Map<string, { valor: EstadoDePlantilla; vence: number }>();

/**
 * Si Meta ya aprobó la plantilla para reabrir un pedido después de las 24 h.
 *
 * Sin la WABA del número no hay a quién preguntarle: devuelve `no_disponible`
 * sin pedir nada y sin tocar la caché, que es el comportamiento de hoy
 * (ventana cerrada, sin plantilla).
 */
export async function estadoDePlantilla(
  nombre: string,
  idioma: string,
  cred: Pick<CredencialesMeta, "accessToken" | "wabaId" | "prueba">
): Promise<EstadoDePlantilla> {
  const { wabaId, accessToken, prueba } = cred;
  if (!wabaId) return "no_disponible";

  const clave = `${wabaId}:${nombre}:${idioma}`;
  const cacheado = cacheDeEstadoDePlantilla.get(clave);
  if (cacheado && cacheado.vence > Date.now()) return cacheado.valor;

  const conCache = (valor: EstadoDePlantilla): EstadoDePlantilla => {
    cacheDeEstadoDePlantilla.set(clave, { valor, vence: Date.now() + TTL_ESTADO_PLANTILLA_MS[valor] });
    return valor;
  };

  try {
    const url = urlDeGraph(`${wabaId}/message_templates?name=${encodeURIComponent(nombre)}&fields=name,status,language`, prueba);
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(PLAZO_ESTADO_PLANTILLA_MS),
    });
    // Un 4xx (token vencido, cuenta sin permiso) no se arregla solo: no se reintenta.
    if (!res.ok) return conCache(res.status === 429 || res.status >= 500 ? "sin_respuesta" : "no_disponible");

    const data = (await res.json()) as { data?: Array<{ name?: string; status?: string; language?: string }> };
    const fila = data.data?.find((f) => f.name === nombre && f.language === idioma);
    return conCache(fila?.status === "APPROVED" ? "aprobada" : "pendiente");
  } catch {
    return conCache("sin_respuesta");
  }
}

/** Limpia la caché de `estadoDePlantilla`: después de un envío fallido, o desde un test. */
export function olvidarEstadoDePlantilla(): void {
  cacheDeEstadoDePlantilla.clear();
}
