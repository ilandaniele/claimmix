/**
 * El webhook firmado al sistema del asegurador.
 *
 * La conexión a la IP que validó `validarDestino` vive en `pedirFijado`
 * (`red/https-fijado.ts`), que comparte con el SSO.
 *
 * Lo que vuelve es un código fijo, nunca el cuerpo de la respuesta: termina en
 * `cases.core_error_message`, que ve cualquiera del tenant.
 */
import { pedirFijado } from "@/server/red/https-fijado";

import type { CoreSyncPayload, CoreSyncResult, ICoreSyncClient } from "./client";
import { encabezadoDeFirma, firmar } from "./firma";

const PLAZO_MS = 10_000;
const TOPE_RESPUESTA = 64 * 1024;
const LARGO_ID_EXTERNO = 200;

function idExterno(texto: string): string | null {
  try {
    const json: unknown = JSON.parse(texto);
    if (!json || typeof json !== "object") return null;
    const { id, external_id } = json as Record<string, unknown>;
    for (const v of [id, external_id]) {
      if (typeof v === "string" && v.length > 0 && v.length <= LARGO_ID_EXTERNO) return v;
    }
  } catch {
    // Un 2xx sin JSON sigue siendo una entrega: sólo no trae id.
  }
  return null;
}

export class RealCoreSyncClient implements ICoreSyncClient {
  constructor(private readonly config: { url: string; secreto: string; plazoMs?: number }) {}

  async syncCase(payload: CoreSyncPayload): Promise<CoreSyncResult> {
    const body = JSON.stringify(payload);
    const ts = Math.floor(Date.now() / 1000);

    const r = await pedirFijado({
      url: this.config.url,
      metodo: "POST",
      cuerpo: body,
      plazoMs: this.config.plazoMs ?? PLAZO_MS,
      topeBytes: TOPE_RESPUESTA,
      encabezados: {
        "Content-Type": "application/json",
        "User-Agent": "ClaimMix-Core-Sync/1",
        "X-ClaimMix-Timestamp": String(ts),
        "X-ClaimMix-Signature": encabezadoDeFirma(ts, firmar(this.config.secreto, ts, body)),
        "Idempotency-Key": payload.caseId,
        "X-ClaimMix-Event-Id": `${payload.caseId}:${payload.updatedAt ?? ""}`,
      },
    });
    if (!r.ok) return { ok: false, motivo: r.motivo };
    // Con el 2xx el Core ya aceptó: lo que falle leyendo el cuerpo sólo pierde el id, no la entrega.
    return { ok: true, externalId: r.cuerpo === null ? null : idExterno(r.cuerpo) };
  }
}
