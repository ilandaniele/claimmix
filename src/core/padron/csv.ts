/**
 * Lector de CSV del padrón (B16), en el servidor y sin dependencias.
 *
 * Excel en castellano guarda con `;` y el resto con `,`, así que el separador
 * se decide por la primera línea. Entiende comillas, comillas duplicadas y
 * saltos de línea dentro de una celda, y le saca la marca BOM. No sabe nada de
 * columnas: eso es de `filas.ts`.
 *
 * Devuelve TODAS las filas, las vacías también, para que el número de fila de
 * un error sea el que la persona ve en su planilla.
 */

/** Filas de datos que acepta una importación: las cuentas de un lote de Neon. */
export const MAX_FILAS_DE_DATOS = 1000;
export const MAX_COLUMNAS = 20;

/** Peso máximo del archivo: 1000 filas de 12 columnas largas caben con holgura. */
export const MAX_BYTES_DEL_ARCHIVO = 512 * 1024;

export type ErrorDeCsv = "archivo_vacio" | "comilla_sin_cerrar" | "demasiadas_filas" | "demasiadas_columnas";

export type LecturaCsv = { ok: true; filas: string[][] } | { ok: false; error: ErrorDeCsv };

function detectarSeparador(texto: string): string {
  const cabecera = texto.split(/\r\n|\n|\r/, 1)[0] ?? "";
  let mejor = ",";
  let cuenta = 0;
  for (const candidato of [",", ";", "\t"]) {
    const n = cabecera.split(candidato).length - 1;
    if (n > cuenta) {
      mejor = candidato;
      cuenta = n;
    }
  }
  return mejor;
}

export function leerCsv(crudo: string): LecturaCsv {
  const texto = crudo.charCodeAt(0) === 0xfeff ? crudo.slice(1) : crudo;
  const separador = detectarSeparador(texto);
  const filas: string[][] = [];
  let fila: string[] = [];
  let celda = "";
  let entreComillas = false;
  let error: ErrorDeCsv | null = null;

  const cerrarFila = () => {
    fila.push(celda);
    celda = "";
    if (fila.length > MAX_COLUMNAS) error = "demasiadas_columnas";
    filas.push(fila);
    if (filas.length > MAX_FILAS_DE_DATOS + 1) error = "demasiadas_filas";
    fila = [];
  };

  for (let i = 0; i < texto.length && !error; i++) {
    const c = texto[i]!;
    if (entreComillas) {
      if (c !== '"') celda += c;
      else if (texto[i + 1] === '"') {
        celda += '"';
        i++;
      } else entreComillas = false;
    } else if (c === '"' && celda === "") {
      entreComillas = true;
    } else if (c === separador) {
      fila.push(celda);
      celda = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && texto[i + 1] === "\n") i++;
      cerrarFila();
    } else {
      celda += c;
    }
  }
  if (error) return { ok: false, error };
  if (entreComillas) return { ok: false, error: "comilla_sin_cerrar" };
  if (celda !== "" || fila.length > 0) cerrarFila();
  if (error) return { ok: false, error };
  if (filas.length < 2) return { ok: false, error: "archivo_vacio" };
  return { ok: true, filas };
}
