/**
 * Unit tests for general-purpose utility functions.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { cn, formatDate, formatAge, truncate } from "@/lib/utils";

describe("cn()", () => {
  it("joins truthy class names", () => {
    expect(cn("a", "b", "c")).toBe("a b c");
  });

  it("filters out falsy values", () => {
    expect(cn("a", undefined, null, false, "b")).toBe("a b");
  });

  it("returns empty string when all values are falsy", () => {
    expect(cn(undefined, null, false)).toBe("");
  });

  it("handles single class", () => {
    expect(cn("text-sm")).toBe("text-sm");
  });
});

describe("formatDate()", () => {
  it("formats a UTC date string to es-AR locale", () => {
    // 2024-01-15T12:00:00Z = 09:00 in Buenos Aires (UTC-3)
    const result = formatDate("2024-01-15T12:00:00Z");
    expect(result).toContain("15");
    expect(result).toContain("01");
    expect(result).toContain("2024");
  });

  it("accepts a Date object", () => {
    const date = new Date("2024-06-01T00:00:00Z");
    const result = formatDate(date);
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  it("returns a non-empty string for any valid date", () => {
    const result = formatDate("2024-12-31T23:59:59Z");
    expect(result).toBeTruthy();
  });
});

describe("formatAge()", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns 'Ahora' for less than 1 minute ago", () => {
    vi.useFakeTimers();
    const now = new Date("2024-06-01T12:00:00Z");
    vi.setSystemTime(now);
    const thirtySecondsAgo = new Date(now.getTime() - 30_000).toISOString();
    expect(formatAge(thirtySecondsAgo)).toBe("Ahora");
  });

  it("returns 'Hace Xm' for less than an hour", () => {
    vi.useFakeTimers();
    const now = new Date("2024-06-01T12:00:00Z");
    vi.setSystemTime(now);
    const thirtyMinutesAgo = new Date(now.getTime() - 30 * 60_000).toISOString();
    expect(formatAge(thirtyMinutesAgo)).toBe("Hace 30m");
  });

  it("returns 'Hace Xh' for less than a day", () => {
    vi.useFakeTimers();
    const now = new Date("2024-06-01T12:00:00Z");
    vi.setSystemTime(now);
    const fiveHoursAgo = new Date(now.getTime() - 5 * 3_600_000).toISOString();
    expect(formatAge(fiveHoursAgo)).toBe("Hace 5h");
  });

  it("returns 'Hace Xd' for more than a day", () => {
    vi.useFakeTimers();
    const now = new Date("2024-06-01T12:00:00Z");
    vi.setSystemTime(now);
    const threeDaysAgo = new Date(now.getTime() - 3 * 86_400_000).toISOString();
    expect(formatAge(threeDaysAgo)).toBe("Hace 3d");
  });
});

describe("truncate()", () => {
  it("returns the original string if within limit", () => {
    expect(truncate("hello", 10)).toBe("hello");
  });

  it("truncates and appends '...' when over limit", () => {
    expect(truncate("hello world", 8)).toBe("hello...");
  });

  it("exact length returns original string", () => {
    expect(truncate("hello", 5)).toBe("hello");
  });

  it("handles empty string", () => {
    expect(truncate("", 5)).toBe("");
  });
});
