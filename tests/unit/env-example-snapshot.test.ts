/**
 * Static snapshot test for .env.example (W1 — Gmail provider).
 *
 * Asserts that:
 * - .env.example does NOT contain RESEND_API_KEY or RESEND_FROM_ADDRESS.
 * - .env.example does NOT contain POSTMARK_SERVER_TOKEN or POSTMARK_FROM_ADDRESS
 *   (outbound-only vars removed in W1 — replaced by GMAIL_* vars).
 * - .env.example DOES contain GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET,
 *   GMAIL_REFRESH_TOKEN, GMAIL_USER_EMAIL, GMAIL_FROM_ADDRESS.
 *
 * This test runs with zero runtime dependencies — just fs.readFileSync.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const ROOT = resolve(__dirname, "../..");
const ENV_EXAMPLE_PATH = resolve(ROOT, ".env.example");

function readEnvExample(): string {
  try {
    return readFileSync(ENV_EXAMPLE_PATH, "utf8");
  } catch (err) {
    throw new Error(`Could not read .env.example at ${ENV_EXAMPLE_PATH}: ${String(err)}`);
  }
}

describe("W1 — .env.example Gmail migration snapshot", () => {
  it("does NOT contain RESEND_API_KEY", () => {
    const content = readEnvExample();
    expect(content).not.toMatch(/RESEND_API_KEY/);
  });

  it("does NOT contain RESEND_FROM_ADDRESS", () => {
    const content = readEnvExample();
    expect(content).not.toMatch(/RESEND_FROM_ADDRESS/);
  });

  it("does NOT contain POSTMARK_SERVER_TOKEN (outbound key removed in W1)", () => {
    const content = readEnvExample();
    expect(content).not.toMatch(/POSTMARK_SERVER_TOKEN/);
  });

  it("does NOT contain POSTMARK_FROM_ADDRESS (outbound key removed in W1)", () => {
    const content = readEnvExample();
    expect(content).not.toMatch(/POSTMARK_FROM_ADDRESS/);
  });

  it("does NOT contain POSTMARK_WEBHOOK_SECRET (Postmark intake removed)", () => {
    const content = readEnvExample();
    expect(content).not.toMatch(/POSTMARK_WEBHOOK_SECRET/);
  });

  it("DOES contain CRON_SECRET", () => {
    const content = readEnvExample();
    expect(content).toMatch(/CRON_SECRET/);
  });

  it("DOES contain GMAIL_TENANT_ID", () => {
    const content = readEnvExample();
    expect(content).toMatch(/GMAIL_TENANT_ID/);
  });

  it("DOES contain GMAIL_CLIENT_ID", () => {
    const content = readEnvExample();
    expect(content).toMatch(/GMAIL_CLIENT_ID/);
  });

  it("DOES contain GMAIL_CLIENT_SECRET", () => {
    const content = readEnvExample();
    expect(content).toMatch(/GMAIL_CLIENT_SECRET/);
  });

  it("DOES contain GMAIL_REFRESH_TOKEN", () => {
    const content = readEnvExample();
    expect(content).toMatch(/GMAIL_REFRESH_TOKEN/);
  });

  it("DOES contain GMAIL_USER_EMAIL", () => {
    const content = readEnvExample();
    expect(content).toMatch(/GMAIL_USER_EMAIL/);
  });

  it("DOES contain GMAIL_FROM_ADDRESS", () => {
    const content = readEnvExample();
    expect(content).toMatch(/GMAIL_FROM_ADDRESS/);
  });

  it("GMAIL_CLIENT_ID line has a placeholder value (not empty)", () => {
    const content = readEnvExample();
    expect(content).toMatch(/GMAIL_CLIENT_ID=.+/);
  });

  it("GMAIL_FROM_ADDRESS line has a placeholder value (not empty)", () => {
    const content = readEnvExample();
    expect(content).toMatch(/GMAIL_FROM_ADDRESS=.+/);
  });

  it(".env.example file itself is not empty", () => {
    const content = readEnvExample();
    expect(content.trim().length).toBeGreaterThan(100);
  });
});
