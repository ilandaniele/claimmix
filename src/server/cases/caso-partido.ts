/** Un caso partido por un siniestro nuevo (`siniestro-nuevo`): lo que llega después ya no es suyo. */
import { sql, type SQL, type SQLWrapper } from "drizzle-orm";
import { AuditEvent } from "@/lib/audit/log";

export function fuePartido(caso: SQLWrapper): SQL {
  return sql`exists (select 1 from audit_log p where p.target_type = 'case' and p.target_id = ${caso}::text and p.event_type = ${AuditEvent.LATE_MESSAGE_SPLIT})`;
}

/** El caso donde está hoy el mensaje; espera a un corte en curso. */
export function casoDondeEstaHoy(messageId: string | null, caseId: string): SQL {
  return sql`coalesce((select m.case_id from claim_messages m where m.id = ${messageId}::uuid for share), ${caseId}::uuid)`;
}

/** Si el caso ya se partió, el caso nuevo; si no, el mismo. */
export function casoQueSigue(caseId: string): SQL {
  return sql`coalesce((select (p.payload->>'caso_nuevo')::uuid from audit_log p where p.target_type = 'case' and p.target_id = ${caseId}::text and p.event_type = ${AuditEvent.LATE_MESSAGE_SPLIT} limit 1), ${caseId}::uuid)`;
}
