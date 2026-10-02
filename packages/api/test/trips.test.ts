import { describe, expect, it } from "vitest";
import { MockSearchProvider, TripPlanner } from "@solagent/planner";
import { BookingExecutor, SandboxPaymentGateway, SandboxSupplier, SupplierRegistry } from "@solagent/booking";
import { createApp, TripService } from "../src/index.ts";

function setup() {
  const sandbox = new SandboxSupplier();
  const payments = new SandboxPaymentGateway();
  const planner = new TripPlanner(new MockSearchProvider());
  const executor = new BookingExecutor(new SupplierRegistry([sandbox]), payments, { backoffMs: () => 0 });
  const service = new TripService(planner, executor, payments, { autoApproveUpToCents: 1_000_000 });
  return { app: createApp({ planner, service, sandbox }), service, sandbox };
}

const body = {
  origin: "JFK",
  destination: "LIS",
  startDate: "2026-11-10",
  endDate: "2026-11-15",
  travelers: 2,
  budgetUsd: 3500,
  preferences: { lodgingStyle: "standard", pace: "balanced", interests: ["food"] },
};

async function json(res: Response) {
  return (await res.json()) as any;
}

describe("API", () => {
  it("creates a trip, books everything, and recovers from a sold-out hotel", async () => {
    const { app, service, sandbox } = setup();
    const created = await json(
      await app.request("/trips", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
    );
    expect(created.plan.items.length).toBeGreaterThan(3);

    const hotel = created.plan.items.find((i: any) => i.category === "lodging");
    sandbox.markSoldOut(hotel.offer.id);
    await app.request(`/trips/${created.id}/approve-all`, { method: "POST" });
    await app.request(`/trips/${created.id}/approve-all`, { method: "POST" });

    const trip = service.get(created.id);
    const bookable = trip.plan.items.filter((i) => i.kind === "booking");
    expect(bookable.every((i) => i.status === "booked")).toBe(true);
    expect(trip.plan.items.find((i) => i.category === "lodging")!.offer!.id).not.toBe(hotel.offer.id);
    expect(trip.events.map((e) => e.type)).toContain("booking_failed");
    expect(trip.plan.totalCents).toBeLessThanOrEqual(350_000);
    const committed = trip.plan.envelopes.reduce((s, e) => s + e.committedCents, 0);
    expect(committed).toBe(bookable.reduce((s, i) => s + i.booking!.pricePaidCents, 0));
  });

  it("validates input", async () => {
    const { app } = setup();
    const res = await app.request("/trips", {
      method: "POST",
      body: JSON.stringify({ ...body, endDate: "2026-11-01" }),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(400);
    expect((await app.request("/trips/nope")).status).toBe(404);
  });

  it("replans on refresh when a price spikes", async () => {
    const { app, service, sandbox } = setup();
    const trip = await service.createTrip({ ...body, budgetCents: 350_000, budgetUsd: undefined } as any);
    const hotel = trip.plan.items.find((i) => i.category === "lodging")!;
    sandbox.setPrice(hotel.offer!.id, hotel.priceCents * 2);
    const res = await json(await app.request(`/trips/${trip.id}/refresh-prices`, { method: "POST" }));
    expect(res.changes.length).toBeGreaterThan(0);
    expect(service.get(trip.id).plan.version).toBe(2);
  });
});
