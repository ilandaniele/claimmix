import "server-only";

import { and, desc, eq, isNull, or } from "drizzle-orm";

import { enTenant, type TenantContext } from "@/data/scope";
import * as tables from "@/lib/db/schema";
import type { UserRole } from "@/lib/auth/require-role";

export const AGENT_EXPORT_TYPES = ["config_only", "memory_only", "full"] as const;
export const AGENT_EXPORT_PII_MODES = ["masked", "excluded", "full_admin_only"] as const;
export const AGENT_EXPORT_FORMATS = ["json", "jsonl_approved_examples", "csv_summary"] as const;

export type AgentExportType = (typeof AGENT_EXPORT_TYPES)[number];
export type AgentExportPiiMode = (typeof AGENT_EXPORT_PII_MODES)[number];
export type AgentExportFormat = (typeof AGENT_EXPORT_FORMATS)[number];

export interface AgentExportRequest {
  exportType: AgentExportType;
  format: AgentExportFormat;
  piiMode: AgentExportPiiMode;
}

type JsonRecord = Record<string, unknown>;

function firstRow<T>(rows: T[]): T | null {
  return rows[0] ?? null;
}

function getExportDefaultProvider(): "openai" | "gemini" {
  const provider = process.env.AI_PROVIDER?.trim().toLowerCase();
  return provider === "openai" || provider === "gemini" ? provider : "gemini";
}

function toProvider(value: unknown): "openai" | "gemini" | null {
  return value === "openai" || value === "gemini" ? value : null;
}

function getExportDefaultOpenAIModel(): string {
  return process.env.OPENAI_MODEL ?? "gpt-4o-mini";
}

function getExportDefaultGeminiModel(): string {
  return process.env.GEMINI_MODEL ?? "gemini-flash-latest";
}

export function normalizeAgentExportFormat(raw: string | null): AgentExportFormat | null {
  if (raw === "json") return "json";
  if (raw === "jsonl" || raw === "jsonl_approved_examples") {
    return "jsonl_approved_examples";
  }
  if (raw === "csv" || raw === "csv_summary") return "csv_summary";
  return null;
}

export function canExportAgentData(role: UserRole, request: AgentExportRequest): boolean {
  if (role === "owner" || role === "admin") return true;
  if (role !== "specialist") return false;
  if (request.piiMode === "full_admin_only") return false;

  return (
    request.exportType === "memory_only" &&
    (request.format === "jsonl_approved_examples" || request.format === "csv_summary")
  );
}

const SECRET_KEY_RE =
  /(^|_)(api[_-]?key|token|secret|credential|password|client[_-]?secret|service[_-]?role|webhook[_-]?secret|oauth|refresh[_-]?token|access[_-]?token|gemini[_-]?api[_-]?key[_-]?encrypted)($|_)/i;

const SENSITIVE_KEY_RE =
  /(^|_)(dni|document|documento|policy[_-]?number|poliza|email|mail|phone|telefono|address|direccion|location|ubicacion|bank|banco|cbu|cvu|iban|account|cuenta|from[_-]?addr|to[_-]?addr|sender[_-]?email|policyholder[_-]?name|full[_-]?name)($|_)/i;

