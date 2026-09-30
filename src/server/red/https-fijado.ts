/**
 * Un pedido HTTPS a una URL que no controlamos, con la guarda contra SSRF.
 *
 * Con `https.request` y no con `fetch`: se conecta a la IP que validó
 * `validarDestino`, con el nombre sólo para el certificado (`servername`) y el
 * `Host`. Con una IP en `host` Node no resuelve, así que no hay segunda
 * resolución que un DNS malicioso pueda cambiar. `fetch`/undici o un `lookup`
 * propio vuelven a abrir ese agujero.
 *
 * Lo comparten el webhook al Core y el SSO por inquilino (discovery, token y
 * JWKS del IdP que escribe un admin). No sigue redirecciones, corta el cuerpo
 * en `topeBytes` y nunca devuelve el cuerpo de una respuesta que no es 2xx.
 */
import { request } from "node:https";

import { DestinoRechazado, validarDestino, type Destino } from "@/server/core-sync/destino";

export type PedidoFijado = {
  url: string;
  metodo?: "GET" | "POST";
  cuerpo?: string;
  /** `Host` y `Content-Length` los pone esta función. */
  encabezados?: Record<string, string>;
  plazoMs: number;
  topeBytes: number;
};

export type RespuestaFijada =
  /** `cuerpo` es null si pasó el tope o se cortó la lectura: con el 2xx el otro lado ya aceptó. */
  | { ok: true; estado: number; cuerpo: string | null }
  | { ok: false; motivo: string };

function falla(motivo: string): RespuestaFijada {
  return { ok: false, motivo };
}

/** Rechaza cuando vence el plazo, para que la resolución DNS también cuente. */
function vencimiento(plazo: AbortSignal): Promise<never> {
  return new Promise((_, rechazar) =>
    plazo.addEventListener("abort", () => rechazar(plazo.reason), { once: true })
  );
}

export async function pedirFijado(pedido: PedidoFijado): Promise<RespuestaFijada> {
  const plazo = AbortSignal.timeout(pedido.plazoMs);

  let destino: Destino;
  try {
    destino = await Promise.race([validarDestino(pedido.url), vencimiento(plazo)]);
  } catch (e) {
    if (e instanceof DestinoRechazado) return falla("destino_rechazado");
    return falla(plazo.aborted ? "timeout" : "red");
  }

  const { pathname, search } = new URL(pedido.url);
  const cuerpo = pedido.cuerpo;

  return new Promise<RespuestaFijada>((resolver) => {
    let respondio = false;
    const conexion = request(
      {
        host: destino.ip,
        family: destino.familia,
        port: 443,
        servername: destino.host,
        path: pathname + search,
        method: pedido.metodo ?? "GET",
        agent: false,
        signal: plazo,
        timeout: pedido.plazoMs,
        headers: {
          ...pedido.encabezados,
          Host: destino.host,
          ...(cuerpo === undefined ? {} : { "Content-Length": Buffer.byteLength(cuerpo) }),
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
        const trozos: Buffer[] = [];
        let largo = 0;
        let excedido = false;
        respuesta.on("data", (trozo: Buffer) => {
          largo += trozo.length;
          if (excedido) return;
          if (largo > pedido.topeBytes) {
            excedido = true;
            respuesta.destroy();
          } else trozos.push(trozo);
        });
        // Un cuerpo cortado por el tope no se entrega a medias: `end` puede llegar antes que `close`.
        respuesta.on("end", () =>
          resolver({ ok: true, estado, cuerpo: excedido ? null : Buffer.concat(trozos).toString("utf8") })
        );
        respuesta.on("close", () => resolver({ ok: true, estado, cuerpo: null }));
        respuesta.on("error", () => resolver({ ok: true, estado, cuerpo: null }));
      }
    );
    conexion.on("timeout", () => conexion.destroy(new Error("timeout")));
    conexion.on("error", (e) => {
      if (!respondio) resolver(falla(plazo.aborted || e.message === "timeout" ? "timeout" : "red"));
    });
    conexion.end(cuerpo);
  });
}
