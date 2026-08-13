/**
 * Invoice arithmetic.
 *
 * This is the code that decides how much a client is charged, so it is tested
 * harder than its size suggests. The failure mode that matters is not a crash
 * — it is a number that looks plausible and is wrong, which nobody notices
 * until a client audits their bill.
 */

import { describe, it, expect } from "vitest";
import {
  computeInvoice,
  computeMargin,
  PLAN_CATALOG,
  PLANS,
  isPlan,
  isBillingStatus,
} from "@/lib/billing/plans";

const terms = (plan: (typeof PLANS)[number]) => PLAN_CATALOG[plan];

describe("computeInvoice", () => {
  it("charges only the monthly fee while inside the included allowance", () => {
    const inv = computeInvoice({ ...terms("operativo"), claims: 700 });

    expect(inv.overage_claims).toBe(0);
    expect(inv.overage_total_usd).toBe(0);
    expect(inv.total_usd).toBe(390);
  });

  it("charges the fee plus overage past the allowance", () => {
    // 900 claims on operativo: 750 included, 150 over at 0.45 = 67.50
    const inv = computeInvoice({ ...terms("operativo"), claims: 900 });

    expect(inv.overage_claims).toBe(150);
    expect(inv.overage_total_usd).toBe(67.5);
    expect(inv.total_usd).toBe(457.5);
  });

  it("bills nothing for a pilot, however much it is used", () => {
    const inv = computeInvoice({ ...terms("piloto"), claims: 5000 });

    expect(inv.total_usd).toBe(0);
    expect(inv.effective_price_per_claim_usd).toBe(0);
  });

  it("charges the fee even in a month with zero claims — it is a subscription", () => {
    const inv = computeInvoice({ ...terms("profesional"), claims: 0 });

    expect(inv.total_usd).toBe(1100);
    // Not Infinity, not NaN: dividing a fee by zero claims has no meaning.
    expect(inv.effective_price_per_claim_usd).toBe(0);
  });

  it("exactly at the allowance is still included — the boundary is not off by one", () => {
    const inv = computeInvoice({ ...terms("operativo"), claims: 750 });

    expect(inv.overage_claims).toBe(0);
    expect(inv.total_usd).toBe(390);
  });

  it("one claim past the allowance costs exactly one overage unit", () => {
    const inv = computeInvoice({ ...terms("operativo"), claims: 751 });

    expect(inv.overage_claims).toBe(1);
    expect(inv.total_usd).toBe(390.45);
  });

  it("the breakdown always sums to the total, so an invoice can be defended", () => {
    for (const plan of PLANS) {
      for (const claims of [0, 1, 299, 750, 751, 3001, 12_345]) {
        const inv = computeInvoice({ ...terms(plan), claims });
        expect(inv.monthly_fee_usd + inv.overage_total_usd).toBeCloseTo(inv.total_usd, 2);
      }
    }
  });

  it("effective price per claim falls as volume rises — the whole point of the ladder", () => {
    const cheapAtLowVolume = computeInvoice({ ...terms("corporativo"), claims: 1000 });
    const cheapAtHighVolume = computeInvoice({ ...terms("corporativo"), claims: 10_000 });

    expect(cheapAtHighVolume.effective_price_per_claim_usd).toBeLessThan(
      cheapAtLowVolume.effective_price_per_claim_usd
    );
  });

  it("never returns a fractional claim count", () => {
    const inv = computeInvoice({ ...terms("operativo"), claims: 900.7 });

    expect(Number.isInteger(inv.claims)).toBe(true);
    expect(inv.claims).toBe(900);
  });

  it("clamps garbage inputs to zero instead of emitting a credit", () => {
    const inv = computeInvoice({
      claims: -500,
      monthly_fee_usd: -390,
      included_claims: -10,
      overage_price_usd: Number.NaN,
      label: "broken",
    });

    expect(inv.claims).toBe(0);
    expect(inv.total_usd).toBe(0);
    // A negative bill would be money handed back because of a bad DB row.
    expect(inv.total_usd).toBeGreaterThanOrEqual(0);
  });

  it("rounds money to cents, never leaving a sub-cent tail", () => {
    // 0.35 * 3 = 1.0499999999999998 in IEEE 754.
    const inv = computeInvoice({ ...terms("profesional"), claims: 3003 });

    expect(inv.overage_total_usd).toBe(1.05);
    expect(inv.total_usd).toBe(1101.05);
  });
});

describe("computeMargin", () => {
  it("reports the AI-level margin the pricing model is built on", () => {
    // 900 claims on operativo = 457.50 revenue, ~1.80 of AI spend.
    const m = computeMargin(457.5, 1.8);

    expect(m.margin_usd).toBe(455.7);
    expect(m.margin_pct).toBeCloseTo(99.6, 1);
  });

  it("returns null margin_pct for a pilot rather than a misleading 0%", () => {
    const m = computeMargin(0, 1.8);

    expect(m.revenue_usd).toBe(0);
    expect(m.margin_pct).toBeNull();
    // The cost is real even when the revenue is not.
    expect(m.margin_usd).toBe(-1.8);
  });

  it("survives a cost larger than the revenue without lying about it", () => {
    const m = computeMargin(10, 25);

    expect(m.margin_usd).toBe(-15);
    expect(m.margin_pct).toBe(-150);
  });
});

describe("plan guards", () => {
  it("accepts every catalogued plan and rejects anything else", () => {
    for (const p of PLANS) expect(isPlan(p)).toBe(true);
    expect(isPlan("gratis")).toBe(false);
    expect(isPlan(null)).toBe(false);
    expect(isPlan(undefined)).toBe(false);
  });

  it("accepts the billing statuses the DB constraint allows", () => {
    for (const s of ["trial", "active", "suspended", "churned"]) {
      expect(isBillingStatus(s)).toBe(true);
    }
    expect(isBillingStatus("paid")).toBe(false);
  });

  it("keeps the catalog consistent with the price ladder", () => {
    // Every paid tier must be cheaper per claim than the one below it,
    // otherwise upgrading costs the client more per unit.
    const ladder = ["operativo", "profesional", "corporativo", "enterprise"] as const;
    for (let i = 1; i < ladder.length; i++) {
      expect(PLAN_CATALOG[ladder[i]].overage_price_usd).toBeLessThanOrEqual(
        PLAN_CATALOG[ladder[i - 1]].overage_price_usd
      );
      expect(PLAN_CATALOG[ladder[i]].included_claims).toBeGreaterThanOrEqual(
        PLAN_CATALOG[ladder[i - 1]].included_claims
      );
    }
  });
});
