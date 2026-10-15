import type { Category, EventType, PlanItem, PlanItemStatus } from "@solagent/shared";
import type { TripEventType, TripSummary } from "@solagent/api";
import { plural, tripDayCount } from "./format.ts";

// --- event types -------------------------------------------------------------

export interface EventTypeOption {
  value: EventType;
  /** Plural name used on the filters in the left rail. */
  filter: string;
  /** Singular name used when creating an event. */
  label: string;
}

/** In the order they appear in the left rail. */
export const EVENT_TYPE_OPTIONS: EventTypeOption[] = [
  { value: "flight", filter: "Flights", label: "Flight" },
  { value: "vacation", filter: "Vacations", label: "Vacation" },
  { value: "shopping", filter: "Shopping", label: "Shopping" },
  { value: "international", filter: "International", label: "International" },
  { value: "local", filter: "Local", label: "Local" },
];

export function isEventType(value: string | null | undefined): value is EventType {
  return EVENT_TYPE_OPTIONS.some((o) => o.value === value);
}

export function eventTypeLabel(type: EventType | undefined): string {
  return EVENT_TYPE_OPTIONS.find((o) => o.value === type)?.label ?? "Trip";
}

// --- titles ----------------------------------------------------------------

type TitleSource = Pick<TripSummary, "eventType" | "destination" | "destinationName" | "startDate" | "endDate">;

export function tripTitle(s: TitleSource): string {
  const place = s.destinationName ?? s.destination;
  switch (s.eventType) {
    case "flight":
      return `Flight to ${place}`;
    case "shopping":
      return `Shopping in ${place}`;
    default:
      return `${plural(tripDayCount(s.startDate, s.endDate), "day")} in ${place}`;
  }
}

// --- where an event stands -----------------------------------------------------

export type Tone = "yellow" | "teal" | "green" | "red" | "neutral";
export type StageKey = "signature" | "attention" | "ready" | "booking" | "partial" | "booked" | "empty";

export interface Stage {
  key: StageKey;
  tone: Tone;
  label: string;
  detail?: string;
}

type StageSource = Pick<TripSummary, "items" | "pendingSignatures">;

export function tripStage(s: StageSource): Stage {
  const { items } = s;
  const open = items.proposed + items.approved;
  const active = open + items.booking + items.booked;
  if (s.pendingSignatures > 0) {
    return { key: "signature", tone: "yellow", label: "Needs your signature", detail: plural(s.pendingSignatures, "payment") };
  }
  if (items.booking > 0) return { key: "booking", tone: "teal", label: "Booking now" };
  if (items.booked > 0 && open === 0) {
    return { key: "booked", tone: "green", label: "Fully booked", detail: plural(items.booked, "booking") };
  }
  if (items.booked > 0) {
    return { key: "partial", tone: "teal", label: "Partly booked", detail: `${items.booked} of ${active} booked` };
  }
  if (open > 0) return { key: "ready", tone: "neutral", label: "Ready to approve", detail: plural(open, "booking") };
  if (items.failed > 0) return { key: "attention", tone: "red", label: "Needs attention" };
  return { key: "empty", tone: "neutral", label: "Nothing to book" };
}

/** Pending events are everything that still needs the traveler or the agent. */
export function isPending(stage: Stage): boolean {
  return stage.key !== "booked" && stage.key !== "empty";
}

const STAGE_RANK: Record<StageKey, number> = {
  signature: 0,
  attention: 1,
  ready: 2,
  partial: 3,
  booking: 4,
  booked: 5,
  empty: 6,
};

/** Most urgent first, then soonest trip first. */
export function compareEvents(a: TripSummary, b: TripSummary): number {
  const rank = STAGE_RANK[tripStage(a).key] - STAGE_RANK[tripStage(b).key];
  return rank !== 0 ? rank : a.startDate.localeCompare(b.startDate);
}

/** Bookable items by status (flights, lodging and activities; estimates like food are skipped). */
export function countBookable(items: PlanItem[]): Record<PlanItemStatus, number> {
  const counts: Record<PlanItemStatus, number> = { proposed: 0, approved: 0, booking: 0, booked: 0, failed: 0, cancelled: 0 };
  for (const item of items) if (item.kind === "booking") counts[item.status] += 1;
  return counts;
}

// --- categories and activity ---------------------------------------------------

export const CATEGORY_ORDER: Category[] = ["flights", "lodging", "activities", "food", "local_transport"];

export function categoryLabel(category: Category): string {
  switch (category) {
    case "flights":
      return "Flights";
    case "lodging":
      return "Stay";
    case "activities":
      return "Activities";
    case "food":
      return "Food";
    case "local_transport":
      return "Local transport";
  }
}

export type EventGroup = "bookings" | "payments" | "changes";

export function eventGroup(type: TripEventType): EventGroup {
  switch (type) {
    case "item_approved":
    case "booking_started":
    case "booked":
    case "cancelled":
      return "bookings";
    case "signature_required":
    case "payment_rejected":
      return "payments";
    default:
      return "changes";
  }
}

/** Events that should reach the traveler's notifications as a heads-up. */
export function isAlert(type: TripEventType): boolean {
  return type === "price_changed" || type === "booking_failed" || type === "payment_rejected";
}

// --- places --------------------------------------------------------------------

/** A starter list for the airport suggestions. Any 3-letter code still works. */
export const AIRPORTS: ReadonlyArray<readonly [code: string, city: string]> = [
  ["JFK", "New York"],
  ["LAX", "Los Angeles"],
  ["SFO", "San Francisco"],
  ["ORD", "Chicago"],
  ["MIA", "Miami"],
  ["YYZ", "Toronto"],
  ["MEX", "Mexico City"],
  ["GRU", "Sao Paulo"],
  ["EZE", "Buenos Aires"],
  ["LHR", "London"],
  ["CDG", "Paris"],
  ["MAD", "Madrid"],
  ["BCN", "Barcelona"],
  ["LIS", "Lisbon"],
  ["OPO", "Porto"],
  ["FCO", "Rome"],
  ["MXP", "Milan"],
  ["AMS", "Amsterdam"],
  ["BER", "Berlin"],
  ["VIE", "Vienna"],
  ["PRG", "Prague"],
  ["ATH", "Athens"],
  ["IST", "Istanbul"],
  ["DXB", "Dubai"],
  ["CAI", "Cairo"],
  ["LOS", "Lagos"],
  ["ABV", "Abuja"],
  ["ACC", "Accra"],
  ["NBO", "Nairobi"],
  ["JNB", "Johannesburg"],
  ["CPT", "Cape Town"],
  ["CMN", "Casablanca"],
  ["DEL", "Delhi"],
  ["BOM", "Mumbai"],
  ["BKK", "Bangkok"],
  ["SIN", "Singapore"],
  ["HKG", "Hong Kong"],
  ["NRT", "Tokyo"],
  ["ICN", "Seoul"],
  ["SYD", "Sydney"],
];

export function cityForCode(code: string): string | undefined {
  const upper = code.trim().toUpperCase();
  return AIRPORTS.find(([c]) => c === upper)?.[1];
}
