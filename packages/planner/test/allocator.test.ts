import { describe, expect, it } from "vitest";
import { sum } from "@solagent/shared";
import { allocateBudget, discretionaryShares, rebalanceEnvelopes, waterFill } from "../src/index.ts";
import { lisbonRequest } from "./fixtures.ts";

const costIndex = {
  destination: "LIS",
  foodPerPersonPerDayCents: { budget: 3000, standard: 5000, luxury: 10000 },
  localTransportPerPersonPerDayCents: 1000,
};

describe("allocateBudget", () => {
  it("splits the whole budget across envelopes and the buffer", () => {
    const req = lisbonRequest();
    const a = allocateBudget(req, costIndex);
    expect(sum(a.envelopes.map((e) => e.allocatedCents)) + a.bufferCents).toBeLessThanOrEqual(req.budgetCents);
    expect(sum(a.envelopes.map((e) => e.allocatedCents)) + a.bufferCents).toBeGreaterThan(req.budgetCents - 10);
    expect(a.bufferCents).toBe(Math.round(req.budgetCents * 0.05));
    // 6 days x 2 travelers x $50
    expect(a.envelopes.find((e) => e.category === "food")!.allocatedCents).toBe(60_000);
  });

  it("gives luxury travelers a bigger share of discretionary spend for lodging", () => {
    const share = (style: "budget" | "luxury") =>
      discretionaryShares(lisbonRequest({ preferences: { ...lisbonRequest().preferences, lodgingStyle: style } }))
        .lodging;
    expect(share("luxury")).toBeGreaterThan(share("budget"));
  });

  it("packed pace shifts budget toward activities", () => {
    const share = (pace: "relaxed" | "packed") =>
      discretionaryShares(lisbonRequest({ preferences: { ...lisbonRequest().preferences, pace } })).activities;
    expect(share("packed")).toBeGreaterThan(share("relaxed"));
  });

  it("allocates nothing to flights when there is no origin", () => {
    const a = allocateBudget(lisbonRequest({ origin: undefined }), costIndex);
    expect(a.envelopes.find((e) => e.category === "flights")!.allocatedCents).toBe(0);
  });

  it("raises envelopes to market floors and reports a shortfall when unaffordable", () => {
    const ok = allocateBudget(lisbonRequest(), costIndex, { floors: { flights: 150_000 } });
    expect(ok.envelopes.find((e) => e.category === "flights")!.allocatedCents).toBe(150_000);

    const short = allocateBudget(lisbonRequest({ budgetCents: 150_000 }), costIndex, {
      floors: { flights: 100_000, lodging: 60_000 },
    });
    expect(short.shortfallCents).toBeGreaterThan(0);
    expect(short.bufferCents).toBe(0);
    expect(short.warnings.join(" ")).toMatch(/short by/);
  });
});

describe("waterFill", () => {
  it("pins categories at their floor and splits the rest by share", () => {
    const r = waterFill(1000, { flights: 0.5, lodging: 0.3, activities: 0.2 }, { lodging: 500 });
    expect(r.lodging).toBe(500);
    expect(r.flights).toBe(357);
    expect(r.activities).toBe(142);
  });
});

describe("rebalanceEnvelopes", () => {
  it("covers overspend from the largest slack first, then the buffer", () => {
    const env = (category: "flights" | "lodging" | "activities", allocatedCents: number, plannedCents: number) => ({
      category,
      allocatedCents,
      plannedCents,
      committedCents: 0,
    });
    const { envelopes, bufferCents, moves } = rebalanceEnvelopes(
      [env("flights", 1000, 1300), env("lodging", 1000, 900), env("activities", 500, 300)],
      3000,
    );
    expect(moves[0]).toEqual({ from: "activities", to: "flights", cents: 200 });
    expect(moves[1]).toEqual({ from: "lodging", to: "flights", cents: 100 });
    expect(envelopes.find((e) => e.category === "flights")!.allocatedCents).toBe(1300);
    expect(bufferCents).toBe(500);
  });
});
