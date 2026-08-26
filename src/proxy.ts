/**
 * proxy.ts — Next.js middleware for ClaimMix.
 *
 * Responsibilities:
 * 1. Generate a per-request CSP nonce (strict, no unsafe-inline on script-src).
 * 2. Inject the Content-Security-Policy header on every response.
 * 3. Verify the Better Auth session so Server Components and Route Handlers
 *    can trust the request is authenticated.
 * 4. Protect routes — unauthenticated requests to /bandeja/** and /api/**
 *    (except public endpoints) are redirected or returned 401.
 *
 * NOTE: This file is named proxy.ts (not middleware.ts) per the team convention.
 * Next.js discovers the middleware by the export name, not the filename —
 * BOTH filenames work. Using proxy.ts is the team convention for this project.
 *
 * AC16: strict nonce-based CSP, HSTS, Permissions-Policy, nosniff, referrer-policy.
 * The non-CSP security headers are also set in next.config.ts headers() for
 * defense-in-depth (Vercel CDN layer picks those up even before middleware runs).
 */

import { type NextRequest, NextResponse } from "next/server";
import { buildCsp, generateNonce } from "@/lib/security/csp";
import { auth } from "@/lib/auth";

/** Public paths that do not require authentication. */
const PUBLIC_PREFIXES = [
  "/login",
  "/registro",
  // Las tres páginas que tienen que poder verse SIN cuenta, y que no podían.
  //
  // /demo es la pantalla que ve un prospecto: estaba detrás del login, o sea
  // que la demo pública no existía para nadie que no fuera ya cliente. El
  // endpoint que usa (/api/demo/) nunca estuvo bloqueado —el matcher de acá
  // abajo no distingue, pero las rutas de API se defienden solas— así que la
  // mitad de atrás funcionaba y la de adelante no se podía abrir.
  //
  // /privacy y /terms son requisito de Google para publicar una app que pide
  // permisos de Gmail, y publicarla es lo que impide que el permiso de la
  // casilla venza a los siete días. Una política de privacidad que redirige al
  // login no es una política de privacidad publicada.
  "/demo",
  "/privacy",
  "/terms",
  "/api/auth/sign-in",
  "/api/auth/sign-out",
  "/api/auth/callback",
  "/api/admin/health",
  // Internal-only endpoints authenticated by CRON_SECRET or X-Internal-Worker header
  // at the route level — no session cookie involved. Passing them through middleware
  // so Vercel Cron and worker-to-worker calls are not blocked with 401 before the
  // route handler can verify its own token.
  "/api/admin/",
  "/api/worker/",
  // Google Cloud Pub/Sub push webhooks arrive without a Better Auth session cookie.
  // The route handles its own OIDC token verification (AC16).
  "/api/webhooks/",
  "/_next",
  "/favicon.ico",
];

/** API paths that require authentication but are not browser-navigable. */
const PROTECTED_API_PREFIX = "/api/";

function isPublic(pathname: string): boolean {
  return PUBLIC_PREFIXES.some((p) => pathname.startsWith(p));
}

/** Get the Better Auth session user from request headers. */
async function getUser(
  request: NextRequest
): Promise<{ id: string } | null> {
  const session = await auth.api.getSession({ headers: request.headers });
  return session?.user ?? null;
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // ── 1. Generate per-request CSP nonce ──────────────────────────────────────
  const nonce = generateNonce();
  const csp = buildCsp(nonce);

  // ── 2. Start with a pass-through response ──────────────────────────────────
  let response = NextResponse.next({ request });

  // ── 3. Inject CSP + security headers ──────────────────────────────────────
  response.headers.set("Content-Security-Policy", csp);
  // Pass nonce to Server Components via request header so layout.tsx can read it.
  response.headers.set("x-csp-nonce", nonce);

  // The following headers are also set in next.config.ts headers() for CDN-layer
  // defense-in-depth. Setting them here too ensures they appear on all responses
  // including API routes and redirects that bypass the CDN cache.
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set(
    "Strict-Transport-Security",
    "max-age=63072000; includeSubDomains; preload"
  );
  response.headers.set(
    "Referrer-Policy",
    "strict-origin-when-cross-origin"
  );
  response.headers.set(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=()"
  );

  // ── 4. Skip auth for public paths ─────────────────────────────────────────
  if (isPublic(pathname)) {
    return response;
  }

  // ── 5. Verify Better Auth session ─────────────────────────────────────────
  const user = await getUser(request);

  // ── 6. Enforce authentication ─────────────────────────────────────────────
  if (!user) {
    // API routes get a 401 JSON response.
    if (pathname.startsWith(PROTECTED_API_PREFIX)) {
      return new NextResponse(
        JSON.stringify({
          error: {
            code: "MISSING_SESSION",
            message: "Se requiere autenticación.",
          },
        }),
        {
          status: 401,
          headers: {
            "Content-Type": "application/json",
            "Content-Security-Policy": csp,
            "X-Content-Type-Options": "nosniff",
          },
        }
      );
    }

    // Browser routes redirect to /login.
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("redirect", pathname);
    const redirectResponse = NextResponse.redirect(loginUrl);
    redirectResponse.headers.set("Content-Security-Policy", csp);
    redirectResponse.headers.set("X-Content-Type-Options", "nosniff");
    redirectResponse.headers.set("X-Frame-Options", "DENY");
    redirectResponse.headers.set(
      "Strict-Transport-Security",
      "max-age=63072000; includeSubDomains; preload"
    );
    return redirectResponse;
  }

  // ── 7. Redirect authenticated users away from login/registro ──────────────
  if (pathname === "/login" || pathname === "/registro" || pathname === "/") {
    return NextResponse.redirect(new URL("/bandeja", request.url));
  }

  return response;
}

export const config = {
  matcher: [
    /*
     * Match all request paths EXCEPT:
     * - _next/static  (static assets — JS, CSS)
     * - _next/image   (image optimization)
     * - favicon.ico
     * - Static image/font extensions
     */
    // Las rutas de API quedan afuera, y no es un descuido: cada una se
    // autentica sola —sesión, rol o CRON_SECRET— y el pen test lo comprueba
    // en cada deploy recorriendo src/app/api sin credenciales. Gatearlas acá
    // además rompe las que se autentican por token: /api/health con su Bearer
    // recibía 401 antes de llegar al handler, y con eso se caen el smoke, los
    // dos crons y el timbre.
    // `.well-known/workflow/` queda afuera igual que /api: es por donde el SDK
    // de workflows se despacha a sí mismo los pasos. Si el proxy lo intercepta,
    // el síntoma es "Queue operation failed … detached ArrayBuffer", que no se
    // parece en nada a un problema de middleware.
    "/((?!api|_next/static|_next/image|favicon\\.ico|\\.well-known/workflow/|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|woff|woff2)$).*)",
  ],
};
