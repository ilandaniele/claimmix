/**
 * Vitest global test setup.
 * Imported via vitest.config.ts → test.setupFiles.
 *
 * vitest.config.ts sets globals: true, which injects vi, describe, it, expect, etc.
 * We add @testing-library/jest-dom matchers for DOM assertions.
 */

import "@testing-library/jest-dom";
