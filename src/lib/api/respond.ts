/**
 * API response helpers — uniform JSON responses for Route Handlers.
 *
 * Usage:
 *   return ok({ items, pagination });
 *   return err(new AppError('NOT_FOUND'));
 *   return err('INTERNAL_ERROR');
 *
 * All error responses use the unified format:
 *   { error: { code, message, details? } }
 *
 * NEVER include stack traces or internal Neon errors in the response body.
 */

import { NextResponse } from "next/server";
import {
  AppError,
  ErrorCode,
  ERROR_MESSAGES,
  ERROR_STATUS,
} from "@/lib/errors";
import { logger } from "@/lib/observability/logger";

/** Return a 200 (or custom status) JSON response. */
export function ok<T>(data: T, status = 200): NextResponse {
  return NextResponse.json(data, { status });
}

/** Return a 201 Created JSON response. */
export function created<T>(data: T): NextResponse {
  return NextResponse.json(data, { status: 201 });
}

/** Return a 202 Accepted JSON response. */
export function accepted<T>(data: T): NextResponse {
  return NextResponse.json(data, { status: 202 });
}

/** Return a 204 No Content response. */
export function noContent(): NextResponse {
  return new NextResponse(null, { status: 204 });
}

/**
 * Return an error JSON response.
 *
 * Accepts:
 * - An AppError instance (code + message + status from the error)
 * - An ErrorCode string (uses default message and status)
 * - Any unknown thrown value (logs internally, returns INTERNAL_ERROR 500)
 */
export function err(
  error: AppError | ErrorCode | unknown,
  details?: unknown,
  /**
   * Encabezados extra. Existe por `Retry-After`.
   *
   * Sin esto, toda ruta que quisiera decirle a quien llama cuántos segundos
   * esperar tenía que armar el `Response` a mano —código, mensaje y forma del
   * cuerpo copiados— y ahí es donde se desincronizan del resto.
   */
  headers?: Record<string, string>
): NextResponse {
  if (error instanceof AppError) {
    /*
     * Un 500 que sale por acá dejaba de existir apenas se mandaba.
     *
     * `err(new AppError("INTERNAL_ERROR"))` es la forma en que casi todas las
     * rutas reportan que algo se rompió del lado del servidor, y era la única
     * rama de esta función que no escribía una línea. Se veía el 500 en el
     * navegador y no quedaba NADA: ni qué ruta, ni qué código, ni cuándo.
     *
     * Los 4xx no se anotan, y eso es a propósito. Una validación que falla, un
     * 404 o un 429 son el producto funcionando: anotarlos como error convierte
     * el registro en algo que nadie mira, que es la otra forma de no tener
     * registro.
     */
    if (error.status >= 500) {
      logger.error(
        { code: error.code, status: error.status },
        "api.error"
      );
    }
    return NextResponse.json(
      {
        error: {
          code: error.code,
          message: error.message,
          ...(error.details !== undefined ? { details: error.details } : {}),
        },
      },
      { status: error.status, ...(headers ? { headers } : {}) }
    );
  }

  if (typeof error === "string" && error in ErrorCode) {
    const code = error as ErrorCode;
    return NextResponse.json(
      {
        error: {
          code,
          message: ERROR_MESSAGES[code],
          ...(details !== undefined ? { details } : {}),
        },
      },
      { status: ERROR_STATUS[code] }
    );
  }

  // Unknown error — log internally, return generic 500.
  // NEVER include the original error message in the response body.
  // El mensaje entero, igual que antes: es un error que nadie previó y es lo
  // único que va a haber para reconstruirlo. Va a stderr, no al cuerpo.
  logger.error(
    {
      code: "INTERNAL_ERROR",
      error_name: error instanceof Error ? error.name : "UnknownError",
      detalle: error instanceof Error ? error.message : String(error),
    },
    "api.error_no_manejado"
  );

  return NextResponse.json(
    {
      error: {
        code: "INTERNAL_ERROR" as ErrorCode,
        message: ERROR_MESSAGES.INTERNAL_ERROR,
      },
    },
    { status: 500 }
  );
}
