import type { Trip, TripEvent, TripSummary } from "@solagent/api";
import type { BookingOutcome, Cents, EventType, PlanChange, TripPreferences } from "@solagent/shared";

/**
 * Thin, typed client for the Hono API in packages/api. Types are imported
 * with `import type` only, so nothing from @solagent/api or @solagent/shared
 * (including their Node-only code) ends up in the browser bundle — just the
 * shapes, erased at build time. See README "Interfaces for the other layers"
 * for the endpoint list this follows.
 */

export const BASE_URL = import.meta.env.VITE_API_URL ?? "http://localhost:8787";

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(body.error ?? `Request failed (${res.status})`, res.status);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export interface CreateTripInput {
  origin?: string;
  destination: string;
  destinationName?: string;
  startDate: string;
  endDate: string;
  travelers: number;
  budgetUsd: number;
  preferences: TripPreferences;
  eventType?: EventType;
  mode?: "optimizer" | "agent";
}

export type { TripSummary };

export interface Health {
  ok: boolean;
  agent?: string;
}

export const api = {
  health: () => request<Health>("/health"),

  createTrip: (input: CreateTripInput) => request<Trip>("/trips", { method: "POST", body: JSON.stringify(input) }),

  listTrips: () => request<TripSummary[]>("/trips"),

  getTrip: (tripId: string) => request<Trip>(`/trips/${tripId}`),

  approveItem: (tripId: string, itemId: string) =>
    request<{ outcome: BookingOutcome | undefined }>(`/trips/${tripId}/items/${itemId}/approve`, { method: "POST" }),

  approveAll: (tripId: string) => request<{ outcomes: BookingOutcome[] }>(`/trips/${tripId}/approve-all`, { method: "POST" }),

  signPayment: (tripId: string, itemId: string) =>
    request<{ outcome: BookingOutcome }>(`/trips/${tripId}/items/${itemId}/sign`, { method: "POST" }),

  cancelItem: (tripId: string, itemId: string) =>
    request<{ refundCents: Cents }>(`/trips/${tripId}/items/${itemId}/cancel`, { method: "POST" }),

  refreshPrices: (tripId: string) => request<{ changes: PlanChange[] }>(`/trips/${tripId}/refresh-prices`, { method: "POST" }),

  /** Demo helper, mirrors the server's /simulate endpoint. */
  simulate: (tripId: string, itemId: string, kind: "price_spike" | "sold_out" | "flaky") =>
    request<{ ok: true }>(`/trips/${tripId}/simulate`, { method: "POST", body: JSON.stringify({ itemId, kind }) }),
};

/**
 * Live trip updates over Server-Sent Events. Returns an unsubscribe function;
 * call it on unmount so the connection doesn't leak.
 */
export function subscribeToTripEvents(tripId: string, onEvent: (event: TripEvent) => void): () => void {
  const source = new EventSource(`${BASE_URL}/trips/${tripId}/events`);
  const handler = (e: MessageEvent) => onEvent(JSON.parse(e.data) as TripEvent);
  const types: TripEvent["type"][] = [
    "plan_created",
    "plan_updated",
    "item_approved",
    "booking_started",
    "booked",
    "signature_required",
    "payment_rejected",
    "booking_failed",
    "price_changed",
    "cancelled",
  ];
  for (const type of types) source.addEventListener(type, handler);
  return () => source.close();
}
