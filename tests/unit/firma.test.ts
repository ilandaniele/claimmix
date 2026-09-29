import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";

import {
  duracionSeg,
  esAudio,
  firmaCoincide,
  MAX_BYTES_AUDIO,
  normalizarMime,
  paginasPdf,
  revisarAdjunto,
  seMira,
  vaAlModelo,
} from "@/core/adjuntos/firma";

const ascii = (s: string) => Uint8Array.from([...s].map((c) => c.charCodeAt(0)));
const con = (...partes: (Uint8Array | number[])[]) =>
  Uint8Array.from(partes.flatMap((p) => [...p]));

function paginaOgg(granule: bigint, cuerpo = ""): Uint8Array {
  const b = new Uint8Array(27 + cuerpo.length);
  b.set(ascii("OggS"), 0);
  new DataView(b.buffer).setBigUint64(6, granule, true);
  b.set(ascii(cuerpo), 27);
  return b;
}

/** PCM mono de 16 bits a 8 kHz: 16.000 bytes por segundo. */
function wav(segundos: number): Uint8Array {
  const datos = segundos * 16_000;
  const b = new Uint8Array(44 + datos);
  const v = new DataView(b.buffer);
  b.set(ascii("RIFF"), 0);
  v.setUint32(4, 36 + datos, true);
  b.set(ascii("WAVEfmt "), 8);
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, 8000, true);
  v.setUint32(28, 16_000, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  b.set(ascii("data"), 36);
  v.setUint32(40, datos, true);
  return b;
}

function pdfConObjStm(filtro: string, cuerpo: Uint8Array): Uint8Array {
  return con(
    ascii(`%PDF-1.7\n5 0 obj <</Type /ObjStm /N 12 /Filter ${filtro} /Length ${cuerpo.length}>>stream\n`),
    cuerpo,
    ascii("\nendstream\nendobj\n1 0 obj <</Type /Pages /Count 1>>\n")
  );
}

describe("normalizarMime", () => {
  it("baja a minúsculas y saca los parámetros", () => {
    expect(normalizarMime("Audio/OGG; codecs=opus")).toBe("audio/ogg");
  });
});

describe("esAudio / vaAlModelo", () => {
  it("sólo la lista exacta de audios, sin AMR ni 3GPP", () => {
    expect(esAudio("audio/ogg; codecs=opus")).toBe(true);
    expect(esAudio("audio/amr")).toBe(false);
    expect(esAudio("audio/3gpp")).toBe(false);
  });

  it("al modelo van las fotos, los PDF y los audios; no un .docx", () => {
    expect(vaAlModelo("image/jpeg")).toBe(true);
    expect(vaAlModelo("application/pdf")).toBe(true);
    expect(vaAlModelo("audio/mpeg")).toBe(true);
    expect(vaAlModelo("image/heic")).toBe(false);
    expect(vaAlModelo("application/msword")).toBe(false);
  });

  it("se miran las fotos y los PDF aunque el tipo traiga parámetros; los audios no", () => {
    expect(seMira("Application/PDF; name=parte.pdf")).toBe(true);
    expect(seMira("image/png")).toBe(true);
    expect(seMira("audio/ogg")).toBe(false);
  });
});

describe("firmaCoincide", () => {
  it.each([
    ["image/jpeg", con([0xff, 0xd8, 0xff, 0xe0])],
    ["image/png", con([0x89, 0x50, 0x4e, 0x47, 0x0d])],
    ["image/webp", con(ascii("RIFF"), [0, 0, 0, 0], ascii("WEBPVP8 "))],
    ["application/pdf", ascii("%PDF-1.4\n")],
    ["audio/ogg", ascii("OggS\0")],
    ["audio/opus", ascii("OggS\0")],
    ["audio/mpeg", ascii("ID3\x04")],
    ["audio/mp3", con([0xff, 0xfb, 0x90])],
    ["audio/mp4", con([0, 0, 0, 0x20], ascii("ftypM4A "))],
    ["audio/x-m4a", con([0, 0, 0, 0x20], ascii("ftypM4A "))],
    ["audio/aac", con([0, 0, 0, 0x20], ascii("ftypM4A "))],
    ["audio/aac", con([0xff, 0xf1, 0x50, 0x80])],
    ["audio/aac", con([0xff, 0xf9, 0x50, 0x80])],
    ["audio/wav", con(ascii("RIFF"), [0, 0, 0, 0], ascii("WAVE"))],
    ["audio/x-wav", con(ascii("RIFF"), [0, 0, 0, 0], ascii("WAVE"))],
  ])("reconoce %s", (tipo, bytes) => {
    expect(firmaCoincide(bytes, tipo)).toBe(true);
  });

  it("rechaza un ejecutable rotulado como PDF o como foto", () => {
    const exe = ascii("MZ\x90\0\x03");
    expect(firmaCoincide(exe, "application/pdf")).toBe(false);
    expect(firmaCoincide(exe, "image/jpeg")).toBe(false);
    expect(firmaCoincide(exe, "audio/ogg")).toBe(false);
  });

  it("un ADTS no pasa por M4A ni un MP3 por AAC", () => {
    expect(firmaCoincide(con([0xff, 0xf1, 0x50, 0x80]), "audio/mp4")).toBe(false);
    expect(firmaCoincide(con([0xff, 0xfb, 0x90]), "audio/aac")).toBe(false);
  });

  it("no confunde un WAV con un WebP, que también empiezan con RIFF", () => {
    const w = con(ascii("RIFF"), [0, 0, 0, 0], ascii("WAVE"));
    expect(firmaCoincide(w, "image/webp")).toBe(false);
  });

  it("no lanza con un archivo vacío ni con un tipo desconocido", () => {
    expect(firmaCoincide(new Uint8Array(), "image/jpeg")).toBe(false);
    expect(firmaCoincide(ascii("hola"), "text/plain")).toBe(false);
  });
});

