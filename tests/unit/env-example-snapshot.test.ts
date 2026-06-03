/**
 * Static snapshot test for .env.example (AC13).
 *
 * Asserts that:
 * - .env.example does NOT contain RESEND_API_KEY or RESEND_FROM_ADDRESS.
 * - .env.example DOES contain POSTMARK_SERVER_TOKEN and POSTMARK_FROM_ADDRESS.
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

describe("AC13 — .env.example Resend removal + Postmark addition", () => {
  it("does NOT contain RESEND_API_KEY", () => {
    const content = readEnvExample();
    expect(content).not.toMatch(/RESEND_API_KEY/);
  });

  it("does NOT contain RESEND_FROM_ADDRESS", () => {
    const content = readEnvExample();
    expect(content).not.toMatch(/RESEND_FROM_ADDRESS/);
  });

  it("DOES contain POSTMARK_SERVER_TOKEN", () => {
    const content = readEnvExample();
    expect(content).toMatch(/POSTMARK_SERVER_TOKEN/);
  });

  it("DOES contain POSTMARK_FROM_ADDRESS", () => {
    const content = readEnvExample();
    expect(content).toMatch(/POSTMARK_FROM_ADDRESS/);
  });

  it("POSTMARK_SERVER_TOKEN line has a placeholder value (not empty)", () => {
    const content = readEnvExample();
    // Should be something like: POSTMARK_SERVER_TOKEN=<your-postmark-server-token>
    expect(content).toMatch(/POSTMARK_SERVER_TOKEN=.+/);
  });

  it("POSTMARK_FROM_ADDRESS line has a placeholder value (not empty)", () => {
    const content = readEnvExample();
    // Should be something like: POSTMARK_FROM_ADDRESS=claims@yourdomain.com
    expect(content).toMatch(/POSTMARK_FROM_ADDRESS=.+/);
  });

  it(".env.example file itself is not empty", () => {
    const content = readEnvExample();
    expect(content.trim().length).toBeGreaterThan(100);
  });
});
