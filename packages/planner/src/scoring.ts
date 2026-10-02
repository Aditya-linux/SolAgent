import type {
  ActivityOffer,
  Category,
  FlightOffer,
  HotelOffer,
  LodgingStyle,
  Offer,
  TripPreferences,
} from "@solagent/shared";

/**
 * Quality scores in [0, 1] per offer, plus per-category weights that say how
 * much the traveler cares about quality in that category. The optimizer trades
 * `weight * score` against price, so "cheaper hotel vs. better location" is an
 * explicit, explainable comparison rather than a black box.
 */

const STYLE_ORDER: LodgingStyle[] = ["budget", "standard", "luxury"];

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

function mentions(list: string[] | undefined, ...terms: string[]): boolean {
  const haystack = (list ?? []).join(" ").toLowerCase();
  return terms.some((t) => haystack.includes(t));
}

export function flightScore(f: FlightOffer, prefs: TripPreferences, fastestMinutes: number): number {
  const stopPenalty = 0.22 * f.stops;
  const extraHours = Math.max(0, f.durationMinutes - fastestMinutes) / 60;
  const durationPenalty = Math.min(0.3, extraHours * 0.04);
  const redEyePenalty = f.redEye ? 0.15 : 0;
  const refundBonus = f.refundable ? 0.08 : 0;
  return clamp01(0.95 - stopPenalty - durationPenalty - redEyePenalty + refundBonus);
}

export function hotelScore(h: HotelOffer, prefs: TripPreferences): number {
  const ratingScore = clamp01((h.rating - 3) / 2);
  const locationScore = clamp01(1 - h.distanceKm / 8);
  // Below the requested style hurts a lot; above it is nice but not needed.
  const styleGap = STYLE_ORDER.indexOf(h.style) - STYLE_ORDER.indexOf(prefs.lodgingStyle);
  const styleScore = styleGap === 0 ? 1 : styleGap > 0 ? 0.7 : styleGap === -1 ? 0.2 : 0;
  const breakfast = h.amenities.includes("breakfast") ? 0.03 : 0;
  const cancel = h.freeCancellation ? 0.04 : 0;
  return clamp01(0.3 * ratingScore + 0.3 * locationScore + 0.33 * styleScore + breakfast + cancel);
}

export function interestMatch(a: ActivityOffer, interests: string[]): number {
  if (interests.length === 0) return 0.5;
  const wanted = interests.map((i) => i.toLowerCase());
  const hits = a.tags.filter((t) => wanted.some((w) => t.includes(w) || w.includes(t))).length;
  return hits === 0 ? 0 : Math.min(1, 0.6 + 0.2 * hits);
}

export function activityScore(a: ActivityOffer, prefs: TripPreferences): number {
  const ratingScore = clamp01((a.rating - 3.5) / 1.5);
  const match = interestMatch(a, prefs.interests);
  // Highly rated but off-interest activities are only worth half as much.
  return clamp01((0.35 * ratingScore + 0.65 * match) * (match === 0 ? 0.5 : 1));
}

/** True when an offer hits something on the traveler's avoid list. */
export function isAvoided(o: Offer, prefs: TripPreferences): boolean {
  const avoid = prefs.avoid ?? [];
  if (avoid.length === 0) return false;
  if (o.category === "flights") {
    if (o.redEye && mentions(avoid, "red-eye", "redeye", "overnight flight")) return true;
    if (prefs.maxStops !== undefined && o.stops > prefs.maxStops) return true;
  }
  if (o.category === "lodging" && o.style === "budget" && mentions(avoid, "hostel")) return true;
  const text = `${o.title} ${o.category === "activities" ? o.tags.join(" ") : ""}`.toLowerCase();
  return avoid.some((term) => term.length > 2 && text.includes(term.toLowerCase()));
}

function median(xs: number[]): number | undefined {
  if (xs.length === 0) return undefined;
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/**
 * How many dollars a full point of quality score is worth in each category,
 * calibrated against the market: going from the worst to the best hotel is
 * worth roughly what a typical hotel in the traveler's preferred style costs.
 * The optimizer compares these values to prices, so the scale matters.
 */
export function categoryWeights(
  prefs: TripPreferences,
  market: { flights: Offer[]; hotels: HotelOffer[]; activities: Offer[] },
): Record<Exclude<Category, "food" | "local_transport">, number> {
  const usd = (cents: number | undefined, fallback: number) => (cents === undefined ? fallback : cents / 100);
  const styleHotels = market.hotels.filter((h) => h.style === prefs.lodgingStyle);
  const typicalHotel = usd(median((styleHotels.length ? styleHotels : market.hotels).map((h) => h.priceCents)), 800);
  const typicalFlight = usd(median(market.flights.map((f) => f.priceCents)), 600);
  const typicalActivity = usd(median(market.activities.map((a) => a.priceCents)), 60);
  return {
    flights: 0.6 * typicalFlight * (prefs.maxStops === 0 ? 1.5 : 1),
    lodging: 1.2 * typicalHotel,
    activities: { relaxed: 1.5, balanced: 2, packed: 2.5 }[prefs.pace] * typicalActivity,
  };
}

/** Activity slots per trip day, before arrival/departure-day adjustments. */
export function activitiesPerDay(pace: TripPreferences["pace"]): number {
  return { relaxed: 1, balanced: 2, packed: 3 }[pace];
}