const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const DNI_RE = /\b\d{1,3}\.?\d{3}\.?\d{3}\b/g;
const POLICY_RE = /\b(?:POL|POLIZA)-?[A-Z0-9-]*\d{3,}\b/gi;
const BANK_RE = /\b(?:CBU|CVU|IBAN|CUENTA)\s*[:#-]?\s*[A-Z0-9-]{8,34}\b/gi;
const PHONE_RE = /(?<!\w)(?:\+?\d[\d .()/-]{7,}\d)(?!\w)/g;

function isObject(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isSecretKey(key: string): boolean {
  return SECRET_KEY_RE.test(key);
}

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_RE.test(key);
}

function maskDni(value: string): string {
  const digits = value.replace(/\D/g, "");
  if (digits.length <= 4) return "****";
  return `****${digits.slice(-4)}`;
}

function maskPolicy(value: string): string {
  const trimmed = value.trim();
  const prefixMatch = trimmed.match(/^[A-Za-z]+-?/);
  const prefix = prefixMatch?.[0] ?? "";
  const tail = trimmed.replace(/\W/g, "").slice(-3);
  return `${prefix || ""}***${tail || ""}`;
}

function maskEmail(value: string): string {
  const [local = "", domain = ""] = value.split("@");
  if (!domain) return "[email_masked]";
  return `${local.charAt(0) || "*"}***@${domain}`;
}

function maskPhone(value: string): string {
  const compact = value.replace(/[^\d+]/g, "");
  if (compact.length <= 6) return "****";
  const prefix = compact.startsWith("+") ? compact.slice(0, 4) : compact.slice(0, 2);
  return `${prefix}****${compact.slice(-4)}`;
}

function maskStringPatterns(value: string): string {
  return value
    .replace(EMAIL_RE, (match) => maskEmail(match))
    .replace(POLICY_RE, (match) => maskPolicy(match))
    .replace(DNI_RE, (match) => maskDni(match))
    .replace(BANK_RE, "[bank_data_masked]")
    .replace(PHONE_RE, (match) => maskPhone(match));
}

function excludeStringPatterns(value: string): string {
  return value
    .replace(EMAIL_RE, "[email_excluded]")
    .replace(POLICY_RE, "[policy_excluded]")
    .replace(DNI_RE, "[dni_excluded]")
    .replace(BANK_RE, "[bank_data_excluded]")
    .replace(PHONE_RE, "[phone_excluded]");
}

function maskByKey(key: string, value: string): string {
  const normalized = key.toLowerCase();

  // El nombre se pregunta PRIMERO, y no es capricho de orden.
  //
  // `policyholder_name` contiene "policy". Cuando la pregunta por póliza iba
  // antes, el nombre del asegurado se enmascaraba con la regla de los números
  // de póliza —prefijo de letras + tres caracteres del final— y "Roberto Paz"
  // salía del sistema como "Roberto***Paz". El nombre de pila entero y las
  // últimas tres letras del apellido: en un padrón de una ciudad chica, eso es
  // la persona.
  //
  // No hay clave que lleve "name" y deba enmascararse como otra cosa, así que
  // la pregunta va arriba de todo.
  if (normalized.includes("name")) return "[name_masked]";

  if (normalized.includes("dni") || normalized.includes("document")) return maskDni(value);
  if (normalized.includes("policy") || normalized.includes("poliza")) {
    return maskPolicy(value);
  }
  if (normalized.includes("phone") || normalized.includes("telefono")) {
    return maskPhone(value);
  }
  if (
    normalized.includes("address") ||
    normalized.includes("direccion") ||
    normalized.includes("location") ||
    normalized.includes("ubicacion")
  ) {
    return "[address_masked]";
  }
  if (
    normalized.includes("email") ||
    normalized.includes("mail") ||
    normalized === "from_addr" ||
    normalized === "to_addr"
  ) {
    return maskEmail(value);
  }
  if (
    normalized.includes("bank") ||
    normalized.includes("banco") ||
    normalized.includes("cbu") ||
    normalized.includes("cvu") ||
    normalized.includes("iban") ||
    normalized.includes("account") ||
    normalized.includes("cuenta")
  ) {
    return "[bank_data_masked]";
  }
  return maskStringPatterns(value);
}

function sanitizeForPii(
  value: unknown,
  piiMode: AgentExportPiiMode,
  canExportFullPii: boolean,
  key = ""
): unknown {
  if (key && isSecretKey(key)) return undefined;
  if (piiMode === "excluded" && key && isSensitiveKey(key)) return undefined;

  if (Array.isArray(value)) {
    return value
      .map((item) => sanitizeForPii(item, piiMode, canExportFullPii))
      .filter((item) => item !== undefined);
  }

  if (isObject(value)) {
    const out: JsonRecord = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      const sanitized = sanitizeForPii(childValue, piiMode, canExportFullPii, childKey);
      if (sanitized !== undefined) out[childKey] = sanitized;
    }
    return out;
  }

  if (typeof value !== "string") return value;

  if (piiMode === "full_admin_only" && canExportFullPii) return value;
  if (key && isSensitiveKey(key)) return maskByKey(key, value);
  return piiMode === "excluded" ? excludeStringPatterns(value) : maskStringPatterns(value);
}

