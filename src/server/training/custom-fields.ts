/**
 * Tenant-defined custom fields for the claim agent.
 *
 * These are operator-managed field definitions, not code changes. Active
 * definitions are injected into the agent prompt and persisted through the
 * generic extracted_fields table via fields[].
 */

import "server-only";
import { and, asc, eq, or, isNull } from "drizzle-orm";
import { db, tables } from "@/lib/db";
import { enTenant, type TenantContext } from "@/data/scope";

export interface AgentCustomField {
  id: string;
  key: string;
  label: string;
  description: string;
  field_type: string;
  claim_type: string | null;
  required: boolean;
  ask_if_missing: boolean;
  enum_values: unknown;
  active: boolean;
}

export async function loadActiveCustomFields(
  tenantId: string,
  claimType?: string | null
): Promise<AgentCustomField[]> {
  // Las consultas de acá ya no llevan filtro por inquilino: lo pone la base.
  const tenantCtx: TenantContext = { tenantId };
  try {
    const t = tables.agentCustomFields;
    const claimFilter = claimType
      ? or(isNull(t.claim_type), eq(t.claim_type, claimType))
      : isNull(t.claim_type);

    return (await enTenant(tenantCtx, (db) =>
      db
        .select({
          id: t.id,
          key: t.key,
          label: t.label,
          description: t.description,
          field_type: t.field_type,
          claim_type: t.claim_type,
          required: t.required,
          ask_if_missing: t.ask_if_missing,
          enum_values: t.enum_values,
          active: t.active,
        })
        .from(t)
        .where(and( eq(t.active, true), claimFilter))
        .orderBy(asc(t.key))) as AgentCustomField[]
    );
  } catch (e) {
    const code = (e as { code?: string })?.code;
    if (code && code !== "42P01" && code !== "42703") {
      console.error("[custom-fields] load error:", code);
    }
    return [];
  }
}

export function formatCustomFields(fields: AgentCustomField[]): string {
  if (fields.length === 0) return "";

  return fields
    .map((field) => {
      const enumValues = Array.isArray(field.enum_values)
        ? field.enum_values.filter((v): v is string => typeof v === "string")
        : [];
      const parts = [
        `key=${field.key}`,
        `label=${field.label}`,
        `type=${field.field_type}`,
        field.claim_type ? `claim_type=${field.claim_type}` : "claim_type=all",
        field.required ? "required=true" : "required=false",
        field.ask_if_missing ? "ask_if_missing=true" : "ask_if_missing=false",
      ];
      if (enumValues.length > 0) parts.push(`enum_values=${enumValues.join("|")}`);
      if (field.description.trim()) parts.push(`description=${field.description.trim()}`);
      return `- ${parts.join("; ")}`;
    })
    .join("\n");
}
