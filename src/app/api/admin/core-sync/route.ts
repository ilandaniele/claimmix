/**
 * /api/admin/core-sync — la entrega al sistema de la aseguradora (B5).
 *
 *   PATCH { webhook_url?, enabled? }  la URL del webhook y si está prendido.
 *   POST  { accion }                  generar-secreto · rotar-clave ·
 *                                     revocar-clave · probar-envio
 *
 * Sin GET: la config llega a /configuracion como prop del servidor
 * (`vistaDeLaConfig`), sin secreto ni hash.
 *
 * El secreto de firma y la clave de /api/v1 se devuelven en claro UNA vez, en
 * la respuesta que los crea, con `no-store`. En la base quedan el secreto
 * cifrado y el sha256 de la clave; no van a logs ni a la auditoría.
 */

import { randomBytes, randomUUID } from "crypto";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { enTenant, type TenantContext } from "@/data/scope";
import { entrar } from "@/lib/api/entrada";
import { ok, err } from "@/lib/api/respond";
import type { RoleContext } from "@/lib/auth/require-role";
import { ADMIN_ROLES } from "@/lib/auth/roles";
import { coreSyncSettings } from "@/lib/db/schema";
import { AppError } from "@/lib/errors";
import { writeAuditLog, AuditEvent } from "@/lib/audit/log";
import { RATE_LIMIT_CONFIGS } from "@/lib/rate-limit/index";
import { cifrar, descifrar } from "@/lib/security/cifrado";
import { claveNueva, SIN_CACHE } from "@/server/core-sync/clave";
import { codigoPg, consultaDeLaConfig, esFaltaDe0036 } from "@/server/core-sync/config";
import { revisarForma } from "@/server/core-sync/destino";
import { RealCoreSyncClient } from "@/server/core-sync/real";

export const dynamic = "force-dynamic";

// La forma se valida acá; la resolución DNS corre recién al enviar (`validarDestino`).
const UrlDelWebhook = z
  .string()
  .trim()
  .refine(
    (url) => {
      try {
        revisarForma(url);
        return true;
      } catch {
        return false;
      }
    },
    "La URL tiene que ser https, en el puerto 443 y con un nombre, no una IP."
  );

const PatchSchema = z
  .object({ webhook_url: UrlDelWebhook.nullable().optional(), enabled: z.boolean().optional() })
  .strict()
  .refine((b) => b.webhook_url !== undefined || b.enabled !== undefined, "No hay nada para cambiar.");

const PostSchema = z.object({
  accion: z.enum(["generar-secreto", "rotar-clave", "revocar-clave", "probar-envio"]),
});

type Cambios = Partial<
  Pick<
    typeof coreSyncSettings.$inferInsert,
    "webhook_url" | "enabled" | "signing_secret_enc" | "api_key_hash" | "api_key_prefix"
  >
>;

/** El mensaje queda en castellano; el panel traduce `motivo`. */
function rechazo(mensaje: string, motivo: "url" | "migracion" | "incompleto" | "secreto_ilegible"): AppError {
  return new AppError("VALIDATION_FAILED", mensaje, { motivo });
}

function traducirError(e: unknown): never {
  if (esFaltaDe0036(e)) throw rechazo("Falta aplicar la migración 0036 (entrega al core).", "migracion");
  // 23514: el CHECK `activo_completo` de la 0036.
  if (codigoPg(e) === "23514") throw rechazo("Para activar el envío hacen falta la URL y el secreto.", "incompleto");
  throw e;
}

/** Upsert de la fila del tenant: la primera vez la crea, apagada. */
async function guardar(ctx: TenantContext, userId: string, cambios: Cambios) {
  const firma = { updated_at: new Date().toISOString(), updated_by: userId };
  try {
    const [fila] = await enTenant(ctx, (db) =>
      db
        .insert(coreSyncSettings)
        .values({ tenant_id: ctx.tenantId, ...cambios, ...firma })
        .onConflictDoUpdate({ target: coreSyncSettings.tenant_id, set: { ...cambios, ...firma } })
        .returning({ webhook_url: coreSyncSettings.webhook_url, enabled: coreSyncSettings.enabled })
    );
    return fila;
  } catch (e) {
    traducirError(e);
  }
}

