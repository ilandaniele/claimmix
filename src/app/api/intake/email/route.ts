/**
 * POST /api/intake/email — real email webhook stub.
 *
 * IC3: Real email ingestion is not connected in MVP.
 * Spec: Returns 501 with Retry-After: 86400 header.
 * Error code: NOT_IMPLEMENTED.
 *
 * No auth required (this is a webhook endpoint).
 */

export async function POST(): Promise<Response> {
  return new Response(
    JSON.stringify({
      error: {
        code: "NOT_IMPLEMENTED",
        message:
          "La recepción de emails reales no está disponible en esta versión. Usá el endpoint de simulación.",
      },
    }),
    {
      status: 501,
      headers: {
        "Content-Type": "application/json",
        "Retry-After": "86400",
      },
    }
  );
}
