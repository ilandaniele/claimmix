import { describe, expect, it } from "vitest";

import {
  duracionSeg,
  esAudio,
  firmaCoincide,
  normalizarMime,
  paginasPdf,
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

function wav(segundos: number, byteRate = 16_000): Uint8Array {
  const datos = segundos * byteRate;
  const b = new Uint8Array(44 + datos);
  const v = new DataView(b.buffer);
  b.set(ascii("RIFF"), 0);
  v.setUint32(4, 36 + datos, true);
  b.set(ascii("WAVEfmt "), 8);
  v.setUint32(16, 16, true);
  v.setUint32(28, byteRate, true);
  b.set(ascii("data"), 36);
  v.setUint32(40, datos, true);
  return b;
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

  it("mide un WAV por el tamaño de los datos y el byteRate", () => {
    expect(duracionSeg(wav(3), "audio/wav")).toBe(3);
  });

  it("da null para lo que no sabe medir, sin lanzar", () => {
    expect(duracionSeg(ascii("ID3\x04"), "audio/mpeg")).toBeNull();
    expect(duracionSeg(ascii("OggS"), "audio/ogg")).toBeNull();
    expect(duracionSeg(con(ascii("RIFF"), [0, 0, 0, 0], ascii("WAVE")), "audio/wav")).toBeNull();
  });
});
