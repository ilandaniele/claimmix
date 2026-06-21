/**
 * package.json audit — verifies the dependency graph at commit time.
 *
 * W5 (feat/gmail-email-intake): postmark removed, googleapis added.
 *
 * This is a static structural test; it does not run pnpm audit as a subprocess
 * (that gate lives in CI). It asserts the dependency graph so that the criterion
 * is covered by a real Vitest test file, not only by a CI yml reference.
 *
 * AC9:  No postmark in dependencies (replaced by Gmail API polling).
 * AC12: googleapis present at the expected major version.
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

  it("googleapis is in dependencies (AC9/AC12 — Gmail API polling)", () => {
    expect(Object.keys(pkg.dependencies || {})).toContain("googleapis");
  });

  it("googleapis version satisfies ^173.0.0", () => {
    const version: string = pkg.dependencies?.googleapis ?? "";
    expect(version).toMatch(/^\^?173\./);
  });
});
