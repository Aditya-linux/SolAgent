import { EventEmitter } from "node:events";
import {
  formatUsd,
  newId,
  type BookingOutcome,
  type Category,
  type Cents,
  type PaymentGateway,
  type PlanChange,
  type PlanItem,
  type ReplanTrigger,
  type SpendAuthorization,
  type TravelPlan,
  type TripRequest,
} from "@solagent/shared";
import {
  isSignificantPriceChange,
  refreshPlanTotals,
  type CandidateSet,
  type PlanMode,
  type TripPlanner,
} from "@solagent/planner";
import type { BookingExecutor } from "@solagent/booking";
import type { SpendingRules } from "@solagent/booking";

/**
 * Trip lifecycle orchestration: the glue between the planner (A), the payments
 * layer (B) and booking execution (C).
 *
 *   createTrip  -> planner proposes a plan; spending rules are derived from it
 *   approveItem -> executor books it (re-quote, authorize, book, capture)
 *   outcomes    -> price changes / failures feed back into the replanner
 *   refreshPrices / replan -> continuous replanning
 *
 * State is in memory for the MVP; swap TripStore for a database later.
 */

export type TripEventType =
  | "plan_created"
  | "plan_updated"
  | "item_approved"
  | "booking_started"
  | "booked"
  | "signature_required"
  | "payment_rejected"
  | "booking_failed"
  | "price_changed"
  | "cancelled";

export interface TripEvent {
  id: string;
  tripId: string;
  at: string;
  type: TripEventType;
  message: string;
  itemId?: string;
  changes?: PlanChange[];
}

export interface Trip {
  id: string;
  createdAt: string;
  plan: TravelPlan;
  /** Market snapshot the replanner works from. */
  candidates: CandidateSet;
  /** Prior plan versions, newest last. */
  history: { version: number; summary: string; totalCents: Cents; trigger?: ReplanTrigger }[];
  events: TripEvent[];
  /** itemId -> payment authorization waiting for the user's signature. */
  pendingSignatures: Record<string, string>;
  agentLog?: { tool: string; input: unknown }[];
}

/** Payments layer, plus the optional hooks the sandbox (and later Solana) layer exposes. */
export type TripPayments = PaymentGateway & {
  setRules?(tripId: string, rules: SpendingRules): void;
  approvePending?(authorizationId: string): Promise<SpendAuthorization>;
};

export interface TripServiceOptions {
  /** Spends above this need an explicit user signature. Default $500. */
  autoApproveUpToCents?: Cents;
  merchantAllowlist?: string[];
}

export class TripService {
  private readonly trips = new Map<string, Trip>();
  readonly events = new EventEmitter();

  constructor(
    private readonly planner: TripPlanner,
    private readonly executor: BookingExecutor,
    private readonly payments: TripPayments,
    private readonly opts: TripServiceOptions = {},
  ) {}

  list(): Trip[] {
    return [...this.trips.values()];
  }

  get(tripId: string): Trip {
    const trip = this.trips.get(tripId);
    if (!trip) throw new NotFoundError(`Trip ${tripId} not found`);
    return trip;
  }

  async createTrip(request: TripRequest, mode?: PlanMode): Promise<Trip> {
    const id = newId("trip");
    const outcome = await this.planner.plan(request, { tripId: id, mode });
    const trip: Trip = {
      id,
      createdAt: new Date().toISOString(),
      plan: outcome.plan,
      candidates: outcome.candidates,
      history: [],
      events: [],
      pendingSignatures: {},
      agentLog: outcome.agentLog,
    };
    this.trips.set(id, trip);
    this.syncSpendingRules(trip);
    this.emit(trip, "plan_created", outcome.plan.summary);
    return trip;
  }

  // --- approvals & booking ---------------------------------------------------

  async approveItem(tripId: string, itemId: string): Promise<BookingOutcome | undefined> {
    const trip = this.get(tripId);
    const item = this.item(trip, itemId);
    if (item.kind !== "booking") throw new BadRequestError("Estimates don't need approval");
    if (item.status === "booked" || item.status === "booking") return undefined;
    this.updateItem(trip, itemId, { status: "approved" });
    this.emit(trip, "item_approved", `Approved ${item.title} at ${formatUsd(item.priceCents)}`, itemId);
    return this.book(trip, itemId);
  }

