/**
 * EmailProvider factory for ClaimMix — Gmail provider.
 *
 * Callers use getEmailProvider() — do not import GmailSender directly from outside
 * src/server/email/gmail/.
 *
 * Supports DI for tests via setEmailProvider() / resetEmailProvider().
 *
 * W2 (GmailSender): getEmailProvider() now lazy-inits GmailSender when no provider
 * has been injected via setEmailProvider(). This reads GMAIL_* env vars on first call.
 *
 * AC9:  This factory returns a provider with name='gmail'.
 * AC12: dispatch.ts imports only from here — no direct googleapis imports outside gmail/.
 */

import "server-only";
import type { EmailProvider } from "../provider";
import { GmailSender } from "./gmail-sender";
import { SmtpSender } from "../smtp/smtp-sender";

let _provider: EmailProvider | null = null;

/**
 * Returns the configured EmailProvider singleton.
 *
 * Resolution order:
 *   1. SMTP_HOST + SMTP_USER + SMTP_PASS set → SmtpSender (custom SMTP)
 *   2. Fallback → GmailSender (legacy Gmail API)
 */
export function getEmailProvider(): EmailProvider {
  if (!_provider) {
    const smtpConfigured =
      process.env.SMTP_HOST &&
      process.env.SMTP_USER &&
      process.env.SMTP_PASS;

    _provider = smtpConfigured ? new SmtpSender() : new GmailSender();
  }
  return _provider;
}

/**
 * Override the provider — for unit tests that inject a mock.
 */
export function setEmailProvider(p: EmailProvider): void {
  _provider = p;
}

/**
 * Reset the provider singleton — call in afterEach/afterAll in tests.
 */
export function resetEmailProvider(): void {
  _provider = null;
}
