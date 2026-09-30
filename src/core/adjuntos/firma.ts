/**
 * Lo que dicen los bytes de un adjunto, sin creerle al content-type.
 *
 * El tipo lo declara quien manda el archivo. Antes de pasárselo al modelo se
 * comprueba que los primeros bytes sean los de ese formato: un ejecutable
 * rotulado `application/pdf` no llega a Vertex. También se mide lo que el
 * modelo va a tener que leer —páginas de un PDF, segundos de un audio— para
 * cortar antes de pagar por algo que no es una denuncia.
 *
 * Nada de acá lanza: un archivo roto devuelve `false` o `null`.
 */

import { inflateSync } from "node:zlib";
import { leerExif } from "@/core/imagen/exif";

export function normalizarMime(contentType: string): string {
  return contentType.toLowerCase().split(";")[0].trim();
}

/**
 * Los audios que entran, con nombre exacto. Nada de `audio/*`: AMR y 3GPP,
 * los de las llamadas, no los lee el modelo.
 */
export const AUDIO_PERMITIDO: ReadonlySet<string> = new Set([
  "audio/ogg",
  "audio/opus",
  "audio/mpeg",
  "audio/mp3",
  "audio/mp4",
  "audio/x-m4a",
  "audio/aac",
  "audio/wav",
  "audio/x-wav",
]);

const IMAGEN_AL_MODELO = new Set(["image/jpeg", "image/png", "image/webp"]);

export function esAudio(contentType: string): boolean {
  return AUDIO_PERMITIDO.has(normalizarMime(contentType));
}

/** Las fotos y PDF que el modelo mira: lo que no es audio de lo que va al modelo. */
export function seMira(contentType: string): boolean {
  const m = normalizarMime(contentType);
  return IMAGEN_AL_MODELO.has(m) || m === "application/pdf";
}

/** Los tipos que se le mandan al modelo, y por eso llevan la firma comprobada. */
export function vaAlModelo(contentType: string): boolean {
  return seMira(contentType) || esAudio(contentType);
}

function bytesEn(b: Uint8Array, desde: number, esperados: readonly number[]): boolean {
  if (b.length < desde + esperados.length) return false;
  return esperados.every((x, i) => b[desde + i] === x);
}

function textoEn(b: Uint8Array, desde: number, texto: string): boolean {
  return bytesEn(b, desde, [...texto].map((c) => c.charCodeAt(0)));
}

export function firmaCoincide(bytes: Uint8Array, contentType: string): boolean {
  const b = bytes;
  switch (normalizarMime(contentType)) {
    case "image/jpeg":
      return bytesEn(b, 0, [0xff, 0xd8, 0xff]);
    case "image/png":
      return bytesEn(b, 0, [0x89, 0x50, 0x4e, 0x47]);
    case "image/webp":
      return textoEn(b, 0, "RIFF") && textoEn(b, 8, "WEBP");
    case "application/pdf":
      return textoEn(b, 0, "%PDF-");
    case "audio/ogg":
    case "audio/opus":
      return textoEn(b, 0, "OggS");
    case "audio/mpeg":
    case "audio/mp3":
      return textoEn(b, 0, "ID3") || (b.length > 1 && b[0] === 0xff && (b[1] & 0xe0) === 0xe0);
    case "audio/mp4":
    case "audio/x-m4a":
      return textoEn(b, 4, "ftyp");
    case "audio/aac":
      // AAC viene en MP4 o suelto en ADTS, que arranca con la sincronía 0xFFF.
      return textoEn(b, 4, "ftyp") || (b.length > 1 && b[0] === 0xff && (b[1] & 0xf6) === 0xf0);
    case "audio/wav":
    case "audio/x-wav":
      return textoEn(b, 0, "RIFF") && textoEn(b, 8, "WAVE");
    default:
      return false;
  }
}

/** El tope de un adjunto; también hasta dónde se lee un PDF para contar páginas. */
export const MAX_ATTACHMENT_SIZE_BYTES = 10 * 1024 * 1024;

