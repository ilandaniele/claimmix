/**
 * Customer matcher — finds customers in the DB that match fields extracted
 * from an inbound email.
 *
 * Match priority (highest confidence first):
 *   1. policy_number exact match (per tenant)
 *   2. DNI exact match (per tenant)
 *   3. Email exact match (per tenant)
 *   4. Phone match via customer_contacts
 *
 * AC6:  High-confidence match sets cases.customer_id + cases.policy_id.
 * AC22: Priority: policy > dni > email > phone.
 * IDOR: No cross-tenant leakage on the customer data — the tenant_id filter
 *       is always applied in SQL.
 *
 * LLM06: PII fields (email, phone, dni) are never logged. Only customer_id
 *        and match_type are logged.
 */

import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { db, tables } from "@/lib/db";
import { enTenant, type TenantContext } from "@/data/scope";
import {
  normalizarDni,
  normalizarEmail,
  normalizarNumeroPoliza,
  normalizarTelefono,
  sirveParaBuscar,
  MINIMO_DNI,
  MINIMO_TELEFONO,
} from "@/core/matching/normalizar";
import type { ClaimFields } from "@/lib/schemas/extracted-claim";

/** A single customer match result. */
export interface CustomerMatch {
  /** UUID of the matched customer row. */
  customerId: string;
  /** UUID of the matched policy row (if a policy was the basis of the match). */
  policyId?: string;
  /** The field type that produced the match. */
  matchType: "policy_number" | "dni" | "email" | "phone";
  /** Confidence score assigned to this match type (0.0–1.0). */
  confidence: number;
  /** Full name of the matched customer (PII — used for conflict detection, not logged). */
  customerName: string;
  /**
   * Field keys where extracted value conflicts with the stored customer record.
   * For example: email in email differs from customers.email.
   */
  conflictsWithExtracted: string[];
  /**
   * Lo que dice el padrón para esos campos, por clave canónica.
   *
   * Faltaba, y por eso el mail de conflicto salía vacío: `getStoredFieldValue`
   * sólo sabía devolver el nombre —lo único que esta interfaz exponía— y para
   * DNI, correo y teléfono devolvía `""`. El asegurado recibía «Obtuvimos el
   * siguiente dato:» y nada después, así que no tenía forma de saber qué había
   * que corregir. El valor estaba a la vista en el buscador, que acaba de
   * compararlo para DETECTAR el conflicto, y se tiraba.
   *
   * Va sin enmascarar: el analista lo ve entero en la pantalla, y el
   * enmascarado ocurre al renderizar el mail (`maskFieldValue`), que es donde
   * corresponde — quien escribió puede no ser el titular.
   */
  storedValues: Record<string, string>;
}

/** Confidence scores by match type. */
const MATCH_CONFIDENCE: Record<CustomerMatch["matchType"], number> = {
  policy_number: 0.95,
  dni: 0.85,
  email: 0.75,
  phone: 0.60,
};

/**
 * Find all customers that match the extracted claim fields.
 *
 * Returns an array of matches sorted by confidence descending.
 * Returns [] if no matches are found.
 *
 * @param tenantId  - Tenant scope (always applied — prevents cross-tenant leakage).
 * @param fields    - Extracted claim fields from the AI extractor.
 */
