import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { google } from "googleapis";
import { requireRole, ADMIN_ROLES } from "@/lib/auth/require-role";

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
    const state = Buffer.from(
      JSON.stringify({ tenantId: userRow.tenant_id, userId: user.id }),
      "utf8"
    ).toString("base64url");

    const url = oauth.generateAuthUrl({
      access_type: "offline",
      prompt: "consent select_account",
      scope: GMAIL_SCOPES,
      state,
    });

    return NextResponse.redirect(url);
  } catch {
    return NextResponse.redirect(new URL("/login?error=missing_session", origin));
  }
}