/** `/T#79pe` es `/Type`: un nombre escrito con escapes no esconde una página. */
function sinEscapes(texto: string): string {
  return texto.replace(/#([0-9A-Fa-f]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
}

const RE_PAGINA = /\/Type\s*\/Page(?![A-Za-z])/g;
/** Lo más que se descomprime de un PDF, contra una bomba de zlib. */
const MAX_INFLADO = 16 * 1024 * 1024;

function maxCount(texto: string): number {
  let n = 0;
  for (const [, c] of texto.matchAll(/\/Count\s+(\d{1,7})/g)) n = Math.max(n, Number(c));
  return n;
}

/**
 * Las páginas guardadas en streams de objetos (`/Type /ObjStm`), que es donde
 * las ponen los generadores modernos. `null` si alguno no se deja abrir: con
 * otro filtro, con predictor, roto o con el diccionario estirado más allá de
 * lo que se mira para atrás, puede tener adentro cualquier cantidad.
 */
function paginasEnStreams(
  crudo: string,
  texto: string,
  bytes: Uint8Array
): { paginas: number; cuenta: number } | null {
  let paginas = 0;
  let cuenta = 0;
  let inflado = 0;
  let abiertos = 0;
  const re = /(?<!end)stream\r?\n/g;
  for (let m = re.exec(crudo); m; m = re.exec(crudo)) {
    const previo = crudo.slice(Math.max(0, m.index - 4096), m.index);
    const dict = sinEscapes(previo.slice(previo.lastIndexOf("obj") + 1));
    if (!/\/Type\s*\/ObjStm\b/.test(dict)) continue;
    const fin = crudo.indexOf("endstream", re.lastIndex);
    const filtros = /\/Filter\s*(\[[^\]]*\]|\/\w+)/.exec(dict)?.[1].match(/\w+/g) ?? [];
    if (fin < 0 || filtros.join() !== "FlateDecode" || dict.includes("/DecodeParms")) return null;
    const abierto = sinEscapes(
      inflateSync(bytes.subarray(re.lastIndex, fin), { maxOutputLength: MAX_INFLADO - inflado }).toString("latin1")
    );
    inflado += abierto.length;
    abiertos++;
    paginas += abierto.match(RE_PAGINA)?.length ?? 0;
    cuenta = Math.max(cuenta, maxCount(abierto));
    re.lastIndex = fin;
  }
  const marcados = texto.match(/\/Type\s*\/ObjStm\b/g)?.length ?? 0;
  return abiertos < marcados ? null : { paginas, cuenta };
}

/**
 * Cuántas páginas tiene un PDF, o `null` si no se puede saber.
 *
 * Cuenta los objetos `/Type /Page` (no `/Pages`, que es el árbol), una vez por
 * número de objeto: una actualización incremental reescribe la página al final
 * del archivo con el mismo número, y no es otra página. Abre los streams de
 * objetos y se queda con lo más alto entre eso y el `/Count` del árbol: los dos
 * los escribe quien arma el archivo, y para achicar la cuenta tiene que mentir
 * en ambos. Un `null` no va al modelo.
 */
export function paginasPdf(bytes: Uint8Array): number | null {
  try {
    const crudo = new TextDecoder("latin1").decode(bytes.subarray(0, MAX_ATTACHMENT_SIZE_BYTES));
    const texto = sinEscapes(crudo);
    const objetos = new Set<string>();
    let sueltas = 0;
    let objeto: string | null = null;
    for (const [, numero] of texto.matchAll(/(\d{1,10})\s+\d{1,5}\s+obj\b|\/Type\s*\/Page(?![A-Za-z])/g)) {
      if (numero !== undefined) objeto = numero;
      else if (objeto !== null) objetos.add(objeto);
      else sueltas++;
    }
    const enStreams = paginasEnStreams(crudo, texto, bytes);
    if (enStreams === null) return null;
    const n = Math.max(objetos.size + sueltas + enStreams.paginas, maxCount(texto), enStreams.cuenta);
    return n > 0 ? n : null;
  } catch {
    return null;
  }
}

/** La página Ogg más larga posible: el último `OggS` está dentro de esto. */
const COLA_OGG = 65_307;

function duracionOgg(b: Uint8Array): number | null {
  // Sólo Opus: su granule siempre cuenta muestras a 48 kHz, sea cual sea la
  // frecuencia original. Vorbis tiene la suya y no vale la pena parsearla.
  const cabecera = new TextDecoder("latin1").decode(b.subarray(0, 64));
  if (!cabecera.includes("OpusHead")) return null;
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  for (let i = b.length - 27; i >= Math.max(0, b.length - COLA_OGG); i--) {
    if (!textoEn(b, i, "OggS")) continue;
    const bajo = v.getUint32(i + 6, true);
    const alto = v.getUint32(i + 10, true);
    if (alto === 0xffffffff) return null;
    return (alto * 2 ** 32 + bajo) / 48_000;
  }
  return null;
}

/** PCM, flotante o extensible: los que se miden por bytes sin decodificar. */
const WAV_SIN_COMPRIMIR = new Set([1, 3, 0xfffe]);

/**
 * El `byteRate` tiene que cuadrar con canales, frecuencia y bits: si no, uno
 * inflado achica la duración. Y se mide por los bytes que siguen al encabezado
 * de `data`, no por el tamaño que declara el chunk.
 */
