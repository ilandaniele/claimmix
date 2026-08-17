/**
 * How a claim field is named when a person reads it.
 *
 * The extractor names gaps in snake_case, and it invents keys freely — the
 * schema only fixes nine canonical fields, but production has produced
 * `dni_asegurado`, `provincia_siniestro`, `hora_siniestro` and a dozen more.
 * Every channel that talks to the claimant used to fall back to printing that
 * key verbatim, so a real WhatsApp reply read:
 *
 *     Para poder avanzar necesitamos que nos envíes:
 *       • dni_asegurado
 *       • telefono_contacto
 *       • hora_siniestro
 *
 * Which is the internal shape of the database leaking onto someone's phone.
 *
 * This module is the single place that turns a key into Spanish. Email and
 * WhatsApp both read from it, so the two channels cannot drift into naming the
 * same thing differently.
 *
 * `kind` matters as much as `label`: half of these are facts you type and half
 * are files you photograph. Asking for a phone number "como foto o archivo" is
 * the same kind of tell as printing the raw key.
 */

export type FieldKind = "dato" | "documento";

export interface FieldLabel {
  /** What the claimant sees, capitalized for a list item. */
  label: string;
  /** One sentence telling them exactly what to send. */
  instruction: string;
  kind: FieldKind;
}

/**
 * Known keys. Canonical schema fields, the keys the model has actually emitted
 * in production, and every doc_key in required_docs_config.
 *
 * An unknown key is not a crisis — `labelForField` humanizes it — but adding it
 * here is always better, because a hand-written label reads like a person wrote
 * it and a humanized one reads like a machine guessed.
 */
