import {
  formatUsd,
  type Cents,
  type Offer,
  type PlanChange,
  type PlanItem,
  type ReplanResult,
  type ReplanTrigger,
  type TravelPlan,
} from "@solagent/shared";
import {
  buildPlan,
  createContext,
  optimize,
  type OptimizeOptions,
  type PlanningContext,
  type Selection,
} from "./optimizer.ts";
import type { CandidateSet } from "./providers/types.ts";

/**
 * Continuous replanning.
 *
 * Policy:
 * - Booked, in-flight (booking) and approved items are never touched; neither
 *   are items the user pinned. Only "proposed" items are fair game.
 * - Small price moves are absorbed by the buffer instead of reshuffling the plan
 *   (minimize churn: the user already reviewed this plan).
 * - Failures repair just the affected slot first; a full re-optimization of the
 *   unlocked items only happens if the targeted repair doesn't fit the budget,
 *   or when the user changes the budget/preferences.
 */

export interface ReplanOptions extends OptimizeOptions {
  /** Price increases up to this fraction are absorbed if the buffer allows. */
  absorbPct?: number;
  /** Increases at or below this many cents are always absorbed (if affordable). */
  absorbCents?: Cents;
}

const LOCKED_STATUSES = new Set<PlanItem["status"]>(["booked", "booking", "approved"]);

export function isLocked(item: PlanItem): boolean {
  return item.kind === "booking" && (LOCKED_STATUSES.has(item.status) || Boolean(item.pinned));
}

/** Decide whether an observed price move is big enough to act on. */
export function isSignificantPriceChange(oldCents: Cents, newCents: Cents, pct = 0.03, minCents = 1000): boolean {
  const delta = Math.abs(newCents - oldCents);
  return delta >= minCents || delta >= oldCents * pct;
}

/** Items that stay put while the rest of the plan is re-optimized. */
function lockedItems(plan: TravelPlan, extra: (i: PlanItem) => boolean = () => false): PlanItem[] {
  return plan.items.filter((i) => i.kind === "booking" && (isLocked(i) || extra(i)));
}

function excludedFrom(plan: TravelPlan): string[] {
  const failedNow = plan.items.filter((i) => i.status === "failed" && i.offer).map((i) => i.offer!.id);
  return [...new Set([...(plan.excludedOfferIds ?? []), ...failedNow])];
}

function withRepricedOffer(candidates: CandidateSet, offerId: string, priceCents: Cents): CandidateSet {
  const reprice = <T extends Offer>(xs: T[]) => xs.map((o) => (o.id === offerId ? { ...o, priceCents } : o));
  return {
    ...candidates,
    flights: reprice(candidates.flights),
    hotels: reprice(candidates.hotels),
    activities: reprice(candidates.activities),
  };
}

export function diffPlans(prev: TravelPlan, next: TravelPlan, reason: string): PlanChange[] {
  const changes: PlanChange[] = [];
  const key = (i: PlanItem) => (i.kind === "estimate" ? i.id : `${i.category}:${i.offer?.id}:${i.date ?? ""}`);
  const prevKeys = new Map(prev.items.map((i) => [key(i), i]));
  const nextKeys = new Map(next.items.map((i) => [key(i), i]));
  const removed = prev.items.filter((i) => !nextKeys.has(key(i)));
  const added = next.items.filter((i) => !prevKeys.has(key(i)));

  // Pair removals with additions in single-slot categories as swaps.
  for (const category of ["flights", "lodging"] as const) {
    const r = removed.find((i) => i.category === category);
    const a = added.find((i) => i.category === category);
    if (r && a) {
      changes.push({
        kind: "swapped",
        itemId: a.id,
        category,
        fromTitle: r.title,
        toTitle: a.title,
        deltaCents: a.priceCents - r.priceCents,
        reason,
      });
      removed.splice(removed.indexOf(r), 1);
      added.splice(added.indexOf(a), 1);
    }
  }
  for (const r of removed) {
    changes.push({ kind: "removed", itemId: r.id, category: r.category, fromTitle: r.title, deltaCents: -r.priceCents, reason });
  }
  for (const a of added) {
    changes.push({ kind: "added", itemId: a.id, category: a.category, toTitle: a.title, deltaCents: a.priceCents, reason });
  }
  for (const n of next.items) {
    const p = prevKeys.get(key(n));
    if (p && p.priceCents !== n.priceCents) {
      changes.push({
        kind: "repriced",
        itemId: n.id,
        category: n.category,
        fromTitle: p.title,
        toTitle: n.title,
        deltaCents: n.priceCents - p.priceCents,
        reason,
      });
    }
  }
  return changes;
}

export class Replanner {
  constructor(private readonly opts: ReplanOptions = {}) {}

  replan(plan: TravelPlan, trigger: ReplanTrigger, candidates: CandidateSet): ReplanResult {
    switch (trigger.type) {
      case "price_change":
        return this.onPriceChange(plan, trigger.itemId, trigger.newPriceCents, candidates);
      case "booking_failed":
        return this.onSlotLost(plan, trigger.itemId, `Booking failed: ${trigger.reason}`, candidates, true);
      case "offer_unavailable": {
        const item = plan.items.find((i) => i.offer?.id === trigger.offerId && !isLocked(i));
        if (!item) return { plan, changes: [], requiresApproval: false };
        return this.onSlotLost(plan, item.id, "Offer no longer available", candidates, true);
      }
      case "remove_item":
        return this.onSlotLost(plan, trigger.itemId, "Removed by user", candidates, false);
      case "pin_item": {
        const items = plan.items.map((i) => (i.id === trigger.itemId ? { ...i, pinned: true } : i));
        return { plan: { ...plan, items }, changes: [], requiresApproval: false };
      }
      case "budget_change": {
        const request = { ...plan.request, budgetCents: trigger.newBudgetCents };
        return this.full(plan, request, candidates, `Budget changed to ${formatUsd(trigger.newBudgetCents)}`);
      }
      case "preferences_change": {
        const request = { ...plan.request, preferences: { ...plan.request.preferences, ...trigger.preferences } };
        return this.full(plan, request, candidates, "Preferences updated");
      }
    }
  }

