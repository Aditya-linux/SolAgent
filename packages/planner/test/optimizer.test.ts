import { describe, expect, it } from "vitest";
import { buildPlan, createContext, daySlots, evaluateSelection, optimize } from "../src/index.ts";
import { lisbonContext } from "./fixtures.ts";

describe("optimize", () => {
  it.each([250_000, 350_000, 600_000, 1_000_000])("stays within a %i cent budget", async (budgetCents) => {
    const { ctx } = await lisbonContext({ budgetCents });
    const sel = optimize(ctx);
    const e = evaluateSelection(ctx, sel);
    expect(e.errors).toEqual([]);
    expect(e.totalCents).toBeLessThanOrEqual(budgetCents);
  });

  it("buys more value with more budget", async () => {
    const value = async (budgetCents: number) => {
      const { ctx } = await lisbonContext({ budgetCents });
      return evaluateSelection(ctx, optimize(ctx)).valueUsd;
    };
    const values = [await value(250_000), await value(350_000), await value(600_000)];
    expect(values[1]).toBeGreaterThanOrEqual(values[0]!);
    expect(values[2]).toBeGreaterThanOrEqual(values[1]!);
  });

  it("honors the avoid list", async () => {
    const { ctx, candidates } = await lisbonContext();
    expect(candidates.flights.some((f) => f.redEye)).toBe(true);
    const flight = candidates.flights.find((f) => f.id === optimize(ctx).flightId)!;
    expect(flight.redEye).toBe(false);
  });

  it("schedules activities only on available days within slot limits", async () => {
    const { ctx, req, candidates } = await lisbonContext({ budgetCents: 1_000_000 });
    const sel = optimize(ctx);
    const slots = daySlots(req);
    for (const a of sel.activities) {
      const offer = candidates.activities.find((o) => o.id === a.offerId)!;
      expect(offer.availableDates.length === 0 || offer.availableDates.includes(a.date)).toBe(true);
      slots.set(a.date, slots.get(a.date)! - 1);
    }
    expect([...slots.values()].every((free) => free >= 0)).toBe(true);
  });

  it("never selects excluded offers", async () => {
    const { req, candidates, ctx } = await lisbonContext();
    const first = optimize(ctx);
    const ctx2 = createContext(req, candidates, { excludedOfferIds: [first.hotelId!] });
    expect(optimize(ctx2).hotelId).not.toBe(first.hotelId);
  });

  it("flags an unaffordable trip instead of silently dropping requirements", async () => {
    const { ctx } = await lisbonContext({ budgetCents: 120_000 });
    const plan = buildPlan(ctx, optimize(ctx), { source: "optimizer", tripId: "t" });
    expect(plan.items.some((i) => i.category === "flights")).toBe(true);
    expect(plan.items.some((i) => i.category === "lodging")).toBe(true);
    expect(plan.warnings.join(" ")).toMatch(/Over budget/);
  });
});

describe("evaluateSelection", () => {
  it("reports missing, unavailable and double-booked items", async () => {
    const { ctx, candidates } = await lisbonContext();
    const limited = candidates.activities.find((a) => a.availableDates.length > 0)!;
    const badDate = ["2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13", "2026-11-14"].find(
      (d) => !limited.availableDates.includes(d),
    )!;
    const e = evaluateSelection(ctx, {
      activities: [
        { offerId: limited.id, date: badDate },
        { offerId: "nope", date: "2026-11-11" },
        { offerId: candidates.activities[0]!.id, date: "2027-01-01" },
      ],
    });
    expect(e.ok).toBe(false);
    expect(e.errors.join("\n")).toMatch(/flight is required/);
    expect(e.errors.join("\n")).toMatch(/Lodging is required/);
    expect(e.errors.join("\n")).toMatch(/not available on/);
    expect(e.errors.join("\n")).toMatch(/unknown/);
    expect(e.errors.join("\n")).toMatch(/outside the trip dates/);
  });
});

describe("buildPlan", () => {
  it("includes estimates and explains choices", async () => {
    const { ctx } = await lisbonContext();
    const plan = buildPlan(ctx, optimize(ctx), { source: "optimizer", tripId: "t" });
    expect(plan.items.find((i) => i.id === "est_food")?.kind).toBe("estimate");
    expect(plan.items.find((i) => i.category === "lodging")?.rationale).toMatch(/km from the center/);
    expect(plan.totalCents).toBe(plan.items.reduce((s, i) => s + i.priceCents, 0));
    expect(plan.items.filter((i) => i.kind === "booking").every((i) => i.alternativeOfferIds.length > 0)).toBe(true);
  });
});
