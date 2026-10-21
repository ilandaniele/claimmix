/**
 * GET  /api/admin/users  — list analysts in the current tenant (role=admin only)
 * POST /api/admin/users  — invite a person to the current tenant (role=admin only)
 *
 * NOTE: POST no longer creates anyone. It mails a sealed link (/invitacion); the
 * account and the profile are born when the person accepts. See
 * src/server/alta/invitacion.ts.
 */

import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { z } from "zod";

import { dominioDelMail, esDominioPublico } from "@/core/sso";
import { requireAdmin } from "@/lib/auth/require-admin";
import { ALL_ROLES } from "@/lib/auth/roles";
import { resolveBaseURL } from "@/lib/auth/base-url";
import { isOperatorEmail } from "@/lib/auth/require-operator";
import { enPrueba, SIN_SERVICIO } from "@/lib/billing/plans";
import { topeEntero } from "@/lib/topes";
import { getT } from "@/lib/i18n";
import { resolveAccountLocale } from "@/lib/i18n/locale";
import { enTenant, type TenantContext } from "@/data/scope";
import { authUsers, users } from "@/lib/db/schema";
import { accepted, ok, err } from "@/lib/api/respond";
import { AppError } from "@/lib/errors";
import { casillaDeGmail } from "@/lib/email/reserved";
import { logger } from "@/lib/observability/logger";
import { AuditEvent, writeAuditLog } from "@/lib/audit/log";
import { claveDeCupo } from "@/lib/rate-limit/clave";
import { getClientIp, rateLimit } from "@/lib/rate-limit/index";
import { SignUpSchema } from "@/lib/schemas/auth";
import { DURACION_DE_LA_INVITACION_MS, sellarInvitacion } from "@/server/alta/invitacion";
import { correoDeInvitacion } from "@/server/notify/correos-de-alta";
import { enviarCorreoDelSistema, remitenteDelSistema } from "@/server/notify/remitente-sistema";

// ── GET /api/admin/users ──────────────────────────────────────────────────────

export async function GET() {
  try {
    const { userRow } = await requireAdmin();
    // Las consultas de acá ya no llevan filtro por inquilino: lo pone la base.
    // Este contexto es lo único que le dice de quién son los datos.
    const tenantCtx: TenantContext = { tenantId: userRow.tenant_id };

    const rows = await enTenant(tenantCtx, (db) =>
      db
        .select({
          id: users.id,
          full_name: users.full_name,
          role: users.role,
          created_at: users.created_at,
          email: authUsers.email,
        })
        .from(users)
        .leftJoin(authUsers, eq(users.id, authUsers.id))
        .orderBy(users.created_at)
    );

    return ok({
      users: rows.map((r) => ({
        id: r.id,
        full_name: r.full_name,
        email: r.email ?? "",
        role: r.role,
        created_at: r.created_at,
      })),
    });
  } catch (e) {
    return err(e);
  }
}

// ── POST /api/admin/users ─────────────────────────────────────────────────────

/**
 * Sin `password`, y `.strict()` para que mandarla sea un error y no un campo
 * ignorado: nadie crea una cuenta con credencial para otra persona.
 */
const InviteUserSchema = SignUpSchema.extend({ role: z.enum(ALL_ROLES) }).strict();

const DIA_MS = 24 * 60 * 60_000;
/** Cuántas invitaciones, de las que no sean pruebas, por día y por espacio. */
const topeDeInvitaciones = () => topeEntero("ALTA_TOPE_INVITACIONES_DIA");
/** Una prueba invita a lo sumo a cinco personas por día. */
const TOPE_EN_PRUEBA = 5;

