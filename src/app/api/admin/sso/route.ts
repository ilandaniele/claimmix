/**
 * /api/admin/sso — el SSO OIDC de la aseguradora (B19).
 *
 *   GET                              la config sin secreto, el registro DNS a
 *                                    publicar y la dirección de vuelta del IdP.
 *   PUT   { issuer, client_id, dominio, client_secret? }
 *                                    guarda el IdP. Sin `client_secret` se
 *                                    conserva el actual, salvo que cambie el
 *                                    issuer o el client_id: a otro IdP o a otra
 *                                    aplicación no viaja el secreto de la anterior.
 *   POST  { accion: "verificar" }    busca el TXT `_claimmix.<dominio>`.
 *   PATCH { activo?, exigir? }       prende o apaga el SSO y «exigir».
 *
 * El inquilino sale de la sesión, nunca del cuerpo. Una consulta por acción
 * (verificar suma la lectura del dominio, porque el DNS va en el medio).
 *
 * El secreto se guarda cifrado y no vuelve nunca: ni en la respuesta, ni en
 * los logs, ni en la auditoría (sólo dice si se cambió).
 */

import { eq } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { enControl, type TenantContext } from "@/data/scope";
import { entrar } from "@/lib/api/entrada";
import { ok, err } from "@/lib/api/respond";
import { writeAuditLog, AuditEvent } from "@/lib/audit/log";
import { ADMIN_ROLES } from "@/lib/auth/roles";
import { ssoSettings } from "@/lib/db/schema";
import { AppError } from "@/lib/errors";
import { logger } from "@/lib/observability/logger";
import { RATE_LIMIT_CONFIGS } from "@/lib/rate-limit/index";
import { cifrar } from "@/lib/security/cifrado";
import { dominioValido, esDominioPublico, normalizarDominio } from "@/core/sso";
import {
  CAMPOS_DE_LA_VISTA,
  cambiarEstadoSso,
  codigoPg,
  descubrir,
  guardarIdp,
  type MotivoDeDescubrimiento,
} from "@/server/sso/config";
import { faltaLaMigracionConTabla, migracionPendiente } from "@/server/core-sync/config";
import { resolverTxt, txtProbado } from "@/server/sso/dominio";
import { armarPanel, panelSso } from "@/server/sso/panel";
import { cerrarSesionesDelDominio } from "@/server/sso/usuarios";

export const dynamic = "force-dynamic";

const PutSchema = z
  .object({
    issuer: z.string().trim().min(1).max(512),
    client_id: z.string().trim().min(1).max(256),
    client_secret: z.string().trim().min(1).max(2048).optional(),
    dominio: z.string().trim().min(1).max(253),
  })
  .strict();

const PostSchema = z.object({ accion: z.enum(["verificar"]) }).strict();

const PatchSchema = z
  .object({ activo: z.boolean().optional(), exigir: z.boolean().optional() })
  .strict()
  .refine((b) => b.activo !== undefined || b.exigir !== undefined, "No hay nada para cambiar.")
  .refine((b) => !(b.activo === false && b.exigir === true), "No se puede exigir SSO con el SSO apagado.");

/** El mensaje queda en castellano; el panel traduce `motivo`. */
function rechazo(mensaje: string, motivo: string): AppError {
  return new AppError("VALIDATION_FAILED", mensaje, { motivo });
}

function conflicto(mensaje: string, motivo: "sso_incompleto" | "sso_sin_prueba" | "dominio_en_uso"): AppError {
  return new AppError("CONFLICT", mensaje, { motivo });
}

const MENSAJE_DEL_IDP: Record<MotivoDeDescubrimiento, string> = {
  issuer_invalido: "El issuer tiene que ser una URL https, en el puerto 443 y con un nombre, no una IP.",
  sin_respuesta: "El proveedor no respondió en su documento de configuración (/.well-known/openid-configuration).",
  documento_ilegible: "El documento de configuración del proveedor no tiene el formato esperado.",
  issuer_no_coincide: "El issuer que figura en el documento del proveedor no es el que cargaste.",
  endpoint_rechazado: "Alguna dirección del documento del proveedor no es https en el puerto 443.",
};

