/**
 * GET /api/health — is the deployment that is actually running healthy?
 *
 * Every check we had ran on a laptop. That is enough to know the code is
 * right and says nothing about whether the thing serving real claimants can
 * reach anything, which is a different question with its own way of going
 * wrong: R2 was configured locally and working in every local run for hours
 * while production silently dropped every attachment, because the credentials
 * had never been added to Vercel. Nothing failed loudly. The bucket simply was
 * not there, and the only symptom was a claimant being asked twice for a photo.
 *
 * So this runs inside the deployment and reports what it can actually reach.
 * It is the check to run after a deploy, and the one to look at first when
 * something is behaving strangely in production.
 *
 * Auth: Bearer CRON_SECRET. It reveals which dependencies exist and how they
 * are configured — not secrets, but a map of the attack surface, and there is
 * no reason for it to be public.
 *
 * `?deep=1` additionally spends money: a real upload to R2 and a real call to
 * the model. The default checks configuration and connectivity only, so it is
 * free to call often.
 */

import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { sql } from "drizzle-orm";

import { db } from "@/lib/db";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

type Status = "ok" | "degraded" | "down";

interface Check {
  name: string;
  status: Status;
  detail: string;
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  if (!authorized(req)) {
    return NextResponse.json(
      { error: { code: "UNAUTHORIZED", message: "Bearer CRON_SECRET requerido." } },
      { status: 401 }
    );
  }

  const deep = req.nextUrl.searchParams.get("deep") === "1";

  const checks = await Promise.all([
    checkDatabase(),
    checkSchema(),
    checkStorage(deep),
    checkModel(deep),
    checkWhatsApp(),
    checkGmail(),
    checkAgentConfig(),
  ]);

  const worst: Status = checks.some((c) => c.status === "down")
    ? "down"
    : checks.some((c) => c.status === "degraded")
      ? "degraded"
      : "ok";