  async approveAll(tripId: string): Promise<BookingOutcome[]> {
    const trip = this.get(tripId);
    const outcomes: BookingOutcome[] = [];
    // Book the big-ticket, hardest-to-replace items first.
    const order: Category[] = ["flights", "lodging", "activities"];
    const pending = trip.plan.items
      .filter((i) => i.kind === "booking" && (i.status === "proposed" || i.status === "approved"))
      .sort((a, b) => order.indexOf(a.category) - order.indexOf(b.category));
    for (const item of pending) {
      // The plan may have been replanned by an earlier failure; skip items that vanished.
      if (!this.get(tripId).plan.items.some((i) => i.id === item.id)) continue;
      const outcome = await this.approveItem(tripId, item.id);
      if (outcome) outcomes.push(outcome);
    }
    return outcomes;
  }

  /** The user signed a payment that was above the auto-approve limit. */
  async signPayment(tripId: string, itemId: string): Promise<BookingOutcome> {
    const trip = this.get(tripId);
    const authId = trip.pendingSignatures[itemId];
    if (!authId) throw new BadRequestError(`No payment awaiting signature for item ${itemId}`);
    if (!this.payments.approvePending) throw new BadRequestError("Payments layer does not support in-app signing");
    await this.payments.approvePending(authId);
    delete trip.pendingSignatures[itemId];
    return this.book(trip, itemId);
  }

  async cancelItem(tripId: string, itemId: string): Promise<{ refundCents: Cents }> {
    const trip = this.get(tripId);
    const item = this.item(trip, itemId);
    let refundCents = 0;
    if (item.status === "booked") {
      ({ refundCents } = await this.executor.cancel(item));
      this.updateItem(trip, itemId, { status: "cancelled" });
      this.emit(trip, "cancelled", `Cancelled ${item.title}; refunded ${formatUsd(refundCents)}`, itemId);
    }
    // Let the planner decide what (if anything) replaces it.
    await this.replan(tripId, { type: "remove_item", itemId });
    return { refundCents };
  }

  private async book(trip: Trip, itemId: string): Promise<BookingOutcome> {
    const item = this.item(trip, itemId);
    this.updateItem(trip, itemId, { status: "booking" });
    this.emit(trip, "booking_started", `Booking ${item.title}…`, itemId);
    const outcome = await this.executor.execute(
      { tripId: trip.id, travelers: trip.plan.request.travelers, profiles: trip.plan.request.travelerProfiles },
      item,
    );

    switch (outcome.status) {
      case "booked":
        this.updateItem(trip, itemId, { status: "booked", booking: outcome.record });
        this.emit(
          trip,
          "booked",
          `Booked ${item.title} — confirmation ${outcome.record.confirmationCode}, paid ${formatUsd(outcome.record.pricePaidCents)}`,
          itemId,
        );
        break;
      case "awaiting_user":
        this.updateItem(trip, itemId, { status: "approved" });
        trip.pendingSignatures[itemId] = outcome.authorizationId;
        this.emit(trip, "signature_required", `Sign to pay ${formatUsd(item.priceCents)} for ${item.title}`, itemId);
        break;
      case "payment_rejected":
        this.updateItem(trip, itemId, { status: "proposed" });
        this.emit(trip, "payment_rejected", `Payment blocked by spending rules: ${outcome.reason}`, itemId);
        break;
      case "price_changed":
        this.updateItem(trip, itemId, { status: "proposed" });
        this.emit(
          trip,
          "price_changed",
          `${item.title} now costs ${formatUsd(outcome.quotedCents)} (approved ${formatUsd(outcome.approvedCents)}); replanning`,
          itemId,
        );
        await this.replan(trip.id, { type: "price_change", itemId, newPriceCents: outcome.quotedCents });
        break;
      case "unavailable":
      case "failed":
        this.emit(trip, "booking_failed", `Could not book ${item.title}: ${outcome.reason}; replanning`, itemId);
        await this.replan(trip.id, { type: "booking_failed", itemId, reason: outcome.reason });
        break;
    }
    return outcome;
  }

  // --- replanning --------------------------------------------------------------

