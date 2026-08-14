/**
 * Billing period resolution.
 *
 * The failure mode worth guarding is not a crash — it is silently billing the
 * wrong month, which produces a plausible-looking total nobody questions until
 * a client reconciles their own numbers.
 */

import { describe, it, expect } from "vitest";
import { resolveBillingPeriod } from "@/lib/billing/period";

describe("resolveBillingPeriod", () => {
  it("resolves an ordinary month to its exact UTC bounds", () => {
    const p = resolveBillingPeriod("2026-03");

    expect(p).not.toBeNull();
    expect(p!.start).toBe("2026-03-01T00:00:00.000Z");
    expect(p!.next).toBe("2026-04-01T00:00:00.000Z");
    expect(p!.month).toBe("2026-03");
  });

  it("rolls December over into the next January", () => {
    // The classic off-by-one: month 12 must not become month 13 of the same year.
    const p = resolveBillingPeriod("2026-12");

    expect(p!.start).toBe("2026-12-01T00:00:00.000Z");
    expect(p!.next).toBe("2027-01-01T00:00:00.000Z");
    expect(p!.month).toBe("2026-12");
  });

  it("covers all 29 days of a leap February", () => {
    const p = resolveBillingPeriod("2028-02");

    expect(p!.start).toBe("2028-02-01T00:00:00.000Z");
    expect(p!.next).toBe("2028-03-01T00:00:00.000Z");
  });

  it("covers all 28 days of a non-leap February", () => {
    const p = resolveBillingPeriod("2026-02");

    expect(p!.next).toBe("2026-03-01T00:00:00.000Z");
  });

  it("uses a half-open range, so no claim is double-counted or dropped", () => {
    // February's `next` is exactly March's `start`: consecutive periods abut
    // without overlapping.
    const feb = resolveBillingPeriod("2026-02")!;
    const mar = resolveBillingPeriod("2026-03")!;

    expect(feb.next).toBe(mar.start);
  });

  it("defaults to the current month when no month is given", () => {
    const now = new Date("2026-07-19T13:45:00.000Z");

    for (const raw of [null, undefined, ""]) {
      const p = resolveBillingPeriod(raw, now);
      expect(p!.month).toBe("2026-07");
      expect(p!.start).toBe("2026-07-01T00:00:00.000Z");
      expect(p!.next).toBe("2026-08-01T00:00:00.000Z");
    }
  });

  it("defaults correctly on the last instant of December", () => {
    const p = resolveBillingPeriod(null, new Date("2026-12-31T23:59:59.999Z"));

    expect(p!.month).toBe("2026-12");
    expect(p!.next).toBe("2027-01-01T00:00:00.000Z");
  });

  it("uses UTC, not local time, so the period does not shift by timezone", () => {
    // 2026-08-01T00:30 UTC is still July 31st in Buenos Aires (UTC-3). The
    // period must follow UTC, matching how created_at is stored and compared.
    const p = resolveBillingPeriod(null, new Date("2026-08-01T00:30:00.000Z"));

    expect(p!.month).toBe("2026-08");
  });

  it("rejects a malformed month rather than guessing", () => {
    for (const bad of ["2026", "2026-", "26-03", "2026-3", "2026/03", "marzo", "2026-03-01", " 2026-03"]) {
      expect(resolveBillingPeriod(bad), `should reject "${bad}"`).toBeNull();
    }
  });

  it("rejects an impossible month number", () => {
    expect(resolveBillingPeriod("2026-00")).toBeNull();
    expect(resolveBillingPeriod("2026-13")).toBeNull();
    expect(resolveBillingPeriod("2026-99")).toBeNull();
  });

  it("rejects a year far outside the product's lifetime", () => {
    expect(resolveBillingPeriod("1999-03")).toBeNull();
    expect(resolveBillingPeriod("2200-03")).toBeNull();
    // The boundaries themselves are valid.
    expect(resolveBillingPeriod("2020-01")).not.toBeNull();
    expect(resolveBillingPeriod("2100-12")).not.toBeNull();
  });

  it("echoes back a canonical month label, never the raw input", () => {
    // The label is what ends up on the invoice, so it must be normalised.
    expect(resolveBillingPeriod("2026-01")!.month).toBe("2026-01");
    expect(resolveBillingPeriod("2026-09")!.month).toBe("2026-09");
  });
});
