/**
 * /api/admin/ai-settings - per-tenant AI provider switch + Gemini key storage.
 *
 * GET   - current provider + which providers have an API key configured.
 * PATCH - change the provider and/or save a Gemini API key.
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
import { ok, err } from "@/lib/api/respond";
import { AppError } from "@/lib/errors";
import { writeAuditLog, AuditEvent } from "@/lib/audit/log";
import {
  getTenantAiProvider,
  hasProviderKey,
  hasProviderKeyForTenant,
  getTenantGeminiKey,
  getTenantOpenAIModel,
  getTenantGeminiModel,
  setTenantModelDefaults,
  setTenantGeminiKey,
} from "@/server/ai/provider";

export const dynamic = "force-dynamic";

const PatchSchema = z
  .object({
    provider: z.enum(["openai", "gemini"]).optional(),
    geminiKey: z.string().min(1).max(500).optional(),
    openaiModel: z.string().trim().min(1).max(120).optional(),
    geminiModel: z.string().trim().min(1).max(120).optional(),
  })
  .refine((d) => Object.keys(d).length > 0, {
    message: "Provide at least one setting to update",
  });

async function providerStatus(tenantId: string) {
  const geminiKey = await getTenantGeminiKey(tenantId);
  return {
    openai: {
      configured: hasProviderKey("openai"),
      model: await getTenantOpenAIModel(tenantId),
    },
    gemini: {
      configured: Boolean(geminiKey),
      model: await getTenantGeminiModel(tenantId),
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
    const { user, userRow } = await requireAdmin();

    const body = await request.json().catch(() => null);
    const parsed = PatchSchema.safeParse(body);
    if (!parsed.success) {
      throw new AppError("VALIDATION_FAILED", undefined, parsed.error.flatten());
    }

    const { provider, geminiKey, openaiModel, geminiModel } = parsed.data;

    if (geminiKey) {
      await setTenantGeminiKey(userRow.tenant_id, geminiKey);
    }

    if (provider) {
      const canUse = await hasProviderKeyForTenant(userRow.tenant_id, provider);
      if (!canUse) {
        throw new AppError(
          "VALIDATION_FAILED",
          provider === "gemini"
            ? "Gemini no esta configurado: ingresa tu API key primero."
            : "OpenAI no esta configurado: falta OPENAI_API_KEY en el servidor."
        );
      }
    }

    if (provider || openaiModel || geminiModel) {
      try {
        await setTenantModelDefaults(userRow.tenant_id, {
          provider,
          openaiModel,
          geminiModel,
        });
      } catch (e) {
        const code = (e as { code?: string })?.code;
        if (code === "42P01" || code === "42703") {
          throw new AppError(
            "VALIDATION_FAILED",
            "Falta aplicar las migraciones de tenant_ai_settings."
          );
        }
        console.error("[admin/ai-settings PATCH]", code ?? "unknown");
        return err(new AppError("INTERNAL_ERROR"));
      }
    }

    if (provider) {
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
