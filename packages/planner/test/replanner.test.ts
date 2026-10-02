import { describe, expect, it } from "vitest";
import type { PlanItem, TravelPlan } from "@solagent/shared";
import { buildPlan, isSignificantPriceChange, optimize, Replanner } from "../src/index.ts";
import { lisbonContext } from "./fixtures.ts";

async function setup(budgetCents = 350_000) {
  const { ctx, candidates } = await lisbonContext({ budgetCents });
  const plan = buildPlan(ctx, optimize(ctx), { source: "optimizer", tripId: "t" });
  return { plan, candidates, replanner: new Replanner() };
}

const find = (plan: TravelPlan, category: PlanItem["category"]) => plan.items.find((i) => i.category === category)!;

function withStatus(plan: TravelPlan, itemId: string, status: PlanItem["status"]): TravelPlan {
  return { ...plan, items: plan.items.map((i) => (i.id === itemId ? { ...i, status } : i)) };
}

describe("Replanner", () => {
  it("swaps a failed hotel and keeps every other item", async () => {
    const { plan, candidates, replanner } = await setup();
    const hotel = find(plan, "lodging");
    const r = replanner.replan(plan, { type: "booking_failed", itemId: hotel.id, reason: "Sold out" }, candidates);
    const newHotel = find(r.plan, "lodging");
    expect(newHotel.offer!.id).not.toBe(hotel.offer!.id);
    expect(r.plan.version).toBe(2);
    expect(r.changes).toContainEqual(expect.objectContaining({ kind: "swapped", category: "lodging" }));
    expect(r.requiresApproval).toBe(true);
    const others = (p: TravelPlan) => p.items.filter((i) => i.category !== "lodging").map((i) => i.offer?.id ?? i.id);
    expect(others(r.plan)).toEqual(others(plan));
    expect(r.plan.totalCents).toBeLessThanOrEqual(plan.request.budgetCents);
  });

  it("does not bring back an offer that already failed", async () => {
    const { plan, candidates, replanner } = await setup();
    const first = find(plan, "lodging");
    const r1 = replanner.replan(plan, { type: "booking_failed", itemId: first.id, reason: "x" }, candidates);
    const second = find(r1.plan, "lodging");
    const r2 = replanner.replan(r1.plan, { type: "booking_failed", itemId: second.id, reason: "x" }, candidates);
    expect([first.offer!.id, second.offer!.id]).not.toContain(find(r2.plan, "lodging").offer!.id);
  });

  it("never touches booked items", async () => {
    const { plan, candidates, replanner } = await setup();
    const flight = find(plan, "flights");
    const booked = withStatus(plan, flight.id, "booked");
    const r = replanner.replan(booked, { type: "budget_change", newBudgetCents: 250_000 }, candidates);
    expect(find(r.plan, "flights")).toEqual(find(booked, "flights"));
  });

  it("absorbs a small price increase with the buffer but asks for re-approval", async () => {
    const { plan, candidates, replanner } = await setup();
    const hotel = find(plan, "lodging");
    const r = replanner.replan(
      withStatus(plan, hotel.id, "approved"),
      { type: "price_change", itemId: hotel.id, newPriceCents: hotel.priceCents + 1500 },
      candidates,
    );
    const repriced = find(r.plan, "lodging");
    expect(repriced.offer!.id).toBe(hotel.offer!.id);
    expect(repriced.priceCents).toBe(hotel.priceCents + 1500);
    expect(repriced.status).toBe("proposed");
    expect(r.requiresApproval).toBe(true);
    expect(r.plan.totalCents).toBe(plan.totalCents + 1500);
    // Absorbed by the lodging envelope's headroom (or the buffer), never past the budget.
    expect(r.plan.bufferCents).toBeGreaterThanOrEqual(0);
  });

  it("keeps the old approval when the price drops", async () => {
    const { plan, candidates, replanner } = await setup();
    const hotel = find(plan, "lodging");
    const r = replanner.replan(
      withStatus(plan, hotel.id, "approved"),
      { type: "price_change", itemId: hotel.id, newPriceCents: hotel.priceCents - 5000 },
      candidates,
    );
    expect(find(r.plan, "lodging").status).toBe("approved");
    expect(r.requiresApproval).toBe(false);
  });

  it("re-optimizes the slot when a price jump is too big to absorb", async () => {
    const { plan, candidates, replanner } = await setup();
    const hotel = find(plan, "lodging");
    const r = replanner.replan(
      plan,
      { type: "price_change", itemId: hotel.id, newPriceCents: hotel.priceCents * 2 },
      candidates,
    );
    expect(find(r.plan, "lodging").offer!.id).not.toBe(hotel.offer!.id);
    expect(r.plan.totalCents).toBeLessThanOrEqual(plan.request.budgetCents);
  });

  it("doesn't substitute an activity the user removed", async () => {
    const { plan, candidates, replanner } = await setup();
    const activity = find(plan, "activities");
    const before = plan.items.filter((i) => i.category === "activities").length;
    const r = replanner.replan(plan, { type: "remove_item", itemId: activity.id }, candidates);
    expect(r.plan.items.filter((i) => i.category === "activities")).toHaveLength(before - 1);
    expect(r.plan.items.some((i) => i.offer?.id === activity.offer!.id)).toBe(false);
  });

  it("shrinks the plan when the budget drops", async () => {
    const { plan, candidates, replanner } = await setup(500_000);
    const r = replanner.replan(plan, { type: "budget_change", newBudgetCents: 300_000 }, candidates);
    expect(r.plan.totalCents).toBeLessThanOrEqual(300_000);
    expect(r.plan.totalCents).toBeLessThan(plan.totalCents);
  });
});

describe("isSignificantPriceChange", () => {
  it("ignores noise and catches real moves", () => {
    expect(isSignificantPriceChange(100_000, 100_500)).toBe(false);
    expect(isSignificantPriceChange(100_000, 104_000)).toBe(true);
    expect(isSignificantPriceChange(5_000, 6_000)).toBe(true);
  });
});
