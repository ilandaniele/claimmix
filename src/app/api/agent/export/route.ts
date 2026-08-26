/**
 * GET /api/agent/export
 *
 * Download provider-aware Gemini/OpenAI agent configuration and memory.
 * Tenant boundary is enforced through the authenticated users.tenant_id.
 */

import { NextResponse } from "next/server";
import { z } from "zod";

import { requireRole, ALL_ROLES } from "@/lib/auth/require-role";
import { AuditEvent, writeAuditLog } from "@/lib/audit/log";
import { err } from "@/lib/api/respond";
import { AppError } from "@/lib/errors";
import {
  AGENT_EXPORT_PII_MODES,
  AGENT_EXPORT_TYPES,
  buildAgentMemoryConfigExport,
  buildApprovedExamplesCsvSummary,
  buildApprovedExamplesJsonl,
  canExportAgentData,
  loadApprovedExamplesForExport,
  normalizeAgentExportFormat,
  type AgentExportFormat,
  type AgentExportPiiMode,
  type AgentExportType,
} from "@/server/agents/export";

export const dynamic = "force-dynamic";

const ExportTypeSchema = z.enum(AGENT_EXPORT_TYPES);
const PiiModeSchema = z.enum(AGENT_EXPORT_PII_MODES);

function parseQuery(request: Request): {
  exportType: AgentExportType;
  format: AgentExportFormat;
  piiMode: AgentExportPiiMode;
} {
  const url = new URL(request.url);
  const exportType = ExportTypeSchema.safeParse(url.searchParams.get("type") ?? "full");
  const piiMode = PiiModeSchema.safeParse(url.searchParams.get("pii_mode") ?? "masked");
  const format = normalizeAgentExportFormat(url.searchParams.get("format") ?? "json");

  if (!exportType.success || !piiMode.success || !format) {
    throw new AppError("VALIDATION_FAILED", "Parametros de exportacion invalidos.");
  }

  return {
    exportType: exportType.data,
    format,
    piiMode: piiMode.data,
  };
}

function contentTypeFor(format: AgentExportFormat): string {
  if (format === "jsonl_approved_examples") return "application/jsonl; charset=utf-8";
  if (format === "csv_summary") return "text/csv; charset=utf-8";
  return "application/json; charset=utf-8";
}

function extensionFor(format: AgentExportFormat): string {
  if (format === "jsonl_approved_examples") return "jsonl";
  if (format === "csv_summary") return "csv";
  return "json";
}

function safeTimestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function clientIp(request: Request): string | null {
  const forwarded = request.headers.get("x-forwarded-for");
  return forwarded?.split(",")[0]?.trim() || null;
}

export async function GET(request: Request) {
  try {
    const parsed = parseQuery(request);
    const { user, userRow } = await requireRole(...ALL_ROLES);
    const canExportFullPii = userRow.role === "owner" || userRow.role === "admin";

    if (!canExportAgentData(userRow.role, parsed)) {
      throw new AppError("FORBIDDEN_ROLE");
    }
    if (parsed.piiMode === "full_admin_only" && !canExportFullPii) {
      throw new AppError("FORBIDDEN_ROLE");
    }

    let content: string;
    if (parsed.format === "json") {
      const exportPayload = await buildAgentMemoryConfigExport({
        tenantId: userRow.tenant_id,
        exportedBy: user.id,
        exportType: parsed.exportType,
        piiMode: parsed.piiMode,
        canExportFullPii,
      });
      content = JSON.stringify(exportPayload, null, 2);
    } else {
      const examples = await loadApprovedExamplesForExport(
        userRow.tenant_id,
        parsed.piiMode,
        canExportFullPii
      );
      content =
        parsed.format === "jsonl_approved_examples"
          ? buildApprovedExamplesJsonl(
              userRow.tenant_id,
              examples,
              parsed.piiMode,
              canExportFullPii
            )
          : buildApprovedExamplesCsvSummary(examples);
    }

    await writeAuditLog({
      tenant_id: userRow.tenant_id,
      actor_id: user.id,
      event_type: AuditEvent.AGENT_MEMORY_CONFIG_EXPORTED,
      target_type: "agent_export",
      target_id: userRow.tenant_id,
      payload: {
        export_type: parsed.exportType,
        format: parsed.format,
        pii_mode: parsed.piiMode,
        include_raw_emails: false,
        full_pii_allowed: parsed.piiMode === "full_admin_only" && canExportFullPii,
      },
      ip: clientIp(request),
      ua: request.headers.get("user-agent"),
    });

    const filename = `claimmix-agent-${parsed.exportType}-${parsed.format}-${safeTimestamp()}.${extensionFor(parsed.format)}`;
    return new NextResponse(content, {
      headers: {
        "content-type": contentTypeFor(parsed.format),
        "content-disposition": `attachment; filename="${filename}"`,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (e) {
    return err(e);
  }
}
