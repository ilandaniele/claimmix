/**
 * package.json audit — verifies the dependency graph at commit time.
 *
 * W5 (feat/gmail-email-intake): postmark removed, googleapis added.
 * E19a: googleapis replaced by the scoped @googleapis/gmail.
 *
 * This is a static structural test; it does not run pnpm audit as a subprocess
 * (that gate lives in CI). It asserts the dependency graph so that the criterion
 * is covered by a real Vitest test file, not only by a CI yml reference.
 *
 * AC9:  No postmark in dependencies (replaced by Gmail API polling).
 * AC12: @googleapis/gmail present, googleapis gone.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

describe("package.json audit — W5 Gmail migration", () => {
  const pkg = JSON.parse(
    readFileSync(resolve(process.cwd(), "package.json"), "utf8")
  );

  it("resend is not in dependencies", () => {
    expect(Object.keys(pkg.dependencies || {})).not.toContain("resend");
  });

  it("resend is not in devDependencies", () => {
    expect(Object.keys(pkg.devDependencies || {})).not.toContain("resend");
  });

  it("postmark is NOT in dependencies (removed in W5 — replaced by Gmail API polling)", () => {
    expect(Object.keys(pkg.dependencies || {})).not.toContain("postmark");
  });

  it("postmark is NOT in devDependencies", () => {
    expect(Object.keys(pkg.devDependencies || {})).not.toContain("postmark");
  });

  it("@googleapis/gmail is in dependencies (E19a — Gmail API polling)", () => {
    expect(pkg.dependencies?.["@googleapis/gmail"]).toBeDefined();
  });

  it("googleapis is NOT in dependencies (E19a — replaced by @googleapis/gmail)", () => {
    expect(pkg.dependencies?.googleapis).toBeUndefined();
  });
});
