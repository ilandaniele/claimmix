/**
 * GET /api/auth/callback
 *
 * Supabase Auth OAuth + magic link callback handler.
 * Exchanges the code from the URL for a session and redirects the user.
 *
 * This route is public (proxy.ts skips auth for /api/auth/callback).
 * After session exchange, the user is redirected to /bandeja.
 */

import { NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";
import { provisionGoogleUserIfAllowed } from "@/lib/auth/google-provision";

export async function GET(request: Request) {
  const requestUrl = new URL(request.url);
  const code = requestUrl.searchParams.get("code");
  const next = requestUrl.searchParams.get("next") ?? "/bandeja";

  if (code) {
    const supabase = await createServerClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) {
      // Redirect to login with error indicator — do not expose error.message.
      return NextResponse.redirect(
        new URL("/login?error=auth_callback_failed", requestUrl.origin)
      );
    }

    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (user) {
      try {
        await provisionGoogleUserIfAllowed(user.id);
      } catch {
        await supabase.auth.signOut();
        return NextResponse.redirect(
          new URL("/login?error=google_user_not_allowed", requestUrl.origin)
        );
      }
    }
  }

  // Redirect to the intended destination (or /bandeja by default).
  return NextResponse.redirect(new URL(next, requestUrl.origin));
}
