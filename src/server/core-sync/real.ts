/**
 * El webhook firmado al sistema del asegurador.
 *
 * Con `https.request` y no con `fetch`: se conecta a la IP que validó
 * `validarDestino`, con el nombre sólo para el certificado (`servername`) y el
 * `Host`. Con una IP en `host` Node no resuelve, así que no hay segunda
 * resolución que un DNS malicioso pueda cambiar. `fetch`/undici o un `lookup`
 * propio vuelven a abrir ese agujero.
 *
 * Lo que vuelve es un código fijo, nunca el cuerpo de la respuesta: termina en
 * `cases.core_error_message`, que ve cualquiera del tenant.
 */
import { request } from "node:https";

import type { CoreSyncPayload, CoreSyncResult, ICoreSyncClient } from "./client";
import { DestinoRechazado, validarDestino, type Destino } from "./destino";
import { encabezadoDeFirma, firmar } from "./firma";

const PLAZO_MS = 10_000;
const TOPE_RESPUESTA = 64 * 1024;
const LARGO_ID_EXTERNO = 200;

function falla(motivo: string): CoreSyncResult {
  return { ok: false, motivo };
}

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

/** Rechaza cuando vence el plazo, para que la resolución DNS también cuente. */
function vencimiento(plazo: AbortSignal): Promise<never> {
  return new Promise((_, rechazar) =>
    plazo.addEventListener("abort", () => rechazar(plazo.reason), { once: true })
  );
}

export class RealCoreSyncClient implements ICoreSyncClient {
  constructor(private readonly config: { url: string; secreto: string; plazoMs?: number }) {}

  async syncCase(payload: CoreSyncPayload): Promise<CoreSyncResult> {
    const plazoMs = this.config.plazoMs ?? PLAZO_MS;
    const plazo = AbortSignal.timeout(plazoMs);

    let destino: Destino;
    try {
      destino = await Promise.race([validarDestino(this.config.url), vencimiento(plazo)]);
    } catch (e) {
      if (e instanceof DestinoRechazado) return falla("destino_rechazado");
      return falla(plazo.aborted ? "timeout" : "red");
    }

    const { pathname, search } = new URL(this.config.url);
    const body = JSON.stringify(payload);
    const ts = Math.floor(Date.now() / 1000);

    return new Promise<CoreSyncResult>((resolver) => {
      let respondio = false;
      const pedido = request(
        {
          host: destino.ip,
          family: destino.familia,
          port: 443,
          servername: destino.host,
          path: pathname + search,
          method: "POST",
          agent: false,
          signal: plazo,
          timeout: plazoMs,
          headers: {
            Host: destino.host,
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body),
            "User-Agent": "ClaimMix-Core-Sync/1",
            "X-ClaimMix-Timestamp": String(ts),
            "X-ClaimMix-Signature": encabezadoDeFirma(ts, firmar(this.config.secreto, ts, body)),
            "Idempotency-Key": payload.caseId,
            "X-ClaimMix-Event-Id": `${payload.caseId}:${payload.updatedAt ?? ""}`,
          },
        },
        (respuesta) => {
          respondio = true;
          const estado = respuesta.statusCode ?? 0;
          if (estado < 200 || estado >= 300) {
            respuesta.destroy();
            // Un 3xx no se sigue: el Location lo elige el otro lado y no pasó por la guarda.
            resolver(falla(estado >= 300 && estado < 400 ? "redireccion" : `http_${estado}`));
            return;
          }
          // Con el 2xx el Core ya aceptó: lo que falle leyendo el cuerpo sólo
          // pierde el id, no la entrega.
          const trozos: Buffer[] = [];
          let largo = 0;
          respuesta.on("data", (trozo: Buffer) => {
            largo += trozo.length;
            if (largo > TOPE_RESPUESTA) respuesta.destroy();
            else trozos.push(trozo);
          });
          respuesta.on("end", () => resolver({ ok: true, externalId: idExterno(Buffer.concat(trozos).toString("utf8")) }));
          respuesta.on("close", () => resolver({ ok: true, externalId: null }));
          respuesta.on("error", () => resolver({ ok: true, externalId: null }));
        }
      );
      pedido.on("timeout", () => pedido.destroy(new Error("timeout")));
      pedido.on("error", (e) => {
        if (!respondio) resolver(falla(plazo.aborted || e.message === "timeout" ? "timeout" : "red"));
      });
      pedido.end(body);
    });
  }
}
