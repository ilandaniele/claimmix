/**
 * POST /api/health/knock — poner un mensaje en la casilla, como si hubiera llegado.
 *
 * La única parte de la cadena que ninguna prueba automática podía tocar era la
 * primera: que un mail que aparece en la casilla de verdad se convierta en un
 * caso. El ensayo entra por los canales simulados —a propósito, para no
 * escribirle nunca a una persona— así que ejercita al agente entero y no toca
 * el transporte. Todo lo que vive entre "Google lo dejó en el buzón" y "el
 * worker lo levanta" quedaba probado por alguien mandando un mail a mano.
 *
 * Esto lo cierra con `users.messages.insert`, que **deposita** un mensaje en la
 * casilla sin mandarlo por ningún lado: no sale del edificio, no hay SMTP, no
 * hay destinatario. A partir de ahí el poller, el watch, el parseo del MIME, el
 * hilado por asunto y el prefiltro corren exactamente como con un mail real.
 *
 * Vive adentro del deploy porque la clave que descifra el token de la casilla
 * (GMAIL_TOKEN_ENCRYPTION_KEY) está marcada Sensitive en Vercel: es de sólo
 * escritura y nadie la puede leer de vuelta. La misma razón por la que
 * /api/health/delivery manda desde acá y no desde una laptop.
 *
 * **El cuerpo lo fija el servidor.** Quien llama elige la acción, nunca el
 * contenido — igual que en /api/health/delivery, y por el mismo motivo: un
 * endpoint autenticado que además deja escribir texto arbitrario en la casilla
 * de entrada de un asegurador es una herramienta de suplantación, no una
 * prueba.
 *
 * El remitente es `@example.com`, reservado por la IANA. Eso no es cosmético:
 * el despachador se niega a mandarle un mail de verdad a esas direcciones, así
 * que la respuesta del agente se compone, se guarda y no sale. Lo que se prueba
 * es la entrada; la salida ya tiene su prueba en /api/health/delivery.
 */

import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { isInternalRequest } from "@/lib/security/internal-auth";
import { getGmailAccountForTenant } from "@/server/email/gmail/accounts";
import { getGmailClient } from "@/server/email/gmail/gmail-client";


export const dynamic = "force-dynamic";
export const maxDuration = 30;

const KnockSchema = z.object({
  action: z.enum(["insert", "trash"]),
  /** Sólo para `trash`: el id que devolvió `insert`. */
  message_id: z.string().max(120).optional(),
  /** Marca de la corrida, para reconocer el caso que genere. */
  run: z.string().regex(/^[A-Za-z0-9-]{1,24}$/).optional(),
});

/**
 * El mensaje, escrito acá y no por quien llama.
 *
 * Tiene forma de denuncia de verdad porque lo que se prueba es el camino de una
 * denuncia: si dijera "esto es una prueba", el agente lo clasificaría como no
 * relevante —correctamente— y el resto de la cadena no correría.
 */
function claimShapedMessage(to: string, run: string): string {
  const from = `timbre.${run.toLowerCase()}@example.com`;
  const subject = `Choque en Bahia Blanca [timbre ${run}]`;

  return [
    `From: Asegurado de prueba <${from}>`,
    `To: ${to}`,
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "",
    "Buenas tardes,",
    "",
    "Ayer a la tarde choqué en Alem al 2300, en Bahía Blanca. Soy Carla Ferreyra,",
    "DNI 31.444.777, póliza POL-8812-C. No hubo heridos; el auto quedó con el",
    "paragolpes delantero roto.",
    "",
    "Quedo a la espera.",
    "Carla",
  ].join("\r\n");
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!isInternalRequest(request)) {
    return NextResponse.json(
      { error: { code: "UNAUTHORIZED", message: "Acceso no autorizado." } },
      { status: 401 }
    );
  }

  const parsed = KnockSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: "VALIDATION_ERROR", message: "Parámetros inválidos." } },
      { status: 400 }
    );
  }

  // La misma resolución que usa el poller: la variable del entorno manda.
  const tenantId = process.env.GMAIL_TENANT_ID?.trim() || null;
  if (!tenantId) {
    return NextResponse.json(
      { error: { code: "NOT_CONFIGURED", message: "Sin tenant configurado." } },
      { status: 503 }
    );
  }

  const account = await getGmailAccountForTenant(tenantId);
  if (!account?.email) {
    return NextResponse.json(
      { error: { code: "NO_MAILBOX", message: "No hay casilla conectada." } },
      { status: 503 }
    );
  }

  try {
    const gmail = getGmailClient(account.refreshToken);

    if (parsed.data.action === "trash") {
      const id = parsed.data.message_id;
      if (!id) {
        return NextResponse.json(
          { error: { code: "VALIDATION_ERROR", message: "Falta message_id." } },
          { status: 400 }
        );
      }
      // A la papelera y no borrado: `messages.delete` pide el permiso total de
      // la cuenta, y para dejar la casilla como estaba alcanza con esto.
      await gmail.users.messages.trash({ userId: "me", id });
      return NextResponse.json({ ok: true, trashed: id });
    }

    const run = parsed.data.run ?? "sin-marca";
    const raw = Buffer.from(claimShapedMessage(account.email, run))
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");

    const inserted = await gmail.users.messages.insert({
      userId: "me",
      internalDateSource: "dateHeader",
      requestBody: { raw, labelIds: ["INBOX", "UNREAD"] },
    });

    return NextResponse.json({
      ok: true,
      message_id: inserted.data.id,
      thread_id: inserted.data.threadId,
      mailbox: account.email,
    });
  } catch (err) {
    // Sin PII y sin el token: sólo por qué no se pudo.
    const code = (err as { code?: string | number })?.code ?? "UNKNOWN";
    console.error("[health/knock] gmail error:", String(code));
    return NextResponse.json(
      { error: { code: "GMAIL_ERROR", message: `Gmail respondió ${String(code)}.` } },
      { status: 502 }
    );
  }
}
