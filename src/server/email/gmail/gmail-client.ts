/**
 * Gmail OAuth2 client factory for ClaimMix.
 *
 * Provides a lazy-initialized OAuth2 client that reads credentials from
 * server-only environment variables. Throws on first use if any required
 * env var is missing — fails fast rather than silently at send time.
 *
 * AC10: Credentials (GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN)
 * are never logged — only error codes are logged on failure paths.
 * AC12: This module is the only place in the codebase that imports from 'googleapis'.
 *
 * resetGmailAuth() / resetGmailClient() are exported for test isolation only.
 */

import "server-only";
import { google } from "googleapis";

// The OAuth2 prototype instance type — inferred to avoid importing the class directly.
type OAuth2Client = InstanceType<typeof google.auth.OAuth2>;

let _auth: OAuth2Client | null = null;

/**
 * Returns the singleton OAuth2 client, initializing it on first call.
 *
 * Throws if GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, or GMAIL_REFRESH_TOKEN
 * are not set in the environment.
 */
export function getGmailAuth(refreshToken?: string): OAuth2Client {
  if (refreshToken) {
    const clientId = process.env.GMAIL_CLIENT_ID;
    const clientSecret = process.env.GMAIL_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
      throw new Error("GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET must be set");
    }

    const auth = new google.auth.OAuth2(clientId, clientSecret);
    auth.setCredentials({ refresh_token: refreshToken });
    return auth;
  }

  if (!_auth) {
    const clientId = process.env.GMAIL_CLIENT_ID;
    const clientSecret = process.env.GMAIL_CLIENT_SECRET;
    const refreshToken = process.env.GMAIL_REFRESH_TOKEN;

    if (!clientId || !clientSecret || !refreshToken) {
      throw new Error(
        "GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN must be set"
      );
    }

    const auth = new google.auth.OAuth2(clientId, clientSecret);
    auth.setCredentials({ refresh_token: refreshToken });
    _auth = auth;
  }
  return _auth;
}

/**
 * Resets the auth singleton — for test isolation only.
 * Call in afterEach / afterAll.
 */
export function resetGmailAuth(): void {
  _auth = null;
}

/**
 * Returns a configured Gmail API client bound to the OAuth2 auth singleton.
 */
export function getGmailClient(refreshToken?: string) {
  return google.gmail({ version: "v1", auth: getGmailAuth(refreshToken) });
}