describe("paginasPdf", () => {
  it("cuenta /Type /Page y no el árbol /Pages", () => {
    const pdf = ascii(
      "%PDF-1.4\n1 0 obj <</Type /Pages /Count 2>>\n2 0 obj <</Type /Page>>\n3 0 obj <</Type/Page /Parent 1 0 R>>\n"
    );
    expect(paginasPdf(pdf)).toBe(2);
  });

  it("una actualización incremental reescribe la página: no la cuenta dos veces", () => {
    const pdf = ascii(
      "%PDF-1.4\n3 0 obj <</Type /Page>> endobj\n4 0 obj <</Type /Page>> endobj\n%%EOF\n" +
        "3 0 obj <</Type /Page /Rotate 90>> endobj\n%%EOF\n"
    );
    expect(paginasPdf(pdf)).toBe(2);
  });

  it("da null si no encuentra ninguna, como en un PDF con objetos comprimidos", () => {
    expect(paginasPdf(ascii("%PDF-1.7\n<</Type /ObjStm>>stream..."))).toBeNull();
  });

  it("abre los streams de objetos y cuenta las páginas que esconden", () => {
    const paginas = deflateSync(Buffer.from("<</Type /Page>> ".repeat(12)));
    expect(paginasPdf(pdfConObjStm("/FlateDecode", paginas))).toBe(12);
  });

  it("da null si el diccionario de un stream de objetos se estira para que no lo vea", () => {
    const paginas = deflateSync(Buffer.from("<</Type /Page>> ".repeat(12)));
    expect(paginasPdf(pdfConObjStm(" ".repeat(5000) + "/FlateDecode", paginas))).toBeNull();
  });

  it("da null si un stream de objetos viene con un filtro que no abre", () => {
    expect(paginasPdf(pdfConObjStm("/LZWDecode", ascii("<</Type /Page>>")))).toBeNull();
  });

  it("lee los nombres escritos con escapes", () => {
    expect(paginasPdf(ascii("%PDF-1.4\n2 0 obj <</T#79pe /Page>>\n3 0 obj <</Type /P#61ge>>\n"))).toBe(2);
  });

  it("se queda con el /Count más alto si dice más que las páginas sueltas", () => {
    expect(paginasPdf(ascii("%PDF-1.4\n1 0 obj <</Type /Pages /Count 40>>\n2 0 obj <</Type /Page>>\n"))).toBe(40);
  });
});

describe("duracionSeg", () => {
  it("mide un Opus por el granule de la última página, a 48 kHz", () => {
    const ogg = con(paginaOgg(BigInt(0), "OpusHead"), paginaOgg(BigInt(48_000 * 12)));
    expect(duracionSeg(ogg, "audio/ogg; codecs=opus")).toBe(12);
  });

  it("no inventa la duración de un Ogg que no es Opus", () => {
    const vorbis = con(paginaOgg(BigInt(0), "\x01vorbis"), paginaOgg(BigInt(44_100 * 5)));
    expect(duracionSeg(vorbis, "audio/ogg")).toBeNull();
  });

  it("mide un WAV por los bytes que siguen a los datos y el byteRate", () => {
    expect(duracionSeg(wav(3), "audio/wav")).toBe(3);
  });

  it("no le cree al tamaño que declara el chunk de datos", () => {
    const w = wav(3);
    new DataView(w.buffer).setUint32(40, 1, true);
    expect(duracionSeg(w, "audio/wav")).toBe(3);
  });

  it("da null si el byteRate no cuadra con canales, frecuencia y bits", () => {
    const w = wav(3);
    new DataView(w.buffer).setUint32(28, 16_000_000, true);
    expect(duracionSeg(w, "audio/wav")).toBeNull();
  });

  it("da null para lo que no sabe medir, sin lanzar", () => {
    expect(duracionSeg(ascii("ID3\x04"), "audio/mpeg")).toBeNull();
    expect(duracionSeg(ascii("OggS"), "audio/ogg")).toBeNull();
    expect(duracionSeg(con(ascii("RIFF"), [0, 0, 0, 0], ascii("WAVE")), "audio/wav")).toBeNull();
  });
});

describe("revisarAdjunto", () => {
  it("no manda al modelo un PDF del que no sabe cuantas paginas tiene", () => {
    expect(revisarAdjunto(ascii("%PDF-1.4\n"), "application/pdf")).toEqual({ ok: false, reason: "pages_unknown" });
  });

  it("corta un Opus pesado aunque su granule diga que dura poco", () => {
    const ogg = con(paginaOgg(BigInt(0), "OpusHead"), new Uint8Array(MAX_BYTES_AUDIO), paginaOgg(BigInt(48_000 * 10)));
    expect(revisarAdjunto(ogg, "audio/ogg")).toEqual({ ok: false, reason: "too_long" });
  });

  it("un WAV se mide por sus bytes, sin tope de peso aparte", () => {
    expect(revisarAdjunto(wav(100), "audio/wav")).toEqual({ ok: true, metadatos: { firma: true, segundos: 100 } });
  });
});
