/**
 * CoreSyncService client interface and factory.
 *
 * AC17: CoreSyncService.send() is called by POST /api/cases/:id/sync-to-core.
 *       On success: cases.status='enviado_a_core', cases.core_external_id set.
 *       On failure: cases.status='error_core', cases.core_error_message set.
 *
 * IC7: No real external API exists — only MockCoreSyncClient is implemented.
 *      Set CORE_SYNC_MODE=mock (or leave unset) to use the mock.
 *      Set CORE_SYNC_MODE=real to use a real implementation (not built in this PR).
 *
 * This file defines the interface contract and the factory function.
 * The mock implementation lives in ./mock.ts.
 */

// ── Payload and result types ──────────────────────────────────────────────────

/**
 * Payload sent to the core system when a case is ready for sync.
 *
 * All fields are required by the core system spec.
 * PII note: customerName and policyNumber are PII — only log IDs, never values.
 */
export interface CoreSyncPayload {
  /** UUID of the case in claimmix. */
  caseId: string;
  /** UUID of the tenant. */
  tenantId: string;
  /** Claim type (choque, robo, granizo, incendio, etc.). */
  claimType: string;
  /** Severity level (low, medium, high, critical). */
  severity: string | null;
  /** Full name of the claimant (PII). */
  customerName: string | null;
  /** Policy number (PII). */
  policyNumber: string | null;
  /** Date of the accident (ISO date string or human-readable). */
  accidentDate: string | null;
  /** Description of the accident. */
  accidentDescription: string | null;
  /** Full snapshot of extracted fields as key-value pairs. */
  extractedFields: Record<string, string>;
}

/**
 * Result returned by CoreSyncClient.syncCase().
 *
 * On success: externalId is set, success=true.
 * On failure: success=false, errorMessage explains the failure.
 */
export interface CoreSyncResult {
  /** External ID assigned by the core system (only set on success). */
  externalId: string;
  /** Whether the sync was successful. */
  success: boolean;
  /** Error message if success=false. */
  errorMessage?: string;
}

// ── Interface ─────────────────────────────────────────────────────────────────

/**
 * Contract for core system integration clients.
 *
 * Implementations:
 *   - MockCoreSyncClient (./mock.ts) — simulates success/failure deterministically.
 *   - (Future) RealCoreSyncClient — calls the actual external core API.
 */
export interface ICoreSyncClient {
  syncCase(caseData: CoreSyncPayload): Promise<CoreSyncResult>;
}

// ── Factory ───────────────────────────────────────────────────────────────────

import { MockCoreSyncClient } from "./mock";

/**
 * En qué modo está la integración con el sistema del asegurador.
 *
 * `sin_configurar` es el default, y ése es el cambio: antes el default era
 * `mock`.
 */
export type ModoDeCoreSync = "mock" | "real" | "sin_configurar";

export function modoDeCoreSync(): ModoDeCoreSync {
  const crudo = process.env.CORE_SYNC_MODE?.trim();
  if (crudo === "mock") return "mock";
  if (crudo === "real") return "real";
  return "sin_configurar";
}

/** No hay a quién mandarle el caso. La tira `getCoreSyncClient`. */
export class CoreSyncSinConfigurar extends Error {
  constructor(readonly modo: ModoDeCoreSync) {
    super(`core-sync sin cliente real (modo=${modo})`);
    this.name = "CoreSyncSinConfigurar";
  }
}

/**
 * El cliente que corresponde, o una excepción si no hay ninguno.
 *
 * ── Lo que hacía antes, y por qué era grave ─────────────────────────────────
 *
 * Devolvía `new MockCoreSyncClient()` SIEMPRE. `CORE_SYNC_MODE=real` sólo
 * escribía un `console.warn` y seguía de largo hasta el mismo `return`. Y
 * `CORE_SYNC_MODE` no está puesta en ningún lado —ni en `.env.local`, ni en la
 * CI, ni en Vercel— así que el default es el que corría en producción.
 *
 * El resultado no era «la función no anda». Era peor: el botón «Enviar al
 * sistema central» aparece en el detalle de cualquier caso en
 * `listo_para_core`, y al apretarlo la ruta guardaba
 * `core_external_id = 'CORE-' + los primeros 8 caracteres del id`, ponía el
 * caso en `enviado_a_core` y escribía un `CORE_SYNC_SUCCESS` en la auditoría.
 * Un identificador inventado, un estado que dice «entregado» y un registro de
 * auditoría de algo que no pasó. Y los ids que terminan en `0` —uno de cada
 * dieciséis, porque son UUID— devolvían un «Core timeout» igual de inventado,
 * que es un error que el analista sale a investigar.
 *
 * Fabricar el comprobante de una entrega que nunca ocurrió es lo peor que
 * puede hacer este archivo, así que ahora el default es no hacer nada y
 * decirlo.
 *
 * `mock` sigue existiendo y hay que pedirlo por su nombre: lo usan los tests y
 * sirve para probar la pantalla sin un sistema del otro lado.
 */
export function getCoreSyncClient(): ICoreSyncClient {
  const modo = modoDeCoreSync();

  if (modo === "mock") return new MockCoreSyncClient();

  // `real` todavía no existe. Cuando exista, acá va
  // `return new RealCoreSyncClient()` y esta rama desaparece sola.
  throw new CoreSyncSinConfigurar(modo);
}
