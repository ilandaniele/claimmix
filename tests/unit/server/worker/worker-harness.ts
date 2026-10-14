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

import { vi, type Mock } from "vitest";
import type { Cabecera } from "@/core/email/autenticacion";
import { puenteDeAlcance } from "../../../mocks/puente-de-alcance";

export interface FilaDeCaso {
  id: string;
  status: string;
  claim_type: string | null;
  tenant_id: string;
  channel: string;
  email_thread_id: string | null;
  policyholder_name: string | null;
  policy_number: string | null;
  /** La tabla de montos del tenant, que el worker lee en el mismo SELECT del caso. */
  rangos_de_monto?: unknown;
  /** Lo que el equipo configuró (B9, B10, B11, B13): también sale en el SELECT del caso. */
  reglas_asignacion?: unknown;
  plazos_propios?: unknown;
  plan_por_tipo?: unknown;
  pesos_puntaje?: unknown;
  created_at?: string;
  /** Lo que la base ya tiene del caso: un presupuesto leído se guarda con `origen: "presupuesto"`. */
  monto_estimado?: unknown;
  severity?: string | null;
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
 *   · `pedido` como `asked_keys` del último mensaje que salió,
 *   · `conversacion` —si viene— como los mensajes entrantes del caso,
 *   · `propuestos` como las confirmaciones pendientes,
 *   · `guardados` como los valores de `extracted_fields` que lee el puntaje,
 *   · `faltantesExistentes` —si viene— como las claves que `missing_docs` ya tiene,
 *   · nada en los demás,
 *   · y le pasa a `espiaDeUpdate` todo lo que se escriba con `.set(...)`,
 *   · y a `espiaDeFiltro`, si viene, cada `.set(...)` con su `.where(...)`.
 *
 * El orden de los dos primeros SELECT es carga estructural: el worker los hace
 * en ese orden y el mock responde por posición.
 */
export function dbSimulado(
  fila: FilaDeCaso,
  espiaDeUpdate: Mock<(data: Record<string, unknown>) => void>,
  cuerpo = "Buenos días, tuve un choque ayer.",
  pedido: string[] = [],
  {
    conversacion,
    propuestos = {},
    guardados = {},
    guardadosFallan = false,
    faltantesExistentes,
    cabecerasDelUltimo,
    casoMovido = false,
    espiaDeFiltro,
    pendienteAlSoltar = false,
  }: Conversacion = {}
) {
  let n = 0;

  const mensajeCrudo = {
    body: cuerpo,
    subject: "Siniestro",
    from_addr: "asegurado@ejemplo.com",
  };

  const mockSelect = vi.fn().mockImplementation((columnas?: Record<string, unknown>) => {
    n++;
    const idx = n;
    const ultimoPedido = pedido.length > 0 && !!columnas && "asked_keys" in columnas;
    const entrantes = !!columnas && "profile_name" in columnas;
    const pendientes = !!columnas && "suggested_value" in columnas;
    const deCampos = !!columnas && "field_key" in columnas && "field_value" in columnas;
    const deFaltantes = !!faltantesExistentes && !!columnas && "doc_key" in columnas;
    const deLaMarca = pendienteAlSoltar && !!columnas && "pending" in columnas;

    const limit = vi.fn().mockImplementation(() => {
      if (deLaMarca) return Promise.resolve([{ pending: true }]);
      if (idx === 1) return Promise.resolve([fila]);
      if (idx === 2) return Promise.resolve([mensajeCrudo]);
      return Promise.resolve([]);
    });
    const orderBy = vi.fn().mockReturnValue({
      limit: vi.fn().mockImplementation(() => {
        if (ultimoPedido) return Promise.resolve([{ asked_keys: pedido, created_at: conversacion?.enviado }]);
        return idx === 2 ? Promise.resolve([mensajeCrudo]) : Promise.resolve([]);
      }),
    });
    if (entrantes && conversacion) {
      const filas = conversacion.mensajes.map(([body_text, received_at], i) => ({
        id: `entrante-${i + 1}`,
        body_text,
        received_at,
        subject: "Siniestro",
        headers: [] as Cabecera[],
        from_addr: undefined as string | undefined,
      }));
      if (cabecerasDelUltimo && filas.length > 0) {
        // El From va con las cabeceras: el veredicto de Gmail se alinea contra él.
        filas[filas.length - 1] = { ...filas[filas.length - 1], headers: cabecerasDelUltimo, from_addr: mensajeCrudo.from_addr };
      }
      orderBy.mockReturnValue(Promise.resolve(filas));
    }
    const where = vi.fn().mockReturnValue({ limit, orderBy });

    return {
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue(
          pendientes
            ? Promise.resolve(
                Object.entries(propuestos).map(([field_name, suggested_value]) => ({ field_name, suggested_value }))
              )
            : deCampos
              ? guardadosFallan
                ? Promise.reject(new Error("se cayó la base"))
                : Promise.resolve(Object.entries(guardados).map(([field_key, field_value]) => ({ field_key, field_value })))
              : deFaltantes
                ? Promise.resolve(faltantesExistentes.map((doc_key) => ({ doc_key })))
                : { limit, orderBy, where }
        ),
        limit,
        orderBy,
        innerJoin: vi.fn().mockReturnValue({ where, limit, orderBy }),
        leftJoin: vi.fn().mockReturnValue({ where, limit, orderBy }),
      }),
    };
  });

  const cadenaUpdate = {
    set: vi.fn<(data: Record<string, unknown>) => unknown>().mockImplementation((data: Record<string, unknown>) => {
      espiaDeUpdate(data);
      // Guarda atómica (E2): un `UPDATE ... RETURNING` sin filas dice «otra
      // mano ya movió el caso». `casoMovido` sólo la simula para las escrituras
      // que la guarda protege —las que tocan `status`—; la reserva de
      // extracción (`extraction_lease_at`/`extraction_pending`) usa el mismo
      // `db.update`, pero no es lo que E2 prueba, y sin esta distinción
      // `casoMovido` la hace fallar también y el worker nunca llega a extraer.
      const filasDelUpdate = casoMovido && "status" in data ? [] : [{ id: fila.id }];
      return {
        where: vi.fn().mockImplementation((filtro: unknown) => {
          espiaDeFiltro?.(data, filtro);
          return {
            returning: vi.fn().mockResolvedValue(filasDelUpdate),
            then: (r: (v: unknown) => void, j?: (e: unknown) => void) => Promise.resolve([]).then(r, j),
          };
        }),
        returning: vi.fn().mockResolvedValue(filasDelUpdate),
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

export interface Conversacion {
  /**
   * Los mensajes entrantes del caso, `[texto, recibido]`, y cuándo salió el
   * último pedido. Sin esto el worker lee el mensaje crudo, como el simulador.
   */
  conversacion?: { enviado: string; mensajes: Array<[string, string]> };
  /** Las confirmaciones pendientes: `{ clave: valor propuesto }`. */
  propuestos?: Record<string, string>;
  /** Lo que `extracted_fields` tiene guardado cuando el puntaje lo lee: `{ clave canónica: valor }`. */
  guardados?: Record<string, string>;
  /** La lectura de los campos guardados falla. */
  guardadosFallan?: boolean;
  /** Las claves que `missing_docs` ya tiene cuando el worker anota los faltantes. */
  faltantesExistentes?: string[];
  /** Cabeceras del último entrante, para E17: `spf=fail` sale sin autenticar. */
  cabecerasDelUltimo?: Cabecera[];
  /** El caso ya no es del agente: todo `UPDATE` con guarda no matchea ninguna fila (E2). */
  casoMovido?: boolean;
  /** Recibe cada `.set(...)` junto con el `.where(...)` que la acota. */
  espiaDeFiltro?: Mock<(data: Record<string, unknown>, filtro: unknown) => void>;
  /** `releaseExtractionLease` encuentra la marca puesta: llegó algo mientras corría. */
  pendienteAlSoltar?: boolean;
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
  injury_severity?: string;
}

/**
 * Registra todo lo que el worker necesita para correr sin tocar nada real.
 *
 * Se llama ANTES de importar el worker: `vi.doMock` no se sube al principio del
 * archivo, así que el orden importa.
 */
export function registrarMocks(opciones: {
  fila: FilaDeCaso;
  espiaDeUpdate: Mock<(data: Record<string, unknown>) => void>;
  espiaDeAuditoria?: ReturnType<typeof vi.fn>;
  necesitaEspecialista?: boolean;
  /** Reemplaza el mock de `isValidTransition`. Por omisión, todo vale. */
  transicionValida?: boolean;
  extractor?: OpcionesDelExtractor;
  /** Lo que escribió la persona. Por omisión, un choque sin más detalle. */
  cuerpo?: string;
  /** Lo que le preguntó el último mensaje que salió. Por omisión, nada. */
  pedido?: string[];
} & Conversacion) {
  const {
    fila,
    espiaDeUpdate,
    espiaDeAuditoria = vi.fn().mockResolvedValue(undefined),
    necesitaEspecialista = false,
    transicionValida = true,
    extractor = {},
    cuerpo,
    pedido,
    conversacion,
    propuestos,
    guardados,
    guardadosFallan,
    faltantesExistentes,
    cabecerasDelUltimo,
    casoMovido,
    espiaDeFiltro,
    pendienteAlSoltar,
  } = opciones;

  const mockDb = dbSimulado(fila, espiaDeUpdate, cuerpo, pedido, {
    conversacion,
    propuestos,
    guardados,
    guardadosFallan,
    faltantesExistentes,
    cabecerasDelUltimo,
    casoMovido,
    espiaDeFiltro,
    pendienteAlSoltar,
  });

  vi.doMock("@/lib/db", () => ({
    db: mockDb,
    tables: { claimMemory: {}, tenantAiSettings: {} },
  }));

  vi.doMock("@/data/scope", () => puenteDeAlcance(() => mockDb));

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
    MATCH_QUE_VINCULA: new Set(["policy_number", "dni"]),
  }));

  vi.doMock("@/server/matching/policy-matcher", () => ({
    findPolicyMatches: vi.fn().mockResolvedValue([]),
  }));

  vi.doMock("@/server/confirmations/orchestrate", () => ({
    orchestratePostExtraction: vi.fn().mockResolvedValue(undefined),
  }));

  vi.doMock("@/server/ai/severity-classifier", () => ({
    classifySeverity: vi
      .fn()
      .mockImplementation((_texto: string, severidadIA?: string | null) =>
        necesitaEspecialista ? "high" : (severidadIA ?? "medium")
      ),
    requiresSpecialist: vi
      .fn()
      .mockImplementation(
        (severidad: string) => necesitaEspecialista || severidad === "high" || severidad === "critical"
      ),
  }));

  vi.doMock("@/core/case/fsm", () => ({
    isValidTransition: vi.fn().mockReturnValue(transicionValida),
  }));

  const claimSimulado = vi.fn().mockReturnValue({
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
    injury_severity: extractor.injury_severity ?? null,
    not_relevant_reason: undefined,
    summary: "",
    suggested_reply: "",
  });

  vi.doMock("@/server/ai/mock-extractor", () => ({
    extractEmailClaimMock: claimSimulado,
    // Stub agregado porque `claim-agent.ts` ahora llama `denunciaSimuladaVacia`
    // en vez de `extractEmailClaimMock` cuando el motor cae a mock (fuera de
    // E2/E17): sin esto, todo test que pasa por `runEmailClaimAgent` revienta
    // con "No denunciaSimuladaVacia export". Delega a la misma denuncia
    // configurable por `extractor` para no romper los tests que ya la usan;
    // `extract.mock-vacio.test.ts` pisa esto con el módulo real cuando le
    // hace falta probar la denuncia vacía de verdad.
    denunciaSimuladaVacia: vi.fn(() => claimSimulado()),
  }));

  return { mockDb, espiaDeAuditoria, espiaDeBusqueda };
}

/** El `status` que quedó escrito en el caso, de todo lo que se haya escrito. */
export function statusEscrito(
  espiaDeUpdate: Mock<(data: Record<string, unknown>) => void>
): string | undefined {
  const conStatus = espiaDeUpdate.mock.calls
    .map((c) => c[0] as Record<string, unknown>)
    .filter((p) => p && "status" in p);
  return conStatus.length > 0
    ? (conStatus[conStatus.length - 1].status as string)
    : undefined;
}
