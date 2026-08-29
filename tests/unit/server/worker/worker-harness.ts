/**
 * El andamiaje para levantar `runEmailExtractionWorker` en un test.
 *
 * Los cuatro archivos de test del worker tienen cada uno su propia copia de
 * esto —un `buildMockDb`, un `registerCommonMocks`, más de cien líneas cada
 * uno—. No se migraron acá porque reescribir tests verdes es justo cuando se
 * pierde cobertura sin que nadie lo note; pero el que viene nuevo no agrega una
 * quinta copia.
 *
 * No es un archivo `.test.ts` a propósito: vitest junta `tests/unit/**\/*.test.ts`,
 * así que esto se importa y no se corre solo.
 */

import { vi } from "vitest";

export interface FilaDeCaso {
  id: string;
  status: string;
  claim_type: string | null;
  tenant_id: string;
  channel: string;
  email_thread_id: string | null;
  policyholder_name: string | null;
  policy_number: string | null;
}

export function filaDeCaso(
  caseId: string,
  tenantId: string,
  cambios: Partial<FilaDeCaso> = {}
): FilaDeCaso {
  return {
    id: caseId,
    status: "recibido",
    claim_type: null,
    tenant_id: tenantId,
    channel: "email",
    email_thread_id: "thread-001",
    policyholder_name: null,
    policy_number: null,
    ...cambios,
  };
}

/**
 * Un `db` simulado que:
 *   · devuelve la fila del caso en el primer SELECT,
 *   · el mensaje crudo en el segundo,
 *   · nada en los demás,
 *   · y le pasa a `espiaDeUpdate` todo lo que se escriba con `.set(...)`.
 *
 * El orden de los dos primeros SELECT es carga estructural: el worker los hace
 * en ese orden y el mock responde por posición.
 */
export function dbSimulado(
  fila: FilaDeCaso,
  espiaDeUpdate: ReturnType<typeof vi.fn>
) {
  let n = 0;

  const mensajeCrudo = {
    body: "Buenos días, tuve un choque ayer.",
    subject: "Siniestro",
    from_addr: "asegurado@ejemplo.com",
  };

  const mockSelect = vi.fn().mockImplementation(() => {
    n++;
    const idx = n;

    const limit = vi.fn().mockImplementation(() => {
      if (idx === 1) return Promise.resolve([fila]);
      if (idx === 2) return Promise.resolve([mensajeCrudo]);
      return Promise.resolve([]);
    });
    const orderBy = vi.fn().mockReturnValue({
      limit: vi.fn().mockImplementation(() =>
        idx === 2 ? Promise.resolve([mensajeCrudo]) : Promise.resolve([])
      ),
    });
    const where = vi.fn().mockReturnValue({ limit, orderBy });

    return {
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({ limit, orderBy, where }),
        limit,
        orderBy,
        innerJoin: vi.fn().mockReturnValue({ where, limit, orderBy }),
        leftJoin: vi.fn().mockReturnValue({ where, limit, orderBy }),
      }),
    };
  });

  const cadenaUpdate = {
    set: vi.fn().mockImplementation((data: Record<string, unknown>) => {
      espiaDeUpdate(data);
      return {
        where: vi.fn().mockResolvedValue([]),
        returning: vi.fn().mockResolvedValue([]),
      };
    }),
  };

  const cadenaInsert = {
    values: vi.fn().mockReturnValue({
      onConflictDoUpdate: vi.fn().mockResolvedValue([]),
      onConflictDoNothing: vi.fn().mockResolvedValue([]),
      returning: vi.fn().mockResolvedValue([]),
      then: (r: (v: unknown) => void) => r([]),
    }),
  };

  return {
    select: mockSelect,
    update: vi.fn().mockReturnValue(cadenaUpdate),
    insert: vi.fn().mockReturnValue(cadenaInsert),
    delete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }),
  };
}

export interface OpcionesDelExtractor {
  fields?: Array<{
    field_key: string;
    field_value: string;
    confidence: number;
    source: string;
  }>;
  /** El objeto tipado que el modelo devuelve además de `fields[]`. Reemplaza. */
  extracted_fields?: Record<string, string>;
  /**
   * Se agrega encima del objeto por omisión, en vez de reemplazarlo.
   *
   * Es lo que quieren los tests que sólo cambian un dato —«y si el modelo
   * devuelve claim_type: robo»— sin tener que repetir los otros.
   */
  extracted_fields_extra?: Record<string, string | undefined>;
  missing_fields?: string[];
  fields_pending_confirmation?: string[];
  severity?: string;
  requires_specialist?: boolean;
}

/**
 * Registra todo lo que el worker necesita para correr sin tocar nada real.
 *
 * Se llama ANTES de importar el worker: `vi.doMock` no se sube al principio del
 * archivo, así que el orden importa.
 */
