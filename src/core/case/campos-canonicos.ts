/**
 * Los campos extraídos, con los sinónimos resueltos.
 *
 * El extractor llama a las cosas de dos maneras. A veces manda `dni`, a veces
 * `dni_asegurado`; a veces `phone`, a veces `telefono_contacto`. Eso ya estaba
 * sabido y documentado en `@/lib/labels/claim-fields`, que tiene el mapa de
 * alias para no mostrarle a nadie dos preguntas por el mismo dato.
 *
 * Lo que NO estaba resuelto es que el buscador de clientes lee sólo las claves
 * canónicas —`fields.dni`, `fields.email`, `fields.phone`,
 * `fields.policy_number`— así que cuando el modelo elegía el nombre en
 * castellano, la búsqueda no encontraba a nadie y no fallaba nada: la persona
 * daba su DNI y le pedíamos de nuevo los datos que acababa de dar.
 *
 * Se vio en el post-deploy: el mismo escenario que en local encontraba la
 * póliza, en CI registraba `customer_matcher.matches_found match_count: 0`. No
 * era el ambiente. Era qué nombre le puso el modelo al campo ese día.
 */

import { canonicalFieldKey } from "@/lib/labels/claim-fields";

/** Un campo tal como lo devuelve el extractor. */
export interface CampoExtraido {
  field_key: string;
  field_value: string;
}

/**
 * Arma el diccionario de campos con los alias resueltos a su clave canónica.
 *
 * Deja las claves crudas donde estaban —hay código que las lee por nombre— y
 * AGREGA la canónica cuando el extractor usó un sinónimo.
 *
 * @param campos    `fields[]` del extractor, en orden.
 * @param canonicos El objeto `extracted_fields`, si vino. Se superpone al final.
 * @param clavesCanonicas Las claves que se copian de `canonicos`.
 */
export function canonizarCampos(
  campos: readonly CampoExtraido[],
  canonicos: Record<string, string | undefined> | null | undefined,
  clavesCanonicas: readonly string[]
): Record<string, string | undefined> {
  const salida: Record<string, string | undefined> = {};

  for (const campo of campos) {
    salida[campo.field_key] = campo.field_value;

    const canonica = canonicalFieldKey(campo.field_key);
    /*
     * El alias NO pisa a la clave canónica si el extractor mandó las dos.
     *
     * Un mismo mensaje produce de rutina `dni` y `dni_asegurado` con el mismo
     * número, pero cuando difieren la canónica es la que el resto del sistema
     * viene leyendo, y cambiarla por atrás sería mover el dato sin que nadie lo
     * pida. El `!salida[canonica]` también cubre el caso de la canónica vacía:
     * un `""` no es un valor que haya que proteger.
     */
    if (canonica !== campo.field_key && campo.field_value && !salida[canonica]) {
      salida[canonica] = campo.field_value;
    }
  }

  /*
   * `extracted_fields` va último y sólo si trae algo.
   *
   * El `if` por valor no es de estilo: a esta altura `fields[]` ya tiene lo que
   * salió de la hidratación y del parser de respaldo, y un `""` del modelo —que
   * los manda— borraría un valor que sí encontramos en el texto.
   */
  if (canonicos) {
    for (const clave of clavesCanonicas) {
      const valor = canonicos[clave];
      if (valor) salida[clave] = valor;
    }
  }

  return salida;
}
