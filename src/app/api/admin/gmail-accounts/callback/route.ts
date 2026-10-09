import { NextRequest, NextResponse } from "next/server";
import * as google from "@googleapis/gmail";
import { requireRole, ADMIN_ROLES } from "@/lib/auth/require-role";
import { tables } from "@/lib/db";
import { encryptRefreshToken, inquilinoDeLaCasilla } from "@/server/email/gmail/accounts";
import { setupGmailWatch } from "@/server/email/gmail/watch";
import { esCasillaDeOtroAmbiente } from "@/server/ambiente/de-otro-ambiente";
import { enControl } from "@/data/scope";
import { codigoPg } from "@/server/core-sync/config";
import { logger } from "@/lib/observability/logger";
import {
  COOKIE_ESTADO_OAUTH,
  decodificarEstado,
  estadoEsValido,
} from "@/lib/auth/oauth-state";

export async function GET(request: NextRequest) {
  const requestUrl = new URL(request.url);
  const origin = requestUrl.origin;
  const code = requestUrl.searchParams.get("code");
  const state = decodificarEstado(requestUrl.searchParams.get("state"));

  if (!code) {
    return NextResponse.redirect(new URL("/configuracion?gmail=missing_code", origin));
  }

  try {
    const { user, userRow } = await requireRole(...ADMIN_ROLES);
    /*
     * El `state` tiene que traer el nonce que dejamos en la cookie.
     *
     * Comparar sólo inquilino y usuario alcanzaba para que nadie enganchara una
     * casilla a la aseguradora de otro, pero no para el CSRF clásico de OAuth:
     * un admin conoce el `userId` de sus colegas —lo ve en el padrón— y podía
     * armarles un `state` válido. El nonce lo pone el servidor y viaja también
     * en una cookie `HttpOnly` que el atacante no puede escribir.
     */
    const esperado = request.cookies.get(COOKIE_ESTADO_OAUTH)?.value;
    if (!estadoEsValido(state, { tenantId: userRow.tenant_id, userId: user.id }, esperado)) {
      const rechazo = NextResponse.redirect(
        new URL("/configuracion?gmail=invalid_state", origin)
      );
      // Se quema igual: un nonce que no sirvió no puede quedar dando vueltas
      // para un segundo intento.
      rechazo.cookies.delete(COOKIE_ESTADO_OAUTH);
      return rechazo;
    }

    const clientId = process.env.GMAIL_CLIENT_ID;
    const clientSecret = process.env.GMAIL_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      return NextResponse.redirect(new URL("/configuracion?gmail=missing_google_config", origin));
    }

    const oauth = new google.auth.OAuth2(
      clientId,
      clientSecret,
      `${origin}/api/admin/gmail-accounts/callback`
    );
    const { tokens } = await oauth.getToken(code);
    if (!tokens.refresh_token) {
      return NextResponse.redirect(new URL("/configuracion?gmail=missing_refresh_token", origin));
    }

    oauth.setCredentials(tokens);
    const gmail = google.gmail({ version: "v1", auth: oauth });
    const profile = await gmail.users.getProfile({ userId: "me" });
    const email = profile.data.emailAddress?.toLowerCase();
    if (!email) {
      return NextResponse.redirect(new URL("/configuracion?gmail=missing_email", origin));
    }

    // La casilla de dev conectada acá le sacaría el aviso a dev: el último watch gana y el otro deja de recibir sin error.
    if (esCasillaDeOtroAmbiente(email)) {
      logger.warn({ motivo: "casilla_de_otro_ambiente" }, "gmail_accounts_callback.rechazado");
      const rechazo = NextResponse.redirect(new URL("/configuracion?gmail=otro_ambiente", origin));
      rechazo.cookies.delete(COOKIE_ESTADO_OAUTH);
      return rechazo;
    }

    // La unicidad en la base es por inquilino: la misma casilla en dos
    // aseguradoras haría que el timbre y las respuestas cayeran en una sola.
    const duena = await inquilinoDeLaCasilla(email);
    if (duena && duena !== userRow.tenant_id) {
      logger.warn({ motivo: "casilla_de_otro_inquilino" }, "gmail_accounts_callback.rechazado");
      const rechazo = NextResponse.redirect(new URL("/configuracion?gmail=mailbox_taken", origin));
      rechazo.cookies.delete(COOKIE_ESTADO_OAUTH);
      return rechazo;
    }

    const t = tables.gmailAccounts;
    const now = new Date().toISOString();
    const refreshTokenEncrypted = encryptRefreshToken(tokens.refresh_token);

    try {
      await enControl({ tenantId: userRow.tenant_id }, (db) =>
        db
          .insert(t)
          .values({
            tenant_id: userRow.tenant_id,
            email,
            refresh_token_encrypted: refreshTokenEncrypted,
            enabled: true,
            connected_by: user.id,
            last_connected_at: now,
            last_error: null,
            updated_at: now,
          })
          .onConflictDoUpdate({
            target: [t.tenant_id, t.email],
            set: {
              refresh_token_encrypted: refreshTokenEncrypted,
              enabled: true,
              connected_by: user.id,
              last_connected_at: now,
              last_error: null,
              updated_at: now,
            },
          })
      );
    } catch (e) {
      const codigo = codigoPg(e);
      // El único índice que puede chocar acá y no es el del ON CONFLICT es el
      // de la casilla única (0047): otro callback ganó la carrera.
      if (codigo === "23505") {
        logger.warn({ motivo: "casilla_de_otro_inquilino" }, "gmail_accounts_callback.rechazado");
        const rechazo = NextResponse.redirect(new URL("/configuracion?gmail=mailbox_taken", origin));
        rechazo.cookies.delete(COOKIE_ESTADO_OAUTH);
        return rechazo;
      }
      logger.error({ detalle: codigo ?? "unknown" }, "gmail_accounts_callback.upsert");
      return NextResponse.redirect(new URL("/configuracion?gmail=save_failed", origin));
    }

    // Reconectar la casilla apagaba el push, en silencio y por una semana.
    //
    // El aviso de Gmail cuelga del permiso: al revocarlo se cae del lado de
    // Google, pero la fila de gmail_poll_state sigue diciendo que vence dentro
    // de siete días. El cron sólo renueva lo que ve por vencer, así que no lo
    // renovaba; /api/health decía «casilla conectada» porque el token se lee
    // bien; y el correo entraba igual, pero por el cron y no en segundos.
    // Nada fallaba a la vista: simplemente todo se volvía más lento.
    //
    // Este es el único momento en que sabemos con certeza que hay permiso
    // nuevo, así que es acá donde se vuelve a pedir el aviso. Si falla no se
    // toca la conexión —la casilla quedó bien conectada— y el cron sigue
    // trayendo el correo mientras tanto.
    const pubsubTopic = process.env.PUBSUB_TOPIC;
    if (pubsubTopic) {
      try {
        await setupGmailWatch(pubsubTopic, {
          email,
          refreshToken: tokens.refresh_token,
        });
      } catch (e) {
        logger.error({ detalle: e instanceof Error ? e.name : "unknown" }, "gmail_accounts_callback.watch");
      }
    }

    // Un `state` sirve una sola vez: la cookie se quema al terminar bien, igual
    // que al rechazar.
    const listo = NextResponse.redirect(new URL("/configuracion?gmail=connected", origin));
    listo.cookies.delete(COOKIE_ESTADO_OAUTH);
    return listo;
  } catch (err) {
    const name = err instanceof Error ? err.name : "UnknownError";
    logger.error({ error_name: name }, "gmail_accounts_callback.error");
    return NextResponse.redirect(new URL("/configuracion?gmail=connect_failed", origin));
  }
}
