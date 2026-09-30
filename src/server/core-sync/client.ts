/**
 * CoreSyncService client interface and factory.
 *
 * AC17: CoreSyncService.send() is called by POST /api/cases/:id/sync-to-core.
 *       On success: cases.status='enviado_a_core', cases.core_external_id set.
 *       On failure: cases.status='error_core', cases.core_error_message set.
 *
 * El modo sale de la fila de `core_sync_settings` de cada aseguradora (0036):
 * con `enabled` hay webhook real (./real.ts). Sin fila, apagada o con la
 * migración sin aplicar es `sin_configurar`: la ruta contesta 501 sin escribir
 * y el caso sale a mano (`SALIDAS_A_MANO`). CORE_SYNC_MODE=mock pisa todo eso,
 * sólo para tests y la demo; cualquier otro valor se ignora.
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
  /** `cases.updated_at`: con el caseId arma X-ClaimMix-Event-Id. */
  updatedAt: string | null;
  /** Sólo en el envío de prueba de /configuracion: no es un caso. */
  prueba?: true;
}

/**
 * Result returned by CoreSyncClient.syncCase().
 *
 * Una unión para que no se pueda armar un éxito con un id inventado: el
 * `externalId` es el que devolvió el Core, o null. `motivo` es un código fijo
 * (timeout, red, http_<n>, redireccion, destino_rechazado), nunca texto del
 * otro lado.
 */
export type CoreSyncResult =
  | { ok: true; externalId: string | null }
  | { ok: false; motivo: string };

// ── Interface ─────────────────────────────────────────────────────────────────

/**
 * Contract for core system integration clients.
 *
 * Implementations:
 *   - MockCoreSyncClient (./mock.ts) — simulates success/failure deterministically.
 *   - RealCoreSyncClient (./real.ts) — webhook firmado a la URL de la aseguradora.
 */
export interface ICoreSyncClient {
  syncCase(caseData: CoreSyncPayload): Promise<CoreSyncResult>;
}

// ── Factory ───────────────────────────────────────────────────────────────────

import { descifrar } from "@/lib/security/cifrado";
import { MockCoreSyncClient } from "./mock";
import { RealCoreSyncClient } from "./real";

/** Lo que la fábrica lee de `core_sync_settings` (`consultaDeLaConfig`). */
export interface FilaDeCoreSync {
  enabled: boolean;
  webhook_url: string | null;
  signing_secret_enc: string | null;
}

/** En qué modo está la integración con el sistema del asegurador. */
export type ModoDeCoreSync = "mock" | "real" | "sin_configurar";

/** Con el mock no hace falta leer la fila: ni la demo ni los tests dependen de la 0036. */
export function esModoMock(): boolean {
  return process.env.CORE_SYNC_MODE?.trim() === "mock";
}

export function modoDeCoreSync(fila?: Pick<FilaDeCoreSync, "enabled"> | null): ModoDeCoreSync {
  if (esModoMock()) return "mock";
  return fila?.enabled ? "real" : "sin_configurar";
}

/**
 * Si `getCoreSyncClient` devuelve un cliente: la ficha muestra el botón sólo
 * con esto, así nunca hay un botón que siempre recibe 501.
 */
export function hayClienteDeCoreSync(fila?: Pick<FilaDeCoreSync, "enabled"> | null): boolean {
  return modoDeCoreSync(fila) !== "sin_configurar";
}

/** No hay a quién mandarle el caso. La tira `getCoreSyncClient`. */
export class CoreSyncSinConfigurar extends Error {
  constructor(readonly modo: ModoDeCoreSync) {
    super(`core-sync sin cliente (modo=${modo})`);
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
 * auditoría de algo que no pasó.
 *
 * Fabricar el comprobante de una entrega que nunca ocurrió es lo peor que
 * puede hacer este archivo. Por eso el mock hay que pedirlo por su nombre
 * (tests y demo), y el cliente real sólo sale de una fila activada: el id que
 * se guarda es el que devolvió el Core, o null, nunca uno armado acá.
 *
 * Un secreto que no se puede descifrar —se rotó GMAIL_TOKEN_ENCRYPTION_KEY—
 * también es `sin_configurar` para la ruta: 501 sin escribir, hasta generar
 * otro desde /configuracion.
 */
export function getCoreSyncClient(fila?: FilaDeCoreSync | null): ICoreSyncClient {
  const modo = modoDeCoreSync(fila);
  if (modo === "mock") return new MockCoreSyncClient();
  if (modo === "sin_configurar" || !fila?.webhook_url || !fila.signing_secret_enc) {
    throw new CoreSyncSinConfigurar(modo);
  }

  let secreto: string;
  try {
    secreto = descifrar(fila.signing_secret_enc);
  } catch {
    throw new CoreSyncSinConfigurar("real");
  }
  return new RealCoreSyncClient({ url: fila.webhook_url, secreto });
}
