import {
  CATEGORIES,
  nightsBetween,
  sum,
  tripDays,
  type BudgetEnvelope,
  type Category,
  type Cents,
  type DailyCostIndex,
  type TripRequest,
} from "@solagent/shared";

/**
 * Budget allocation: split the total budget into per-category envelopes.
 *
 * 1. Hold back a contingency buffer (absorbs price swings and rebooking).
 * 2. Food and local transport are daily estimates from the destination cost index.
 * 3. The discretionary rest is split across flights / lodging / activities by
 *    preference-weighted shares, with "water-filling" so every category gets at
 *    least its market floor (the cheapest real offer) when one is known.
 *
 * The envelopes double as per-category spending caps for the payments layer.
 */

export interface AllocationOptions {
  /** Fraction of the budget held back as contingency. */
  bufferPct?: number;
  /** Cheapest observed price per bookable category, from search results. */
  floors?: Partial<Record<"flights" | "lodging" | "activities", Cents>>;
}

export interface Allocation {
  envelopes: BudgetEnvelope[];
  bufferCents: Cents;
  estimates: { foodCents: Cents; localTransportCents: Cents };
  /** Positive when even the cheapest option in every category doesn't fit. */
  shortfallCents: Cents;
  warnings: string[];
}

type Discretionary = "flights" | "lodging" | "activities";

export const DEFAULT_BUFFER_PCT = 0.05;

export function estimateDailyCosts(req: TripRequest, index: DailyCostIndex) {
  const days = tripDays(req.startDate, req.endDate).length;
  return {
    foodCents: index.foodPerPersonPerDayCents[req.preferences.lodgingStyle] * days * req.travelers,
    localTransportCents: index.localTransportPerPersonPerDayCents * days * req.travelers,
  };
}

export function discretionaryShares(req: TripRequest): Record<Discretionary, number> {
  const p = req.preferences;
  const shares: Record<Discretionary, number> = {
    flights: req.origin ? 0.4 : 0,
    lodging: 0.42,
    activities: 0.18,
  };
  shares.lodging += { budget: -0.1, standard: 0, luxury: 0.12 }[p.lodgingStyle];
  shares.activities += { relaxed: -0.06, balanced: 0, packed: 0.1 }[p.pace];
  shares.activities += Math.min(0.08, 0.02 * p.interests.length);
  // Longer stays shift weight from the (fixed-cost) flight to lodging.
  const nights = nightsBetween(req.startDate, req.endDate);
  if (req.origin && nights > 7) {
    const shift = Math.min(0.1, 0.01 * (nights - 7));
    shares.flights -= shift;
    shares.lodging += shift;
  }
  const total = sum(Object.values(shares));
  return {
    flights: shares.flights / total,
    lodging: shares.lodging / total,
    activities: shares.activities / total,
  };
}

/** Split `amount` by `shares`, raising any category below its floor to the floor. */
export function waterFill(
  amount: Cents,
  shares: Record<Discretionary, number>,
  floors: Partial<Record<Discretionary, Cents>>,
): Record<Discretionary, Cents> {
  const result: Record<Discretionary, Cents> = { flights: 0, lodging: 0, activities: 0 };
  let free = (Object.keys(shares) as Discretionary[]).filter((c) => shares[c] > 0);
  let remaining = amount;
  // Pin categories whose proportional share is under their floor, then re-split.
  for (;;) {
    const shareSum = sum(free.map((c) => shares[c]));
    const pinned = free.filter((c) => (floors[c] ?? 0) > (remaining * shares[c]) / shareSum);
    if (pinned.length === 0 || shareSum === 0) break;
    for (const c of pinned) {
      result[c] = floors[c] ?? 0;
      remaining -= result[c];
    }
    free = free.filter((c) => !pinned.includes(c));
  }
  const shareSum = sum(free.map((c) => shares[c]));
  for (const c of free) result[c] = Math.max(0, Math.floor((remaining * shares[c]) / shareSum));
  return result;
}

/**
 * Rebalance after real prices come in: any category planned above its envelope
 * borrows from categories with slack (largest slack first), then from the
 * buffer. Slack that isn't borrowed stays in its envelope as headroom for price
 * changes in that category. Returns the new buffer (negative = over budget).
 */
export function rebalanceEnvelopes(
  envelopes: BudgetEnvelope[],
  budgetCents: Cents,
): { envelopes: BudgetEnvelope[]; bufferCents: Cents; moves: { from: Category | "buffer"; to: Category; cents: Cents }[] } {
  const next = envelopes.map((e) => ({ ...e }));
  const moves: { from: Category | "buffer"; to: Category; cents: Cents }[] = [];
  for (const over of next.filter((e) => e.plannedCents > e.allocatedCents)) {
    let need = over.plannedCents - over.allocatedCents;
    const donors = next
      .filter((e) => e !== over && e.allocatedCents > e.plannedCents)
      .sort((a, b) => b.allocatedCents - b.plannedCents - (a.allocatedCents - a.plannedCents));
    for (const donor of donors) {
      if (need <= 0) break;
      const take = Math.min(need, donor.allocatedCents - donor.plannedCents);
      donor.allocatedCents -= take;
      over.allocatedCents += take;
      need -= take;
      moves.push({ from: donor.category, to: over.category, cents: take });
    }
    if (need > 0) {
      over.allocatedCents += need;
      moves.push({ from: "buffer", to: over.category, cents: need });
    }
  }
  const bufferCents = budgetCents - sum(next.map((e) => e.allocatedCents));
  return { envelopes: next, bufferCents, moves };
}

export function allocateBudget(
  req: TripRequest,
  index: DailyCostIndex,
  opts: AllocationOptions = {},
): Allocation {
  const warnings: string[] = [];
  const estimates = estimateDailyCosts(req, index);
  let bufferCents = Math.round(req.budgetCents * (opts.bufferPct ?? DEFAULT_BUFFER_PCT));
  let discretionary = req.budgetCents - bufferCents - estimates.foodCents - estimates.localTransportCents;

  const floors = opts.floors ?? {};
  const requiredFloor = (floors.flights ?? 0) + (floors.lodging ?? 0);
  let shortfallCents = 0;
  if (requiredFloor > discretionary) {
    // Eat into the buffer before declaring the trip unaffordable.
    const fromBuffer = Math.min(bufferCents, requiredFloor - discretionary);
    bufferCents -= fromBuffer;
    discretionary += fromBuffer;
    if (fromBuffer > 0) warnings.push("Budget is tight: contingency buffer reduced to fit flights and lodging.");
    shortfallCents = Math.max(0, requiredFloor - discretionary);
    if (shortfallCents > 0) {
      warnings.push(
        `Budget is short by at least $${(shortfallCents / 100).toFixed(0)} for the cheapest flight + lodging.`,
      );
    }
  }

  const split = waterFill(Math.max(0, discretionary), discretionaryShares(req), floors);
  const allocated: Record<Category, Cents> = {
    ...split,
    food: estimates.foodCents,
    local_transport: estimates.localTransportCents,
  };
  return {
    envelopes: CATEGORIES.map((category) => ({
      category,
      allocatedCents: allocated[category],
      plannedCents: 0,
      committedCents: 0,
    })),
    bufferCents,
    estimates,
    shortfallCents,
    warnings,
  };
}
