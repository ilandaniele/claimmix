/**
 * Los nombres y los DNI de las personas de un caso, tachados de un ejemplo
 * entero antes de que llegue al prompt few-shot o salga en un export.
 *
 * `training_examples` guarda el email o el WhatsApp completos: el nombre y el
 * DNI pueden aparecer en cualquier parte del texto libre, no sólo en el campo
 * que la extracción reconoció como tal. Por eso esto no mira un campo puntual:
 * recorre cada string de los dos payloads, estén donde estén.
 */

import "server-only";

import { createHash } from "node:crypto";

import { DNI_RE, EMAIL_RE, PHONE_RE, tacharNombreYDni } from "@/server/ai/hydrate-fields";
import { canonicalFieldKey } from "@/lib/labels/claim-fields";

interface DatosDeLasPersonas {
  nombres: string[];
  dnis: string[];
}

const EN = { nombre: "[NOMBRE]", dni: "[DNI]" };

/**
 * Los nombres y los DNI de todas las personas del caso: el asegurado, el
 * tercero, el conductor. Una clave de nombre termina en `_name`
 * (`full_name`, `party_b_name`, `driver_name`); una de DNI es `dni` o lo lleva
 * como parte (`dni_tercero`).
 *
 * Por clave canónica, primero lo que confirmó un humano, porque es el dato
 * bueno; si no hay confirmación, lo que propuso el modelo. `nombre_asegurado`
 * es el mismo nombre que `full_name`.
 */
function datosDeLasPersonas(expectedOutput: unknown): DatosDeLasPersonas {
  const datos: DatosDeLasPersonas = { nombres: [], dnis: [] };
  if (!expectedOutput || typeof expectedOutput !== "object") return datos;
  const eo = expectedOutput as {
    confirmed_fields?: unknown;
    agent_output?: { extracted_fields?: unknown };
  };

  const porClave = new Map<string, string>();
  const extraidos = eo.agent_output?.extracted_fields;
  if (extraidos && typeof extraidos === "object") {
    for (const [k, v] of Object.entries(extraidos)) {
      if (typeof v === "string" && v) porClave.set(canonicalFieldKey(k), v);
    }
  }
  // `confirmed_fields` es el array que arma `examples.ts`; pisa lo extraído.
  if (Array.isArray(eo.confirmed_fields)) {
    for (const f of eo.confirmed_fields) {
      const { field_key, field_value } = (f ?? {}) as { field_key?: unknown; field_value?: unknown };
      if (typeof field_value === "string" && field_value) {
        porClave.set(canonicalFieldKey(String(field_key)), field_value);
      }
    }
  }

  for (const [clave, valor] of porClave) {
    if (/(^|_)name$/.test(clave)) datos.nombres.push(valor);
    else if (/(^|_)dni($|_)/.test(clave)) datos.dnis.push(valor);
  }
  return datos;
}

/** Clave canónica de teléfono o correo: `telefono_contacto` (→ `phone`), `email`, `mail`. */
const CLAVE_TELEFONO_O_CORREO_RE = /(^|_)(phone|telefono|email|mail)($|_)/i;

/**
 * Tacha nombres y DNI en cada string, y el email o el teléfono por patrón; saca
 * `sender_email` y tacha (no saca, para no romper la forma del objeto) cualquier
 * otra clave que sea teléfono o correo (`telefono_contacto`, `phone`, `email`,
 * `mail`) en cada objeto.
 */
function tachar(valor: unknown, datos: DatosDeLasPersonas): unknown {
  if (typeof valor === "string") {
    let out = valor;
    for (const nombre of datos.nombres) out = tacharNombreYDni(out, { nombre }, EN, { porPalabra: true });
    for (const dni of datos.dnis) out = tacharNombreYDni(out, { dni }, EN);
    return out.replace(DNI_RE, EN.dni).replace(EMAIL_RE, "[TACHADO]").replace(PHONE_RE, "[TACHADO]");
  }
  if (Array.isArray(valor)) {
    return valor.map((v) => tachar(v, datos));
  }
  if (valor && typeof valor === "object") {
    const out: Record<string, unknown> = {};
    for (const [clave, v] of Object.entries(valor)) {
      if (clave === "sender_email") continue;
      if (CLAVE_TELEFONO_O_CORREO_RE.test(canonicalFieldKey(clave))) {
        out[clave] = "[TACHADO]";
        continue;
      }
      out[clave] = tachar(v, datos);
    }
    return out;
  }
  return valor;
}

/**
 * Un ejemplo de `training_examples`, con los nombres, los DNI, el email y el
 * teléfono de las personas tachados en cada string de `input_payload` y
 * `expected_output`, y sin `sender_email` (el worker lo guarda junto a
 * `subject`/`body`, ver `extract.ts`).
 *
 * Pura, y nunca tira: un payload que no es un objeto vuelve sin tocar.
 */
export function ejemploSinDatosDeLaPersona<
  T extends { input_payload: unknown; expected_output: unknown },
>(ej: T): T {
  if (!ej || typeof ej !== "object") return ej;
  const datos = datosDeLasPersonas(ej.expected_output);

  return {
    ...ej,
    input_payload: tachar(ej.input_payload, datos),
    expected_output: tachar(ej.expected_output, datos),
  } as T;
}

const CLAVES_DE_CAMPO = ["field", "field_key", "field_name"] as const;
const CLAVES_DE_VALOR = ["value", "field_value", "confirmed_value", "new_value"] as const;

/**
 * Los nombres que un valor JSON trae declarados: bajo una clave que termina en
 * `_name` (`full_name`, `party_b_name`, `nombre_asegurado` canonizada) o como
 * par campo/valor (`{ field: "full_name", value: "…" }`, y las variantes
 * field_key/field_value, field_name/confirmed_value, new_value). Recorre todo.
 */
export function nombresEn(valor: unknown): string[] {
  const nombres: string[] = [];

  const recorrer = (v: unknown): void => {
    if (Array.isArray(v)) {
      v.forEach(recorrer);
      return;
    }
    if (!v || typeof v !== "object") return;
    const obj = v as Record<string, unknown>;

    for (const [clave, val] of Object.entries(obj)) {
      if (typeof val === "string" && canonicalFieldKey(clave).endsWith("_name")) {
        nombres.push(val);
      }
    }

    for (const claveDeCampo of CLAVES_DE_CAMPO) {
      const campo = obj[claveDeCampo];
      if (typeof campo !== "string" || !canonicalFieldKey(campo).endsWith("_name")) continue;
      for (const claveDeValor of CLAVES_DE_VALOR) {
        const val = obj[claveDeValor];
        if (typeof val === "string") nombres.push(val);
      }
    }

    Object.values(obj).forEach(recorrer);
  };

  recorrer(valor);
  return nombres;
}

/**
 * Cualquier valor JSON sin DNI, email ni teléfono (por patrón), sin los nombres
 * dados y sin claves `sender_email` u otra de teléfono o correo. Es
 * `ejemploSinDatosDeLaPersona` para lo que no es un ejemplo: la memoria del
 * remitente y los payloads de auditoría del export.
 */
export function sinDatosDeLaPersona<T>(valor: T, nombres: readonly string[] = []): T {
  return tachar(valor, { nombres: [...nombres], dnis: [] }) as T;
}

/** La clave de `claim_memory` es la persona (correo o teléfono): sale como huella. */
export function huellaDelRemitente(key: string): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 12);
}
