/**
 * Alta y edición a mano de un cliente y de una póliza (B16).
 *
 * Las mismas reglas por campo que la importación (`campos.ts`), así una persona
 * y una planilla no pueden dejar datos distintos. Los cuerpos son `strict`: un
 * `tenant_id` u otro campo de más es un error, no algo que se ignora.
 *
 * En el alta, vacío es «no vino». En la edición, vacío borra el dato (menos el
 * nombre, que no se puede dejar en blanco) y omitir el campo lo deja igual.
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
  anulable,
  campo,
  opcional,
} from "./campos";
import { ERRORES_DE_FILA } from "./filas";

/** Los rechazos que sólo existen fuera de la importación; el resto reusa los de fila. */
export const ERRORES_MANUALES = [
  "datos_invalidos",
  "cliente_invalido",
  "cliente_no_existe",
  "poliza_no_existe",
  "dni_existente",
  "poliza_existente",
  "sin_cambios",
  "vigencia_incompleta",
] as const;

const CODIGOS = new Set<string>([...ERRORES_DE_FILA, ...ERRORES_MANUALES]);

/** Un campo obligatorio: `faltante` si no viene o viene vacío, `invalido` si no sirve. */
const requerido = <T>(invalido: string, convertir: (s: string) => T | null, faltante = invalido) =>
  z
    .string({ required_error: faltante, invalid_type_error: invalido })
    .trim()
    .min(1, faltante)
    .pipe(campo(invalido, convertir));

const sinVigenciaInvertida = (d: { desde?: string | null; hasta?: string | null }) =>
  !d.desde || !d.hasta || d.desde <= d.hasta;

export const ClienteNuevoSchema = z
  .object({
    nombre: requerido("nombre_invalido", aNombre, "nombre_requerido"),
    dni: requerido("dni_invalido", aDni, "dni_requerido"),
    email: opcional(campo("email_invalido", aEmail)),
    telefono: opcional(campo("telefono_invalido", aTelefono)),
    nacimiento: opcional(campo("nacimiento_invalido", aNacimiento)),
    direccion: opcional(campo("direccion_invalida", aDireccion)),
  })
  .strict();

export const ClienteCambioSchema = z
  .object({
    nombre: opcional(campo("nombre_invalido", aNombre)),
    email: anulable(campo("email_invalido", aEmail)),
    telefono: anulable(campo("telefono_invalido", aTelefono)),
    nacimiento: anulable(campo("nacimiento_invalido", aNacimiento)),
    direccion: anulable(campo("direccion_invalida", aDireccion)),
  })
  .strict();

export const PolizaNuevaSchema = z
  .object({
    customer_id: z.string({ required_error: "cliente_invalido", invalid_type_error: "cliente_invalido" }).uuid("cliente_invalido"),
    numero: requerido("poliza_invalida", aNumeroPoliza),
    ramo: opcional(campo("ramo_invalido", aRamo)),
    estado: opcional(campo("estado_invalido", aEstado)),
    desde: opcional(campo("desde_invalido", aFecha)),
    hasta: opcional(campo("hasta_invalido", aFecha)),
    prima: opcional(campo("prima_invalida", aPrima)),
  })
  .strict()
  .refine(sinVigenciaInvertida, { message: "vigencia_invertida", path: ["hasta"] });

/**
 * La vigencia se manda entera o no se manda: con una sola fecha no hay forma de
 * saber, sin leer la póliza, si el rango queda invertido.
 */
export const PolizaCambioSchema = z
  .object({
    ramo: opcional(campo("ramo_invalido", aRamo)),
    estado: opcional(campo("estado_invalido", aEstado)),
    desde: anulable(campo("desde_invalido", aFecha)),
    hasta: anulable(campo("hasta_invalido", aFecha)),
    prima: anulable(campo("prima_invalida", aPrima)),
  })
  .strict()
  .refine((d) => (d.desde === undefined) === (d.hasta === undefined), {
    message: "vigencia_incompleta",
    path: ["hasta"],
  })
  .refine(sinVigenciaInvertida, { message: "vigencia_invertida", path: ["hasta"] });

/** Los códigos que un rechazo de zod trae, sin repetir; lo que no es un código es `datos_invalidos`. */
export function codigosDeRechazo(error: z.ZodError): string[] {
  const codigos = error.issues.map((i) => (CODIGOS.has(i.message) ? i.message : "datos_invalidos"));
  return [...new Set(codigos)];
}

/** Sólo lo que vino, para armar el `set` de un UPDATE. */
export function soloLoPresente<T extends Record<string, unknown>>(datos: T): Partial<T> {
  return Object.fromEntries(Object.entries(datos).filter(([, v]) => v !== undefined)) as Partial<T>;
}