export async function findCustomerMatches(
  tenantId: string,
  fields: Partial<ClaimFields>
): Promise<CustomerMatch[]> {
  const matches: CustomerMatch[] = [];
  const seenCustomerIds = new Set<string>();

  // ── 1. Policy number match (highest priority) ────────────────────────────────
  if (fields.policy_number && fields.policy_number.trim() !== "") {
    const policyMatches = await matchByPolicyNumber(tenantId, fields.policy_number.trim(), fields);
    for (const m of policyMatches) {
      if (!seenCustomerIds.has(m.customerId)) {
        matches.push(m);
        seenCustomerIds.add(m.customerId);
      }
    }
  }

  // ── 2. DNI match ──────────────────────────────────────────────────────────────
  if (fields.dni && fields.dni.trim() !== "") {
    const dniMatches = await matchByDni(tenantId, fields.dni.trim(), fields);
    for (const m of dniMatches) {
      if (!seenCustomerIds.has(m.customerId)) {
        matches.push(m);
        seenCustomerIds.add(m.customerId);
      }
    }
  }

  // ── 3. Email match ─────────────────────────────────────────────────────────────
  if (fields.email && fields.email.trim() !== "") {
    const emailMatches = await matchByEmail(tenantId, fields.email.trim(), fields);
    for (const m of emailMatches) {
      if (!seenCustomerIds.has(m.customerId)) {
        matches.push(m);
        seenCustomerIds.add(m.customerId);
      }
    }
  }

  // ── 4. Phone match via customer_contacts ──────────────────────────────────────
  if (fields.phone && fields.phone.trim() !== "") {
    const phoneMatches = await matchByPhone(tenantId, fields.phone.trim(), fields);
    for (const m of phoneMatches) {
      if (!seenCustomerIds.has(m.customerId)) {
        matches.push(m);
        seenCustomerIds.add(m.customerId);
      }
    }
  }

  // Sort by confidence descending (highest first).
  matches.sort((a, b) => b.confidence - a.confidence);

  console.info(
    JSON.stringify({
      level: "info",
      service: "claimmix",
      msg: "customer_matcher.matches_found",
      tenant_id: tenantId,
      match_count: matches.length,
      match_types: matches.map((m) => m.matchType),
      /*
       * Con qué claves se pudo buscar. Los NOMBRES, nunca los valores.
       *
       * Un `match_count: 0` tiene dos causas que se ven igual en el log: la
       * persona no está en el padrón, o no teníamos por dónde buscarla. Son
       * problemas distintos —uno es normal, el otro es un dato que llegó y se
       * perdió por el camino— y distinguirlos costó leer el código del
       * extractor y adivinar.
       *
       * Pasó: el buscador daba cero en CI y uno en local para el mismo
       * escenario, y no había forma de saber si le faltaba el DNI o si el DNI
       * no figuraba. Un DNI, un teléfono o un número de póliza no van a un log;
       * la lista de qué campos había, sí.
       */
      claves_disponibles: (["policy_number", "dni", "email", "phone"] as const).filter(
        (k) => fields[k] && fields[k]!.trim() !== ""
      ),
    })
  );

  return matches;
}

// ── Private matchers ──────────────────────────────────────────────────────────

async function matchByPolicyNumber(
  tenantId: string,
  policyNumber: string,
  fields: Partial<ClaimFields>
): Promise<CustomerMatch[]> {
  // Las consultas de acá ya no llevan filtro por inquilino: lo pone la base.
  const tenantCtx: TenantContext = { tenantId };
  const p = tables.policies;
  const c = tables.customers;

  let data: Array<{
    id: string;
    customer_id: string;
    customer: { id: string; full_name: string; email: string | null; dni: string | null } | null;
  }>;
  try {
    data = await enTenant(tenantCtx, (db) =>
      db
        .select({
          id: p.id,
          customer_id: p.customer_id,
          customer: {
            id: c.id,
            full_name: c.full_name,
            email: c.email,
            dni: c.dni,
          },
        })
        .from(p)
        .leftJoin(c, eq(p.customer_id, c.id))
        // Sin espacios y en mayúsculas de los DOS lados: los números de póliza
        // los tipea una persona, y `pol-8812-r` es el mismo contrato que
        // `POL-8812-R`.
        //
        // El guion no se saca, ni acá ni en `normalizarNumeroPoliza`, y tiene
        // que seguir así en los dos o en ninguno: ver el motivo escrito en esa
        // función. El ejemplo que estaba acá era `pol 8812-r`, que normaliza a
        // `POL8812-R` y NO coincide con `POL-8812-R` — un comentario que se
        // desmentía a sí mismo contra la consulta que documentaba.
        .where(
          sql`upper(replace(${p.policy_number}, ' ', '')) = ${normalizarNumeroPoliza(policyNumber)}`
        )
        .limit(5)
    );
  } catch (e) {
    console.error("[customer-matcher] Policy lookup error:", (e as { code?: string })?.code);
    return [];
  }

  return data.map((row) => {
    const customer = row.customer;
    const conflicts = detectConflicts(fields, customer);
    return {
      customerId: row.customer_id,
      policyId: row.id,
      matchType: "policy_number" as const,
      confidence: MATCH_CONFIDENCE.policy_number,
      customerName: customer?.full_name ?? "",
      conflictsWithExtracted: conflicts,
      storedValues: valoresGuardados(customer),
    };
  });
}