export function sanitizeExportPayload<T>(
  payload: T,
  piiMode: AgentExportPiiMode,
  canExportFullPii: boolean
): T {
  return sanitizeForPii(payload, piiMode, canExportFullPii) as T;
}

export interface ApprovedExampleExportRow {
  id: string;
  tenant_id?: string;
  agent_run_id: string;
  case_id: string | null;
  claim_message_id: string | null;
  claim_type: string | null;
  input_payload: unknown;
  expected_output: unknown;
  status: string;
  approved_by: string | null;
  approved_at: string | null;
  created_at: string;
  severity?: string | null;
  case_status?: string | null;
  trainability_score?: string | number | null;
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = String(value);
  if (!/[",\n\r]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

export function buildApprovedExamplesJsonl(
  tenantId: string,
  examples: ApprovedExampleExportRow[],
  piiMode: AgentExportPiiMode,
  canExportFullPii: boolean
): string {
  return examples
    .filter((example) => example.status === "approved")
    .map((example) => {
      const line = {
        input: example.input_payload ?? {},
        expected_output: example.expected_output ?? {},
        metadata: {
          tenant_id: tenantId,
          example_id: example.id,
          approved_at: example.approved_at,
          approved_by: example.approved_by,
          source: {
            claim_id: example.case_id,
            claim_message_id: example.claim_message_id,
            agent_run_id: example.agent_run_id,
          },
          claim_type: example.claim_type,
        },
      };
      return JSON.stringify(sanitizeExportPayload(line, piiMode, canExportFullPii));
    })
    .join("\n");
}

export function buildApprovedExamplesCsvSummary(examples: ApprovedExampleExportRow[]): string {
  const headers = [
    "example_id",
    "claim_id",
    "claim_type",
    "severity",
    "status",
    "trainability_score",
    "approved_by",
    "approved_at",
  ];
  const rows = examples
    .filter((example) => example.status === "approved")
    .map((example) => [
      example.id,
      example.case_id,
      example.claim_type,
      example.severity ?? "",
      example.case_status ?? "",
      example.trainability_score ?? "",
      example.approved_by,
      example.approved_at,
    ]);

  return [headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\n");
}

async function loadProviderSettings(tenantId: string) {
  // Las consultas de acá ya no llevan filtro por inquilino: lo pone la base.
  const tenantCtx: TenantContext = { tenantId };
  const t = tables.tenantAiSettings;
  const row = firstRow(
    await enTenant(tenantCtx, (db) =>
      db
        .select({
          tenant_id: t.tenant_id,
          provider: t.provider,
          openai_model: t.openai_model,
          gemini_model: t.gemini_model,
          active_model_provider: t.active_model_provider,
          active_model: t.active_model,
          previous_model: t.previous_model,
          model_activated_by: t.model_activated_by,
          model_activated_at: t.model_activated_at,
          updated_at: t.updated_at,
        })
        .from(t)
        .limit(1)
    )
  );

  const defaultProvider = toProvider(row?.provider) ?? getExportDefaultProvider();
  const activeModelProvider = toProvider(row?.active_model_provider) ?? defaultProvider;
  const activeModel =
    row?.active_model ??
    (activeModelProvider === "openai"
      ? row?.openai_model ?? getExportDefaultOpenAIModel()
      : row?.gemini_model ?? getExportDefaultGeminiModel());

  return {
    provider: {
      default_provider: defaultProvider,
      active_model: activeModel,
      active_model_provider: activeModelProvider,
      fallback_provider: defaultProvider === "gemini" ? "openai" : "gemini",
      fallback_enabled: false,
    },
    model_settings: {
      provider: defaultProvider,
      openai_model: row?.openai_model ?? getExportDefaultOpenAIModel(),
      gemini_model: row?.gemini_model ?? getExportDefaultGeminiModel(),
      active_model_provider: activeModelProvider,
      active_model: activeModel,
      previous_model: row?.previous_model ?? null,
      model_activated_by: row?.model_activated_by ?? null,
      model_activated_at: row?.model_activated_at ?? null,
      updated_at: row?.updated_at ?? null,
    },
  };
}

async function loadConfigSection(tenantId: string) {
  // Las consultas de acá ya no llevan filtro por inquilino: lo pone la base.
  const tenantCtx: TenantContext = { tenantId };
  const [providerSettings, promptVersions, customFields, promptRules] = await Promise.all([
    loadProviderSettings(tenantId),
    enTenant(tenantCtx, (db) =>
      db
        .select({
          id: tables.promptVersions.id,
          version: tables.promptVersions.version,
          system_prompt: tables.promptVersions.system_prompt,
          active: tables.promptVersions.active,
          created_by: tables.promptVersions.created_by,
          created_at: tables.promptVersions.created_at,
        })
        .from(tables.promptVersions)
        .orderBy(desc(tables.promptVersions.created_at))
    ),
    enTenant(tenantCtx, (db) =>
      db
        .select({
          id: tables.agentCustomFields.id,
          key: tables.agentCustomFields.key,
          label: tables.agentCustomFields.label,
          description: tables.agentCustomFields.description,
          field_type: tables.agentCustomFields.field_type,
          claim_type: tables.agentCustomFields.claim_type,
          required: tables.agentCustomFields.required,
          ask_if_missing: tables.agentCustomFields.ask_if_missing,
          enum_values: tables.agentCustomFields.enum_values,
          active: tables.agentCustomFields.active,
          created_by: tables.agentCustomFields.created_by,
          created_at: tables.agentCustomFields.created_at,
          updated_at: tables.agentCustomFields.updated_at,
        })
        .from(tables.agentCustomFields)
        .orderBy(desc(tables.agentCustomFields.created_at))
    ),
    enTenant(tenantCtx, (db) =>
      db
        .select({
          id: tables.agentPromptRules.id,
          title: tables.agentPromptRules.title,
          rule_text: tables.agentPromptRules.rule_text,
          rule_type: tables.agentPromptRules.rule_type,
          active: tables.agentPromptRules.active,
          created_by: tables.agentPromptRules.created_by,
          created_at: tables.agentPromptRules.created_at,
          updated_at: tables.agentPromptRules.updated_at,
        })
        .from(tables.agentPromptRules)
        .orderBy(desc(tables.agentPromptRules.created_at))
    ),
  ]);

  return {
    ...providerSettings,
    prompt_versions: promptVersions,
    custom_fields: customFields,
    prompt_rules: promptRules,
  };
}

async function loadApprovedExampleRows(tenantId: string) {
  // Las consultas de acá ya no llevan filtro por inquilino: lo pone la base.
  const tenantCtx: TenantContext = { tenantId };
  const t = tables.trainingExamples;
  const c = tables.cases;
  const r = tables.agentRuns;
  return (await enTenant(tenantCtx, (db) =>
    db
      .select({
        id: t.id,
        tenant_id: t.tenant_id,
        agent_run_id: t.agent_run_id,
        case_id: t.case_id,
        claim_message_id: t.claim_message_id,
        claim_type: t.claim_type,
        input_payload: t.input_payload,
        expected_output: t.expected_output,
        status: t.status,
        approved_by: t.approved_by,
        approved_at: t.approved_at,
        created_at: t.created_at,
        severity: c.severity,
        case_status: c.status,
        trainability_score: r.trainability_score,
      })
      .from(t)
      .leftJoin(c, eq(c.id, t.case_id))
      .leftJoin(r, eq(r.id, t.agent_run_id))
      .where(eq(t.status, "approved"))
      .orderBy(desc(t.approved_at))) as ApprovedExampleExportRow[]
  );
}

async function loadTrainingExamples(tenantId: string, status: "approved" | "rejected") {
  // Las consultas de acá ya no llevan filtro por inquilino: lo pone la base.
  const tenantCtx: TenantContext = { tenantId };
  const t = tables.trainingExamples;
  return enTenant(tenantCtx, (db) =>
    db
      .select({
        id: t.id,
        agent_run_id: t.agent_run_id,
        case_id: t.case_id,
        claim_message_id: t.claim_message_id,
        claim_type: t.claim_type,
        input_payload: t.input_payload,
        expected_output: t.expected_output,
        status: t.status,
        approved_by: t.approved_by,
        approved_at: t.approved_at,
        created_at: t.created_at,
      })
      .from(t)
      .where(eq(t.status, status))
      .orderBy(desc(t.approved_at))
  );
}

async function loadMemorySection(tenantId: string) {
  // Las consultas de acá ya no llevan filtro por inquilino: lo pone la base.
  const tenantCtx: TenantContext = { tenantId };
  const [
    approvedTrainingExamples,
    rejectedTrainingExamples,
    agentFeedback,
    claimMemory,
    knownClaimPatterns,
  ] = await Promise.all([
    loadTrainingExamples(tenantId, "approved"),
    loadTrainingExamples(tenantId, "rejected"),
    enTenant(tenantCtx, (db) =>
      db
        .select({
          id: tables.agentFeedback.id,
          agent_run_id: tables.agentFeedback.agent_run_id,
          reviewer_id: tables.agentFeedback.reviewer_id,
          original_output: tables.agentFeedback.original_output,
          corrected_output: tables.agentFeedback.corrected_output,
          feedback_type: tables.agentFeedback.feedback_type,
          approved_for_training: tables.agentFeedback.approved_for_training,
          created_at: tables.agentFeedback.created_at,
        })
        .from(tables.agentFeedback)
        .orderBy(desc(tables.agentFeedback.created_at))
    ),
    enTenant(tenantCtx, (db) =>
      db
        .select({
          id: tables.claimMemory.id,
          memory_type: tables.claimMemory.memory_type,
          key: tables.claimMemory.key,
          value: tables.claimMemory.value,
          confidence: tables.claimMemory.confidence,
          source: tables.claimMemory.source,
          last_used_at: tables.claimMemory.last_used_at,
          use_count: tables.claimMemory.use_count,
          created_at: tables.claimMemory.created_at,
          updated_at: tables.claimMemory.updated_at,
        })
        .from(tables.claimMemory)
        .orderBy(desc(tables.claimMemory.updated_at))
    ),
    enTenant(tenantCtx, (db) =>
      db
        .select({
          id: tables.knownClaimPatterns.id,
          tenant_id: tables.knownClaimPatterns.tenant_id,
          pattern_text: tables.knownClaimPatterns.pattern_text,
          pattern_type: tables.knownClaimPatterns.pattern_type,
          claim_type: tables.knownClaimPatterns.claim_type,
          severity_hint: tables.knownClaimPatterns.severity_hint,
          language: tables.knownClaimPatterns.language,
          enabled: tables.knownClaimPatterns.enabled,
          created_at: tables.knownClaimPatterns.created_at,
        })
        .from(tables.knownClaimPatterns)
        .where(
          and(
            or(isNull(tables.knownClaimPatterns.tenant_id), eq(tables.knownClaimPatterns.tenant_id, tenantId)),
            eq(tables.knownClaimPatterns.enabled, true)
          )
        )
        .orderBy(desc(tables.knownClaimPatterns.created_at))
    ),
  ]);

  return {
    approved_training_examples: approvedTrainingExamples,
    rejected_training_examples: rejectedTrainingExamples,
    agent_feedback: agentFeedback,
    claim_memory: claimMemory,
    known_claim_patterns: knownClaimPatterns.map((pattern) => ({
      ...pattern,
      scope: pattern.tenant_id ? "tenant" : "global",
    })),
  };
}

async function loadFullMetadata(tenantId: string) {
  // Las consultas de acá ya no llevan filtro por inquilino: lo pone la base.
  const tenantCtx: TenantContext = { tenantId };
  const [agentRuns, claimEvents] = await Promise.all([
    enTenant(tenantCtx, (db) =>
      db
        .select({
          id: tables.agentRuns.id,
          case_id: tables.agentRuns.case_id,
          claim_message_id: tables.agentRuns.claim_message_id,
          model_provider: tables.agentRuns.model_provider,
          model_name: tables.agentRuns.model_name,
          prompt_version_id: tables.agentRuns.prompt_version_id,
          prompt_version: tables.agentRuns.prompt_version,
          missing_fields: tables.agentRuns.missing_fields,
          is_trainable_suggestion: tables.agentRuns.is_trainable_suggestion,
          trainability_score: tables.agentRuns.trainability_score,
          trainability_reasons: tables.agentRuns.trainability_reasons,
          blocking_reasons: tables.agentRuns.blocking_reasons,
          created_at: tables.agentRuns.created_at,
        })
        .from(tables.agentRuns)
        .orderBy(desc(tables.agentRuns.created_at))
        .limit(500)
    ),
    enTenant(tenantCtx, (db) =>
      db
        .select({
          id: tables.auditLog.id,
          event_type: tables.auditLog.event_type,
          target_type: tables.auditLog.target_type,
          target_id: tables.auditLog.target_id,
          payload: tables.auditLog.payload,
          created_at: tables.auditLog.created_at,
        })
        .from(tables.auditLog)
        .orderBy(desc(tables.auditLog.created_at))
        .limit(500)
    ),
  ]);

  return { agent_runs: agentRuns, claim_events: claimEvents };
}

export async function loadApprovedExamplesForExport(
  tenantId: string,
  piiMode: AgentExportPiiMode,
  canExportFullPii: boolean
): Promise<ApprovedExampleExportRow[]> {
  const rows = await loadApprovedExampleRows(tenantId);
  return sanitizeExportPayload(rows, piiMode, canExportFullPii);
}

export async function buildAgentMemoryConfigExport(params: {
  tenantId: string;
  exportedBy: string;
  exportType: AgentExportType;
  piiMode: AgentExportPiiMode;
  canExportFullPii: boolean;
}) {
  const { tenantId, exportedBy, exportType, piiMode, canExportFullPii } = params;
  const includeConfig = exportType === "config_only" || exportType === "full";
  const includeMemory = exportType === "memory_only" || exportType === "full";

  const [providerSettings, config, memory, metadata] = await Promise.all([
    includeConfig ? Promise.resolve(null) : loadProviderSettings(tenantId),
    includeConfig ? loadConfigSection(tenantId) : Promise.resolve(null),
    includeMemory ? loadMemorySection(tenantId) : Promise.resolve(null),
    exportType === "full" ? loadFullMetadata(tenantId) : Promise.resolve(null),
  ]);

  const provider = config?.provider ?? providerSettings?.provider;
  const modelSettings = config?.model_settings ?? providerSettings?.model_settings;

  const base = {
    schema_version: "1.0",
    export_type: "gemini_agent_memory_config",
    tenant_id: tenantId,
    exported_at: new Date().toISOString(),
    exported_by: exportedBy,
    provider,
    prompt_versions: config?.prompt_versions ?? [],
    custom_fields: config?.custom_fields ?? [],
    prompt_rules: config?.prompt_rules ?? [],
    approved_training_examples: memory?.approved_training_examples ?? [],
    rejected_training_examples: memory?.rejected_training_examples ?? [],
    agent_feedback: memory?.agent_feedback ?? [],
    claim_memory: memory?.claim_memory ?? [],
    known_claim_patterns: memory?.known_claim_patterns ?? [],
    model_settings: modelSettings ?? {},
    export_options: {
      pii_mode: piiMode,
      include_raw_emails: false,
      include_agent_runs: exportType === "full",
      include_feedback: includeMemory,
    },
    ...(metadata ?? {}),
  };

  return sanitizeExportPayload(base, piiMode, canExportFullPii);
}
