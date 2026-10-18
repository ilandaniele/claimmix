import { NextResponse } from "next/server";
import * as google from "@googleapis/gmail";
import { requireRole, ADMIN_ROLES } from "@/lib/auth/require-role";
import { resolveBaseURL, urlDeVueltaDeGmail } from "@/lib/auth/base-url";
import {
  COOKIE_ESTADO_OAUTH,
  RUTA_COOKIE_ESTADO_OAUTH,
  ESTADO_OAUTH_DURA_SEGUNDOS,
  codificarEstado,
  nuevoNonce,
} from "@/lib/auth/oauth-state";
import { baseLista } from "@/server/bases/base-lista";

const GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.send",
];

export async function GET() {
  // El mismo origen que el callback y el login: Google exige el redirect_uri idéntico en los dos pasos.
  const origin = resolveBaseURL();

  try {
    const { userRow, user } = await requireRole(...ADMIN_ROLES);

    // Sin su base, el poller leería correos que no tienen dónde guardarse y los daría por perdidos.
    if (!(await baseLista(user.id))) return NextResponse.redirect(new URL("/preparando", origin));

    const clientId = process.env.GMAIL_CLIENT_ID;
    const clientSecret = process.env.GMAIL_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      return NextResponse.redirect(new URL("/configuracion?gmail=missing_google_config", origin));
    }

    const oauth = new google.auth.OAuth2(clientId, clientSecret, urlDeVueltaDeGmail());
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
      // Le sugiere a Google el correo con que se entró a ClaimMix.
      ...(user.email ? { login_hint: user.email } : {}),
    });

    const respuesta = NextResponse.redirect(url);
    respuesta.cookies.set(COOKIE_ESTADO_OAUTH, nonce, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax", // La vuelta de Google es una navegación de primer nivel.
      path: RUTA_COOKIE_ESTADO_OAUTH,
      maxAge: ESTADO_OAUTH_DURA_SEGUNDOS,
    });
    return respuesta;
  } catch {
    return NextResponse.redirect(new URL("/login?error=missing_session", origin));
  }
}
