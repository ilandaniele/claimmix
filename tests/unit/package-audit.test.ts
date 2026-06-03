/**
 * AC14 — package.json audit: verifies that the Resend dependency has been removed
 * and that Postmark is present at the expected major version.
 *
 * This is a static structural test; it does not run pnpm audit as a subprocess
 * (that gate lives in CI). It asserts the dependency graph at commit time so that
 * the criterion is covered by a real Vitest test file, not only by a CI yml reference.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

describe("package.json audit — AC14", () => {
  const pkg = JSON.parse(
    readFileSync(resolve(process.cwd(), "package.json"), "utf8")
  );

  it("resend is not in dependencies", () => {
    expect(Object.keys(pkg.dependencies || {})).not.toContain("resend");
  });

  it("resend is not in devDependencies", () => {
    expect(Object.keys(pkg.devDependencies || {})).not.toContain("resend");
  });

  it("postmark is in dependencies", () => {
    expect(Object.keys(pkg.dependencies || {})).toContain("postmark");
  });

  it("postmark version satisfies ^4.0.0", () => {
    const version: string = pkg.dependencies?.postmark ?? "";
    expect(version).toMatch(/^\^?4\./);
  });
});
