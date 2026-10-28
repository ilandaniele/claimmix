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
  PLANES_COMERCIALES,
  isPlan,
  isBillingStatus,
} from "@/lib/billing/plans";

const terms = (plan: (typeof PLANS)[number]) => PLAN_CATALOG[plan];

describe("computeInvoice", () => {
  it("charges only the monthly fee while inside the included allowance", () => {
    const inv = computeInvoice({ ...terms("operativo"), claims: 300 });

    expect(inv.overage_claims).toBe(0);
    expect(inv.overage_total_usd).toBe(0);
    expect(inv.total_usd).toBe(390);
  });

  it("charges the fee plus overage past the allowance", () => {
    // 400 claims on operativo: 320 included, 80 over at 1.30 = 104
    const inv = computeInvoice({ ...terms("operativo"), claims: 400 });

    expect(inv.overage_claims).toBe(80);
    expect(inv.overage_total_usd).toBe(104);
    expect(inv.total_usd).toBe(494);
  });

  it("inicial: fee up to 12, then 1.50 per extra unit", () => {
    expect(computeInvoice({ ...terms("inicial"), claims: 12 }).total_usd).toBe(19);
    expect(computeInvoice({ ...terms("inicial"), claims: 13 }).total_usd).toBe(20.5);
    expect(computeInvoice({ ...terms("inicial"), claims: 15 }).total_usd).toBe(23.5);
  });

  it("enterprise: monthly fee, 8000 included, 1.00 per extra", () => {
    const inv = computeInvoice({ ...terms("enterprise"), claims: 8001 });

    expect(inv.overage_claims).toBe(1);
    expect(inv.total_usd).toBe(8001);
  });

  it("bills nothing for a pilot, however much it is used", () => {
    const inv = computeInvoice({ ...terms("piloto"), claims: 5000 });

    expect(inv.total_usd).toBe(0);
    expect(inv.effective_price_per_claim_usd).toBe(0);
  });

  it("the pilot is a 50-unit trial with no overage price", () => {
    expect(terms("piloto")).toMatchObject({
      monthly_fee_usd: 0,
      included_claims: 50,
      overage_price_usd: 0,
    });
  });

  it("charges the fee even in a month with zero claims — it is a subscription", () => {
    const inv = computeInvoice({ ...terms("profesional"), claims: 0 });

    expect(inv.total_usd).toBe(1100);
    // Not Infinity, not NaN: dividing a fee by zero claims has no meaning.
    expect(inv.effective_price_per_claim_usd).toBe(0);
  });

  it("exactly at the allowance is still included — the boundary is not off by one", () => {
    const inv = computeInvoice({ ...terms("operativo"), claims: 320 });

    expect(inv.overage_claims).toBe(0);
    expect(inv.total_usd).toBe(390);
  });

  it("one claim past the allowance costs exactly one overage unit", () => {
    const inv = computeInvoice({ ...terms("operativo"), claims: 321 });

    expect(inv.overage_claims).toBe(1);
    expect(inv.total_usd).toBe(391.3);
  });

  it("without `units` it charges one unit per claim, as before the weights", () => {
    const inv = computeInvoice({ ...terms("operativo"), claims: 323 });

    expect(inv.units).toBe(323);
    expect(inv.overage_claims).toBe(3);
    expect(inv.total_usd).toBe(393.9);
  });

  it("charges the units, not the head count, when the caller weighs the channels", () => {
    // 400 claims weighing 350 units: 30 over the 320 included.
    const inv = computeInvoice({ ...terms("operativo"), claims: 400, units: 350 });

    expect(inv.claims).toBe(400);
    expect(inv.units).toBe(350);
    expect(inv.overage_claims).toBe(30);
    expect(inv.total_usd).toBe(429);
  });

  it("a half unit over the allowance is charged as half a unit", () => {
    const inv = computeInvoice({ ...terms("operativo"), claims: 641, units: 320.5 });

    expect(inv.overage_claims).toBe(0.5);
    expect(inv.overage_total_usd).toBe(0.65);
    expect(inv.total_usd).toBe(390.65);
  });

  it("a float tail in the units does not leak into the overage", () => {
    // 3 * 0.8 = 2.4000000000000004 in IEEE 754.
    const inv = computeInvoice({
      monthly_fee_usd: 0,
      included_claims: 0,
      overage_price_usd: 1,
      label: "t",
      claims: 3,
      units: 3 * 0.8,
    });

    expect(inv.overage_claims).toBe(2.4);
    expect(inv.total_usd).toBe(2.4);
  });

  it("negative or NaN units count as zero", () => {
    expect(computeInvoice({ ...terms("operativo"), claims: 10, units: -5 }).units).toBe(0);
    expect(computeInvoice({ ...terms("operativo"), claims: 10, units: Number.NaN }).units).toBe(0);
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
    // 1.1 * 3 = 3.3000000000000003 in IEEE 754.
    const inv = computeInvoice({ ...terms("corporativo"), claims: 2703 });

    expect(inv.overage_total_usd).toBe(3.3);
    expect(inv.total_usd).toBe(2903.3);
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
    // Every paid tier must be cheaper per unit than the one below it,
    // otherwise upgrading costs the client more per unit.
    for (let i = 1; i < PLANES_COMERCIALES.length; i++) {
      expect(PLAN_CATALOG[PLANES_COMERCIALES[i]].overage_price_usd).toBeLessThanOrEqual(
        PLAN_CATALOG[PLANES_COMERCIALES[i - 1]].overage_price_usd
      );
      expect(PLAN_CATALOG[PLANES_COMERCIALES[i]].included_claims).toBeGreaterThanOrEqual(
        PLAN_CATALOG[PLANES_COMERCIALES[i - 1]].included_claims
      );
    }
  });

  it("the paid ladder is inicial, operativo, profesional, corporativo, enterprise", () => {
    expect(PLANES_COMERCIALES).toEqual([
      "inicial",
      "operativo",
      "profesional",
      "corporativo",
      "enterprise",
    ]);
    expect(PLANES_COMERCIALES).not.toContain("piloto");
  });

  it("matches the approved 2027 prices", () => {
    const tabla = Object.fromEntries(
      PLANES_COMERCIALES.map((p) => [
        p,
        [
          PLAN_CATALOG[p].monthly_fee_usd,
          PLAN_CATALOG[p].included_claims,
          PLAN_CATALOG[p].overage_price_usd,
        ],
      ])
    );

    expect(tabla).toEqual({
      inicial: [19, 12, 1.5],
      operativo: [390, 320, 1.3],
      profesional: [1100, 950, 1.2],
      corporativo: [2900, 2700, 1.1],
      enterprise: [8000, 8000, 1],
    });
  });

  // Regla comercial nueva (28/10/2026). La anterior (el excedente de un plan nunca
  // supera su propia tarifa incluida) cae a propósito: el excedente de operativo
  // (US$ 1,30) ya supera US$ 390 / 320 (US$ 1,22), y el dueño lo aprobó así. Quedan dos
  // invariantes que sí protegen al cliente que crece.
  it("the in-plan rate (fee / included) falls strictly at every tier", () => {
    const tarifa = PLANES_COMERCIALES.map(
      (p) => PLAN_CATALOG[p].monthly_fee_usd / PLAN_CATALOG[p].included_claims
    );
    for (let i = 1; i < tarifa.length; i++) {
      expect(tarifa[i], `${PLANES_COMERCIALES[i]} must be cheaper per unit`).toBeLessThan(tarifa[i - 1]);
    }
  });

  it("overage never exceeds the previous tier's in-plan rate", () => {
    // Así nadie paga más por la unidad extra de su plan que lo que le costaría
    // la unidad incluida en el plan de abajo: no conviene bajarse para esquivar el excedente.
    for (let i = 1; i < PLANES_COMERCIALES.length; i++) {
      const abajo = PLAN_CATALOG[PLANES_COMERCIALES[i - 1]];
      expect(
        PLAN_CATALOG[PLANES_COMERCIALES[i]].overage_price_usd,
        `${PLANES_COMERCIALES[i]}: overage above the in-plan rate of ${PLANES_COMERCIALES[i - 1]}`
      ).toBeLessThanOrEqual(abajo.monthly_fee_usd / abajo.included_claims + 1e-9);
    }
  });
});
