/**
 * Qué datos requeridos le faltan a un caso, dado lo que el caso ya tiene.
 *
 * Es el cálculo del analizador de huecos de mail sin la base: recibe los campos
 * ya leídos y devuelve la lista. Puro y sin `server-only`, para poder probarlo
 * sin montar nada y para que otros lo usen sin pasar por el analizador.
 */

import { canonicalFieldKey } from "@/lib/labels/claim-fields";
import type { ExtractedField } from "@/lib/schemas/extracted-claim";
import { CONFIANZA_DE_DATO_PRESENTE } from "@/core/case/faltantes-vigentes";
import { clavesQueSatisfacen } from "@/core/case/required-fields";

/**
 * Fields that MUST be present for an email claim to be considered complete.
 * Note: 'email' and 'phone' are treated as a contact pair — at least one required.
 */
export const REQUIRED_CLAIM_FIELDS = [
  "full_name",
  "accident_date",
  "accident_description",
  "claim_type",
  // A claim an insurer cannot attach to a policy is not a claim it can act on.
  // These were absent from the list, so nothing ever asked for them and a case
  // could reach listo_para_core with no way to identify the policyholder,
  // while the agent spent its one question confirming an inferred province.
  "policy_number",
  "dni",
] as const;

/** At least one of these contact fields must be present. */
export const REQUIRED_CONTACT_FIELDS = ["email", "phone"] as const;

/**
 * Los campos por clave canónica, quedándose con la mejor copia de cada uno.
 *
 * El extractor emite `numero_poliza` tan seguido como `policy_number`, y con el
 * número de póliza requerido, un mapa por clave cruda lo daría por faltante
 * teniéndolo bajo la otra grafía, y le mandaríamos al denunciante un mail
 * pidiéndole algo que ya mandó.
 *
 * A igual confianza gana el que viene después: se pasa primero lo guardado y
 * después lo de esta corrida, así una corrección del último mensaje no queda
 * por debajo del valor viejo.
 */
export function mapaDeCampos(campos: readonly ExtractedField[]): Map<string, ExtractedField> {
  const mapa = new Map<string, ExtractedField>();
  for (const f of campos) {
    const clave = canonicalFieldKey(f.field_key);
    const existente = mapa.get(clave);
    if (!existente || f.confidence >= existente.confidence) {
      mapa.set(clave, f);
    }
  }
  return mapa;
}

/**
 * El ramo del caso, o `null` si `claim_type` no está lo bastante firme: con
 * poca confianza no sabemos qué ramo es, y pedir de más sería peor que no
 * pedir todavía.
 */
export function claveDelRamoDelCaso(mapa: ReadonlyMap<string, ExtractedField>): string | null {
  const tipo = mapa.get("claim_type");
  return tipo && tipo.confidence >= CONFIANZA_DE_DATO_PRESENTE ? tipo.field_value : null;
}

/**
 * Los campos requeridos que no están o no son firmes, más `email_or_phone` si
 * no hay ningún medio de contacto.
 *
 * @param mapa            - Los campos del caso, ya por clave canónica (`mapaDeCampos`).
 * @param delRamo         - Lo que pide el ramo del caso además de los campos base.
 * @param pedidosSinValor - Claves canónicas que se pidieron y no llegaron (`missing_docs` abiertos).
 */
export function faltantesRequeridos(
  mapa: ReadonlyMap<string, ExtractedField>,
  delRamo: readonly string[],
  pedidosSinValor: readonly string[]
): string[] {
  const faltantes: string[] = [];

  // Check mandatory fields, más lo que pida el ramo de este caso.
  for (const reqField of [...REQUIRED_CLAIM_FIELDS, ...delRamo]) {
    const extracted = mejorEntreClaves(mapa, clavesQueSatisfacen(reqField));
    const isMissingInDB = pedidosSinValor.includes(reqField);

    if (isMissingInDB && !extracted) {
      // Still missing — no re-extraction has provided it
      faltantes.push(reqField);
    } else if (!extracted && !isMissingInDB) {
      // Not in extracted fields and not in missing_docs — add it
      faltantes.push(reqField);
    } else if (extracted && extracted.confidence < CONFIANZA_DE_DATO_PRESENTE) {
      // Below low confidence threshold → treat as missing (AC8, IC9)
      faltantes.push(reqField);
    }
  }

  /*
   * Hace falta AL MENOS UNO de los campos de contacto.
   *
   * Recorre `REQUIRED_CONTACT_FIELDS` en vez de escribir "email" y "phone" a
   * mano cuatro veces, que es como estaba: la constante se exportaba con el
   * comentario «al menos uno de estos tiene que estar» y no la usaba nadie, ni
   * siquiera esta comprobación. Agregarle un tercer canal —WhatsApp, por
   * ejemplo— no cambiaba absolutamente nada, y el que la agregara no tenía
   * forma de enterarse.
   */
  const tieneAlguno = REQUIRED_CONTACT_FIELDS.some((clave) => {
    const campo = mapa.get(clave);
    return campo !== undefined && campo.confidence >= CONFIANZA_DE_DATO_PRESENTE;
  });

  // Se pidió y no llegó, o nunca lo mencionaron: en los dos casos falta.
  const algunoPedidoYSinValor = REQUIRED_CONTACT_FIELDS.some((clave) =>
    pedidosSinValor.includes(clave)
  );
  const ningunoMencionado = REQUIRED_CONTACT_FIELDS.every((clave) => !mapa.has(clave));

  if (!tieneAlguno && (algunoPedidoYSinValor || ningunoMencionado)) {
    faltantes.push("email_or_phone");
  }

  return faltantes;
}

/**
 * La entrada de mayor confianza entre las claves que satisfacen un campo
 * requerido. Para los campos base, `clavesQueSatisfacen` sólo devuelve la
 * clave pedida, así que esto es `mapa.get(reqField)` como antes.
 */
function mejorEntreClaves(
  mapa: ReadonlyMap<string, ExtractedField>,
  claves: readonly string[]
): ExtractedField | undefined {
  let mejor: ExtractedField | undefined;
  for (const clave of claves) {
    const campo = mapa.get(canonicalFieldKey(clave));
    if (campo && (!mejor || campo.confidence > mejor.confidence)) {
      mejor = campo;
    }
  }
  return mejor;
}
