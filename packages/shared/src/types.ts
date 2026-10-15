/**
 * Domain model shared by the planning engine, booking executor, payments layer
 * and product surface. These types are the contract between the three layers:
 *
 *   planner  -> TravelPlan (proposed items + budget envelopes)
 *   payments -> SpendAuthorization / PaymentReceipt (see PaymentGateway)
 *   booking  -> BookingResult (turns an approved PlanItem into a reservation)
 *
 * All money is integer US cents. Conversion to USDC (6 decimals) happens in the
 * payments layer, never here.
 */

export type Cents = number;

export const CATEGORIES = [
  "flights",
  "lodging",
  "food",
  "activities",
  "local_transport",
] as const;
export type Category = (typeof CATEGORIES)[number];

/** Categories the agent can actually book. The rest are spend estimates. */
export const BOOKABLE_CATEGORIES = ["flights", "lodging", "activities"] as const;
export type BookableCategory = (typeof BOOKABLE_CATEGORIES)[number];

export type LodgingStyle = "budget" | "standard" | "luxury";
export type Pace = "relaxed" | "balanced" | "packed";

/**
 * What kind of event a request is. This is a label for the product surface
 * (filters, grouping): the planner treats every type the same today and always
 * produces flights / lodging / activities / estimates.
 */
export const EVENT_TYPES = ["flight", "vacation", "shopping", "international", "local"] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export interface TravelerProfile {
  givenName: string;
  familyName: string;
  bornOn: string; // YYYY-MM-DD
  email: string;
  phone: string; // E.164
  gender?: "m" | "f";
  title?: "mr" | "ms" | "mrs" | "miss" | "dr";
}

export interface TripPreferences {
  lodgingStyle: LodgingStyle;
  pace: Pace;
  /** Free-form interests, e.g. ["food", "museums", "hiking"]. */
  interests: string[];
  /** Things the plan must not include, e.g. ["red-eye flights", "hostels"]. */
  avoid?: string[];
  /** Natural-language notes passed straight to the planning agent. */
  notes?: string;
  /** Max flight stops each way. */
  maxStops?: number;
}

export interface TripRequest {
  /** IATA code of the departure city/airport, e.g. "JFK". Omit if no flight needed. */
  origin?: string;
  /** IATA code of the destination, e.g. "LIS". */
  destination: string;
  destinationName?: string;
  startDate: string; // YYYY-MM-DD (arrival / check-in)
  endDate: string; // YYYY-MM-DD (departure / check-out)
  travelers: number;
  budgetCents: Cents;
  preferences: TripPreferences;
  travelerProfiles?: TravelerProfile[];
  /** Optional label used by the app to filter and group events. */
  eventType?: EventType;
}

// ---------------------------------------------------------------------------
// Offers (search results)
// ---------------------------------------------------------------------------

interface OfferBase {
  id: string;
  supplier: string;
  /** Supplier's own id for this offer (used when booking). */
  supplierRef: string;
  title: string;
  /** Total price for the whole party, in cents. */
  priceCents: Cents;
  currency: "USD";
  expiresAt?: string;
}

export interface FlightOffer extends OfferBase {
  category: "flights";
  carrier: string;
  stops: number;
  durationMinutes: number;
  outboundDepartAt: string;
  returnDepartAt?: string;
  redEye: boolean;
  refundable: boolean;
}

export interface HotelOffer extends OfferBase {
  category: "lodging";
  style: LodgingStyle;
  rating: number; // 0-5
  /** Distance from the city center / points of interest, km. */
  distanceKm: number;
  neighborhood: string;
  nights: number;
  freeCancellation: boolean;
  amenities: string[];
}

export interface ActivityOffer extends OfferBase {
  category: "activities";
  tags: string[];
  rating: number; // 0-5
  durationHours: number;
  /** Activities available on these dates only (YYYY-MM-DD). Empty = any day. */
  availableDates: string[];
}

export type Offer = FlightOffer | HotelOffer | ActivityOffer;

/** Per-person-per-day cost reference for non-bookable categories. */
export interface DailyCostIndex {
  destination: string;
  foodPerPersonPerDayCents: Record<LodgingStyle, Cents>;
  localTransportPerPersonPerDayCents: Cents;
}

// ---------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------

export interface BudgetEnvelope {
  category: Category;
  /** What the allocator set aside for this category. */
  allocatedCents: Cents;
  /** What the current plan spends in this category. */
  plannedCents: Cents;
  /** What has actually been paid (booked items). */
  committedCents: Cents;
}

export type PlanItemStatus =
  | "proposed"
  | "approved"
  | "booking"
  | "booked"
  | "failed"
  | "cancelled";

