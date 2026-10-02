import {
  CATEGORIES,
  formatUsd,
  newId,
  nightsBetween,
  sum,
  tripDays,
  type ActivityOffer,
  type Category,
  type Cents,
  type FlightOffer,
  type HotelOffer,
  type Offer,
  type PlanItem,
  type TravelPlan,
  type TripRequest,
} from "@solagent/shared";
import { allocateBudget, rebalanceEnvelopes, type Allocation } from "./allocator.ts";
import type { CandidateSet } from "./providers/types.ts";
import {
  activitiesPerDay,
  activityScore,
  categoryWeights,
  flightScore,
  hotelScore,
  interestMatch,
  isAvoided,
} from "./scoring.ts";

/** Which offers a plan uses. Both the optimizer and the LLM agent produce one. */
export interface Selection {
  flightId?: string;
  hotelId?: string;
  activities: { offerId: string; date: string }[];
}

export interface PlanningContext {
  request: TripRequest;
  candidates: CandidateSet;
  allocation: Allocation;
  /** Items the planner must keep as-is: booked, being booked, approved or pinned. */
  locked: PlanItem[];
  /** Offers that must not be used (sold out, failed, removed by the user). */
  excludedOfferIds: Set<string>;
}

export interface OptimizeOptions {
  /**
   * Minimum quality value (in $) an extra dollar of spend must buy. Higher =
   * thriftier plans that leave more budget unspent.
   */
  minValuePerDollar?: number;
}

const DEFAULT_MIN_VALUE_PER_DOLLAR = 0.3;
/** Each extra activity is worth a bit less than the one before. */
const ACTIVITY_DIMINISHING = 0.12;
const OVER_ENVELOPE_PENALTY = 1.5;

