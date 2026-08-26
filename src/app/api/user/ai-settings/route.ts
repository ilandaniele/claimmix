import { NextRequest } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { requireRole, ALL_ROLES } from "@/lib/auth/require-role";
// `user_ai_settings` no tiene columna de inquilino: la clave es el usuario.
// Por eso estas consultas van por el `db` del módulo y no por `enTenant` —
// no hay inquilino que fijar, y la capa no tendría nada que filtrar.
import { db, tables } from "@/lib/db";
import { firstRow } from "@/lib/db/helpers";
import { ok, err } from "@/lib/api/respond";
import { AppError } from "@/lib/errors";
import { getUserGeminiKey, setUserGeminiKey } from "@/server/ai/provider";

const PatchSchema = z.object({
  geminiKey: z.string().min(1).max(500).optional(),
  clearGeminiKey: z.boolean().optional(),
});

export async function GET() {
  try {
    const { user } = await requireRole(...ALL_ROLES);

    const row = firstRow(
      await db
        .select({ enc: tables.userAiSettings.gemini_api_key_encrypted })
        .from(tables.userAiSettings)
        .where(eq(tables.userAiSettings.user_id, user.id))
        .limit(1)
    );

    return ok({ has_gemini_key: Boolean(row?.enc) });
  } catch (e) {
    return err(e);
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const { user } = await requireRole(...ALL_ROLES);

    const parsed = PatchSchema.safeParse(await request.json());
    if (!parsed.success) throw new AppError("VALIDATION_FAILED", undefined, parsed.error.flatten());

    const { geminiKey, clearGeminiKey } = parsed.data;

    if (clearGeminiKey) {
      await import("@/lib/db").then(({ db }) =>
        db
          .update(tables.userAiSettings)
          .set({ gemini_api_key_encrypted: null, updated_at: new Date().toISOString() })
          .where(eq(tables.userAiSettings.user_id, user.id))
      );
      return ok({ has_gemini_key: false });
    }

    if (geminiKey) {
      await setUserGeminiKey(user.id, geminiKey);
      return ok({ has_gemini_key: true });
    }

    return ok({ has_gemini_key: Boolean(await getUserGeminiKey(user.id)) });
  } catch (e) {
    return err(e);
  }
}
