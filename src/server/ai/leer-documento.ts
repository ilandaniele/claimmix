/**
 * Un documento al modelo y de vuelta un dato validado, o el motivo de por qué
 * no se leyó (B6, B21 y B24).
 *
 * El orden es el de la clasificación del mensaje tardío: motor, presupuesto de
 * IA, cupo, y recién ahí el modelo. Las páginas se cuentan antes del cupo: un
 * PDF que no se va a leer no gasta un intento. Sin cupo o sin presupuesto no
 * hay lectura: la pantalla dice «sin leer», nunca un resultado inventado.
 * Nunca tira, y lo que se registra no lleva nada del documento.
 */

import "server-only";

import type { ZodType, ZodTypeDef } from "zod";

import type { MotivoSinLeer } from "@/core/ai/sin-leer";
import { errorCode } from "@/lib/observability/error-code";
import { logger } from "@/lib/observability/logger";
import { rateLimit, RATE_LIMIT_CONFIGS } from "@/lib/rate-limit/index";
import { claveDeCupo, type AmbitoDeCupo } from "@/lib/rate-limit/clave";
import { checkBudget, registrarConsumoDelModelo, soltarReserva } from "@/server/ai/budget";
import { callGemini, contarTokens, type InlineMedia } from "@/server/ai/gemini-extractor";
import { resolveExtractionEngine } from "@/server/ai/provider";
import { PLAZO_DE_CONTEO_MS, TOPE_TOKENS_PDF } from "@/server/worker/adjuntos";

export type Lectura<T> = { ok: T } | { sinLeer: MotivoSinLeer };

type AmbitoDeLectura = Extract<
  AmbitoDeCupo,
  "condiciones-poliza" | "lectura-presupuesto" | "lectura-reclamo" | "asistente-caso"
>;

const CUPOS: Record<AmbitoDeLectura, keyof typeof RATE_LIMIT_CONFIGS> = {
  "condiciones-poliza": "CONDICIONES_POR_POLIZA",
  "lectura-presupuesto": "LECTURA_PRESUPUESTO_POR_CASO",
  "lectura-reclamo": "LECTURA_RECLAMO_POR_CASO",
  "asistente-caso": "ASISTENTE_CASO",
};

export async function leerDocumento<T>({
  tenantId,
  userId,
  ambito,
  partesDeClave,
  sistema,
  usuario,
  media,
  schema,
  limpiar = (x) => x,
}: {
  tenantId: string;
  userId: string | null;
  ambito: AmbitoDeLectura;
  partesDeClave: string[];
  sistema: string;
  usuario: string;
  media: InlineMedia[];
  schema: ZodType<T, ZodTypeDef, unknown>;
  limpiar?: (dato: T) => T;
}): Promise<Lectura<T>> {
  try {
    if ((await resolveExtractionEngine(tenantId, userId)) === "mock") return { sinLeer: "mock" };
    const presupuesto = await checkBudget(tenantId, userId);
    if (presupuesto.exceeded) return { sinLeer: "presupuesto" };
    // Lo que se rechaza sin llamar al modelo no gasta del cupo diario de una prueba.
    const sinLlamar = async (motivo: MotivoSinLeer): Promise<{ sinLeer: MotivoSinLeer }> => {
      await soltarReserva(presupuesto.reserva);
      return { sinLeer: motivo };
    };

    // Mismo tope que el worker: lo que el modelo cobraría decide, no un
    // contador propio de páginas. Sólo un rechazo habla del archivo; un plazo
    // agotado o una red caída son del modelo, y se puede probar de nuevo.
    for (const m of media) {
      if (m.mimeType !== "application/pdf") continue;
      const tokens = await contarTokens(m, PLAZO_DE_CONTEO_MS);
      if (tokens === "rechazo") return sinLlamar("archivo");
      if (typeof tokens !== "number") return sinLlamar("modelo");
      if (tokens > TOPE_TOKENS_PDF) return sinLlamar("paginas");
    }

    const cupo = await rateLimit(claveDeCupo(ambito, ...partesDeClave), RATE_LIMIT_CONFIGS[CUPOS[ambito]]).catch(
      () => null
    );
    if (!cupo?.allowed) return sinLlamar("cupo");

    const r = await callGemini(sistema, usuario, undefined, undefined, media);
    await registrarConsumoDelModelo(tenantId, r.model, r.usage, userId);
    if (!r.text) return { sinLeer: "modelo" };

    let crudo: unknown;
    try {
      crudo = JSON.parse(r.text);
    } catch {
      return { sinLeer: "formato" };
    }
    const parsed = schema.safeParse(crudo);
    return parsed.success ? { ok: limpiar(parsed.data) } : { sinLeer: "formato" };
  } catch (err) {
    logger.warn({ ambito, error_code: errorCode(err) }, "leer_documento.fallida");
    return { sinLeer: "modelo" };
  }
}
