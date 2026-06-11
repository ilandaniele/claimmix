/**
 * /api/admin/ai-settings — per-tenant AI provider switch.
 *
 * GET   — current provider + which providers have an API key configured.
 * PATCH — change the provider. Body: { provider: "openai" | "gemini" }.
 *
 * The setting is stored in tenant_ai_settings (one row per tenant, RLS).
 * The extraction worker reads it on every run (resolveExtractionEngine),
 * so switching takes effect immediately — no redeploy needed.
 *
 * Auth: admin/owner (requireAdmin). Audit: AI_PROVIDER_CHANGED.
 */

import { NextRequest } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/auth/require-admin";
import { ok, err } from "@/lib/api/respond";
import { AppError } from "@/lib/errors";
import { writeAuditLog, AuditEvent } from "@/lib/audit/log";
import {
  getTenantAiProvider,
  hasProviderKey,
} from "@/server/ai/provider";
import { getGeminiModel } from "@/server/ai/gemini-extractor";

export const dynamic = "force-dynamic";

const PatchSchema = z.object({
  provider: z.enum(["openai", "gemini"]),
});

function providerStatus() {
  return {
    openai: {
      configured: hasProviderKey("openai"),
      model: process.env.OPENAI_MODEL ?? "gpt-4o-mini",
    },
    gemini: {
      configured: hasProviderKey("gemini"),
      model: getGeminiModel(),
    },
  };
}

export async function GET() {
  try {
    const { supabase, userRow } = await requireAdmin();

    const provider = await getTenantAiProvider(supabase, userRow.tenant_id);

    return ok({ provider, providers: providerStatus() });
  } catch (e) {
    return err(e);
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const { supabase, user, userRow } = await requireAdmin();

    const body = await request.json().catch(() => null);
    const parsed = PatchSchema.safeParse(body);
    if (!parsed.success) {
      throw new AppError("VALIDATION_FAILED", undefined, parsed.error.flatten());
    }

    const { provider } = parsed.data;

    if (!hasProviderKey(provider)) {
      throw new AppError(
        "VALIDATION_FAILED",
        provider === "gemini"
          ? "Gemini no está configurado: falta GEMINI_API_KEY en el servidor."
          : "OpenAI no está configurado: falta OPENAI_API_KEY en el servidor."
      );
    }

    const { error } = await (supabase as any)
      .from("tenant_ai_settings")
      .upsert(
        {
          tenant_id: userRow.tenant_id,
          provider,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "tenant_id" }
      );

    if (error) {
      if (error.code === "42P01") {
        throw new AppError(
          "VALIDATION_FAILED",
          "Falta aplicar la migración 0015 (tenant_ai_settings)."
        );
      }
      console.error("[admin/ai-settings PATCH]", error.code);
      return err(new AppError("INTERNAL_ERROR"));
    }

    await writeAuditLog({
      tenant_id: userRow.tenant_id,
      actor_id: user.id,
      event_type: AuditEvent.AI_PROVIDER_CHANGED,
      target_type: "tenant_ai_settings",
      target_id: userRow.tenant_id,
      payload: { provider },
    });

    return ok({ provider, providers: providerStatus() });
  } catch (e) {
    return err(e);
  }
}
