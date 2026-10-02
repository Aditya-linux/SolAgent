import type { TripRequest } from "@solagent/shared";
import { createContext, gatherCandidates, MockSearchProvider } from "../src/index.ts";

export function lisbonRequest(overrides: Partial<TripRequest> = {}): TripRequest {
  return {
    origin: "JFK",
    destination: "LIS",
    startDate: "2026-11-10",
    endDate: "2026-11-15",
    travelers: 2,
    budgetCents: 350_000,
    preferences: { lodgingStyle: "standard", pace: "balanced", interests: ["food", "history"], avoid: ["red-eye"] },
    ...overrides,
  };
}

export async function lisbonContext(overrides: Partial<TripRequest> = {}) {
  const req = lisbonRequest(overrides);
  const candidates = await gatherCandidates(new MockSearchProvider(), req);
  return { req, candidates, ctx: createContext(req, candidates) };
}
