/**
 * Zod schemas for cases API routes.
 *
 * Validated at every API boundary — server-side only.
 */

import { z } from "zod";

import { camposDePagina } from "@/lib/schemas/paginacion";

/** Allowed claim types */
export const ClaimTypeSchema = z.enum([
  "choque",
  "robo",
  "granizo",
  "incendio",
  "cristales",        // windshield / glass damage
  "rc",               // responsabilidad civil — third-party liability
  "robo_contenido",   // theft of belongings from inside the vehicle
  "accidente_personal", // personal injury (occupant, pedestrian)
  "other",
]);
export type ClaimType = z.infer<typeof ClaimTypeSchema>;

/**
 * Original case statuses (existing FNOL simulate flow).
 * Kept as a sub-union for backward compatibility with existing code.
 */
export const CaseStatusLegacySchema = z.enum([
  "procesando",
  "listo",
  "esperando",
  "escalado",
  "cerrado",
]);
export type CaseStatusLegacy = z.infer<typeof CaseStatusLegacySchema>;

/**
 * New email-intake FSM statuses added in 0005_email_intake.sql (IC6).
 * Mapped from spec English names to es-AR Spanish for consistency with
 * existing statuses (procesando, listo, esperando, escalado, cerrado).
 *
 * English → Spanish mapping (documented inline):
 *   received             → recibido
 *   missing_info         → info_faltante
 *   pending_confirmation → confirmacion_pendiente
 *   requires_specialist  → requiere_especialista
 *   ready_for_core       → listo_para_core
 *   sent_to_core         → enviado_a_core
 *   core_error           → error_core
 *   not_relevant         → no_relevante
 */
export const CaseStatusEmailSchema = z.enum([
  "recibido",
  "info_faltante",
  "confirmacion_pendiente",
  "requiere_especialista",
  "listo_para_core",
  "enviado_a_core",
  "error_core",
  "no_relevante",
]);
export type CaseStatusEmail = z.infer<typeof CaseStatusEmailSchema>;

/** All allowed case statuses (legacy + email-intake) */
export const CaseStatusSchema = z.enum([
  // Original statuses
  "procesando",
  "listo",
  "esperando",
  "escalado",
  "cerrado",
  // Email-intake statuses
  "recibido",
  "info_faltante",
  "confirmacion_pendiente",
  "requiere_especialista",
  "listo_para_core",
  "enviado_a_core",
  "error_core",
  "no_relevante",
]);
export type CaseStatus = z.infer<typeof CaseStatusSchema>;

/**
 * Claim severity levels — set by the severity classifier.
 * Maps to the CHECK constraint in 0005_email_intake.sql.
 */
export const SeveritySchema = z.enum(["low", "medium", "high", "critical"]);
export type Severity = z.infer<typeof SeveritySchema>;

/** Allowed sort columns — whitelist prevents SQL injection via sort param */
export const SortColumnSchema = z.enum(["created_at", "confidence_min", "status"]);
export type SortColumn = z.infer<typeof SortColumnSchema>;

/**
 * Convierte un campo en lista, aceptando un valor suelto o varios.
 *
 * Repetido en la URL (`?type=choque&type=robo`) y no separado por comas:
 * `URLSearchParams` ya sabe juntar valores repetidos en un array, así que no
 * hace falta parsear nada a mano. Y un solo valor (`?type=choque`) queda
 * byte a byte igual que hoy — un bookmark viejo con un filtro sigue andando.
 * Vacío (`""`, `[]`) o ausente da `undefined`; cualquier valor inválido tira
 * abajo el parámetro entero, como ya pasaba con uno solo.
 */
const listaDe = <T extends z.ZodTypeAny>(v: T) =>
  z.preprocess((x) => {
    if (x === undefined) return undefined;
    const lista = (Array.isArray(x) ? x : [x]).filter((s) => s !== "");
    return lista.length === 0 ? undefined : lista;
  }, z.array(v).nonempty().optional());

