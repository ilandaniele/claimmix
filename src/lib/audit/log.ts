/**
 * Audit log writer for ClaimMix.
 *
 * Every mutation writes an immutable row to audit_log.
 * This module uses the service-role client to write audit logs
 * (the service role bypasses RLS so audit writes succeed even
 * for system events where there is no authenticated user).
 *
 * PII rules:
 * - Never include DNI, license plates, policy numbers, or full names in payload.
 * - Use redactObject() from audit/redact.ts before building the payload.
 * - IP and UA are captured for forensic purposes but are not logged to stdout.
 *
 * AC1: audit log row inserted on auth.success.
 * AC3: audit log row inserted on auth.rate_limited.
 */

import { createServiceClient } from "@/lib/supabase/service";
import type { Database } from "@/lib/supabase/types";
import type { AuditPayload } from "./redact";

type AuditLogInsert = Database["public"]["Tables"]["audit_log"]["Insert"];

export interface AuditLogEntry {
  tenant_id: string;
  actor_id?: string | null;
  event_type: string;
  target_type?: string | null;
  target_id?: string | null;
  payload?: AuditPayload;
  ip?: string | null;
  ua?: string | null;
}

/**
 * Write an audit log entry.
 *
 * Uses the service-role client so the write succeeds regardless of
 * the current auth context (system events, failed auth, etc.).
 *
 * Failures are logged to stderr but never thrown — audit log writes
 * must never break the primary request flow.
 */
export async function writeAuditLog(entry: AuditLogEntry): Promise<void> {
  try {
    const supabase = createServiceClient();
    const insertRow: AuditLogInsert = {
      tenant_id: entry.tenant_id,
      actor_id: entry.actor_id ?? null,
      event_type: entry.event_type,
      target_type: entry.target_type ?? null,
      target_id: entry.target_id ?? null,
      payload: entry.payload ?? {},
      ip: entry.ip ?? null,
      ua: entry.ua ?? null,
    };
    // The Supabase typed client resolves insert() as 'never[]' when Update: never.
    // Casting to any to bypass the type bug — the insert shape is verified by AuditLogInsert above.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (supabase.from("audit_log") as any).insert(insertRow);

    if (error) {
      // Log the error code only — never the full Supabase error (may contain PII).
      console.error("[audit] Failed to write audit log:", error.code);
    }
  } catch (err) {
    const errName = err instanceof Error ? err.name : "UnknownError";
    console.error("[audit] Exception writing audit log:", errName);
  }
}

/** Common event type constants — prevents typo drift across the codebase. */
export const AuditEvent = {
  AUTH_SUCCESS: "auth.success",
  AUTH_FAILURE: "auth.failure",
  AUTH_SIGN_OUT: "auth.sign_out",
  AUTH_RATE_LIMITED: "auth.rate_limited",
  CASE_CREATED: "case.created",
  CASE_STATUS_CHANGED: "case.status_changed",
  CASE_CLOSED: "case.closed",
  CASE_ASSIGNED: "case.assigned",
  AI_EXTRACTED: "ai.extracted",
  AI_BUDGET_EXCEEDED: "ai.budget_exceeded",
  DOC_RECEIVED: "doc.received",
} as const;

export type AuditEventType = (typeof AuditEvent)[keyof typeof AuditEvent];
