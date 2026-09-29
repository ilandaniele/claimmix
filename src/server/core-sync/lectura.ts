/**
 * Lo que el sistema de la aseguradora lee de un caso: la forma de
 * export-to-core, compartida con `/api/v1`, que la expone con la clave.
 */

import { and, eq, sql, type AnyColumn, type SQL } from "drizzle-orm";

import { RESERVED_PREFIXES } from "@/core/phone/reserved";
import type { ClienteDatos } from "@/data/scope";
import { DOMINIO_RESERVADO } from "@/lib/email/reserved";
import { cases, claimMessages, extractedFields, missingDocs } from "@/lib/db/schema";

/**
 * ISO 8601 en UTC, con microsegundos. El driver devuelve el texto de Postgres
 * («2026-09-28 14:03:11.123+00»), que `updated_since` no acepta de vuelta; con
 * los microsegundos, el valor sirve de posición exacta para el cursor.
 */
function iso<T extends string | null = string | null>(columna: AnyColumn | SQL) {
  return sql<T>`to_char(${columna} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
}

/** Las columnas del caso con los nombres de export-to-core. */
export const columnasDelCaso = {
  case_id: cases.id,
  policy_number: cases.policy_number,
  policyholder_name: cases.policyholder_name,
  claim_type: cases.claim_type,
  status: cases.status,
  confidence_min: cases.confidence_min,
  channel: cases.channel,
  created_at: iso<string>(cases.created_at),
  updated_at: iso(cases.updated_at),
  closed_at: iso(cases.closed_at),
};

const remitente = sql`lower(btrim(coalesce(substring(${claimMessages.from_addr} from '<([^>]+)>'), ${claimMessages.from_addr})))`;
const digitos = sql`regexp_replace(${claimMessages.from_addr}, '\\D', '', 'g')`;

/**
 * Un caso de una persona, no de una simulación ni de una prueba. Los `_sim`
 * son simulados; el ensayo, el timbre y la carga entran por los canales reales
 * pero escriben desde contactos reservados. Es el mismo criterio de
 * `isReservedTestAddress` e `isReservedTestNumber`, que usa el aviso a
 * especialistas.
 */
export const esCasoReal = sql`(${cases.channel} in ('email', 'whatsapp') and not exists (
  select 1 from ${claimMessages}
  where ${claimMessages.case_id} = ${cases.id}
    and ${claimMessages.direction} = 'inbound'
    and (${remitente} ~ ${DOMINIO_RESERVADO.source}
      or ${sql.join(RESERVED_PREFIXES.map((p) => sql`${digitos} like ${`${p}%`}`), sql` or `)})
))`;

/** El caso, sus campos y sus documentos, para un solo lote de `enTenantVarias`. */
export function consultasDelCaso(db: ClienteDatos, caseId: string, filtro?: SQL) {
  return [
    db.select(columnasDelCaso).from(cases).where(and(eq(cases.id, caseId), filtro)).limit(1),
    db
      .select({
        field_key: extractedFields.field_key,
        field_value: extractedFields.field_value,
        confidence: extractedFields.confidence,
      })
      .from(extractedFields)
      .where(eq(extractedFields.case_id, caseId)),
    db
      .select({
        doc_key: missingDocs.doc_key,
        requested_at: iso(missingDocs.requested_at),
        satisfied_at: iso(missingDocs.satisfied_at),
        // Carried through separately: the core system must not read "the
        // claimant says no such report exists" as "we have the report".
        declined_at: iso(missingDocs.declined_at),
        declined_note: missingDocs.declined_note,
      })
      .from(missingDocs)
      .where(eq(missingDocs.case_id, caseId)),
  ] as const;
}

type Consultas = ReturnType<typeof consultasDelCaso>;
export type DelCaso = { -readonly [K in keyof Consultas]: Awaited<Consultas[K]> };