/** GET /api/cases query parameters (extended with email-intake filters) */
export const CaseQuerySchema = z.object({
  status: listaDe(CaseStatusSchema),
  type: listaDe(ClaimTypeSchema),
  /*
   * Tres caracteres es lo que el índice necesita para servir de algo.
   *
   * `q` entra a un `ilike '%…%'` sobre `policyholder_name` y `policy_number`,
   * y los dos índices que lo sostienen son trigram (0020): pg_trgm parte el
   * texto en grupos de TRES. Con uno o dos caracteres no hay ningún grupo que
   * buscar, el planificador descarta el índice y recorre la tabla entera del
   * inquilino. `?q=a` es una petición barata que cuesta una lectura completa.
   *
   * Nadie lo manda desde la interfaz: `q` sólo existe en la API y en el CSV.
   * Un 400 acá no le cambia nada a nadie que hoy esté buscando.
   */
  q: z.string().min(3).max(200).optional(),
  ...camposDePagina,
  sort: SortColumnSchema.default("created_at"),
  order: z.enum(["asc", "desc"]).default("desc"),
  // Email-intake filters (AC18)
  severity: listaDe(SeveritySchema),
  customer_id: z.string().uuid().optional(),
  policy_id: z.string().uuid().optional(),
  channel: listaDe(z.enum(["email_sim", "email", "whatsapp_sim", "whatsapp"])),
  is_claim: z.enum(["true", "false"]).transform((v) => v === "true").optional(),
  // Sólo `true` filtra: «los que no están para responder» no es una sección.
  // Cualquier otro valor se ignora, como en `bandeja/page.tsx`: un 400 acá
  // rompía el sondeo y el CSV de una página que sí se veía.
  para_responder: z
    .string()
    .optional()
    .transform((v) => (v === "true" ? true : undefined)),
  // «Mi cola»: nunca acepta un id de usuario por la query, sólo esta marca.
  // Quién es «mi» lo resuelve el servidor con la sesión.
  cola: z.literal("mia").optional(),
});

export type CaseQuery = z.infer<typeof CaseQuerySchema>;

/** PATCH /api/cases/:id request body */
export const CasePatchSchema = z
  .object({
    status: CaseStatusSchema.optional(),
    assigned_to: z.string().uuid("ID de analista inválido.").optional().nullable(),
    reason: z.string().max(500).optional(),
    confirmar_listo: z.literal(true).optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: "Se requiere al menos un campo para actualizar.",
  })
  .refine((d) => !(d.confirmar_listo && d.assigned_to !== undefined), {
    message: "Confirmar y asignar van por separado.",
  });

export type CasePatch = z.infer<typeof CasePatchSchema>;

/**
 * PATCH /api/cases/:id/confirm-field request body (AC16, AC21).
 * Analyst confirms, rejects, or corrects an AI-extracted field.
 */
export const ConfirmFieldSchema = z.object({
  field_key: z.string().min(1).max(100),
  value: z.string().max(2000).nullable(),
  action: z.enum(["confirm", "correct", "reject"]),
});

export type ConfirmField = z.infer<typeof ConfirmFieldSchema>;

/**
 * POST /api/cases/:id/sync-to-core request body (AC17).
 * Triggers CoreSyncService for a case that is listo_para_core.
 * force=true bypasses the status precondition check (admin only).
 */
export const SyncToCoreSchema = z.object({
  force: z.boolean().optional().default(false),
});

export type SyncToCore = z.infer<typeof SyncToCoreSchema>;

/**
 * Extended case type including email-intake columns added in 0005 and 0006.
 * Used in route handler return types and UI components.
 * This is a TypeScript-only type — the DB row type comes from Database["public"]["Tables"]["cases"]["Row"].
 */
export interface EmailCase {
  id: string;
  tenant_id: string;
  policy_number: string | null;
  policyholder_name: string | null;
  claim_type: ClaimType;
  status: CaseStatus;
  confidence_min: number | null;
  assigned_to: string | null;
  channel: "email_sim" | "email" | "whatsapp_sim" | "whatsapp";
  created_at: string;
  updated_at: string | null;
  closed_at: string | null;
  // Email-intake columns (0005)
  email_message_id: string | null;
  email_thread_id: string | null;
  is_claim: boolean | null;
  not_relevant_reason: string | null;
  requires_specialist: boolean;
  severity: Severity | null;
  core_external_id: string | null;
  core_error_message: string | null;
  core_sent_at: string | null;
  /**
   * When the agent last successfully wrote back to the claimant, on whatever
   * channel the case came in on. Null means nobody has answered them yet.
   *
   * Derived from outbound_messages rather than stored on the case, so it can
   * never drift from what was actually sent. An analyst looking at the inbox
   * needs this at a glance: a claim sitting unanswered for a day is a very
   * different problem from one that was acknowledged and is simply waiting.
   */
  replied_at: string | null;
  fields_pending_confirmation: string[];
  // Customer/policy FK columns (0006)
  customer_id: string | null;
  policy_id: string | null;
}
