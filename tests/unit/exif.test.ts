import { describe, expect, it } from "vitest";

import { leerExif } from "@/core/imagen/exif";

interface Opciones {
  le?: boolean;
  fecha?: string;
  offset?: string;
  gps?: { lat: [number, number, number]; latRef: string; lon: [number, number, number]; lonRef: string };
  /** El puntero al IFD Exif apunta al IFD0: un ciclo. */
  ciclo?: boolean;
}

/** Un JPEG mínimo con un APP1 Exif armado a mano: nada de fotos reales. */
function jpegConExif(o: Opciones = {}): Uint8Array {
  const le = o.le ?? true;
  const t = new Uint8Array(256);
  const v = new DataView(t.buffer);
  const u16 = (at: number, x: number) => v.setUint16(at, x, le);
  const u32 = (at: number, x: number) => v.setUint32(at, x, le);
  const str = (at: number, s: string) => [...s].forEach((c, i) => (t[at + i] = c.charCodeAt(0)));
  const entrada = (at: number, tag: number, tipo: number, cuenta: number, valor: number) => {
    u16(at, tag);
    u16(at + 2, tipo);
    u32(at + 4, cuenta);
    u32(at + 8, valor);
  };

  str(0, le ? "II" : "MM");
  u16(2, 42);
  u32(4, 8);
  u16(8, 2);
  entrada(10, 0x8769, 4, 1, o.ciclo ? 8 : 38);
  entrada(22, 0x8825, 4, 1, 96);

  u16(38, 2);
  entrada(40, 0x9003, 2, 20, 68);
  entrada(52, 0x9011, 2, 7, 88);
  str(68, o.fecha ?? "2026:09:20 14:30:00");
  if (o.offset) str(88, o.offset);

  if (o.gps) {
    u16(96, 4);
    entrada(98, 1, 2, 2, 0);
    str(106, o.gps.latRef);
    entrada(110, 2, 5, 3, 150);
    entrada(122, 3, 2, 2, 0);
    str(130, o.gps.lonRef);
    entrada(134, 4, 5, 3, 174);
    o.gps.lat.forEach((x, i) => (u32(150 + i * 8, x), u32(154 + i * 8, 1)));
    o.gps.lon.forEach((x, i) => (u32(174 + i * 8, x), u32(178 + i * 8, 1)));
  }

  const app1 = new Uint8Array(4 + 6 + t.length);
  app1.set([0xff, 0xe1, ((app1.length - 2) >> 8) & 0xff, (app1.length - 2) & 0xff]);
  app1.set([0x45, 0x78, 0x69, 0x66, 0, 0], 4);
  app1.set(t, 10);
  return Uint8Array.from([0xff, 0xd8, ...app1, 0xff, 0xda, 0, 2, 0xff, 0xd9]);
}

const BAHIA = {
  lat: [38, 43, 8] as [number, number, number],
  latRef: "S",
  lon: [62, 16, 8] as [number, number, number],
  lonRef: "W",
};

describe("leerExif", () => {
  it("lee la fecha de captura y, sin offset, la toma como hora argentina", () => {
    expect(leerExif(jpegConExif())).toEqual({ tomadaEn: "2026-09-20T17:30:00.000Z" });
  });

  it("respeta OffsetTimeOriginal cuando está", () => {
    expect(leerExif(jpegConExif({ offset: "+02:00" })).tomadaEn).toBe("2026-09-20T12:30:00.000Z");
  });

  it("lee el GPS con signo por hemisferio y cuatro decimales, en los dos órdenes de bytes", () => {
    for (const le of [true, false]) {
      const exif = leerExif(jpegConExif({ le, gps: BAHIA }));
      expect(exif.lat).toBe(-38.7189);
      expect(exif.lon).toBe(-62.2689);
    }
  });

  it("descarta un GPS en 0,0 o con una referencia inválida", () => {
    expect(leerExif(jpegConExif({ gps: { ...BAHIA, lat: [0, 0, 0], lon: [0, 0, 0] } })).lat).toBeUndefined();
    expect(leerExif(jpegConExif({ gps: { ...BAHIA, latRef: "X" } })).lat).toBeUndefined();
  });

  it("descarta una fecha mal formada", () => {
    expect(leerExif(jpegConExif({ fecha: "ayer a la tarde    " })).tomadaEn).toBeUndefined();
  });

  it("no se cuelga con un puntero circular", () => {
    expect(leerExif(jpegConExif({ ciclo: true }))).toEqual({});
  });

  it("devuelve {} para lo que no es un JPEG con EXIF, sin lanzar", () => {
    expect(leerExif(new Uint8Array())).toEqual({});
    expect(leerExif(Uint8Array.from([0x89, 0x50, 0x4e, 0x47]))).toEqual({});
    expect(leerExif(Uint8Array.from([0xff, 0xd8, 0xff, 0xda, 0, 2]))).toEqual({});
    const truncado = jpegConExif({ gps: BAHIA }).subarray(0, 60);
    expect(() => leerExif(truncado)).not.toThrow();
  });
});
