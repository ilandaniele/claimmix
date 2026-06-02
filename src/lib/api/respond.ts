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
 * NEVER include stack traces or internal Supabase errors in the response body.
 */

import { NextResponse } from "next/server";
import {
  AppError,
  ErrorCode,
  ERROR_MESSAGES,
  ERROR_STATUS,
} from "@/lib/errors";

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
  details?: unknown
): NextResponse {
  if (error instanceof AppError) {
    return NextResponse.json(
      {
        error: {
          code: error.code,
          message: error.message,
          ...(error.details !== undefined ? { details: error.details } : {}),
        },
      },
      { status: error.status }
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
  const unknownErr = error instanceof Error ? error.message : String(error);
  console.error("[ClaimMix] Unhandled error in route handler:", unknownErr);

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
