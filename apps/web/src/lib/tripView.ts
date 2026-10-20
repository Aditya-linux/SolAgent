import type { Trip, TripSummary } from "@solagent/api";
import { countBookable } from "./events.ts";

/**
 * Builds the same figures the API's /trips list returns, from a full trip,
 * so the detail page and the dashboard describe an event identically.
 * Mirrors summarizeTrip in packages/api/src/trips.ts (kept separate because
 * the browser can't import that file at runtime).
 */
export function summarizeForView(trip: Trip): TripSummary {
  const { plan } = trip;
  const req = plan.request;
  const items = countBookable(plan.items);
  const bookable = plan.items.filter((i) => i.kind === "booking");
  const last = trip.events[trip.events.length - 1];
  return {
    id: trip.id,
    createdAt: trip.createdAt,
    summary: plan.summary,
    version: plan.version,
    eventType: req.eventType,
    origin: req.origin,
    destination: req.destination,
    destinationName: req.destinationName,
    startDate: req.startDate,
    endDate: req.endDate,
    travelers: req.travelers,
    budgetCents: req.budgetCents,
    plannedCents: plan.totalCents,
    paidCents: plan.envelopes.reduce((sum, e) => sum + e.committedCents, 0),
    bufferCents: plan.bufferCents,
    items,
    openBookingsCents: bookable
      .filter((i) => i.status === "proposed" || i.status === "approved")
      .reduce((sum, i) => sum + i.priceCents, 0),
    pendingSignatures: Object.keys(trip.pendingSignatures).length,
    lastEvent: last ? { type: last.type, message: last.message, at: last.at } : undefined,
  };
}
