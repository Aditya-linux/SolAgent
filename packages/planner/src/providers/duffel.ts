import {
  approxUsdCents,
  isoDurationToMinutes,
  type DuffelClient,
  type DuffelOffer,
  type FlightOffer,
  type TripRequest,
} from "@solagent/shared";
import type { SearchProvider } from "./types.ts";

export const DUFFEL_SUPPLIER = "duffel";

/** Flights only; compose with another provider for hotels/activities. */
export class DuffelFlightSearch implements Pick<SearchProvider, "searchFlights"> {
  constructor(
    private readonly client: DuffelClient,
    private readonly maxOffers = 25,
  ) {}

  async searchFlights(req: TripRequest): Promise<FlightOffer[]> {
    if (!req.origin) return [];
    const offers = await this.client.searchOffers({
      origin: req.origin,
      destination: req.destination,
      departureDate: req.startDate,
      returnDate: req.endDate,
      adults: req.travelers,
      maxConnections: req.preferences.maxStops,
    });
    return offers
      .map(toFlightOffer)
      .filter((o): o is FlightOffer => o !== undefined)
      .sort((a, b) => a.priceCents - b.priceCents)
      .slice(0, this.maxOffers);
  }
}

export function toFlightOffer(o: DuffelOffer): FlightOffer | undefined {
  const priceCents = approxUsdCents(o.total_amount, o.total_currency);
  const outbound = o.slices[0];
  const firstSeg = outbound?.segments[0];
  if (priceCents === undefined || !outbound || !firstSeg) return undefined;
  const inbound = o.slices[1];
  const stops = Math.max(0, ...o.slices.map((s) => s.segments.length - 1));
  const durationMinutes = Math.max(
    ...o.slices.map(
      (s) =>
        isoDurationToMinutes(s.duration) ||
        (Date.parse(s.segments.at(-1)!.arriving_at) - Date.parse(s.segments[0]!.departing_at)) / 60_000,
    ),
  );
  const departHour = new Date(firstSeg.departing_at).getUTCHours();
  return {
    id: `duffel_${o.id}`,
    supplier: DUFFEL_SUPPLIER,
    supplierRef: o.id,
    category: "flights",
    title: `${o.owner.name} ${stops === 0 ? "nonstop" : `${stops} stop${stops > 1 ? "s" : ""}`}`,
    carrier: o.owner.name,
    stops,
    durationMinutes: Math.round(durationMinutes),
    outboundDepartAt: firstSeg.departing_at,
    returnDepartAt: inbound?.segments[0]?.departing_at,
    redEye: departHour >= 22 || departHour < 5,
    refundable: o.conditions?.refund_before_departure?.allowed ?? false,
    priceCents,
    currency: "USD",
    expiresAt: o.expires_at,
  };
}
