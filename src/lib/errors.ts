/**
 * Unified error types for ClaimMix.
 *
 * All API errors use the format:
 *   { error: { code: string, message: string, details?: unknown } }
 *
 * HTTP status code map:
 *   400  VALIDATION_FAILED
 *   401  MISSING_SESSION | INVALID_CREDENTIALS
 *   403  FORBIDDEN_ROLE
 *   404  NOT_FOUND
 *   409  FSM_INVALID_TRANSITION
 *   422  AI_OUTPUT_INVALID
 *   429  RATE_LIMITED | AI_BUDGET_EXCEEDED
 *   500  INTERNAL_ERROR
 *   501  NOT_IMPLEMENTED
 *
 * NEVER include stack traces or internal error strings in API responses.
 */

/** All defined error codes. */
export const ErrorCode = {
  MISSING_SESSION: "MISSING_SESSION",
  INVALID_CREDENTIALS: "INVALID_CREDENTIALS",
  NOT_FOUND: "NOT_FOUND",
  FORBIDDEN_ROLE: "FORBIDDEN_ROLE",
  VALIDATION_FAILED: "VALIDATION_FAILED",
  RATE_LIMITED: "RATE_LIMITED",
  AI_BUDGET_EXCEEDED: "AI_BUDGET_EXCEEDED",
  AI_OUTPUT_INVALID: "AI_OUTPUT_INVALID",
  FSM_INVALID_TRANSITION: "FSM_INVALID_TRANSITION",
  INTERNAL_ERROR: "INTERNAL_ERROR",
  NOT_IMPLEMENTED: "NOT_IMPLEMENTED",
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

/** HTTP status for each error code. */
export const ERROR_STATUS: Record<ErrorCode, number> = {
  MISSING_SESSION: 401,
  INVALID_CREDENTIALS: 401,
  NOT_FOUND: 404,
  FORBIDDEN_ROLE: 403,
  VALIDATION_FAILED: 400,
  RATE_LIMITED: 429,
  AI_BUDGET_EXCEEDED: 429,
  AI_OUTPUT_INVALID: 422,
  FSM_INVALID_TRANSITION: 409,
  INTERNAL_ERROR: 500,
  NOT_IMPLEMENTED: 501,
};

/** Default es-AR messages for each error code. */
export const ERROR_MESSAGES: Record<ErrorCode, string> = {
  MISSING_SESSION: "Se requiere autenticación.",
  INVALID_CREDENTIALS: "Credenciales inválidas.",
  NOT_FOUND: "El recurso solicitado no existe.",
  FORBIDDEN_ROLE: "No tenés permisos para realizar esta acción.",
  VALIDATION_FAILED: "Los datos enviados no son válidos.",
  RATE_LIMITED: "Demasiadas solicitudes. Esperá un momento.",
  AI_BUDGET_EXCEEDED: "Presupuesto de IA agotado para hoy.",
  AI_OUTPUT_INVALID: "La respuesta de la IA no tiene el formato esperado.",
  FSM_INVALID_TRANSITION:
    "La transición de estado solicitada no está permitida.",
  INTERNAL_ERROR: "Error interno del servidor.",
  NOT_IMPLEMENTED: "Esta función no está disponible en esta versión.",
};

/** Application error — carries a typed error code and HTTP status. */
export class AppError extends Error {
  public readonly code: ErrorCode;
  public readonly status: number;
  public readonly details?: unknown;

  constructor(code: ErrorCode, message?: string, details?: unknown) {
    super(message ?? ERROR_MESSAGES[code]);
    this.name = "AppError";
    this.code = code;
    this.status = ERROR_STATUS[code];
    this.details = details;
  }
}

/** Shape of an API error response body. */
export interface ApiErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    details?: unknown;
  };
}