export function createContext(
  request: TripRequest,
  candidates: CandidateSet,
  opts: { locked?: PlanItem[]; excludedOfferIds?: Iterable<string>; bufferPct?: number } = {},
): PlanningContext {
  const excluded = new Set(opts.excludedOfferIds ?? []);
  const usable = <T extends Offer>(offers: T[]) =>
    offers.filter((o) => !excluded.has(o.id) && !isAvoided(o, request.preferences));
  const minPrice = (offers: Offer[]) =>
    offers.length ? Math.min(...offers.map((o) => o.priceCents)) : undefined;
  const lockedFlight = opts.locked?.find((i) => i.category === "flights");
  const lockedHotel = opts.locked?.find((i) => i.category === "lodging");
  const allocation = allocateBudget(request, candidates.costIndex, {
    bufferPct: opts.bufferPct,
    floors: {
      flights: request.origin ? lockedFlight?.priceCents ?? minPrice(usable(candidates.flights)) : undefined,
      lodging: lockedHotel?.priceCents ?? minPrice(usable(candidates.hotels)),
    },
  });
  return { request, candidates, allocation, locked: opts.locked ?? [], excludedOfferIds: excluded };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface Scored<T extends Offer> {
  offer: T;
  score: number;
}

function usableOffers<T extends Offer>(ctx: PlanningContext, offers: T[]): T[] {
  return offers.filter((o) => !ctx.excludedOfferIds.has(o.id) && !isAvoided(o, ctx.request.preferences));
}

function scoreAll(ctx: PlanningContext) {
  const prefs = ctx.request.preferences;
  const flights = usableOffers(ctx, ctx.candidates.flights);
  const fastest = flights.length ? Math.min(...flights.map((f) => f.durationMinutes)) : 0;
  return {
    flights: flights.map((offer) => ({ offer, score: flightScore(offer, prefs, fastest) })),
    hotels: usableOffers(ctx, ctx.candidates.hotels).map((offer) => ({ offer, score: hotelScore(offer, prefs) })),
    activities: usableOffers(ctx, ctx.candidates.activities).map((offer) => ({
      offer,
      score: activityScore(offer, prefs),
    })),
  };
}

/** Activity capacity per trip day (arrival/departure days hold one fewer). */
export function daySlots(req: TripRequest): Map<string, number> {
  const days = tripDays(req.startDate, req.endDate);
  const perDay = activitiesPerDay(req.preferences.pace);
  const slots = new Map<string, number>();
  days.forEach((d, i) => {
    const edge = days.length > 2 && (i === 0 || i === days.length - 1);
    slots.set(d, edge ? Math.max(0, perDay - 1) : perDay);
  });
  return slots;
}

function availableOn(a: ActivityOffer, date: string): boolean {
  return a.availableDates.length === 0 || a.availableDates.includes(date);
}

function cheapest<T extends Offer>(xs: Scored<T>[]): Scored<T> | undefined {
  return xs.reduce<Scored<T> | undefined>(
    (best, x) => (!best || x.offer.priceCents < best.offer.priceCents ? x : best),
    undefined,
  );
}

// ---------------------------------------------------------------------------
// Evaluation (used by the agent's tools and to validate any Selection)
// ---------------------------------------------------------------------------

export interface Evaluation {
  ok: boolean;
  errors: string[];
  warnings: string[];
  totalCents: Cents;
  byCategory: Record<Category, Cents>;
  remainingCents: Cents;
  /** Total quality value in $ (comparable across selections for the same trip). */
  valueUsd: number;
}

export function evaluateSelection(ctx: PlanningContext, sel: Selection): Evaluation {
  const req = ctx.request;
  const errors: string[] = [];
  const warnings: string[] = [];
  const scored = scoreAll(ctx);
  const weights = categoryWeights(req.preferences, ctx.candidates);
  const byCategory = Object.fromEntries(CATEGORIES.map((c) => [c, 0])) as Record<Category, Cents>;
  byCategory.food = ctx.allocation.estimates.foodCents;
  byCategory.local_transport = ctx.allocation.estimates.localTransportCents;
  let valueUsd = 0;

  for (const item of ctx.locked) byCategory[item.category] += item.priceCents;
  const lockedFlight = ctx.locked.some((i) => i.category === "flights");
  const lockedHotel = ctx.locked.some((i) => i.category === "lodging");

  if (req.origin && !lockedFlight) {
    const f = scored.flights.find((x) => x.offer.id === sel.flightId);
    if (!sel.flightId) errors.push("A flight is required (trip has an origin).");
    else if (!f) errors.push(`Flight ${sel.flightId} is unknown, excluded, or on the avoid list.`);
    else {
      byCategory.flights += f.offer.priceCents;
      valueUsd += weights.flights * f.score;
    }
  }
  if (!lockedHotel) {
    const h = scored.hotels.find((x) => x.offer.id === sel.hotelId);
    if (!sel.hotelId) errors.push("Lodging is required.");
    else if (!h) errors.push(`Hotel ${sel.hotelId} is unknown, excluded, or on the avoid list.`);
    else {
      byCategory.lodging += h.offer.priceCents;
      valueUsd += weights.lodging * h.score;
    }
  }

  const slots = daySlots(req);
  for (const item of ctx.locked) {
    if (item.category === "activities" && item.date) slots.set(item.date, (slots.get(item.date) ?? 0) - 1);
  }
  const seen = new Set(ctx.locked.map((i) => i.offer?.id));
  sel.activities.forEach((a, k) => {
    const s = scored.activities.find((x) => x.offer.id === a.offerId);
    if (!s) return errors.push(`Activity ${a.offerId} is unknown, excluded, or on the avoid list.`);
    if (seen.has(a.offerId)) return errors.push(`Activity ${a.offerId} is selected twice.`);
    seen.add(a.offerId);
    const free = slots.get(a.date);
    if (free === undefined) return errors.push(`${a.date} is outside the trip dates.`);
    if (!availableOn(s.offer, a.date)) return errors.push(`"${s.offer.title}" is not available on ${a.date}.`);
    if (free <= 0) return errors.push(`${a.date} has no free activity slot at this pace.`);
    slots.set(a.date, free - 1);
    byCategory.activities += s.offer.priceCents;
    valueUsd += (weights.activities * s.score) / (1 + ACTIVITY_DIMINISHING * k);
  });

  const totalCents = sum(Object.values(byCategory));
  const remainingCents = req.budgetCents - totalCents;
  if (remainingCents < 0) errors.push(`Over budget by ${formatUsd(-remainingCents)}.`);
  else if (remainingCents < ctx.allocation.bufferCents) {
    warnings.push(`Uses part of the contingency buffer (only ${formatUsd(remainingCents)} left).`);
  }
  return { ok: errors.length === 0, errors, warnings, totalCents, byCategory, remainingCents, valueUsd };
}

// ---------------------------------------------------------------------------
// Optimization
// ---------------------------------------------------------------------------

interface Move {
  apply: () => void;
  deltaCents: Cents;
  deltaValue: number;
  category: "flights" | "lodging" | "activities";
}

/**
 * Greedy marginal-value optimizer.
 *
 * Start from the cheapest valid plan, then repeatedly apply the single change
 * (swap flight, swap hotel, add activity) with the best quality-per-dollar ratio
 * that still fits the spendable budget (total minus buffer and fixed estimates).
 * The allocator's envelopes act as soft caps (see OVER_ENVELOPE_PENALTY).
 */
export function optimize(ctx: PlanningContext, opts: OptimizeOptions = {}): Selection & { notes: string[] } {
  const req = ctx.request;
  const minRatio = opts.minValuePerDollar ?? DEFAULT_MIN_VALUE_PER_DOLLAR;
  const scored = scoreAll(ctx);
  const weights = categoryWeights(req.preferences, ctx.candidates);
  const notes: string[] = [];

  const lockedFlight = ctx.locked.some((i) => i.category === "flights");
  const lockedHotel = ctx.locked.some((i) => i.category === "lodging");
  const needFlight = Boolean(req.origin) && !lockedFlight;

  let flight = needFlight ? cheapest(scored.flights) : undefined;
  let hotel = lockedHotel ? undefined : cheapest(scored.hotels);
  if (needFlight && !flight) notes.push("No usable flight offers found.");
  if (!lockedHotel && !hotel) notes.push("No usable lodging offers found.");
  const acts: { s: Scored<ActivityOffer>; date: string }[] = [];

  const slots = daySlots(req);
  for (const item of ctx.locked) {
    if (item.category === "activities" && item.date) slots.set(item.date, (slots.get(item.date) ?? 0) - 1);
  }
  const lockedOfferIds = new Set(ctx.locked.map((i) => i.offer?.id));

  const lockedSpend = (c: Category) => sum(ctx.locked.filter((i) => i.category === c).map((i) => i.priceCents));
  const spend = () => ({
    flights: lockedSpend("flights") + (flight?.offer.priceCents ?? 0),
    lodging: lockedSpend("lodging") + (hotel?.offer.priceCents ?? 0),
    activities: lockedSpend("activities") + sum(acts.map((a) => a.s.offer.priceCents)),
  });
  const { estimates, bufferCents, envelopes } = ctx.allocation;
  const discretionaryCap = req.budgetCents - bufferCents - estimates.foodCents - estimates.localTransportCents;
  const envelopeCap = (c: Category) => envelopes.find((e) => e.category === c)?.allocatedCents ?? 0;

  const candidateMoves = (): Move[] => {
    const moves: Move[] = [];
    if (flight) {
      const cur = flight;
      for (const f of scored.flights) {
        if (f === cur) continue;
        moves.push({
          category: "flights",
          deltaCents: f.offer.priceCents - cur.offer.priceCents,
          deltaValue: weights.flights * (f.score - cur.score),
          apply: () => (flight = f),
        });
      }
    }
    if (hotel) {
      const cur = hotel;
      for (const h of scored.hotels) {
        if (h === cur) continue;
        moves.push({
          category: "lodging",
          deltaCents: h.offer.priceCents - cur.offer.priceCents,
          deltaValue: weights.lodging * (h.score - cur.score),
          apply: () => (hotel = h),
        });
      }
    }
    const chosen = new Set(acts.map((a) => a.s.offer.id));
    for (const a of scored.activities) {
      if (chosen.has(a.offer.id) || lockedOfferIds.has(a.offer.id) || a.score <= 0) continue;
      const date = [...slots.entries()].find(([d, free]) => free > 0 && availableOn(a.offer, d))?.[0];
      if (!date) continue;
      moves.push({
        category: "activities",
        deltaCents: a.offer.priceCents,
        deltaValue: (weights.activities * a.score) / (1 + ACTIVITY_DIMINISHING * acts.length),
        apply: () => {
          acts.push({ s: a, date });
          slots.set(date, (slots.get(date) ?? 0) - 1);
        },
      });
    }
    return moves;
  };

  const total = () => sum(Object.values(spend()));
  // Envelopes are soft caps: spending past a category's envelope is allowed only
  // when the upgrade is worth OVER_ENVELOPE_PENALTY times more per dollar. This
  // keeps the allocator's split as the default while letting real prices move
  // money to wherever it buys the most value.
  for (let iter = 0; iter < 500; iter++) {
    let best: { move: Move; ratio: number } | undefined;
    const current = spend();
    for (const move of candidateMoves()) {
      if (move.deltaValue <= 0 || total() + move.deltaCents > discretionaryCap) continue;
      const overEnvelope =
        move.deltaCents > 0 && current[move.category] + move.deltaCents > envelopeCap(move.category);
      const raw = move.deltaCents <= 0 ? Infinity : (move.deltaValue * 100) / move.deltaCents;
      const ratio = overEnvelope ? raw / OVER_ENVELOPE_PENALTY : raw;
      if (ratio < minRatio) continue;
      if (!best || ratio > best.ratio) best = { move, ratio };
    }
    if (!best) break;
    best.move.apply();
  }

  if (total() > discretionaryCap) {
    notes.push(
      `Cheapest valid plan exceeds the spendable budget by ${formatUsd(total() - discretionaryCap)}; dipping into the buffer.`,
    );
  }

  return {
    flightId: flight?.offer.id,
    hotelId: hotel?.offer.id,
    activities: acts
      .sort((a, b) => a.date.localeCompare(b.date))
      .map((a) => ({ offerId: a.s.offer.id, date: a.date })),
    notes,
  };
}

// ---------------------------------------------------------------------------
// Plan materialization
// ---------------------------------------------------------------------------

function hours(minutes: number) {
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}`;
}

function explainFlight(f: FlightOffer, all: FlightOffer[]): string {
  const cheapestF = all.reduce((a, b) => (b.priceCents < a.priceCents ? b : a), f);
  const parts = [
    `${f.stops === 0 ? "Nonstop" : `${f.stops} stop${f.stops > 1 ? "s" : ""}`}, ${hours(f.durationMinutes)}`,
    f.redEye ? "red-eye" : "daytime departure",
    f.refundable ? "refundable" : "non-refundable",
  ];
  const premium = f.priceCents - cheapestF.priceCents;
  const why =
    premium > 0
      ? ` Costs ${formatUsd(premium)} more than the cheapest option (${cheapestF.title}) for fewer stops / shorter travel.`
      : " Cheapest acceptable option.";
  return `${parts.join(", ")}.${why}`;
}

function explainHotel(h: HotelOffer, all: HotelOffer[]): string {
  const cheapestH = all.reduce((a, b) => (b.priceCents < a.priceCents ? b : a), h);
  const premium = h.priceCents - cheapestH.priceCents;
  const base = `${h.rating}★ ${h.style} in ${h.neighborhood}, ${h.distanceKm} km from the center, ${h.nights} nights${
    h.freeCancellation ? ", free cancellation" : ""
  }.`;
  if (premium <= 0) return `${base} Cheapest acceptable option.`;
  const better: string[] = [];
  if (h.rating > cheapestH.rating) better.push(`rating ${cheapestH.rating}→${h.rating}`);
  if (h.distanceKm < cheapestH.distanceKm) better.push(`${cheapestH.distanceKm}→${h.distanceKm} km from center`);
  return `${base} ${formatUsd(premium)} more than the cheapest (${cheapestH.title})${
    better.length ? ` for ${better.join(" and ")}` : ""
  }.`;
}

function explainActivity(a: ActivityOffer, req: TripRequest): string {
  const matches = a.tags.filter((t) => interestMatch({ ...a, tags: [t] }, req.preferences.interests) > 0);
  return `${a.rating}★, ${a.durationHours}h.${matches.length ? ` Matches your interests: ${matches.join(", ")}.` : ""}`;
}

function alternativesFor(ctx: PlanningContext, offer: Offer, date?: string): string[] {
  const pool = (
    offer.category === "flights"
      ? ctx.candidates.flights
      : offer.category === "lodging"
        ? ctx.candidates.hotels
        : ctx.candidates.activities
  ) as Offer[];
  return usableOffers(ctx, pool)
    .filter((o) => o.id !== offer.id)
    .filter((o) => !date || o.category !== "activities" || availableOn(o, date))
    .sort((a, b) => Math.abs(a.priceCents - offer.priceCents) - Math.abs(b.priceCents - offer.priceCents))
    .slice(0, 3)
    .map((o) => o.id);
}

export interface BuildPlanMeta {
  source: TravelPlan["source"];
  tripId: string;
  version?: number;
  rationales?: Record<string, string>;
  summary?: string;
  /** Prepended to the generated summary, e.g. why a replan happened. */
  summaryPrefix?: string;
  warnings?: string[];
  /** Reuse item ids from the previous version when the same offer is kept. */
  previous?: TravelPlan;
}

export function buildPlan(ctx: PlanningContext, sel: Selection, meta: BuildPlanMeta): TravelPlan {
  const req = ctx.request;
  const evaluation = evaluateSelection(ctx, sel);
  const byId = new Map<string, Offer>(
    [...ctx.candidates.flights, ...ctx.candidates.hotels, ...ctx.candidates.activities].map((o) => [o.id, o]),
  );
  const prevByOffer = new Map(
    (meta.previous?.items ?? []).filter((i) => i.offer).map((i) => [`${i.offer!.id}@${i.date ?? ""}`, i]),
  );

  const makeItem = (offer: Offer, rationale: string, date?: string): PlanItem => {
    const prev = prevByOffer.get(`${offer.id}@${date ?? ""}`);
    return {
      id: prev?.id ?? newId("item"),
      category: offer.category,
      kind: "booking",
      title: offer.title,
      priceCents: offer.priceCents,
      status: prev && prev.status !== "failed" && prev.priceCents === offer.priceCents ? prev.status : "proposed",
      offer,
      date,
      rationale: meta.rationales?.[offer.id] ?? rationale,
      alternativeOfferIds: alternativesFor(ctx, offer, date),
      pinned: prev?.pinned,
    };
  };

  const items: PlanItem[] = [...ctx.locked];
  const flight = sel.flightId ? byId.get(sel.flightId) : undefined;
  if (flight?.category === "flights") {
    items.push(makeItem(flight, explainFlight(flight, usableOffers(ctx, ctx.candidates.flights))));
  }
  const hotel = sel.hotelId ? byId.get(sel.hotelId) : undefined;
  if (hotel?.category === "lodging") {
    items.push(makeItem(hotel, explainHotel(hotel, usableOffers(ctx, ctx.candidates.hotels))));
  }
  for (const a of sel.activities) {
    const offer = byId.get(a.offerId);
    if (offer?.category === "activities") items.push(makeItem(offer, explainActivity(offer, req), a.date));
  }

  const days = tripDays(req.startDate, req.endDate).length;
  const style = req.preferences.lodgingStyle;
  items.push(
    {
      id: "est_food",
      category: "food",
      kind: "estimate",
      title: `Meals (${days} days × ${req.travelers} traveler${req.travelers > 1 ? "s" : ""}, ${style})`,
      priceCents: ctx.allocation.estimates.foodCents,
      status: "proposed",
      rationale: `${formatUsd(ctx.candidates.costIndex.foodPerPersonPerDayCents[style])}/person/day at ${style} level.`,
      alternativeOfferIds: [],
    },
    {
      id: "est_transport",
      category: "local_transport",
      kind: "estimate",
      title: `Local transport (${days} days)`,
      priceCents: ctx.allocation.estimates.localTransportCents,
      status: "proposed",
      rationale: `${formatUsd(ctx.candidates.costIndex.localTransportPerPersonPerDayCents)}/person/day for transit and taxis.`,
      alternativeOfferIds: [],
    },
  );

  const planned = (c: Category) => sum(items.filter((i) => i.category === c).map((i) => i.priceCents));
  const committed = (c: Category) =>
    sum(items.filter((i) => i.category === c && i.booking).map((i) => i.booking!.pricePaidCents));
  const { envelopes, bufferCents } = rebalanceEnvelopes(
    ctx.allocation.envelopes.map((e) => ({
      ...e,
      plannedCents: planned(e.category),
      committedCents: committed(e.category),
    })),
    req.budgetCents,
  );

  const totalCents = sum(items.map((i) => i.priceCents));
  const warnings = [...ctx.allocation.warnings, ...evaluation.warnings, ...evaluation.errors, ...(meta.warnings ?? [])];
  const activityCount = items.filter((i) => i.category === "activities").length;
  return {
    id: newId("plan"),
    tripId: meta.tripId,
    version: meta.version ?? 1,
    createdAt: new Date().toISOString(),
    request: req,
    envelopes,
    items,
    totalCents,
    bufferCents,
    summary:
      meta.summary ??
      (meta.summaryPrefix ? `${meta.summaryPrefix}. ` : "") +
        `${days}-day trip to ${req.destinationName ?? req.destination} for ${req.travelers}: ` +
        `${items.find((i) => i.category === "lodging")?.title ?? "no lodging"}, ${activityCount} activities. ` +
        `Total ${formatUsd(totalCents)} of ${formatUsd(req.budgetCents)} ` +
        (totalCents > req.budgetCents
          ? `(OVER budget by ${formatUsd(totalCents - req.budgetCents)}).`
          : `(${formatUsd(req.budgetCents - totalCents)} unspent).`),
    warnings: [...new Set(warnings)],
    excludedOfferIds: [...ctx.excludedOfferIds],
    source: meta.source,
  };
}

/**
 * Recompute planned/committed totals after item statuses or prices change
 * outside the optimizer (e.g. a booking confirmed at a slightly lower price).
 */
export function refreshPlanTotals(plan: TravelPlan): TravelPlan {
  const items = plan.items;
  const planned = (c: Category) =>
    sum(items.filter((i) => i.category === c && i.status !== "failed" && i.status !== "cancelled").map((i) => i.booking?.pricePaidCents ?? i.priceCents));
  const committed = (c: Category) =>
    sum(items.filter((i) => i.category === c && i.booking && i.status === "booked").map((i) => i.booking!.pricePaidCents));
  const { envelopes, bufferCents } = rebalanceEnvelopes(
    plan.envelopes.map((e) => ({ ...e, plannedCents: planned(e.category), committedCents: committed(e.category) })),
    plan.request.budgetCents,
  );
  return { ...plan, envelopes, bufferCents, totalCents: sum(envelopes.map((e) => e.plannedCents)) };
}
