/**
 * Static provider-isolation test (AC12).
 *
 * Reads the source files for:
 *   - src/server/email/dispatch.ts
 *   - src/server/confirmations/orchestrate.ts
 *   - all files under src/server/confirmations/
 *
 * And asserts that NONE of them contain a direct import of 'postmark', 'resend',
 * or 'googleapis'.
 *
 * Only files under src/server/email/postmark/** are allowed to import the postmark package.
 * Only files under src/server/email/gmail/** are allowed to import googleapis.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import { resolve, join } from "path";

const ROOT = resolve(__dirname, "../..");

/** Read a file, return its content as a string. */
function readFile(filePath: string): string {
  try {
    return readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

/** Recursively collect all .ts files under a directory. */
function collectTsFiles(dir: string): string[] {
  const results: string[] = [];
  try {
    const entries = readdirSync(dir);
    for (const entry of entries) {
      const full = join(dir, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        results.push(...collectTsFiles(full));
      } else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) {
        results.push(full);
      }
    }
  } catch {
    // directory may not exist
  }
  return results;
}

/** Check a file's content for direct postmark/resend imports. */
function hasDirectProviderImport(content: string): boolean {
  // Matches: from "postmark", from 'postmark', from "resend", from 'resend'
  const importRegex = /from\s+["'](postmark|resend)["']/;
  // Also matches: require("postmark"), require('postmark'), etc.
  const requireRegex = /require\s*\(\s*["'](postmark|resend)["']\s*\)/;
  return importRegex.test(content) || requireRegex.test(content);
}

/** Check a file's content for direct googleapis imports. */
function hasGoogleapisImport(content: string): boolean {
  const importRegex = /from\s+["']googleapis["']/;
  const requireRegex = /require\s*\(\s*["']googleapis["']\s*\)/;
  return importRegex.test(content) || requireRegex.test(content);
}

describe("AC12 — provider isolation (no direct postmark/resend/googleapis imports outside allowed dirs)", () => {
  it("dispatch.ts does not import postmark or resend directly", () => {
    const filePath = join(ROOT, "src/server/email/dispatch.ts");
    const content = readFile(filePath);

    expect(content.length).toBeGreaterThan(0); // file must exist
    expect(hasDirectProviderImport(content)).toBe(false);
  });

  it("dispatch.ts does not import googleapis directly", () => {
    const filePath = join(ROOT, "src/server/email/dispatch.ts");
    const content = readFile(filePath);

    expect(content.length).toBeGreaterThan(0);
    expect(hasGoogleapisImport(content)).toBe(false);
  });

  it("src/server/confirmations/ files do not import postmark or resend directly", () => {
    const dir = join(ROOT, "src/server/confirmations");
    const files = collectTsFiles(dir);

    // Confirmations directory must have at least one file (orchestrate.ts).
    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      const content = readFile(file);
      const relativePath = file.replace(ROOT, "");
      expect(
        hasDirectProviderImport(content),
        `Found direct provider import in ${relativePath}`
      ).toBe(false);
    }
  });

  it("src/server/confirmations/ files do not import googleapis directly", () => {
    const dir = join(ROOT, "src/server/confirmations");
    const files = collectTsFiles(dir);

    for (const file of files) {
      const content = readFile(file);
      const relativePath = file.replace(ROOT, "");
      expect(
        hasGoogleapisImport(content),
        `Found googleapis import in ${relativePath}`
      ).toBe(false);
    }
  });

  it("only src/server/email/postmark/** files may import postmark", () => {
    // Collect all server-side email files EXCEPT the postmark directory.
    const emailDir = join(ROOT, "src/server/email");
    const postmarkDir = join(ROOT, "src/server/email/postmark");

    const allEmailFiles = collectTsFiles(emailDir).filter(
      (f) => !f.startsWith(postmarkDir)
    );

    for (const file of allEmailFiles) {
      const content = readFile(file);
      const relativePath = file.replace(ROOT, "");
      // No direct postmark import allowed outside the postmark/ subdir.
      const hasPostmarkImport = /from\s+["']postmark["']/.test(content);
      expect(
        hasPostmarkImport,
        `Unexpected 'postmark' import in ${relativePath}`
      ).toBe(false);
    }
  });

  it("only src/server/email/gmail/** files may import googleapis", () => {
    // Collect all server-side files EXCEPT the gmail directory.
    const serverDir = join(ROOT, "src/server");
    const gmailDir = join(ROOT, "src/server/email/gmail");

    const allFiles = collectTsFiles(serverDir).filter(
      (f) => !f.startsWith(gmailDir)
    );

    for (const file of allFiles) {
      const content = readFile(file);
      const relativePath = file.replace(ROOT, "");
      expect(
        hasGoogleapisImport(content),
        `Unexpected 'googleapis' import in ${relativePath} — only src/server/email/gmail/** may import googleapis`
      ).toBe(false);
    }
  });

  it("postmark/ files DO import postmark (sanity check that postmark-sender.ts uses the package)", () => {
    const senderPath = join(ROOT, "src/server/email/postmark/postmark-sender.ts");
    const content = readFile(senderPath);

    expect(content.length).toBeGreaterThan(0);
    expect(/from\s+["']postmark["']/.test(content)).toBe(true);
  });

  it("resend is not imported anywhere in src/server/**", () => {
    const serverDir = join(ROOT, "src/server");
    const allFiles = collectTsFiles(serverDir);

    for (const file of allFiles) {
      const content = readFile(file);
      const relativePath = file.replace(ROOT, "");
      const hasResendImport = /from\s+["']resend["']/.test(content);
      expect(
        hasResendImport,
        `Found 'resend' import in ${relativePath} — Resend must be fully removed (AC12)`
      ).toBe(false);
    }
  });
});