async function matchByDni(
  tenantId: string,
  dni: string,
  fields: Partial<ClaimFields>
): Promise<CustomerMatch[]> {
  // Las consultas de acá ya no llevan filtro por inquilino: lo pone la base.
  const tenantCtx: TenantContext = { tenantId };
  const c = tables.customers;

  /*
   * Los dos lados normalizados, o no se encuentra a nadie.
   *
   * Decía `eq(c.dni, dni)`: igualdad exacta contra una columna que guarda los
   * dígitos pelados. Una persona que escribe `27.654.321` —como se escribe un
   * DNI acá— no aparecía en nuestro propio padrón.
   *
   * La guarda del mínimo no es defensiva de más: un `"—"` o un `"s/d"` se
   * normalizan a la cadena vacía, y buscar por vacío contra una columna
   * normalizada devuelve a toda persona con el documento vacío. En vez de no
   * encontrar a nadie encontraríamos a cualquiera, con la confianza de una
   * coincidencia por documento.
   */
  const buscado = normalizarDni(dni);
  if (!sirveParaBuscar(buscado, MINIMO_DNI)) return [];

  let data: Array<{ id: string; full_name: string; email: string | null; dni: string | null }>;
  try {
    data = await enTenant(tenantCtx, (db) =>
      db
        .select({ id: c.id, full_name: c.full_name, email: c.email, dni: c.dni })
        .from(c)
        .where(sql`regexp_replace(coalesce(${c.dni}, ''), '[^0-9]', '', 'g') = ${buscado}`)
        .limit(5)
    );
  } catch (e) {
    console.error("[customer-matcher] DNI lookup error:", (e as { code?: string })?.code);
    return [];
  }

  return data.map((customer) => {
    const conflicts = detectConflicts(fields, customer);
    return {
      customerId: customer.id,
      policyId: undefined,
      matchType: "dni" as const,
      confidence: MATCH_CONFIDENCE.dni,
      customerName: customer.full_name ?? "",
      conflictsWithExtracted: conflicts,
      storedValues: valoresGuardados(customer),
    };
  });
}

async function matchByEmail(
  tenantId: string,
  email: string,
  fields: Partial<ClaimFields>
): Promise<CustomerMatch[]> {
  // Las consultas de acá ya no llevan filtro por inquilino: lo pone la base.
  const tenantCtx: TenantContext = { tenantId };
  const c = tables.customers;

  let data: Array<{ id: string; full_name: string; email: string | null; dni: string | null }>;
  try {
    data = await enTenant(tenantCtx, (db) =>
      db
        .select({ id: c.id, full_name: c.full_name, email: c.email, dni: c.dni })
        .from(c)
        // `lower()` de los dos lados: el de entrada ya venía en minúsculas, la
        // columna no. Una dirección guardada como `Cecilia@…` no aparecía.
        .where(sql`lower(${c.email}) = ${normalizarEmail(email)}`)
        .limit(5)
    );
  } catch (e) {
    console.error("[customer-matcher] Email lookup error:", (e as { code?: string })?.code);
    return [];
  }

  return data.map((customer) => {
    const conflicts = detectConflicts(fields, customer);
    return {
      customerId: customer.id,
      policyId: undefined,
      matchType: "email" as const,
      confidence: MATCH_CONFIDENCE.email,
      customerName: customer.full_name ?? "",
      conflictsWithExtracted: conflicts,
      storedValues: valoresGuardados(customer),
    };
  });
}