  async replan(tripId: string, trigger: ReplanTrigger): Promise<{ plan: TravelPlan; changes: PlanChange[]; requiresApproval: boolean }> {
    const trip = this.get(tripId);
    if (trigger.type === "budget_change" || trigger.type === "preferences_change") {
      // The market may have moved since the original search.
      const request =
        trigger.type === "budget_change"
          ? { ...trip.plan.request, budgetCents: trigger.newBudgetCents }
          : { ...trip.plan.request, preferences: { ...trip.plan.request.preferences, ...trigger.preferences } };
      trip.candidates = await this.planner.searchCandidates(request);
    }
    const result = this.planner.replan(trip.plan, trigger, trip.candidates);
    if (result.plan !== trip.plan) {
      trip.history.push({
        version: trip.plan.version,
        summary: trip.plan.summary,
        totalCents: trip.plan.totalCents,
        trigger,
      });
      trip.plan = result.plan;
      this.syncSpendingRules(trip);
      const summary = result.changes.length
        ? result.changes.map(describeChange).join("; ")
        : "No changes needed";
      this.emit(trip, "plan_updated", `Plan v${result.plan.version}: ${summary}`, undefined, result.changes);
    }
    return result;
  }

  /**
   * Re-quote every unbooked item and replan on significant moves. Call on a
   * timer for continuous replanning, or from the UI's "refresh prices".
   */
  async refreshPrices(tripId: string): Promise<PlanChange[]> {
    const trip = this.get(tripId);
    const changes: PlanChange[] = [];
    const open = trip.plan.items.filter((i) => i.kind === "booking" && (i.status === "proposed" || i.status === "approved"));
    for (const item of open) {
      if (!this.get(tripId).plan.items.some((i) => i.id === item.id)) continue;
      const quote = await this.executor.quote(item).catch(() => undefined);
      if (!quote) continue;
      if (!quote.available) {
        changes.push(...(await this.replan(tripId, { type: "booking_failed", itemId: item.id, reason: quote.reason ?? "Unavailable" })).changes);
      } else if (isSignificantPriceChange(item.priceCents, quote.priceCents)) {
        changes.push(...(await this.replan(tripId, { type: "price_change", itemId: item.id, newPriceCents: quote.priceCents })).changes);
      }
    }
    return changes;
  }

  // --- helpers -----------------------------------------------------------------

  /** Envelopes become the payments layer's per-category caps for this trip. */
  private syncSpendingRules(trip: Trip): void {
    this.payments.setRules?.(trip.id, {
      categoryCapsCents: Object.fromEntries(
        trip.plan.envelopes.map((e) => [e.category, this.executor.maxAcceptable(e.allocatedCents)]),
      ),
      autoApproveUpToCents: this.opts.autoApproveUpToCents ?? 50_000,
      merchantAllowlist: this.opts.merchantAllowlist,
    });
  }

  private item(trip: Trip, itemId: string): PlanItem {
    const item = trip.plan.items.find((i) => i.id === itemId);
    if (!item) throw new NotFoundError(`Item ${itemId} not in the current plan`);
    return item;
  }

  private updateItem(trip: Trip, itemId: string, patch: Partial<PlanItem>): void {
    trip.plan = refreshPlanTotals({
      ...trip.plan,
      items: trip.plan.items.map((i) => (i.id === itemId ? { ...i, ...patch } : i)),
    });
  }

  private emit(trip: Trip, type: TripEventType, message: string, itemId?: string, changes?: PlanChange[]): void {
    const event: TripEvent = { id: newId("evt"), tripId: trip.id, at: new Date().toISOString(), type, message, itemId, changes };
    trip.events.push(event);
    this.events.emit("event", event);
  }
}

function describeChange(c: PlanChange): string {
  const delta = `${c.deltaCents >= 0 ? "+" : ""}${formatUsd(c.deltaCents)}`;
  switch (c.kind) {
    case "swapped":
      return `${c.category}: ${c.fromTitle} → ${c.toTitle} (${delta})`;
    case "added":
      return `added ${c.toTitle} (${delta})`;
    case "removed":
      return `removed ${c.fromTitle}`;
    case "repriced":
      return `${c.toTitle} repriced (${delta})`;
    case "rebalanced":
      return `rebalanced ${c.category} (${delta})`;
  }
}

export class NotFoundError extends Error {}
export class BadRequestError extends Error {}
