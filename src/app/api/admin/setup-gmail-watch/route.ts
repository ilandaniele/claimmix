/**
 * POST /api/admin/setup-gmail-watch — operator one-time setup endpoint.
 *
 * Registers a Gmail push subscription for the configured account by calling
 * setupGmailWatch() with the PUBSUB_TOPIC environment variable.
 *
 * Auth: interna, con CRON_SECRET (Bearer). NO es una ruta de cara al usuario.
 *
 * Antes también aceptaba un header `X-Internal-Worker: true`, que no es un
 * secreto: lo manda cualquiera. El comentario decía que proxy.ts tapaba el
 * hueco como segunda capa, pero el matcher de proxy.ts excluye /api y nunca
 * corrió acá. El header era la única puerta y estaba abierta.
 *
 * W4: AC12, AC13, AC14, AC15.
 */

import { type NextRequest, NextResponse } from "next/server";
import { setupGmailWatch } from "@/server/email/gmail/watch";
import { isInternalRequest } from "@/lib/security/internal-auth";

export async function POST(request: NextRequest): Promise<NextResponse> {
  // ── Auth check ────────────────────────────────────────────────────────────────
  if (!isInternalRequest(request)) {
    return NextResponse.json(
      { error: { code: "UNAUTHORIZED", message: "Acceso no autorizado." } },
      { status: 401 }
    );
  }

  // ── Env check ────────────────────────────────────────────────────────────────
  const topicName = process.env.PUBSUB_TOPIC;
  if (!topicName) {
    return NextResponse.json(
      {
        error: {
          code: "PUBSUB_NOT_CONFIGURED",
          message: "Set PUBSUB_TOPIC env var to the fully-qualified Pub/Sub topic name (e.g. projects/my-project/topics/gmail-push).",
        },
      },
      { status: 500 }
    );
  }

  // ── Setup watch ──────────────────────────────────────────────────────────────
  try {
    const { historyId, expiration } = await setupGmailWatch(topicName);
    return NextResponse.json(
      { historyId, expiration, message: "watch setup OK" },
      { status: 200 }
    );
  } catch (err) {
    const errName = err instanceof Error ? err.name : "UnknownError";
    console.error(
      JSON.stringify({
        level: "error",
        service: "claimmix",
        msg: "admin.setup_gmail_watch.failed",
        error_name: errName,
      })
    );
    return NextResponse.json(
      { error: { code: "INTERNAL", message: "Watch setup failed. Check server logs." } },
      { status: 500 }
    );
  }
}