  private onPriceChange(plan: TravelPlan, itemId: string, newPriceCents: Cents, candidates: CandidateSet): ReplanResult {
    const item = plan.items.find((i) => i.id === itemId);
    if (!item?.offer || item.status === "booked") return { plan, changes: [], requiresApproval: false };
    const delta = newPriceCents - item.priceCents;
    const reason = `Price of "${item.title}" moved ${delta >= 0 ? "+" : ""}${formatUsd(delta)}`;
    const repriced = withRepricedOffer(candidates, item.offer.id, newPriceCents);

    // Cheaper, or a small increase the buffer can absorb: keep the plan, just reprice.
    const absorbable =
      delta <= 0 ||
      ((delta <= (this.opts.absorbCents ?? 2500) || delta <= item.priceCents * (this.opts.absorbPct ?? 0.08)) &&
        delta <= plan.bufferCents);
    if (absorbable) {
      const updated: PlanItem = {
        ...item,
        priceCents: newPriceCents,
        offer: { ...item.offer, priceCents: newPriceCents },
        // A higher price needs fresh sign-off; a lower one is covered by the old approval.
        status: delta > 0 ? "proposed" : item.status,
      };
      // Keep every bookable item exactly as it is, with the one item repriced.
      const keep = plan.items
        .filter((i) => i.kind === "booking" && i.status !== "failed" && i.status !== "cancelled")
        .map((i) => (i.id === itemId ? updated : i));
      const ctx = createContext(plan.request, repriced, { locked: keep, excludedOfferIds: excludedFrom(plan) });
      const next = this.rebuild(plan, ctx, { activities: [] }, reason);
      return { plan: next, changes: diffPlans(plan, next, reason), requiresApproval: delta > 0 };
    }
    // Too big to absorb: re-optimize this slot with the new price in the market.
    return this.repairSlot(plan, item, reason, repriced, true);
  }

  private onSlotLost(
    plan: TravelPlan,
    itemId: string,
    reason: string,
    candidates: CandidateSet,
    exclude: boolean,
  ): ReplanResult {
    const item = plan.items.find((i) => i.id === itemId);
    if (!item || item.kind !== "booking" || item.status === "booked") return { plan, changes: [], requiresApproval: false };
    const marked: TravelPlan = {
      ...plan,
      items: plan.items.map((i) => (i.id === itemId ? { ...i, status: exclude ? "failed" : "cancelled" } : i)),
    };
    // A failed activity gets one substitute; one the user removed doesn't.
    const result = this.repairSlot(marked, item, reason, candidates, exclude, exclude ? [] : [item.offer!.id]);
    // Keep the failed item out of the new plan but don't drop it silently from the diff.
    return { ...result, changes: diffPlans(plan, result.plan, reason) };
  }

  /**
   * Re-fill one slot while keeping every other item. If that can't fit, fall
   * back to re-optimizing all unlocked items.
   */
  private repairSlot(
    plan: TravelPlan,
    item: PlanItem,
    reason: string,
    candidates: CandidateSet,
    substituteActivity: boolean,
    extraExcluded: string[] = [],
  ): ReplanResult {
    const keepOthers = lockedItems(plan, (i) => i.id !== item.id && i.status === "proposed");
    const excluded = [...excludedFrom(plan), ...extraExcluded];
    const ctx = createContext(plan.request, candidates, { locked: keepOthers, excludedOfferIds: excluded });
    const sel = optimize(ctx, this.opts);
    // Activities are optional: refill at most the one lost slot, never more.
    if (item.category === "activities") sel.activities = sel.activities.slice(0, substituteActivity ? 1 : 0);
    else sel.activities = [];
    let next = this.rebuild(plan, ctx, sel, reason);

    if (next.totalCents > plan.request.budgetCents) {
      const lockedOnly = lockedItems(plan);
      const fullCtx = createContext(plan.request, candidates, { locked: lockedOnly, excludedOfferIds: excluded });
      next = this.rebuild(plan, fullCtx, optimize(fullCtx, this.opts), `${reason} (full re-optimization)`);
    }
    const changes = diffPlans(plan, next, reason);
    return { plan: next, changes, requiresApproval: changes.some((c) => c.kind !== "removed") };
  }

  private full(plan: TravelPlan, request: TravelPlan["request"], candidates: CandidateSet, reason: string): ReplanResult {
    const ctx = createContext(request, candidates, { locked: lockedItems(plan), excludedOfferIds: excludedFrom(plan) });
    const next = this.rebuild(plan, ctx, optimize(ctx, this.opts), reason);
    const changes = diffPlans(plan, next, reason);
    return { plan: next, changes, requiresApproval: changes.length > 0 };
  }

  private rebuild(plan: TravelPlan, ctx: PlanningContext, sel: Selection & { notes?: string[] }, reason: string): TravelPlan {
    return buildPlan(ctx, sel, {
      source: "replanner",
      tripId: plan.tripId,
      version: plan.version + 1,
      previous: plan,
      warnings: sel.notes,
      summaryPrefix: reason,
    });
  }
}