/** El admin y su cupo, en paralelo; sin cupo, el 429 que hay que devolver. */
async function puerta(): Promise<RoleContext | Response> {
  const { ctx, rl } = await entrar("core-sync", RATE_LIMIT_CONFIGS.SYNC_TO_CORE, ...ADMIN_ROLES);
  if (rl.allowed) return ctx;
  return err(new AppError("RATE_LIMITED"), undefined, { "Retry-After": String(rl.retryAfterSeconds) });
}

function auditar(ctx: TenantContext, userId: string, event_type: string, payload: Record<string, boolean | string | null>) {
  return writeAuditLog({
    tenant_id: ctx.tenantId,
    actor_id: userId,
    event_type,
    target_type: "tenant",
    target_id: ctx.tenantId,
    payload,
  });
}

export async function PATCH(request: NextRequest) {
  try {
    const admin = await puerta();
    if (admin instanceof Response) return admin;
    const { user, userRow } = admin;

    const parsed = PatchSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      const [problema] = parsed.error.issues;
      if (problema?.path[0] === "webhook_url") throw rechazo(problema.message, "url");
      throw new AppError("VALIDATION_FAILED", problema?.message);
    }
    const { webhook_url, enabled } = parsed.data;

    const ctx: TenantContext = { tenantId: userRow.tenant_id }; // nunca del body
    const fila = await guardar(ctx, user.id, { webhook_url, enabled });

    await auditar(ctx, user.id, AuditEvent.CORE_SETTINGS_CHANGED, {
      url_cambiada: webhook_url !== undefined,
      ...(enabled !== undefined && { enabled }),
    });
    return ok(fila);
  } catch (e) {
    return err(e);
  }
}

export async function POST(request: NextRequest) {
  try {
    const admin = await puerta();
    if (admin instanceof Response) return admin;
    const { user, userRow } = admin;

    const parsed = PostSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) throw new AppError("VALIDATION_FAILED", parsed.error.issues[0]?.message);
    const ctx: TenantContext = { tenantId: userRow.tenant_id };

    switch (parsed.data.accion) {
      case "generar-secreto": {
        const secreto = randomBytes(32).toString("base64url");
        await guardar(ctx, user.id, { signing_secret_enc: cifrar(secreto) });
        await auditar(ctx, user.id, AuditEvent.CORE_SETTINGS_CHANGED, { secreto_generado: true });
        return NextResponse.json({ secreto }, { headers: SIN_CACHE });
      }
      case "rotar-clave": {
        const { clave, prefijo, hash } = claveNueva(ctx.tenantId);
        await guardar(ctx, user.id, { api_key_hash: hash, api_key_prefix: prefijo });
        await auditar(ctx, user.id, AuditEvent.CORE_SETTINGS_CHANGED, { clave_rotada: true });
        return NextResponse.json({ clave, prefijo }, { headers: SIN_CACHE });
      }
      case "revocar-clave": {
        await guardar(ctx, user.id, { api_key_hash: null, api_key_prefix: null });
        await auditar(ctx, user.id, AuditEvent.CORE_SETTINGS_CHANGED, { clave_revocada: true });
        return ok({ revocada: true });
      }
      case "probar-envio":
        return await probarEnvio(ctx, user.id);
    }
  } catch (e) {
    return err(e);
  }
}

/** Un payload sintético, marcado `prueba`, a la URL guardada. No toca ningún caso. */
async function probarEnvio(ctx: TenantContext, userId: string): Promise<Response> {
  let fila;
  try {
    [fila] = await enTenant(ctx, (db) => consultaDeLaConfig(db));
  } catch (e) {
    traducirError(e);
  }
  if (!fila?.webhook_url || !fila.signing_secret_enc) {
    throw rechazo("Primero guardá la URL y generá el secreto.", "incompleto");
  }
  let secreto: string;
  try {
    secreto = descifrar(fila.signing_secret_enc);
  } catch {
    throw rechazo("El secreto guardado no se puede leer: generá otro.", "secreto_ilegible");
  }

  const resultado = await new RealCoreSyncClient({ url: fila.webhook_url, secreto }).syncCase({
    caseId: randomUUID(),
    tenantId: ctx.tenantId,
    claimType: "prueba",
    severity: null,
    customerName: null,
    policyNumber: null,
    accidentDate: null,
    accidentDescription: null,
    extractedFields: {},
    updatedAt: new Date().toISOString(),
    prueba: true,
  });
  const respuesta = { ok: resultado.ok, motivo: resultado.ok ? null : resultado.motivo };
  await auditar(ctx, userId, AuditEvent.CORE_WEBHOOK_TESTED, respuesta);
  return ok(respuesta);
}