const FIELD_LABELS: Record<string, FieldLabel> = {
  // ── Canonical schema fields ───────────────────────────────────────────────
  full_name: {
    label: "Nombre completo",
    instruction: "Decinos tu nombre y apellido.",
    kind: "dato",
  },
  email: {
    label: "Correo electrónico",
    instruction: "Dejanos un correo donde podamos escribirte.",
    kind: "dato",
  },
  phone: {
    label: "Teléfono de contacto",
    instruction: "Dejanos un teléfono donde podamos llamarte.",
    kind: "dato",
  },
  email_or_phone: {
    label: "Un dato de contacto",
    instruction: "Dejanos un teléfono o un correo donde podamos ubicarte.",
    kind: "dato",
  },
  dni: {
    label: "DNI del titular",
    instruction: "Decinos el DNI del titular de la póliza.",
    kind: "dato",
  },
  policy_number: {
    label: "Número de póliza",
    instruction: "Decinos el número de póliza (por ejemplo POL-12345).",
    kind: "dato",
  },
  accident_date: {
    label: "Fecha del siniestro",
    instruction: "Decinos qué día ocurrió (por ejemplo 15/05/2026).",
    kind: "dato",
  },
  accident_location: {
    label: "Lugar del siniestro",
    instruction: "Decinos la dirección o la localidad donde ocurrió.",
    kind: "dato",
  },
  accident_description: {
    label: "Qué pasó",
    instruction: "Contanos brevemente cómo ocurrió el siniestro.",
    kind: "dato",
  },
  claim_type: {
    label: "Tipo de siniestro",
    instruction: "Decinos qué tipo de siniestro fue: choque, robo, granizo, incendio.",
    kind: "dato",
  },

  // ── Keys the extractor has invented in production ─────────────────────────
  nombre_asegurado: {
    label: "Nombre del asegurado",
    instruction: "Decinos el nombre y apellido del titular de la póliza.",
    kind: "dato",
  },
  dni_asegurado: {
    label: "DNI del asegurado",
    instruction: "Decinos el DNI del titular de la póliza.",
    kind: "dato",
  },
  telefono_contacto: {
    label: "Teléfono de contacto",
    instruction: "Dejanos un teléfono donde podamos llamarte.",
    kind: "dato",
  },
  numero_poliza: {
    label: "Número de póliza",
    instruction: "Decinos el número de póliza (por ejemplo POL-12345).",
    kind: "dato",
  },
  fecha_siniestro: {
    label: "Fecha del siniestro",
    instruction: "Decinos qué día ocurrió.",
    kind: "dato",
  },
  hora_siniestro: {
    label: "Hora aproximada",
    instruction: "Decinos más o menos a qué hora fue.",
    kind: "dato",
  },
  lugar_siniestro: {
    label: "Lugar del siniestro",
    instruction: "Decinos la dirección o la esquina donde ocurrió.",
    kind: "dato",
  },
  provincia_siniestro: {
    label: "Provincia",
    instruction: "Decinos en qué provincia ocurrió.",
    kind: "dato",
  },
  tipo_vehiculo: {
    label: "Vehículo involucrado",
    instruction: "Decinos marca, modelo y patente del vehículo.",
    kind: "dato",
  },
  hay_heridos: {
    label: "Si hubo personas lastimadas",
    instruction: "Decinos si alguien resultó lastimado.",
    kind: "dato",
  },
  heridos: {
    label: "Personas lastimadas",
    instruction: "Decinos si alguien resultó lastimado y quién.",
    kind: "dato",
  },
  testigos: {
    label: "Testigos",
    instruction: "Si hubo testigos, pasanos su nombre y teléfono.",
    kind: "dato",
  },
  partes_relacionadas: {
    label: "Otros involucrados",
    instruction: "Decinos quién más participó del hecho y sus datos.",
    kind: "dato",
  },
  numero_denuncia: {
    label: "Número de denuncia",
    instruction: "Si hiciste la denuncia, pasanos el número.",
    kind: "dato",
  },

  // ── Documents (required_docs_config) ──────────────────────────────────────
  fotos_danos: {
    label: "Fotos de los daños",
    instruction: "Mandanos fotos de los daños.",
    kind: "documento",
  },
  fotos_lugar: {
    label: "Fotos del lugar",
    instruction: "Mandanos fotos del lugar del hecho.",
    kind: "documento",
  },
  foto_vidrio: {
    label: "Foto del vidrio roto",
    instruction: "Mandanos una foto del vidrio dañado.",
    kind: "documento",
  },
  licencia_conducir: {
    label: "Licencia de conducir",
    instruction: "Mandanos una foto de la licencia de quien manejaba.",
    kind: "documento",
  },
  parte_amistoso: {
    label: "Parte amistoso",
    instruction: "Mandanos el parte amistoso de accidente si lo completaron.",
    kind: "documento",
  },
  denuncia_policial: {
    label: "Denuncia policial",
    instruction: "Mandanos una foto de la denuncia policial.",
    kind: "documento",
  },
  informe_bomberos: {
    label: "Informe de bomberos",
    instruction: "Mandanos el informe de bomberos.",
    kind: "documento",
  },
  foto_oblea_vtv: {
    label: "Oblea de la VTV",
    instruction: "Mandanos una foto de la oblea de la VTV.",
    kind: "documento",
  },
  vtv: {
    label: "Oblea de la VTV",
    instruction: "Mandanos una foto de la oblea de la VTV.",
    kind: "documento",
  },
};

/**
 * Words that survive a round-trip through snake_case badly.
 *
 * The keys arrive unaccented and abbreviated, so a naive underscore-to-space
 * pass yields "Dni asegurado" and "Telefono". This fixes the common tokens; the
 * result still reads like a machine wrote it, which is why the explicit table
 * above exists — this is only the safety net for a key nobody has seen yet.
 */
const TOKEN_SPELLING: Record<string, string> = {
  dni: "DNI",
  vtv: "VTV",
  cbu: "CBU",
  rc: "responsabilidad civil",
  nro: "número",
  num: "número",
  numero: "número",
  telefono: "teléfono",
  poliza: "póliza",
  danos: "daños",
  danios: "daños",
  vehiculo: "vehículo",
  direccion: "dirección",
  descripcion: "descripción",
  ubicacion: "ubicación",
  companiaseguros: "compañía de seguros",
  compania: "compañía",
  patente: "patente",
};