export function registrarMocks(opciones: {
  fila: FilaDeCaso;
  espiaDeUpdate: ReturnType<typeof vi.fn>;
  espiaDeAuditoria?: ReturnType<typeof vi.fn>;
  necesitaEspecialista?: boolean;
  /** Reemplaza el mock de `isValidTransition`. Por omisión, todo vale. */
  transicionValida?: boolean;
  extractor?: OpcionesDelExtractor;
}) {
  const {
    fila,
    espiaDeUpdate,
    espiaDeAuditoria = vi.fn().mockResolvedValue(undefined),
    necesitaEspecialista = false,
    transicionValida = true,
    extractor = {},
  } = opciones;

  const mockDb = dbSimulado(fila, espiaDeUpdate);

  vi.doMock("@/lib/db", () => ({
    db: mockDb,
    tables: { claimMemory: {}, tenantAiSettings: {} },
  }));

  /*
   * La capa de datos, corriendo contra el mismo db simulado.
   *
   * Lo que NO se prueba acá es que el contexto de inquilino llegue a la base:
   * eso no se puede simular sin mentir. Se verifica en
   * `tests/unit/data-scope-sin-rol.test.ts` y, contra bases de verdad, en
   * `pnpm capa-datos` y `pnpm tenancy`.
   */
  vi.doMock("@/data/scope", () => ({
    enTenant: (_ctx: unknown, armar: (d: unknown) => unknown) =>
      Promise.resolve(armar(mockDb)),
    enTenantVarias: (_ctx: unknown, armar: (d: unknown) => unknown[]) =>
      Promise.all(armar(mockDb)),
  }));

  vi.doMock("@/server/memory/load", () => ({
    loadMemoryHints: vi.fn().mockResolvedValue([]),
  }));

  vi.doMock("@/lib/audit/log", () => ({
    writeAuditLog: espiaDeAuditoria,
    AuditEvent: {
      EXTRACTION_COMPLETE: "claim.extraction_complete",
      SPECIALIST_REQUIRED: "claim.specialist_required",
      MEMORY_APPLIED: "claim.memory_applied",
      AI_BUDGET_EXCEEDED: "ai.budget_exceeded",
      AI_EXTRACTED: "ai.extracted",
    },
  }));

  vi.doMock("@/server/ai/budget", () => ({
    checkBudget: vi.fn().mockResolvedValue({ exceeded: false }),
    recordUsage: vi.fn().mockResolvedValue(undefined),
  }));

  // Se devuelve el espía para poder mirar con qué datos se buscó al cliente:
  // es la salida observable del solapamiento de `extracted_fields`.
  const espiaDeBusqueda = vi.fn().mockResolvedValue([]);
  vi.doMock("@/server/matching/customer-matcher", () => ({
    findCustomerMatches: espiaDeBusqueda,
  }));

  vi.doMock("@/server/matching/policy-matcher", () => ({
    findPolicyMatches: vi.fn().mockResolvedValue([]),
  }));

  vi.doMock("@/server/confirmations/orchestrate", () => ({
    orchestratePostExtraction: vi.fn().mockResolvedValue(undefined),
  }));

  vi.doMock("@/server/ai/severity-classifier", () => ({
    classifySeverity: vi.fn().mockReturnValue(necesitaEspecialista ? "high" : "medium"),
    requiresSpecialist: vi.fn().mockReturnValue(necesitaEspecialista),
  }));

  vi.doMock("@/core/case/fsm", () => ({
    isValidTransition: vi.fn().mockReturnValue(transicionValida),
  }));

  vi.doMock("@/server/ai/mock-extractor", () => ({
    runMockExtractor: vi.fn(),
    extractEmailClaimMock: vi.fn().mockReturnValue({
      extraction_model: "mock-email-v1",
      fields: extractor.fields ?? [
        { field_key: "full_name", field_value: "Juan Pérez", confidence: 0.92, source: "ai" },
        { field_key: "claim_type", field_value: "choque", confidence: 0.88, source: "ai" },
      ],
      prompt_tokens: 0,
      completion_tokens: 0,
      cost_usd: 0,
      is_claim: true,
      confidence: 0.92,
      extracted_fields: extractor.extracted_fields ?? {
        full_name: "Juan Pérez",
        claim_type: "choque",
        ...(extractor.extracted_fields_extra ?? {}),
      },
      field_confidences: { claim_type: 0.88 },
      missing_fields: extractor.missing_fields ?? [],
      fields_pending_confirmation: extractor.fields_pending_confirmation ?? [],
      possible_customer_matches: [],
      possible_policy_matches: [],
      severity: extractor.severity ?? "medium",
      requires_specialist: extractor.requires_specialist ?? false,
      not_relevant_reason: undefined,
      summary: "",
      suggested_reply: "",
    }),
  }));

  return { mockDb, espiaDeAuditoria, espiaDeBusqueda };
}

/** El `status` que quedó escrito en el caso, de todo lo que se haya escrito. */
export function statusEscrito(
  espiaDeUpdate: ReturnType<typeof vi.fn>
): string | undefined {
  const conStatus = espiaDeUpdate.mock.calls
    .map((c) => c[0] as Record<string, unknown>)
    .filter((p) => p && "status" in p);
  return conStatus.length > 0
    ? (conStatus[conStatus.length - 1].status as string)
    : undefined;
}
