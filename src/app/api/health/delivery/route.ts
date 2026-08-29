/**
 * POST /api/health/delivery — manda un mensaje de prueba desde el deploy.
 *
 * Probar que un mensaje puede salir del edificio era el último chequeo que
 * seguía corriendo en una laptop, y ahí no podía quedarse. El refresh token de
 * Gmail está cifrado y `GMAIL_TOKEN_ENCRYPTION_KEY` está marcada Sensitive en
 * Vercel — o sea, de sólo escritura. Nadie la puede volver a leer: ni por el
 * panel, ni por la CLI, ni quien la puso. Ese es el punto de la opción y es la
 * opción correcta para esa clave.
 *
 * Así que la prueba va a donde ya viven las credenciales. Producción tiene la
 * clave, el token y el de WhatsApp; manda el mensaje y cuenta qué contestó el
 * proveedor. No hay que copiar nada a ningún lado, y lo que se prueba es que
 * ESTE deploy puede enviar — una laptop que puede enviar no dice nada de
 * producción.
 *
 * Auth: Bearer CRON_SECRET, la misma llave que /api/health.
 *
 * Manda mensajes de verdad, así que tres cosas lo acotan: el texto es fijo del
 * lado del servidor y quien llama elige a quién pero nunca qué; no acepta más
 * de un envío por minuto; y queda asentado en auditoría con el destinatario
 * enmascarado, para poder contestar «¿por qué me llegó esto?».
 */

import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq, gt } from "drizzle-orm";
import { z } from "zod";

import { enTenant, type TenantContext } from "@/data/scope";
import { writeAuditLog, AuditEvent } from "@/lib/audit/log";
import { auditLog } from "@/lib/db/schema";
import { isInternalRequest } from "@/lib/security/internal-auth";
import {
  enmascararDestinatario,
  probarEntrega,
  type CanalDeEntrega,
} from "@/server/notify/delivery-check";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Uno por minuto. Alcanza para reintentar después de un arreglo, no para ser una molestia. */
const MIN_SECONDS_BETWEEN_SENDS = 60;

/*
 * El canal se valida contra la lista, no se adivina.
 *
 * Antes era `body.channel === "whatsapp" ? "whatsapp" : "email"`, así que
 * cualquier cosa que no fuera exactamente «whatsapp» mandaba un MAIL. Un typo
 * —«whatsap», «wa», «WhatsApp»— no fallaba: le mandaba un correo a lo que en
 * realidad era un número de teléfono, o peor, a la dirección de una persona a
 * la que se le quería escribir por otro lado.
 */
const CuerpoSchema = z.object({
  channel: z.enum(["email", "whatsapp"]),
  to: z.string().trim().min(1),
});

/** Que el destinatario tenga la forma del canal por el que se lo va a mandar. */
function destinatarioValido(canal: CanalDeEntrega, to: string): boolean {
  return canal === "whatsapp"
    ? /^\+?\d{8,15}$/.test(to.replace(/[\s-]/g, ""))
    : /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to);
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!isInternalRequest(req)) {
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

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, detail: "cuerpo inválido" }, { status: 400 });
  }

  const parsed = CuerpoSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, detail: "falta 'to', o 'channel' no es email ni whatsapp" },
      { status: 400 }
    );
  }
  const { channel, to } = parsed.data;

  if (!destinatarioValido(channel, to)) {
    return NextResponse.json(
      { ok: false, detail: `'to' no tiene forma de destinatario de ${channel}` },
      { status: 400 }
    );
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

  const result = await probarEntrega(channel, tenantId, to);

  /*
   * Se escribe haya salido o no: se mandó un mensaje real, o se intentó, y eso
   * va al registro como cualquier otra cosa que mandamos.
   *
   * El destinatario va enmascarado. Antes no iba de ninguna forma: quedaba
   * asentado que hubo una prueba pero no a quién, así que ante «me llegó esto y
   * no sé por qué» el registro no ayudaba.
   */
  await writeAuditLog({
    tenant_id: tenantId,
    actor_id: null,
    event_type: AuditEvent.DELIVERY_TEST,
    target_type: "delivery",
    target_id: null,
    payload: {
      channel,
      to: enmascararDestinatario(channel, to),
      ok: result.ok,
      detail: result.detail,
    },
  });

  return NextResponse.json(
    { ok: result.ok, channel, detail: result.detail },
    { status: result.ok ? 200 : 502 }
  );
}

/** ¿Salió una prueba en el último minuto? */
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
    // Un limitador que no puede leer su propio historial no debería bloquear el
    // chequeo que existe para proteger — la autenticación y el texto fijo ya
    // hacen el trabajo que importa.
    return false;
  }
}
