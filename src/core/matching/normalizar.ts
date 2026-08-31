/**
 * Cómo escribe la gente los datos que usamos para encontrarla en el padrón.
 *
 * Un DNI se escribe `27.654.321`, `27654321` y `DNI 27 654 321`. Una póliza,
 * `POL-8812-R`, `pol 8812 r` y `POL8812R`. Un teléfono, `+54 9 291 555-0000` y
 * `5492915550000`. Son la misma persona y el mismo contrato.
 *
 * Esto ya estaba sabido: las herramientas del agente normalizan antes de buscar,
 * y hay un comentario en `agent-tools.ts` que enumera las tres formas del DNI.
 * Lo que no estaba es que los BUSCADORES lo hicieran. `matchByDni` comparaba con
 * `eq(c.dni, dni)` —igualdad exacta de cadenas— contra una columna que guarda
 * los dígitos pelados. Una persona que escribía su DNI como lo escribe todo el
 * mundo no aparecía en nuestro propio padrón, y no fallaba nada: el caso quedaba
 * sin cliente asociado y se le volvían a pedir los datos que acababa de dar.
 *
 * `matchByPhone` era el caso más elocuente: calculaba el teléfono normalizado y
 * después lo tiraba —`void normalized; // not in SQL`— para comparar el crudo.
 *
 * Se descubrió porque el mismo escenario del ensayo encontraba la póliza en
 * local y no en CI. No era el ambiente: era si el modelo devolvía el DNI con
 * puntos o sin puntos ese día.
 */

/** Sólo los dígitos: `27.654.321`, `27 654 321` y `27654321` son el mismo DNI. */
export function normalizarDni(crudo: string): string {
  return crudo.replace(/\D/g, "");
}

/** Sin espacios y en mayúsculas: los números de póliza los tipea una persona. */
export function normalizarNumeroPoliza(crudo: string): string {
  return crudo.replace(/\s+/g, "").toUpperCase();
}

/**
 * Sólo los dígitos, prefijo internacional incluido.
 *
 * Comparar dígitos completos no inventa coincidencias: si el padrón guarda el
 * número con código de país y la persona lo escribe sin él, no coincide — igual
 * que hoy. Lo que gana es todo lo que sólo se diferenciaba en la puntuación.
 */
export function normalizarTelefono(crudo: string): string {
  return crudo.replace(/\D/g, "");
}

/** Las direcciones no distinguen mayúsculas, y llegan con espacios alrededor. */
export function normalizarEmail(crudo: string): string {
  return crudo.trim().toLowerCase();
}

/**
 * ¿Sirve para buscar?
 *
 * La guarda que hace falta ANTES de consultar con un valor normalizado. Un
 * `"—"` o un `"s/d"` se normalizan a la cadena vacía, y buscar por vacío contra
 * una columna normalizada devuelve a toda persona cuyo campo esté vacío o sea
 * pura puntuación: en vez de no encontrar a nadie, encontraríamos a cualquiera,
 * y con la confianza alta de una coincidencia por documento.
 *
 * Un dato que la persona no dio es preferible a la persona equivocada.
 */
export function sirveParaBuscar(normalizado: string, minimo = 1): boolean {
  return normalizado.length >= minimo;
}

/** Un DNI argentino tiene 7 u 8 dígitos; menos de 6 no es un DNI. */
export const MINIMO_DNI = 6;

/** Un teléfono con menos de siete dígitos no identifica a nadie. */
export const MINIMO_TELEFONO = 7;