export async function POST(request: NextRequest) {
  let t = getT("es-AR");
  try {
    const { user, userRow: adminRow } = await requireAdmin();
    t = getT(await resolveAccountLocale(adminRow.locale));

    const body = await request.json().catch(() => null);
    const parsed = InviteUserSchema.safeParse(body);
    if (!parsed.success) {
      throw new AppError("VALIDATION_FAILED", undefined, parsed.error.flatten());
    }

    const { full_name, email, role } = parsed.data;
    if (role === "owner" && adminRow.role !== "owner") {
      throw new AppError("FORBIDDEN_ROLE", t("usuarios.error.soloOwner"));
    }

    /*
     * Un espacio suspendido o dado de baja no invita: nadie podría aceptar (la
     * invitación ya no se abre), pero el mail saldría igual con nuestro remitente.
     * Se corta antes del cupo y de mandar nada, y no depende de la dirección.
     */
    if (SIN_SERVICIO.has(adminRow.billing_status ?? "")) {
      throw new AppError("FORBIDDEN_ROLE", t("usuarios.error.suspendido"));
    }

    // Sin remitente no hay invitación posible, y es un estado del servidor, no de la dirección: se dice antes de gastar cupo.
    if (!remitenteDelSistema()) {
      throw new AppError("ENVIO_FALLIDO", t("usuarios.error.envio"));
    }

    /*
     * El cupo se toma en CADA intento, y la respuesta no depende de que la
     * dirección tenga o no cuenta. Si el contador no contesta, no se invita.
     */
    const prueba = enPrueba(adminRow);
    const tope = prueba ? Math.min(topeDeInvitaciones(), TOPE_EN_PRUEBA) : topeDeInvitaciones();
    const cupo = await rateLimit(claveDeCupo("usuarios:inquilino", adminRow.tenant_id), {
      limit: tope,
      windowMs: DIA_MS,
      fallaCerrada: true,
    });
    if (!cupo.allowed) {
      return err(new AppError("RATE_LIMITED"), undefined, { "Retry-After": String(cupo.retryAfterSeconds) });
    }

    /*
     * En una prueba sólo se invita a gente del dominio de quien invita, y nunca de
     * un proveedor abierto: si no, una prueba gratuita sirve para mandar mails con
     * nuestro remitente a cualquier dirección. Habla del espacio de quien pide,
     * no de la dirección de un tercero. Única excepción: un alias «+» de la
     * propia casilla de Gmail de quien invita (verificada), porque Gmail entrega
     * el alias en esa casilla y no llega a un tercero.
     */
    let aSuPropiaCasilla = false;
    if (prueba) {
      const casilla = casillaDeGmail(email);
      aSuPropiaCasilla = user.emailVerified === true && casilla !== null && casilla === casillaDeGmail(user.email);
      const dominio = dominioDelMail(email);
      if (
        !aSuPropiaCasilla &&
        (!dominio || esDominioPublico(dominio) || dominio !== dominioDelMail(user.email ?? ""))
      ) {
        throw new AppError("DOMINIO_NO_PERMITIDO", t("usuarios.error.dominio"));
      }
    }

    /*
     * Las direcciones de ADMIN_EMAILS abren la cartera de todas las aseguradoras:
     * no se invitan desde un inquilino. Se mira DESPUÉS del cupo y del filtro de
     * dominio y se contesta igual que a cualquier otra: un 400 distinto sería un
     * buscador de quién opera la plataforma, y un admin de una prueba gratuita
     * puede probar direcciones. Queda asentado, sin sellar ni mandar nada.
     */
    const delOperador = isOperatorEmail(email);
    if (delOperador) logger.warn({ tenant_id: adminRow.tenant_id }, "admin_users.invitacion_a_operador");

    await writeAuditLog({
      tenant_id: adminRow.tenant_id,
      actor_id: adminRow.id,
      event_type: AuditEvent.USER_INVITED,
      target_type: "invitacion",
      // Sin el mail: el asiento queda en el registro del espacio y no es de quien lo lee.
      payload: delOperador
        ? { rol: role, bloqueada: true }
        : aSuPropiaCasilla
          ? { rol: role, alias: true }
          : { rol: role },
      ip: getClientIp(request),
      ua: request.headers.get("user-agent") ?? undefined,
    });
    if (delOperador) return accepted({ estado: "invitacion_enviada" });

    const token = sellarInvitacion({
      t: adminRow.tenant_id,
      e: email,
      r: role,
      n: full_name,
      i: adminRow.id,
    });

    // El texto es fijo y sin nombres. Que el mail no salga (cupo del remitente, rebote) tampoco cambia la respuesta.
    const enlace = `${resolveBaseURL()}/invitacion?t=${token}`;
    const resultado = await enviarCorreoDelSistema(
      { to: email, ...correoDeInvitacion(t, enlace, DURACION_DE_LA_INVITACION_MS / 3_600_000) },
      { tipo: "invitacion" }
    );
    if (!resultado.enviado) logger.warn({ motivo: resultado.motivo }, "admin_users.invitacion_no_salio");

    return accepted({ estado: "invitacion_enviada" });
  } catch (e) {
    if (e instanceof AppError) return err(e);
    logger.error({ detalle: e instanceof Error ? e.message : "unknown" }, "admin_users_post");
    return err(new AppError("INTERNAL_ERROR", t("usuarios.error.crear")));
  }
}