async function matchByPhone(
  tenantId: string,
  phone: string,
  fields: Partial<ClaimFields>
): Promise<CustomerMatch[]> {
  // Las consultas de acá ya no llevan filtro por inquilino: lo pone la base.
  const tenantCtx: TenantContext = { tenantId };
  /*
   * El normalizado se calculaba y se TIRABA.
   *
   * Abajo decía `void normalized; // not in SQL (match exact stored value)`, y
   * la comparación iba contra el crudo. O sea: se sabía cómo había que
   * comparar, se hacía la cuenta, y después se comparaba de la otra forma.
   */
  const buscado = normalizarTelefono(phone);
  if (!sirveParaBuscar(buscado, MINIMO_TELEFONO)) return [];

  const cc = tables.customerContacts;
  const c = tables.customers;

  let data: Array<{
    customer_id: string;
    customer: { id: string; full_name: string; email: string | null; dni: string | null } | null;
  }>;
  try {
    data = await enTenant(tenantCtx, (db) =>
      db
        .select({
          customer_id: cc.customer_id,
          customer: {
            id: c.id,
            full_name: c.full_name,
            email: c.email,
            dni: c.dni,
          },
        })
        .from(cc)
        .leftJoin(c, eq(cc.customer_id, c.id))
        .where(
          and(
            eq(cc.contact_type, "phone"),
            sql`regexp_replace(coalesce(${cc.value}, ''), '[^0-9]', '', 'g') = ${buscado}`
          )
        )
        .limit(5)
    );
  } catch (e) {
    console.error("[customer-matcher] Phone lookup error:", (e as { code?: string })?.code);
    return [];
  }


  return data.map((row) => {
    const customer = row.customer;
    const conflicts = detectConflicts(fields, customer);
    return {
      customerId: row.customer_id,
      policyId: undefined,
      matchType: "phone" as const,
      confidence: MATCH_CONFIDENCE.phone,
      customerName: customer?.full_name ?? "",
      conflictsWithExtracted: conflicts,
      storedValues: valoresGuardados(customer),
    };
  });
}

/**
 * Detect fields where the extracted value conflicts with the stored customer record.
 *
 * AC9: Conflict detected when a high-confidence extracted field differs from
 *      the stored customer record value.
 *
 * Returns field keys that conflict (e.g. ["full_name"] when names differ).
 */
/**
 * Lo que el padrón dice de esta persona, por clave canónica.
 *
 * Se arma junto con `detectConflicts` y de la misma fila: si se detectó un
 * conflicto sobre un campo es porque el valor guardado estaba a mano.
 */
function valoresGuardados(
  customer: { full_name?: string | null; email?: string | null; dni?: string | null } | null
): Record<string, string> {
  if (!customer) return {};
  const valores: Record<string, string> = {};
  if (customer.full_name) valores.full_name = customer.full_name;
  if (customer.email) valores.email = customer.email;
  if (customer.dni) valores.dni = customer.dni;
  return valores;
}

function detectConflicts(
  extracted: Partial<ClaimFields>,
  customer: { full_name?: string | null; email?: string | null; dni?: string | null } | null
): string[] {
  if (!customer) return [];
  const conflicts: string[] = [];

  // Check full_name conflict.
  if (
    extracted.full_name &&
    customer.full_name &&
    extracted.full_name.toLowerCase().trim() !== customer.full_name.toLowerCase().trim()
  ) {
    conflicts.push("full_name");
  }

  // Check email conflict.
  if (
    extracted.email &&
    customer.email &&
    extracted.email.toLowerCase().trim() !== customer.email.toLowerCase().trim()
  ) {
    conflicts.push("email");
  }

  // Check DNI conflict.
  if (
    extracted.dni &&
    customer.dni &&
    extracted.dni.replace(/\D/g, "") !== customer.dni.replace(/\D/g, "")
  ) {
    conflicts.push("dni");
  }

  return conflicts;
}
