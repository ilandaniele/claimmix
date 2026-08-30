import { NextRequest, NextResponse } from "next/server";
import { google } from "googleapis";
import { requireRole, ADMIN_ROLES } from "@/lib/auth/require-role";
import { tables } from "@/lib/db";
import { encryptRefreshToken } from "@/server/email/gmail/accounts";
import { setupGmailWatch } from "@/server/email/gmail/watch";
import { enTenant } from "@/data/scope";
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

    const t = tables.gmailAccounts;
    const now = new Date().toISOString();
    const refreshTokenEncrypted = encryptRefreshToken(tokens.refresh_token);

    try {
      await enTenant({ tenantId: userRow.tenant_id }, (db) =>
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
      console.error(
        "[gmail-accounts callback] upsert:",
        (e as { code?: string })?.code ?? "unknown"
      );
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
        console.error(
          "[gmail-accounts callback] watch:",
          e instanceof Error ? e.name : "unknown"
        );
      }
    }

    // Un `state` sirve una sola vez: la cookie se quema al terminar bien, igual
    // que al rechazar.
    const listo = NextResponse.redirect(new URL("/configuracion?gmail=connected", origin));
    listo.cookies.delete(COOKIE_ESTADO_OAUTH);
    return listo;
  } catch (err) {
    const name = err instanceof Error ? err.name : "UnknownError";
    console.error("[gmail-accounts callback] error:", name);
    return NextResponse.redirect(new URL("/configuracion?gmail=connect_failed", origin));
  }
}