  return NextResponse.json(
    {
      status: worst,
      deep,
      commit: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? null,
      environment: process.env.VERCEL_ENV ?? "local",
      checked_at: new Date().toISOString(),
      checks,
    },
    // 503 so anything watching a URL notices without parsing the body.
    { status: worst === "down" ? 503 : 200 }
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

function ok(name: string, detail: string): Check {
  return { name, status: "ok", detail };
}
function degraded(name: string, detail: string): Check {
  return { name, status: "degraded", detail };
}
function down(name: string, detail: string): Check {
  return { name, status: "down", detail };
}

function why(err: unknown): string {
  return (
    (err as { code?: string })?.code ??
    (err instanceof Error ? err.message.slice(0, 120) : "error desconocido")
  );
}

// ── The checks ───────────────────────────────────────────────────────────────

async function checkDatabase(): Promise<Check> {
  try {
    await db.execute(sql`select 1`);
    return ok("base de datos", "responde");
  } catch (err) {
    return down("base de datos", why(err));
  }
}

/**
 * Are the migrations actually applied to the database this deployment talks to?
 *
 * Migrations here are applied by hand and nothing tracks them, so code that
 * expects a column can ship days before the column exists. The failure is
 * quiet and specific: one feature stops working while everything else looks
 * fine. Checking the newest columns catches the whole class.
 */
async function checkSchema(): Promise<Check> {
  const required: Array<[string, string]> = [
    ["missing_docs", "declined_at"],
    ["outbound_messages", "asked_keys"],
    ["cases", "extraction_lease_at"],
  ];

  try {
    const rows = (await db.execute(sql`
      select table_name, column_name
        from information_schema.columns
       where table_schema = 'public'
    `)) as unknown as Array<{ table_name: string; column_name: string }>;

    const present = new Set(
      (Array.isArray(rows) ? rows : []).map((r) => `${r.table_name}.${r.column_name}`)
    );
    const missing = required
      .map(([t, c]) => `${t}.${c}`)
      .filter((key) => !present.has(key));

    return missing.length === 0
      ? ok("migraciones", "las columnas que el código espera existen")
      : down("migraciones", `faltan: ${missing.join(", ")}`);
  } catch (err) {
    return degraded("migraciones", `no se pudo verificar: ${why(err)}`);
  }
}

/**
 * Object storage.
 *
 * Configuration alone is not proof — the shallow check confirms the variables
 * reached this deployment, which is the failure that actually happened. `deep`
 * does the round trip that proves the credentials work and the bucket exists.
 */
async function checkStorage(deep: boolean): Promise<Check> {
  const configured = ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET"]
    .filter((v) => !process.env[v]?.trim());

  if (configured.length > 0) {
    return down("almacenamiento", `sin configurar: ${configured.join(", ")}`);
  }
  if (!deep) return ok("almacenamiento", "configurado (sin probar; usá deep=1)");

  try {
    const { uploadAttachment, readAttachment } = await import(
      "@/server/storage/claim-attachments-bucket"
    );
    const data = Buffer.from(`health ${Date.now()}`);
    const uploaded = await uploadAttachment({
      tenantId: "health",
      caseId: "check",
      messageId: String(Date.now()),
      filename: "health.txt",
      contentType: "text/plain",
      data,
    });
    if ("error" in uploaded) return down("almacenamiento", `subida: ${uploaded.error}`);

    const read = await readAttachment(uploaded.storagePath);
    if (!read || !read.equals(data)) {
      return down("almacenamiento", "lo subido no volvió igual");
    }

    return ok("almacenamiento", "subida y lectura correctas");
  } catch (err) {
    return down("almacenamiento", why(err));
  }
}

/** The model. Shallow: are the credentials here. Deep: does it answer. */
async function checkModel(deep: boolean): Promise<Check> {
  const vertex = process.env.GEMINI_TRANSPORT === "vertex";
  const missing = vertex
    ? ["GOOGLE_CLOUD_PROJECT", "GOOGLE_SERVICE_ACCOUNT_JSON"].filter(
        (v) => !process.env[v]?.trim()
      )
    : ["GEMINI_API_KEY"].filter((v) => !process.env[v]?.trim());

  if (missing.length > 0) {
    return down("modelo", `sin configurar: ${missing.join(", ")}`);
  }
  if (!deep) {
    return ok("modelo", `${vertex ? "vertex" : "ai studio"} configurado (sin probar)`);
  }

  try {
    const { callGemini } = await import("@/server/ai/gemini-extractor");
    const { text } = await callGemini(
      'Respondé exactamente {"ok": true} y nada más.',
      "ping"
    );
    return text ? ok("modelo", "responde") : down("modelo", "respondió vacío");
  } catch (err) {
    return down("modelo", why(err));
  }
}

/**
 * WhatsApp.
 *
 * The access token is long-lived, not permanent, and when it lapses the
 * failure is silent from our side: the webhook keeps accepting messages, the
 * agent keeps deciding what to say, and every reply fails to send. Asking
 * Graph who we are costs nothing and catches it.
 */
async function checkWhatsApp(): Promise<Check> {
  const token = process.env.WHATSAPP_ACCESS_TOKEN?.trim();
  const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID?.trim();
  if (!token || !phoneId) return degraded("whatsapp", "sin configurar");

  try {
    const version = process.env.WHATSAPP_API_VERSION?.trim() || "v21.0";
    const res = await fetch(
      `https://graph.facebook.com/${version}/${phoneId}?fields=display_phone_number`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!res.ok) return down("whatsapp", `graph respondió ${res.status}`);

    const body = (await res.json()) as { display_phone_number?: string };
    return ok("whatsapp", `token válido para ${body.display_phone_number ?? phoneId}`);
  } catch (err) {
    return down("whatsapp", why(err));
  }
}

/** Is a mailbox connected, and is its refresh token still good? */
async function checkGmail(): Promise<Check> {
  const tenantId = process.env.GMAIL_TENANT_ID?.trim();
  if (!tenantId) return degraded("gmail", "GMAIL_TENANT_ID sin configurar");

  try {
    const rows = (await db.execute(sql`
      select email_address, refresh_token is not null as has_token
        from gmail_accounts
       where tenant_id = ${tenantId}::uuid
       limit 1
    `)) as unknown as Array<{ email_address: string; has_token: boolean }>;

    const account = Array.isArray(rows) ? rows[0] : undefined;
    if (!account) return degraded("gmail", "ninguna casilla conectada");
    if (!account.has_token) {
      return down("gmail", `${account.email_address} perdió el refresh token`);
    }
    return ok("gmail", `${account.email_address} conectada`);
  } catch (err) {
    return degraded("gmail", `no se pudo verificar: ${why(err)}`);
  }
}

/**
 * Which agent behaviours are switched on in this deployment.
 *
 * Not a failure either way — both have an off switch on purpose — but a
 * deployment quietly running with deliberation disabled behaves like the old
 * decision tree, and that is worth being able to see rather than deduce from
 * the messages.
 */
function checkAgentConfig(): Check {
  const deliberation = process.env.AGENT_DELIBERATION !== "off";
  const composing = process.env.AGENT_COMPOSE_REPLIES !== "off";

  const parts = [
    `deliberación ${deliberation ? "on" : "OFF"}`,
    `redacción ${composing ? "on" : "OFF"}`,
  ];

  return deliberation && composing
    ? ok("agente", parts.join(", "))
    : degraded("agente", parts.join(", "));
}
