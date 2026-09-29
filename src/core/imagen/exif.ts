/**
 * La fecha y el lugar donde se sacó una foto, leídos del EXIF del JPEG.
 *
 * Parser propio y mínimo: sólo el camino APP1 → TIFF → IFD0 → Exif (fecha) y
 * GPS. No depende de nada y no lanza: una foto sin EXIF, recortada o armada
 * para colgarnos devuelve `{}`. Cada lectura se chequea contra el largo, y
 * cada IFD se visita una sola vez, así un puntero circular no da vueltas.
 *
 * WhatsApp saca el EXIF al recomprimir; esto sirve para las fotos que llegan
 * por mail como archivo.
 */

export interface Exif {
  /** ISO en UTC. */
  tomadaEn?: string;
  lat?: number;
  lon?: number;
}

/** Sin `OffsetTimeOriginal` la hora es la del lugar: se asume Argentina. */
const OFFSET_POR_DEFECTO = "-03:00";
const MAX_ENTRADAS = 256;
const MAX_SEGMENTOS = 64;

const TAG_EXIF = 0x8769;
const TAG_GPS = 0x8825;
const TAG_FECHA = 0x9003;
const TAG_OFFSET = 0x9011;

interface Entrada {
  tipo: number;
  cuenta: number;
  /** Donde está el valor, relativo al comienzo del TIFF. */
  valor: number;
}

class Tiff {
  constructor(
    private readonly v: DataView,
    private readonly le: boolean
  ) {}

  cabe(o: number, n: number): boolean {
    return o >= 0 && n >= 0 && o + n <= this.v.byteLength;
  }
  u16(o: number): number {
    return this.v.getUint16(o, this.le);
  }
  u32(o: number): number {
    return this.v.getUint32(o, this.le);
  }

  ifd(offset: number, visitados: Set<number>): Map<number, Entrada> {
    const tags = new Map<number, Entrada>();
    if (visitados.has(offset) || !this.cabe(offset, 2)) return tags;
    visitados.add(offset);
    const n = Math.min(this.u16(offset), MAX_ENTRADAS);
    for (let i = 0; i < n; i++) {
      const e = offset + 2 + i * 12;
      if (!this.cabe(e, 12)) break;
      const tipo = this.u16(e + 2);
      const cuenta = this.u32(e + 4);
      const tam = (tipo === 5 ? 8 : tipo === 3 ? 2 : tipo === 4 ? 4 : 1) * cuenta;
      tags.set(this.u16(e), { tipo, cuenta, valor: tam <= 4 ? e + 8 : this.u32(e + 8) });
    }
    return tags;
  }

  texto(e: Entrada | undefined): string | undefined {
    if (!e || e.tipo !== 2 || !this.cabe(e.valor, e.cuenta) || e.cuenta > 64) return undefined;
    let s = "";
    for (let i = 0; i < e.cuenta; i++) {
      const c = this.v.getUint8(e.valor + i);
      if (c === 0) break;
      s += String.fromCharCode(c);
    }
    return s;
  }

  puntero(e: Entrada | undefined): number | undefined {
    return e && (e.tipo === 4 || e.tipo === 13) && this.cabe(e.valor, 4) ? this.u32(e.valor) : undefined;
  }

  /** Grados, minutos y segundos en tres RATIONAL. */
  grados(e: Entrada | undefined): number | undefined {
    if (!e || e.tipo !== 5 || e.cuenta !== 3 || !this.cabe(e.valor, 24)) return undefined;
    let total = 0;
    for (let i = 0; i < 3; i++) {
      const den = this.u32(e.valor + i * 8 + 4);
      if (den === 0) return undefined;
      total += this.u32(e.valor + i * 8) / den / 60 ** i;
    }
    return total;
  }
}

function tiffDelJpeg(b: Uint8Array): DataView | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  for (let s = 0; s < MAX_SEGMENTOS && i + 4 <= b.length; s++) {
    if (b[i] !== 0xff) return null;
    const marca = b[i + 1];
    if (marca === 0xda || marca === 0xd9) return null;
    const largo = (b[i + 2] << 8) | b[i + 3];
    if (largo < 2) return null;
    const esExif =
      marca === 0xe1 &&
      i + 10 <= b.length &&
      String.fromCharCode(...b.subarray(i + 4, i + 8)) === "Exif" &&
      b[i + 8] === 0 &&
      b[i + 9] === 0;
    if (esExif) {
      const fin = Math.min(i + 2 + largo, b.length);
      return new DataView(b.buffer, b.byteOffset + i + 10, Math.max(0, fin - (i + 10)));
    }
    i += 2 + largo;
  }
  return null;
}

function fechaIso(fecha: string | undefined, offset: string | undefined): string | undefined {
  const m = fecha?.match(/^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})$/);
  if (!m) return undefined;
  const off = offset && /^[+-]\d{2}:\d{2}$/.test(offset) ? offset : OFFSET_POR_DEFECTO;
  const d = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${off}`);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

const cuatroDecimales = (n: number) => Math.round(n * 10_000) / 10_000;

export function leerExif(bytes: Uint8Array): Exif {
  try {
    const v = tiffDelJpeg(bytes);
    if (!v || v.byteLength < 8) return {};
    const orden = v.getUint16(0);
    if (orden !== 0x4949 && orden !== 0x4d4d) return {};
    const t = new Tiff(v, orden === 0x4949);
    if (t.u16(2) !== 42) return {};

    const visitados = new Set<number>();
    const ifd0 = t.ifd(t.u32(4), visitados);
    const out: Exif = {};

    const pExif = t.puntero(ifd0.get(TAG_EXIF));
    if (pExif !== undefined) {
      const exif = t.ifd(pExif, visitados);
      const tomadaEn = fechaIso(t.texto(exif.get(TAG_FECHA)), t.texto(exif.get(TAG_OFFSET)));
      if (tomadaEn) out.tomadaEn = tomadaEn;
    }

    const pGps = t.puntero(ifd0.get(TAG_GPS));
    if (pGps !== undefined) {
      const gps = t.ifd(pGps, visitados);
      const lat = t.grados(gps.get(2));
      const lon = t.grados(gps.get(4));
      const latRef = t.texto(gps.get(1));
      const lonRef = t.texto(gps.get(3));
      const ok =
        lat !== undefined &&
        lon !== undefined &&
        lat <= 90 &&
        lon <= 180 &&
        (lat !== 0 || lon !== 0) &&
        (latRef === "N" || latRef === "S") &&
        (lonRef === "E" || lonRef === "W");
      if (ok) {
        out.lat = cuatroDecimales(latRef === "S" ? -lat : lat);
        out.lon = cuatroDecimales(lonRef === "W" ? -lon : lon);
      }
    }
    return out;
  } catch {
    return {};
  }
}