function duracionWav(b: Uint8Array): number | null {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let byteRate = 0;
  let i = 12;
  // Un WAV tiene tres o cuatro chunks; el tope es contra uno armado para colgarnos.
  for (let vueltas = 0; vueltas < 32 && i + 8 <= b.length; vueltas++) {
    const tam = v.getUint32(i + 4, true);
    if (textoEn(b, i, "fmt ") && i + 24 <= b.length) {
      const canales = v.getUint16(i + 10, true);
      const frecuencia = v.getUint32(i + 12, true);
      const bits = v.getUint16(i + 22, true);
      byteRate = v.getUint32(i + 16, true);
      const cuadra =
        WAV_SIN_COMPRIMIR.has(v.getUint16(i + 8, true)) &&
        canales >= 1 &&
        canales <= 8 &&
        frecuencia >= 8000 &&
        frecuencia <= 192_000 &&
        bits >= 8 &&
        bits <= 32 &&
        bits % 8 === 0 &&
        byteRate === (canales * frecuencia * bits) / 8;
      if (!cuadra) return null;
    }
    if (textoEn(b, i, "data")) return byteRate > 0 ? (b.length - (i + 8)) / byteRate : null;
    i += 8 + tam + (tam % 2);
  }
  return null;
}

/** Los segundos de un audio, o `null` si el formato no deja medirlos. */
export function duracionSeg(bytes: Uint8Array, contentType: string): number | null {
  try {
    const m = normalizarMime(contentType);
    const s =
      (m === "audio/ogg" || m === "audio/opus") && textoEn(bytes, 0, "OggS")
        ? duracionOgg(bytes)
        : (m === "audio/wav" || m === "audio/x-wav") && firmaCoincide(bytes, m)
          ? duracionWav(bytes)
          : null;
    return s !== null && Number.isFinite(s) && s >= 0 ? Math.round(s * 10) / 10 : null;
  } catch {
    return null;
  }
}

/** Lo que medimos de un adjunto al recibirlo; va a `claim_attachments.metadatos`. */
export interface Metadatos {
  /** Los bytes son del tipo declarado: el archivo puede ir al modelo. */
  firma?: true;
  paginas?: number;
  segundos?: number;
  tomadaEn?: string;
  lat?: number;
  lon?: number;
  /** Las extracciones con este archivo que agotaron el plazo, y la última. */
  plazoAgotado?: { veces: number; en: string };
  /** Por qué no pasó `revisarAdjunto`: se guarda igual, pero no va al modelo. */
  descarte?: string;
  /** Cuándo una corrida tomó la lectura de la carta de este archivo (B24): mientras no venza, otra no la lee. */
  leyendoCarta?: string;
}

export const MAX_PAGINAS_PDF = 10;
export const MAX_SEGUNDOS_AUDIO = 120;
/**
 * Lo más que pesa un audio comprimido: dos minutos de Opus sobran. El granule
 * de un Ogg lo escribe quien manda el archivo, así que vale aunque se haya
 * medido; sólo un WAV, que se mide por sus bytes, queda afuera.
 */
export const MAX_BYTES_AUDIO = 2 * 1024 * 1024;

export type Revision = { ok: true; metadatos: Metadatos | null } | { ok: false; reason: string };

/**
 * El control de lo que va al modelo, al recibirlo. Lo que no va al modelo
 * (un .docx, un HEIC) pasa sin revisar: ya lo filtró la lista blanca.
 */
export function revisarAdjunto(bytes: Uint8Array, contentType: string): Revision {
  const m = normalizarMime(contentType);
  if (!vaAlModelo(m)) return { ok: true, metadatos: null };
  if (!firmaCoincide(bytes, m)) return { ok: false, reason: "content_mismatch" };

  const metadatos: Metadatos = { firma: true };
  if (m === "application/pdf") {
    const paginas = paginasPdf(bytes);
    if (paginas === null) return { ok: false, reason: "pages_unknown" };
    if (paginas > MAX_PAGINAS_PDF) return { ok: false, reason: "too_many_pages" };
    metadatos.paginas = paginas;
  } else if (AUDIO_PERMITIDO.has(m)) {
    const segundos = duracionSeg(bytes, m);
    const esWav = m === "audio/wav" || m === "audio/x-wav";
    const porBytes = !(esWav && segundos !== null) && bytes.length > MAX_BYTES_AUDIO;
    if (porBytes || (segundos !== null && segundos > MAX_SEGUNDOS_AUDIO)) return { ok: false, reason: "too_long" };
    if (segundos !== null) metadatos.segundos = segundos;
  } else if (m === "image/jpeg") {
    Object.assign(metadatos, leerExif(bytes));
  }
  return { ok: true, metadatos };
}
