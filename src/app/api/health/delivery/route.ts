/**
 * POST /api/health/delivery — send one test message from the deployment.
 *
 * Proving that a message can actually leave the building was the last check
 * still running on a laptop, and it could not stay there. The Gmail refresh
 * token is stored encrypted, and `GMAIL_TOKEN_ENCRYPTION_KEY` is marked
 * Sensitive in Vercel — which means write-only. Nobody can read it back, not
 * through the dashboard, not through the CLI, not the person who set it. That
 * is the point of the setting and it is the right setting for that key.
 *
 * So the test goes to where the credentials already live. Production has the
 * key, the token, and the WhatsApp access token; it sends the message and
 * reports what the provider said. Nothing has to be copied anywhere, and the
 * thing being proved is the deployment's ability to send, which is the thing
 * that matters — a laptop that can send tells you nothing about production.
 *
 * Auth: Bearer CRON_SECRET, the same key as /api/health.
 *
 * This endpoint sends real messages, so two things bound it. The body is fixed
 * here and cannot be supplied by the caller — it can announce itself as a test
 * and nothing else, which is what stops it being useful to anyone who gets
 * hold of the secret. And it refuses more than one send a minute, so it cannot
 * be turned into a way to hammer somebody's phone.
 */

import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { and, desc, eq, gt } from "drizzle-orm";

import { db } from "@/lib/db";
import { enTenant, type TenantContext } from "@/data/scope";
import { auditLog } from "@/lib/db/schema";
import { writeAuditLog, AuditEvent } from "@/lib/audit/log";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** One a minute. Enough to retry after a fix, not enough to be a nuisance. */
const MIN_SECONDS_BETWEEN_SENDS = 60;

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!authorized(req)) {
    return NextResponse.json(
      { error: { code: "UNAUTHORIZED", message: "Bearer CRON_SECRET requerido." } },
      { status: 401 }
    );
  }

  const tenantId = process.env.GMAIL_TENANT_ID?.trim();
  if (!tenantId) {
    return NextResponse.json(
      { ok: false, detail: "GMAIL_TENANT_ID sin configurar" },
      { status: 500 }
    );
  }

  // Después de la guarda a propósito: antes, tenantId puede ser undefined.
  const tenantCtx: TenantContext = { tenantId };

  let body: { channel?: unknown; to?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, detail: "cuerpo inválido" }, { status: 400 });
  }

  const channel = body.channel === "whatsapp" ? "whatsapp" : "email";
  const to = typeof body.to === "string" ? body.to.trim() : "";
  if (!to) {
    return NextResponse.json({ ok: false, detail: "falta 'to'" }, { status: 400 });
  }

  if (await sentRecently(tenantId)) {
    return NextResponse.json(
      {
        ok: false,
        detail: `esperá ${MIN_SECONDS_BETWEEN_SENDS} segundos entre pruebas de envío`,
      },
      { status: 429 }
    );
  }

  const result =
    channel === "whatsapp" ? await sendWhatsApp(to) : await sendEmail(tenantId, to);

  // Written whether it worked or not: a real message went out, or was
  // attempted, and that belongs in the record like anything else we send.
  await writeAuditLog({
    tenant_id: tenantId,
    actor_id: null,
    event_type: AuditEvent.DELIVERY_TEST,
    target_type: "delivery",
    target_id: null,
    payload: { channel, ok: result.ok, detail: result.detail },
  });

  return NextResponse.json(
    { ok: result.ok, channel, detail: result.detail },
    { status: result.ok ? 200 : 502 }
  );
}

function authorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;

  const given = req.headers.get("authorization") ?? "";
  const expected = `Bearer ${secret}`;
  const a = Buffer.from(given, "utf-8");
  const b = Buffer.from(expected, "utf-8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Has a test message gone out in the last minute? */
async function sentRecently(tenantId: string): Promise<boolean> {
  const tenantCtx: TenantContext = { tenantId };
  try {
    const since = new Date(Date.now() - MIN_SECONDS_BETWEEN_SENDS * 1000).toISOString();
    const rows = await enTenant(tenantCtx, (db) =>
      db
        .select({ id: auditLog.id })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.event_type, AuditEvent.DELIVERY_TEST),
            gt(auditLog.created_at, since)
          )
        )
        .orderBy(desc(auditLog.created_at))
        .limit(1)
    );
    return rows.length > 0;
  } catch {
    // A rate limit that cannot read its own history should not block the
    // check it exists to protect — the auth and the fixed body already do the
    // work that matters.
    return false;
  }
}

/** The body. Fixed here on purpose: the caller chooses who, never what. */
function testBody(): string {
  const stamp = new Date().toISOString().replace("T", " ").slice(0, 16);
  return (
    `Prueba de entrega de ClaimMix — ${stamp}. ` +
    `Es un mensaje automático para verificar que el sistema puede enviar. ` +
    `No hace falta que contestes.`
  );
}

async function sendWhatsApp(to: string): Promise<{ ok: boolean; detail: string }> {
  const { sendWhatsAppText } = await import("@/server/whatsapp/cloud-api");
  const res = await sendWhatsAppText(to, testBody());
  return res.ok
    ? { ok: true, detail: "Meta lo aceptó y lo puso en camino" }
    : { ok: false, detail: res.error ?? "falló el envío" };
}

async function sendEmail(
  tenantId: string,
  to: string
): Promise<{ ok: boolean; detail: string }> {
  const { getGmailAccountForTenant } = await import("@/server/email/gmail/accounts");
  const account = await getGmailAccountForTenant(tenantId);
  if (!account) {
    return { ok: false, detail: "ninguna casilla conectada, o el token no descifra" };
  }

  const { GmailSender } = await import("@/server/email/gmail/gmail-sender");
  const result = await new GmailSender(account.refreshToken).send({
    to,
    from: account.email,
    subject: "Prueba de entrega de ClaimMix",
    textBody: testBody(),
  });

  if ("providerMessageId" in result && result.providerMessageId) {
    return { ok: true, detail: `enviado desde ${account.email}` };
  }

  // Almost always a refresh token revoked by a password change.
  return {
    ok: false,
    detail:
      ("errorCode" in result && result.errorCode) ||
      "falló el envío; puede que haya que reconectar la casilla",
  };
}