const faltaLa0045 = faltaLaMigracionConTabla("0045");

function traducirError(e: unknown): never {
  // 23505: el índice único del dominio verificado de la 0045.
  if (codigoPg(e) === "23505") {
    throw conflicto("Otra aseguradora ya verificó ese dominio.", "dominio_en_uso");
  }
  return faltaLa0045(e);
}

function limitado(rl: { retryAfterSeconds: number }): Response {
  return err(new AppError("RATE_LIMITED"), undefined, { "Retry-After": String(rl.retryAfterSeconds) });
}

function auditar(ctx: TenantContext, userId: string, event_type: string, payload: Record<string, unknown>) {
  return writeAuditLog({
    tenant_id: ctx.tenantId,
    actor_id: userId,
    event_type,
    target_type: "tenant",
    target_id: ctx.tenantId,
    payload,
  });
}

export async function GET() {
  try {
    const { ctx: admin, rl } = await entrar("sso", RATE_LIMIT_CONFIGS.SSO_ADMIN, ...ADMIN_ROLES);
    if (!rl.allowed) return limitado(rl);
    return ok(await panelSso(admin.userRow.tenant_id));
  } catch (e) {
    return err(e);
  }
}

export async function PUT(request: NextRequest) {
  try {
    const { ctx: admin, rl } = await entrar("sso", RATE_LIMIT_CONFIGS.SSO_ADMIN, ...ADMIN_ROLES);
    if (!rl.allowed) return limitado(rl);
    const { user, userRow } = admin;

    const parsed = PutSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      const [problema] = parsed.error.issues;
      const campo = String(problema?.path[0] ?? "cuerpo");
      throw rechazo(problema?.message ?? "Los datos enviados no son válidos.", `${campo}_invalido`);
    }
    const { issuer, client_id, client_secret } = parsed.data;

    const dominio = normalizarDominio(parsed.data.dominio);
    if (!dominioValido(dominio)) throw rechazo("El dominio no tiene forma de dominio (por ejemplo, empresa.com).", "dominio_invalido");
    // Con «@gmail.com» verificado, cualquier cuenta de Gmail entraría a esta aseguradora.
    if (esDominioPublico(dominio)) throw rechazo("Un proveedor de correo abierto no puede ser el dominio de una aseguradora.", "dominio_publico");

    // De nuevo, no de la memoria: no se valida contra el documento de hace cinco minutos.
    const descubierto = await descubrir(issuer, { usarMemoria: false });
    if (!descubierto.ok) throw rechazo(MENSAJE_DEL_IDP[descubierto.motivo], descubierto.motivo);

    const ctx: TenantContext = { tenantId: userRow.tenant_id }; // nunca del body
    const cifrado = client_secret ? cifrar(client_secret) : null;

    // Todo en una sentencia: qué conserva y qué apaga cada cambio está en guardarIdp.
    let fila;
    try {
      [fila] = await enControl(ctx, (db) =>
        guardarIdp(db, ctx.tenantId, { issuer, client_id, dominio, client_secret_cifrado: cifrado })
      );
    } catch (e) {
      traducirError(e);
    }

    await auditar(ctx, user.id, AuditEvent.SSO_CONFIGURADO, {
      campos: ["issuer", "client_id", "dominio"],
      secreto_cambiado: cifrado !== null,
    });
    return ok(armarPanel(ctx.tenantId, fila));
  } catch (e) {
    return err(e);
  }
}

