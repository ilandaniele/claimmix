/**
 * Cómo escribe la gente los datos que usamos para encontrarla en el padrón.
 *
 * Un DNI se escribe `27.654.321`, `27654321` y `DNI 27 654 321`. Una póliza,
 * `POL-8812-R`, `pol-8812-r` y `POL - 8812 - R`. Un teléfono, `+54 9 11 0000-0000` y
 * `5491100000000`. Son la misma persona y el mismo contrato.
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

/**
 * Sin espacios y en mayúsculas: los números de póliza los tipea una persona.
 *
 * ── El guion NO se saca, y es una decisión ──────────────────────────────────
 *
 * Un DNI es un número y la puntuación es decorado. Un número de póliza es una
 * cadena que inventa la aseguradora, y `(tenant_id, policy_number)` es único
 * sobre el texto CRUDO: nada impide que `POL-8812-R` y `POL8812R` sean dos
 * contratos distintos del mismo inquilino. Sacando el guion, los dos
 * coincidirían con 0.95 y el worker se queda con `customerMatches[0]` —el
 * primero que devolvió la base, sin `ORDER BY`—, así que la denuncia quedaría
 * colgada de un contrato al azar.
 *
 * Vale lo mismo que para el teléfono: se pierde una coincidencia posible antes
 * que ganar una equivocada.
 *
 * El encabezado de este archivo decía lo contrario —que `POL8812R` y
 * `POL-8812-R` son el mismo contrato— y era falso desde el primer día. Un
 * comentario así no es cosmético: es la instrucción para que alguien «arregle»
 * la función, no toque los tres sitios SQL, y rompa el 100 % de las búsquedas
 * de póliza en silencio.
 *
 * SI ALGÚN DÍA CAMBIA: hay que cambiar TAMBIÉN el lado SQL de los tres
 * buscadores —`customer-matcher.ts`, `policy-matcher.ts`, `agent-tools.ts`— en
 * el mismo commit, y con un índice único sobre la forma pelada. Cambiar sólo
 * esta función deja de encontrar las que hoy sí encuentra. Hay un test que lo
 * ata: «el guion viaja de los dos lados o de ninguno».
 */
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
