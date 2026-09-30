/**
 * De un CSV a filas validadas del padrón (B16).
 *
 * Una fila por póliza. Cada fila trae al titular (por DNI) y, si tiene número
 * de póliza, la póliza: un cliente con tres pólizas ocupa tres filas con el
 * mismo DNI. Las columnas se reconocen por el encabezado, en castellano o en
 * inglés, sin importar el orden; las que sobran se ignoran.
 *
 * Una celda vacía nunca borra un dato: el padrón se completa, no se pisa.
 */

import { z } from "zod";

import {
  aDireccion,
  aDni,
  aEmail,
  aEstado,
  aFecha,
  aNacimiento,
  aNombre,
  aNumeroPoliza,
  aPrima,
  aRamo,
  aTelefono,
  campo,
  opcional,
  type EstadoDePoliza,
  type RamoDePoliza,
} from "./campos";
import { leerCsv } from "./csv";

export const ERRORES_DE_ARCHIVO = [
  "sin_archivo",
  "archivo_vacio",
  "archivo_no_admitido",
  "archivo_muy_grande",
  "comilla_sin_cerrar",
  "demasiadas_filas",
  "demasiadas_columnas",
  "falta_columna_dni",
  "cabecera_repetida",
  "cruce_de_importaciones",
] as const;
export type ErrorDeArchivo = (typeof ERRORES_DE_ARCHIVO)[number];

export const ERRORES_DE_FILA = [
  "fila_invalida",
  "dni_requerido",
  "dni_invalido",
  "nombre_invalido",
  "nombre_requerido",
  "email_invalido",
  "telefono_invalido",
  "nacimiento_invalido",
  "direccion_invalida",
  "poliza_invalida",
  "ramo_invalido",
  "estado_invalido",
  "desde_invalido",
  "hasta_invalido",
  "prima_invalida",
  "poliza_incompleta",
  "columnas_de_mas",
  "cliente_contradictorio",
  "poliza_repetida",
  "poliza_de_otro_titular",
  "vigencia_invertida",
] as const;
export type CodigoDeFila = (typeof ERRORES_DE_FILA)[number];

export interface ErrorDeFila {
  /** El número que la persona ve en su planilla: la cabecera es la 1. */
  fila: number;
  codigo: CodigoDeFila;
}

export interface FilaPadron {
  fila: number;
  dni: string;
  nombre?: string;
  email?: string;
  telefono?: string;
  nacimiento?: string;
  direccion?: string;
  poliza?: {
    numero: string;
    ramo?: RamoDePoliza;
    estado?: EstadoDePoliza;
    desde?: string;
    hasta?: string;
    prima?: string;
  };
}

const CAMPOS = [
  "dni",
  "nombre",
  "email",
  "telefono",
  "nacimiento",
  "direccion",
  "poliza",
  "ramo",
  "estado",
  "desde",
  "hasta",
  "prima",
] as const;
type Campo = (typeof CAMPOS)[number];

const ALIAS: Record<string, Campo> = {
  dni: "dni",
  documento: "dni",
  nombre: "nombre",
  "nombre completo": "nombre",
  "full name": "nombre",
  email: "email",
  mail: "email",
  correo: "email",
  telefono: "telefono",
  celular: "telefono",
  phone: "telefono",
  nacimiento: "nacimiento",
  "fecha de nacimiento": "nacimiento",
  "birth date": "nacimiento",
  direccion: "direccion",
  domicilio: "direccion",
  address: "direccion",
  poliza: "poliza",
  "numero de poliza": "poliza",
  "nro de poliza": "poliza",
  "policy number": "poliza",
  ramo: "ramo",
  tipo: "ramo",
  "policy type": "ramo",
  estado: "estado",
  status: "estado",
  desde: "desde",
  inicio: "desde",
  "start date": "desde",
  hasta: "hasta",
  vencimiento: "hasta",
  "end date": "hasta",
  prima: "prima",
  premium: "prima",
};

const cabecera = (s: string) =>
  s
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

const FilaSchema = z.object({
  dni: z.string().trim().min(1, "dni_requerido").pipe(campo("dni_invalido", aDni)),
  nombre: opcional(campo("nombre_invalido", aNombre)),
  email: opcional(campo("email_invalido", aEmail)),
  telefono: opcional(campo("telefono_invalido", aTelefono)),
  nacimiento: opcional(campo("nacimiento_invalido", aNacimiento)),
  direccion: opcional(campo("direccion_invalida", aDireccion)),
  poliza: opcional(campo("poliza_invalida", aNumeroPoliza)),
  ramo: opcional(campo("ramo_invalido", aRamo)),
  estado: opcional(campo("estado_invalido", aEstado)),
  desde: opcional(campo("desde_invalido", aFecha)),
  hasta: opcional(campo("hasta_invalido", aFecha)),
  prima: opcional(campo("prima_invalida", aPrima)),
});

const esCodigo = (m: string): m is CodigoDeFila => (ERRORES_DE_FILA as readonly string[]).includes(m);

export type LecturaPadron =
  | { ok: true; filas: FilaPadron[]; errores: ErrorDeFila[]; ignoradas: string[] }
  | { ok: false; error: ErrorDeArchivo };

export function leerPadron(texto: string): LecturaPadron {
  const csv = leerCsv(texto);
  if (!csv.ok) return { ok: false, error: csv.error };

  const [encabezado, ...datos] = csv.filas;
  const columna = new Map<Campo, number>();
  const ignoradas: string[] = [];
  for (const [i, nombre] of encabezado!.entries()) {
    const c = ALIAS[cabecera(nombre)];
    if (!c) {
      if (nombre.trim()) ignoradas.push(nombre.trim().slice(0, 40));
      continue;
    }
    if (columna.has(c)) return { ok: false, error: "cabecera_repetida" };
    columna.set(c, i);
  }
  if (!columna.has("dni")) return { ok: false, error: "falta_columna_dni" };

  const filas: FilaPadron[] = [];
  const errores: ErrorDeFila[] = [];
  for (const [i, celdas] of datos.entries()) {
    const fila = i + 2;
    if (celdas.every((c) => c.trim() === "")) continue;
    if (celdas.slice(encabezado!.length).some((c) => c.trim() !== "")) {
      errores.push({ fila, codigo: "columnas_de_mas" });
      continue;
    }
    const crudo = Object.fromEntries(CAMPOS.map((c) => [c, (celdas[columna.get(c) ?? -1] ?? "").trim()]));
    const leida = FilaSchema.safeParse(crudo);
    if (!leida.success) {
      const mensaje = leida.error.issues[0]?.message ?? "";
      errores.push({ fila, codigo: esCodigo(mensaje) ? mensaje : "fila_invalida" });
      continue;
    }
    const { poliza, ramo, estado, desde, hasta, prima, ...cliente } = leida.data;
    if (!poliza && (ramo || estado || desde || hasta || prima)) {
      errores.push({ fila, codigo: "poliza_incompleta" });
      continue;
    }
    filas.push({
      fila,
      ...cliente,
      ...(poliza ? { poliza: { numero: poliza, ramo, estado, desde, hasta, prima } } : {}),
    });
  }
  return { ok: true, filas, errores, ignoradas: ignoradas.slice(0, 10) };
}
