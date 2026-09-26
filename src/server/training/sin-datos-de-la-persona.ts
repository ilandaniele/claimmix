/**
 * El nombre y el DNI de una persona, tachados de un ejemplo entero antes de
 * que llegue al prompt few-shot.
 *
 * `training_examples` guarda el email o el WhatsApp completos: el nombre y el
 * DNI pueden aparecer en cualquier parte del texto libre, no sólo en el campo
 * que la extracción reconoció como tal. Por eso esto no mira un campo puntual:
 * recorre cada string de los dos payloads, estén donde estén.
 */

import "server-only";

import { DNI_RE, tacharNombreYDni } from "@/server/ai/hydrate-fields";
import { canonicalFieldKey } from "@/lib/labels/claim-fields";

interface DatosDeLaPersona {
  nombre?: string | null;
  dni?: string | null;
}

/** El valor de `field_key` en `confirmed_fields`, el array que arma `examples.ts`. */
function campoConfirmado(confirmedFields: unknown, clave: "full_name" | "dni"): string | undefined {
  if (!Array.isArray(confirmedFields)) return undefined;
  const fila = confirmedFields.find(
    (f) =>
      f &&
      typeof f === "object" &&
      canonicalFieldKey(String((f as { field_key?: unknown }).field_key)) === clave
  ) as { field_value?: unknown } | undefined;
  return typeof fila?.field_value === "string" ? fila.field_value : undefined;
}

/** El valor de `clave` en `extracted_fields`, aunque el modelo haya usado un alias. */
function campoExtraido(extraidos: unknown, clave: "full_name" | "dni"): string | undefined {
  if (!extraidos || typeof extraidos !== "object") return undefined;
  for (const [k, v] of Object.entries(extraidos)) {
    if (canonicalFieldKey(k) === clave && typeof v === "string" && v) return v;
  }
  return undefined;
}

/**
 * De dónde salen el nombre y el DNI: primero lo que confirmó un humano,
 * porque es el dato bueno; si no hay confirmación, lo que propuso el modelo.
 * Por clave canónica: `nombre_asegurado` es el mismo nombre que `full_name`.
 */
function datosDeLaPersona(expectedOutput: unknown): DatosDeLaPersona {
  if (!expectedOutput || typeof expectedOutput !== "object") return {};
  const eo = expectedOutput as {
    confirmed_fields?: unknown;
    agent_output?: { extracted_fields?: unknown };
  };
  const extraidos = eo.agent_output?.extracted_fields;

  return {
    nombre: campoConfirmado(eo.confirmed_fields, "full_name") ?? campoExtraido(extraidos, "full_name"),
    dni: campoConfirmado(eo.confirmed_fields, "dni") ?? campoExtraido(extraidos, "dni"),
  };
}

/** Tacha nombre y DNI en cada string; saca `sender_email` en cada objeto. */
function tachar(valor: unknown, datos: DatosDeLaPersona): unknown {
  if (typeof valor === "string") {
    return tacharNombreYDni(valor, datos, { nombre: "[NOMBRE]", dni: "[DNI]" }, { porPalabra: true }).replace(
      DNI_RE,
      "[DNI]"
    );
  }
  if (Array.isArray(valor)) {
    return valor.map((v) => tachar(v, datos));
  }
  if (valor && typeof valor === "object") {
    const out: Record<string, unknown> = {};
    for (const [clave, v] of Object.entries(valor)) {
      if (clave === "sender_email") continue;
      out[clave] = tachar(v, datos);
    }
    return out;
  }
  return valor;
}

/**
 * Un ejemplo de `training_examples`, con el nombre y el DNI de la persona
 * tachados en cada string de `input_payload` y `expected_output`, y sin
 * `sender_email` (el worker lo guarda junto a `subject`/`body`, ver
 * `extract.ts`).
 *
 * Pura, y nunca tira: un payload que no es un objeto vuelve sin tocar.
 */
export function ejemploSinDatosDeLaPersona<
  T extends { input_payload: unknown; expected_output: unknown },
>(ej: T): T {
  if (!ej || typeof ej !== "object") return ej;
  const datos = datosDeLaPersona(ej.expected_output);

  return {
    ...ej,
    input_payload: tachar(ej.input_payload, datos),
    expected_output: tachar(ej.expected_output, datos),
  } as T;
}