export interface PlanItem {
  id: string;
  category: Category;
  kind: "booking" | "estimate";
  title: string;
  priceCents: Cents;
  status: PlanItemStatus;
  /** Present for bookable items. */
  offer?: Offer;
  /** Date this item applies to (activities), YYYY-MM-DD. */
  date?: string;
  /** Why the planner picked this, in one or two sentences. */
  rationale: string;
  /** Next-best offers in the same slot, used for fast rebooking. */
  alternativeOfferIds: string[];
  /** Set once booked. */
  booking?: BookingRecord;
  /** Pinned items are never swapped out by the replanner. */
  pinned?: boolean;
}

export interface TravelPlan {
  id: string;
  tripId: string;
  version: number;
  createdAt: string;
  request: TripRequest;
  envelopes: BudgetEnvelope[];
  items: PlanItem[];
  totalCents: Cents;
  /** Unallocated contingency kept back for price swings and rebooking. */
  bufferCents: Cents;
  summary: string;
  warnings: string[];
  /** Offers that failed or were removed; never proposed again for this trip. */
  excludedOfferIds: string[];
  /** Who produced this version. */
  source: "optimizer" | "agent" | "replanner";
}

// ---------------------------------------------------------------------------
// Replanning
// ---------------------------------------------------------------------------

export type ReplanTrigger =
  | { type: "price_change"; itemId: string; newPriceCents: Cents }
  | { type: "booking_failed"; itemId: string; reason: string }
  | { type: "offer_unavailable"; offerId: string }
  | { type: "budget_change"; newBudgetCents: Cents }
  | { type: "remove_item"; itemId: string }
  | { type: "pin_item"; itemId: string }
  | { type: "preferences_change"; preferences: Partial<TripPreferences> };

export interface PlanChange {
  kind: "added" | "removed" | "swapped" | "repriced" | "rebalanced";
  itemId?: string;
  category?: Category;
  fromTitle?: string;
  toTitle?: string;
  deltaCents: Cents;
  reason: string;
}

export interface ReplanResult {
  plan: TravelPlan;
  changes: PlanChange[];
  /** True when the user must re-approve because spend went up or items changed. */
  requiresApproval: boolean;
}

// ---------------------------------------------------------------------------
// Payments contract (implemented by the payments & wallet layer)
// ---------------------------------------------------------------------------

export interface SpendRequest {
  tripId: string;
  itemId: string;
  category: Category;
  merchant: string;
  amountCents: Cents;
  description: string;
  idempotencyKey: string;
}

export type SpendAuthorizationStatus = "authorized" | "pending_user" | "rejected";

export interface SpendAuthorization {
  id: string;
  status: SpendAuthorizationStatus;
  amountCents: Cents;
  /** Which spending rule rejected or escalated the request. */
  reason?: string;
}

export interface PaymentReceipt {
  id: string;
  authorizationId: string;
  amountCents: Cents;
  /** On-chain transaction signature (Solana) or sandbox reference. */
  txRef: string;
  settledAt: string;
}

/**
 * Two-phase payment API. The booking executor authorizes before calling the
 * supplier, captures after the supplier confirms, and voids on failure so a
 * failed booking never moves money.
 *
 * Idempotency requirements (the executor retries and resumes):
 * - authorize() with an idempotencyKey already seen returns the same authorization
 *   (unless it was voided or rejected).
 * - capture() on an already-captured authorization returns the original receipt;
 *   it must not throw, or the executor will cancel the supplier booking.
 */
export interface PaymentGateway {
  authorize(req: SpendRequest): Promise<SpendAuthorization>;
  capture(authorizationId: string, finalAmountCents: Cents): Promise<PaymentReceipt>;
  void(authorizationId: string): Promise<void>;
  refund(receiptId: string, amountCents: Cents): Promise<PaymentReceipt>;
}

// ---------------------------------------------------------------------------
// Booking
// ---------------------------------------------------------------------------

export interface BookingRecord {
  supplier: string;
  confirmationCode: string;
  supplierOrderId: string;
  pricePaidCents: Cents;
  paymentReceiptId?: string;
  bookedAt: string;
}

export type BookingOutcome =
  | { status: "booked"; itemId: string; record: BookingRecord }
  | { status: "price_changed"; itemId: string; quotedCents: Cents; approvedCents: Cents }
  | { status: "unavailable"; itemId: string; reason: string }
  | { status: "payment_rejected"; itemId: string; reason: string }
  | { status: "awaiting_user"; itemId: string; authorizationId: string }
  | { status: "failed"; itemId: string; reason: string };