/** Anything named like a photo, a scan or a form is a file, not a fact. */
const DOCUMENT_HINTS = [
  "foto",
  "fotos",
  "imagen",
  "adjunto",
  "comprobante",
  "constancia",
  "certificado",
  "informe",
  "acta",
  "denuncia",
  "presupuesto",
  "factura",
  "recibo",
  "escaneo",
  "copia",
];

/** `provincia_siniestro` → `Provincia siniestro`. Last resort only. */
function humanizeKey(fieldKey: string): string {
  const words = fieldKey
    .split(/[_\-.]+/)
    .filter(Boolean)
    .map((w) => TOKEN_SPELLING[w.toLowerCase()] ?? w.toLowerCase());

  if (words.length === 0) return "Dato adicional";

  const phrase = words.join(" ");
  return phrase.charAt(0).toUpperCase() + phrase.slice(1);
}

function guessKind(fieldKey: string): FieldKind {
  const lower = fieldKey.toLowerCase();
  return DOCUMENT_HINTS.some((h) => lower.includes(h)) ? "documento" : "dato";
}

/**
 * The label, instruction and kind for a field key — never a raw key.
 *
 * `override` is the tenant's own wording from required_docs_config, which wins
 * over ours: an operator who renamed a document knows their book of business
 * better than this table does.
 */
export function labelForField(fieldKey: string, override?: string | null): FieldLabel {
  const known = FIELD_LABELS[fieldKey];

  if (override && override.trim()) {
    const trimmed = override.trim();
    return {
      label: trimmed,
      instruction: known?.instruction ?? `Mandanos ${lowerFirst(trimmed)}.`,
      kind: known?.kind ?? guessKind(fieldKey),
    };
  }

  if (known) return known;

  const label = humanizeKey(fieldKey);
  const kind = guessKind(fieldKey);
  return {
    label,
    instruction:
      kind === "documento"
        ? `Mandanos ${lowerFirst(label)}.`
        : `Decinos ${lowerFirst(label)}.`,
    kind,
  };
}

function lowerFirst(s: string): string {
  // Keep acronyms intact — "DNI del asegurado" must not become "dNI...".
  if (s.length > 1 && s[0] === s[0].toUpperCase() && s[1] === s[1].toUpperCase()) {
    return s;
  }
  return s.charAt(0).toLowerCase() + s.slice(1);
}

// ── Claim types ───────────────────────────────────────────────────────────────

/**
 * Every value of ClaimTypeSchema. `other` is deliberately absent: it is a
 * bucket, not a kind of accident, and "Registramos tu reclamo de other" was
 * exactly the sort of thing that ended up in a claimant's inbox.
 */
const CLAIM_TYPE_LABELS: Record<string, string> = {
  choque: "choque de vehículo",
  robo: "robo de vehículo",
  robo_contenido: "robo de pertenencias del vehículo",
  granizo: "daño por granizo",
  incendio: "incendio",
  cristales: "rotura de cristales",
  rc: "daños a terceros",
  accidente_personal: "accidente con lesiones",
};

/**
 * How to name the claim type in a sentence, e.g. "tu reclamo de {…}".
 *
 * Falls back to the generic "siniestro", which is always true and always
 * readable — including for `other`, for null, and for a type the model made up.
 */
export function labelForClaimType(claimType: string | null | undefined): string {
  if (!claimType) return "siniestro";
  return CLAIM_TYPE_LABELS[claimType] ?? "siniestro";
}

/**
 * How to show a field's extracted value back to the claimant.
 *
 * Only claim_type needs translating today — its values are enum members, so
 * asking someone to confirm that their claim type is "other" is meaningless.
 */
export function displayFieldValue(fieldKey: string, value: string): string {
  if (fieldKey === "claim_type" || fieldKey === "tipo_siniestro") {
    return labelForClaimType(value);
  }
  return value;
}
