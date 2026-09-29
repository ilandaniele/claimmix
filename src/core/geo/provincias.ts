/**
 * Rectángulos aproximados de cada provincia, para una sola pregunta: ¿esta
 * coordenada puede ser de acá?
 *
 * Un rectángulo contiene pedazos de las vecinas, así que un punto adentro no
 * prueba nada; un punto afuera, con margen, sí dice que la foto no es de esa
 * provincia. Se usa sólo para marcar, y ante la duda no se marca. Sin
 * geocodificación: no hay servicio al que mandarle la ubicación de nadie.
 */

type Caja = readonly [latMin: number, latMax: number, lonMin: number, lonMax: number];

const ARGENTINA: Caja = [-55.2, -21.7, -73.6, -53.5];
const BUENOS_AIRES: Caja = [-41.1, -33.2, -63.4, -56.6];

const CAJAS: Record<string, Caja> = {
  "buenos aires": BUENOS_AIRES,
  // Capital y provincia se confunden al hablar: se mide contra la provincia entera.
  caba: BUENOS_AIRES,
  "capital federal": BUENOS_AIRES,
  "ciudad de buenos aires": BUENOS_AIRES,
  "ciudad autonoma de buenos aires": BUENOS_AIRES,
  catamarca: [-30.1, -25.1, -69.1, -64.9],
  chaco: [-28.0, -24.0, -63.4, -58.3],
  chubut: [-46.0, -42.0, -72.2, -63.6],
  cordoba: [-35.0, -29.5, -65.8, -61.7],
  corrientes: [-30.8, -27.2, -59.7, -55.6],
  "entre rios": [-34.1, -30.1, -60.8, -57.8],
  formosa: [-27.0, -22.2, -62.4, -57.5],
  jujuy: [-24.6, -21.7, -67.2, -64.1],
  "la pampa": [-39.3, -35.0, -68.3, -63.4],
  "la rioja": [-32.0, -27.7, -69.7, -65.4],
  mendoza: [-37.6, -32.0, -70.6, -66.5],
  misiones: [-28.2, -25.5, -56.1, -53.6],
  neuquen: [-41.1, -36.1, -72.0, -68.0],
  "rio negro": [-42.0, -37.5, -72.0, -62.8],
  salta: [-26.4, -22.0, -68.6, -62.3],
  "san juan": [-32.6, -28.4, -70.6, -66.7],
  "san luis": [-36.0, -31.8, -67.5, -64.9],
  "santa cruz": [-52.4, -46.0, -73.6, -65.7],
  "santa fe": [-34.4, -28.0, -62.9, -58.8],
  "santiago del estero": [-30.5, -25.6, -65.2, -61.6],
  "tierra del fuego": [-55.2, -52.6, -68.7, -63.7],
  tucuman: [-28.0, -26.0, -66.2, -64.5],
};

/** Unas diez cuadras de GPS impreciso y bordes redondeados. */
const MARGEN = 0.1;

function clave(nombre: string): string {
  return nombre
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/^provincia de\s+/, "")
    .replace(/[^a-z ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function adentro([latMin, latMax, lonMin, lonMax]: Caja, lat: number, lon: number): boolean {
  return (
    lat >= latMin - MARGEN && lat <= latMax + MARGEN && lon >= lonMin - MARGEN && lon <= lonMax + MARGEN
  );
}

/**
 * `false` sólo cuando la coordenada seguro no es de ahí: afuera de la
 * Argentina, o afuera del rectángulo de la provincia nombrada. Una provincia
 * que no se reconoce no marca nada.
 */
export function puedeSerDe(lat: number, lon: number, provincia: string | null): boolean {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return true;
  if (!adentro(ARGENTINA, lat, lon)) return false;
  const caja = provincia ? CAJAS[clave(provincia)] : undefined;
  return caja ? adentro(caja, lat, lon) : true;
}