export async function POST(request: NextRequest) {
  try {
    const { ctx: admin, rl } = await entrar("sso", RATE_LIMIT_CONFIGS.SSO_ADMIN, ...ADMIN_ROLES);
    if (!rl.allowed) return limitado(rl);
    const { user, userRow } = admin;

    const parsed = PostSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) throw new AppError("VALIDATION_FAILED", parsed.error.issues[0]?.message);
    const ctx: TenantContext = { tenantId: userRow.tenant_id };

    const actual = await panelSso(ctx.tenantId);
    if (actual.migracion_pendiente) throw migracionPendiente("0045");
    if (!actual.dominio) throw conflicto("Primero guardá el dominio.", "sso_incompleto");
    if (actual.dominio_verificado_en) return ok({ verificado: true, motivo: null, panel: actual });

    const registros = await resolverTxt(actual.registro!.nombre);
    if (!registros.ok) return ok({ verificado: false, motivo: registros.motivo, panel: actual });
    if (!txtProbado(registros.registros, ctx.tenantId, actual.dominio)) {
      return ok({ verificado: false, motivo: "no_coincide", panel: actual });
    }

    let fila;
    try {
      // `dominio = …`: si lo cambiaron mientras se consultaba el DNS, no se marca nada.
      [fila] = await enControl(ctx, (db) =>
        db
          .update(ssoSettings)
          .set({ dominio_verificado_en: new Date().toISOString(), actualizado_en: new Date().toISOString() })
          .where(eq(ssoSettings.dominio, actual.dominio!))
          .returning(CAMPOS_DE_LA_VISTA)
      );
    } catch (e) {
      traducirError(e);
    }
    if (!fila) throw conflicto("El dominio cambió mientras se verificaba. Probá de nuevo.", "sso_incompleto");

    await auditar(ctx, user.id, AuditEvent.SSO_DOMINIO_VERIFICADO, { dominio: actual.dominio });
    return ok({ verificado: true, motivo: null, panel: armarPanel(ctx.tenantId, fila) });
  } catch (e) {
    return err(e);
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const { ctx: admin, rl } = await entrar("sso", RATE_LIMIT_CONFIGS.SSO_ADMIN, ...ADMIN_ROLES);
    if (!rl.allowed) return limitado(rl);
    const { user, userRow } = admin;

    const parsed = PatchSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) throw new AppError("VALIDATION_FAILED", parsed.error.issues[0]?.message);
    const { activo, exigir } = parsed.data;
    const ctx: TenantContext = { tenantId: userRow.tenant_id };

    // Las condiciones viajan en el mismo UPDATE (ver cambiarEstadoSso): sin fila afectada, no se cumplían.
    let fila;
    try {
      [fila] = await enControl(ctx, (db) => cambiarEstadoSso(db, ctx.tenantId, user.id, { activo, exigir }));
    } catch (e) {
      traducirError(e);
    }
    if (!fila) {
      throw exigir === true
        ? conflicto("Para exigir SSO, el SSO tiene que estar activo y vos tenés que haber entrado ya por él.", "sso_sin_prueba")
        : conflicto("Para activar el SSO hacen falta el IdP completo y el dominio verificado.", "sso_incompleto");
    }

    // Exigir deja sin sesión por contraseña a ese dominio, no sólo sin ingresos nuevos.
    let sesionesCerradas: number | null = 0;
    if (exigir === true && fila.dominio) {
      try {
        sesionesCerradas = await cerrarSesionesDelDominio(ctx.tenantId, fila.dominio, user.id);
      } catch {
        sesionesCerradas = null;
        logger.error({ tenant_id: ctx.tenantId }, "sso.no_se_pudieron_cerrar_las_sesiones");
      }
    }

    await auditar(ctx, user.id, AuditEvent.SSO_EXIGIDO, {
      activo: fila.activo,
      exigir: fila.exigir,
      sesiones_cerradas: sesionesCerradas,
    });
    return NextResponse.json({ panel: armarPanel(ctx.tenantId, fila), sesiones_cerradas: sesionesCerradas });
  } catch (e) {
    return err(e);
  }
}
