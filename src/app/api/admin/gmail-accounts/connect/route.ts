import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { google } from "googleapis";
import { requireRole, ADMIN_ROLES } from "@/lib/auth/require-role";
import {
  COOKIE_ESTADO_OAUTH,
  ESTADO_OAUTH_DURA_SEGUNDOS,
  codificarEstado,
  nuevoNonce,
} from "@/lib/auth/oauth-state";

const GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.send",
];

export async function GET() {
  const headerStore = await headers();
  const origin =
    process.env.NEXT_PUBLIC_APP_URL ??
    `${headerStore.get("x-forwarded-proto") ?? "https"}://${headerStore.get("host")}`;

  try {
    const { userRow, user } = await requireRole(...ADMIN_ROLES);

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
    /*
     * Un valor al azar que viaja por dos caminos: adentro del `state`, que va y
     * vuelve por Google, y en una cookie propia. El callback exige que
     * coincidan.
     *
     * Sin esto, un admin que conoce el `userId` de un colega —lo ve en el
     * padrón de `/api/admin/users`— podía armarle un `state` válido, conseguir
     * un `code` de su propia casilla, y lograr que el colega abriera el
     * callback: la casilla del atacante quedaba enganchada a la aseguradora y
     * todos los siniestros pasaban por ahí.
     */
    const nonce = nuevoNonce();
    const state = codificarEstado({
      tenantId: userRow.tenant_id,
      userId: user.id,
      nonce,
    });

    const url = oauth.generateAuthUrl({
      access_type: "offline",
      prompt: "consent select_account",
      scope: GMAIL_SCOPES,
      state,
    });

    const respuesta = NextResponse.redirect(url);
    respuesta.cookies.set(COOKIE_ESTADO_OAUTH, nonce, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax", // La vuelta de Google es una navegación de primer nivel.
      path: "/api/admin/gmail-accounts",
      maxAge: ESTADO_OAUTH_DURA_SEGUNDOS,
    });
    return respuesta;
  } catch {
    return NextResponse.redirect(new URL("/login?error=missing_session", origin));
  }
}
