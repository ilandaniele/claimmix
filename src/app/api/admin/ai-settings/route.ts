/**
 * /api/admin/ai-settings — per-tenant AI provider switch + Gemini key storage.
 *
 * GET   — current provider + which providers have an API key configured.
 * PATCH — change the provider and/or save a Gemini API key.
 *         Body: { provider?: "openai" | "gemini", geminiKey?: string }
 *
 * Gemini key is stored encrypted in tenant_ai_settings.gemini_api_key_encrypted
 * (same AES-256-GCM as Gmail token storage). The extraction worker reads it on
 * every run (resolveExtractionEngine), so switching takes effect immediately.
 *
 * Auth: admin/owner (requireAdmin). Audit: AI_PROVIDER_CHANGED.
 */

import { NextRequest } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/auth/require-admin";
import { tables } from "@/lib/db";
import { ok, err } from "@/lib/api/respond";
import { AppError } from "@/lib/errors";
import { writeAuditLog, AuditEvent } from "@/lib/audit/log";
import {
  getTenantAiProvider,
  hasProviderKey,
  hasProviderKeyForTenant,
  getTenantGeminiKey,
  setTenantGeminiKey,
} from "@/server/ai/provider";
import { getGeminiModel } from "@/server/ai/gemini-extractor";

export const dynamic = "force-dynamic";

const PatchSchema = z
  .object({
    provider: z.enum(["openai", "gemini"]).optional(),
    geminiKey: z.string().min(1).max(500).optional(),
  })
  .refine((d) => d.provider !== undefined || d.geminiKey !== undefined, {
    message: "Provide at least one of: provider, geminiKey",
  });

async function providerStatus(tenantId: string) {
  const geminiKey = await getTenantGeminiKey(tenantId);
  return {
    openai: {
      configured: hasProviderKey("openai"),
      model: process.env.OPENAI_MODEL ?? "gpt-4o-mini",
    },
    gemini: {
      configured: Boolean(geminiKey),
      model: getGeminiModel(),
    },
  };
}

export async function GET() {
  try {
    const { userRow } = await requireAdmin();

    const provider = await getTenantAiProvider(userRow.tenant_id);

    return ok({ provider, providers: await providerStatus(userRow.tenant_id) });
  } catch (e) {
    return err(e);
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const { db, user, userRow } = await requireAdmin();

    const body = await request.json().catch(() => null);
    const parsed = PatchSchema.safeParse(body);
    if (!parsed.success) {
      throw new AppError("VALIDATION_FAILED", undefined, parsed.error.flatten());
    }

    const { provider, geminiKey } = parsed.data;

    // Save Gemini key if provided
    if (geminiKey) {
      await setTenantGeminiKey(userRow.tenant_id, geminiKey);
    }

    // Switch provider if requested
    if (provider) {
      const canUse = await hasProviderKeyForTenant(userRow.tenant_id, provider);
      if (!canUse) {
        throw new AppError(
          "VALIDATION_FAILED",
          provider === "gemini"
            ? "Gemini no está configurado: ingresá tu API key primero."
            : "OpenAI no está configurado: falta OPENAI_API_KEY en el servidor."
        );
      }

      const t = tables.tenantAiSettings;
      try {
        await db
          .insert(t)
          .values({
            tenant_id: userRow.tenant_id,
            provider,
            updated_at: new Date().toISOString(),
          })
          .onConflictDoUpdate({
            target: t.tenant_id,
            set: {
              provider,
              updated_at: new Date().toISOString(),
            },
          });
      } catch (e) {
        const code = (e as { code?: string })?.code;
        if (code === "42P01") {
          throw new AppError(
            "VALIDATION_FAILED",
            "Falta aplicar la migración 0015 (tenant_ai_settings)."
          );
        }
        console.error("[admin/ai-settings PATCH]", code ?? "unknown");
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
    }

    const activeProvider = provider ?? (await getTenantAiProvider(userRow.tenant_id));
    return ok({ provider: activeProvider, providers: await providerStatus(userRow.tenant_id) });
  } catch (e) {
    return err(e);
  }
}
