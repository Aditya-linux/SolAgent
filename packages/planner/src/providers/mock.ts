import {
  nightsBetween,
  seededRandom,
  tripDays,
  type ActivityOffer,
  type DailyCostIndex,
  type FlightOffer,
  type HotelOffer,
  type LodgingStyle,
  type TripRequest,
} from "@solagent/shared";
import type { SearchProvider } from "./types.ts";

export const MOCK_SUPPLIER = "sandbox";

interface CityProfile {
  name: string;
  /** Relative price level, 1.0 = average. */
  costLevel: number;
  neighborhoods: string[];
}

const CITIES: Record<string, CityProfile> = {
  LIS: { name: "Lisbon", costLevel: 0.85, neighborhoods: ["Alfama", "Baixa", "Chiado", "Bairro Alto", "Belém", "Parque das Nações"] },
  BCN: { name: "Barcelona", costLevel: 0.95, neighborhoods: ["Gothic Quarter", "El Born", "Eixample", "Gràcia", "Barceloneta", "Poblenou"] },
  PAR: { name: "Paris", costLevel: 1.25, neighborhoods: ["Le Marais", "Saint-Germain", "Montmartre", "Latin Quarter", "Bastille", "La Défense"] },
  NYC: { name: "New York", costLevel: 1.45, neighborhoods: ["SoHo", "Midtown", "West Village", "Lower East Side", "Williamsburg", "Long Island City"] },
  TYO: { name: "Tokyo", costLevel: 1.1, neighborhoods: ["Shibuya", "Shinjuku", "Asakusa", "Ginza", "Ueno", "Odaiba"] },
  MEX: { name: "Mexico City", costLevel: 0.7, neighborhoods: ["Roma Norte", "Condesa", "Centro Histórico", "Coyoacán", "Polanco", "Juárez"] },
};

function city(code: string): CityProfile {
  return (
    CITIES[code.toUpperCase()] ?? {
      name: code.toUpperCase(),
      costLevel: 1,
      neighborhoods: ["Old Town", "Central", "Riverside", "Arts District", "Harbor", "Airport Area"],
    }
  );
}

const CARRIERS = ["SkyBridge Air", "Atlantic Connect", "Nimbus Airways", "Polar Jet", "Coastline Air", "Meridian"];

const HOTEL_NAMES: Record<LodgingStyle, string[]> = {
  budget: ["Backpack Social", "Casa Simples", "The Nook Rooms", "Urban Bunk"],
  standard: ["Hotel Belvedere", "The Courtyard Inn", "Linen & Light", "Corner House Hotel", "Garden Court Suites"],
  luxury: ["The Grand Palácio", "Riverside Royal", "Maison Lumière", "The Atelier"],
};

const STYLE_NIGHTLY_USD: Record<LodgingStyle, [number, number]> = {
  budget: [55, 105],
  standard: [120, 220],
  luxury: [290, 560],
};

const STYLE_RATING: Record<LodgingStyle, [number, number]> = {
  budget: [3.2, 4.1],
  standard: [3.9, 4.6],
  luxury: [4.5, 5.0],
};

const ACTIVITY_TEMPLATES: { title: string; tags: string[]; usd: number; hours: number }[] = [
  { title: "Old Town walking tour", tags: ["history", "culture", "walking"], usd: 25, hours: 3 },
  { title: "Street food tasting tour", tags: ["food", "culture"], usd: 70, hours: 3.5 },
  { title: "Cooking class with market visit", tags: ["food", "hands-on"], usd: 95, hours: 4 },
  { title: "National museum + skip-the-line pass", tags: ["museums", "art", "history"], usd: 22, hours: 3 },
  { title: "Sunset river cruise", tags: ["sightseeing", "relax", "romantic"], usd: 45, hours: 2 },
  { title: "Wine tasting at a local cellar", tags: ["food", "wine"], usd: 60, hours: 2.5 },
  { title: "Coastal day trip", tags: ["nature", "day-trip", "beach"], usd: 110, hours: 8 },
  { title: "Guided hike in the hills", tags: ["nature", "hiking", "adventure"], usd: 55, hours: 6 },
  { title: "Street art bike tour", tags: ["art", "cycling", "culture"], usd: 40, hours: 3 },
  { title: "Live music night", tags: ["music", "nightlife", "culture"], usd: 50, hours: 3 },
  { title: "Kayak & snorkel session", tags: ["adventure", "beach", "nature"], usd: 75, hours: 3 },
  { title: "Spa & thermal baths", tags: ["relax", "wellness"], usd: 85, hours: 3 },
  { title: "Photography walk with a local", tags: ["photography", "walking", "culture"], usd: 65, hours: 3 },
  { title: "Rooftop bar crawl", tags: ["nightlife"], usd: 40, hours: 4 },
  { title: "Contemporary art gallery tour", tags: ["art", "museums"], usd: 30, hours: 2.5 },
];

function between(rand: () => number, [lo, hi]: [number, number]): number {
  return lo + (hi - lo) * rand();
}

function roundCents(usd: number): number {
  return Math.round(usd) * 100;
}

/**
 * Deterministic sandbox data: the same request always yields the same offers,
 * so plans, tests and the demo are reproducible.
 */
export class MockSearchProvider implements SearchProvider {
  async searchFlights(req: TripRequest): Promise<FlightOffer[]> {
    if (!req.origin) return [];
    const rand = seededRandom(`flights:${req.origin}:${req.destination}:${req.startDate}`);
    const base = between(rand, [260, 720]) * city(req.destination).costLevel;
    const offers: FlightOffer[] = [];
    for (let i = 0; i < 8; i++) {
      const stops = i < 3 ? 0 : i < 6 ? 1 : 2;
      const redEye = rand() < 0.3;
      const refundable = rand() < 0.35;
      const perPerson =
        base * (stops === 0 ? 1.25 : stops === 1 ? 1 : 0.82) * (refundable ? 1.15 : 1) * (redEye ? 0.9 : 1) *
        between(rand, [0.9, 1.15]);
      const durationMinutes = Math.round(between(rand, [380, 460]) + stops * between(rand, [90, 200]));
      const departHour = redEye ? 22 + Math.floor(rand() * 2) : 7 + Math.floor(rand() * 12);
      const carrier = CARRIERS[Math.floor(rand() * CARRIERS.length)]!;
      offers.push({
        id: `mock_fl_${req.destination}_${i}`,
        supplier: MOCK_SUPPLIER,
        supplierRef: `fl_${req.origin}_${req.destination}_${i}`,
        category: "flights",
        title: `${carrier} ${req.origin}⇄${req.destination} (${stops === 0 ? "nonstop" : `${stops} stop${stops > 1 ? "s" : ""}`})`,
        carrier,
        stops,
        durationMinutes,
        outboundDepartAt: `${req.startDate}T${String(departHour).padStart(2, "0")}:${rand() < 0.5 ? "05" : "40"}:00Z`,
        returnDepartAt: `${req.endDate}T${String(9 + Math.floor(rand() * 10)).padStart(2, "0")}:15:00Z`,
        redEye,
        refundable,
        priceCents: roundCents(perPerson * req.travelers),
        currency: "USD",
      });
    }
    return offers;
  }

  async searchHotels(req: TripRequest): Promise<HotelOffer[]> {
    const c = city(req.destination);
    const nights = nightsBetween(req.startDate, req.endDate);
    const rooms = Math.ceil(req.travelers / 2);
    const rand = seededRandom(`hotels:${req.destination}:${req.startDate}`);
    const offers: HotelOffer[] = [];
    let i = 0;
    for (const style of ["budget", "standard", "luxury"] as const) {
      for (const name of HOTEL_NAMES[style]) {
        const distanceKm = Math.round(between(rand, [0.3, 7.5]) * 10) / 10;
        // Central hotels cost more: up to +35% in the center.
        const locationPremium = 1 + 0.35 * (1 - distanceKm / 7.5);
        const nightly = between(rand, STYLE_NIGHTLY_USD[style]) * c.costLevel * locationPremium;
        const neighborhood = c.neighborhoods[Math.floor(rand() * c.neighborhoods.length)]!;
        const freeCancellation = rand() < 0.6;
        offers.push({
          id: `mock_ht_${req.destination}_${i}`,
          supplier: MOCK_SUPPLIER,
          supplierRef: `ht_${req.destination}_${i}`,
          category: "lodging",
          title: `${name}, ${neighborhood}`,
          style,
          rating: Math.round(between(rand, STYLE_RATING[style]) * 10) / 10,
          distanceKm,
          neighborhood,
          nights,
          freeCancellation,
          amenities: [
            "wifi",
            ...(rand() < 0.5 ? ["breakfast"] : []),
            ...(style !== "budget" && rand() < 0.4 ? ["gym"] : []),
            ...(style === "luxury" ? ["spa", "pool"] : []),
          ],
          priceCents: roundCents(nightly * nights * rooms * (freeCancellation ? 1.05 : 1)),
          currency: "USD",
        });
        i++;
      }
    }
    return offers;
  }

  async searchActivities(req: TripRequest): Promise<ActivityOffer[]> {
    const c = city(req.destination);
    const days = tripDays(req.startDate, req.endDate);
    const rand = seededRandom(`activities:${req.destination}:${req.startDate}`);
    return ACTIVITY_TEMPLATES.map((t, i) => {
      // ~30% of activities only run on specific days.
      const limited = rand() < 0.3;
      const availableDates = limited ? days.filter(() => rand() < 0.5) : [];
      return {
        id: `mock_ac_${req.destination}_${i}`,
        supplier: MOCK_SUPPLIER,
        supplierRef: `ac_${req.destination}_${i}`,
        category: "activities" as const,
        title: `${c.name}: ${t.title}`,
        tags: t.tags,
        rating: Math.round(between(rand, [3.9, 4.95]) * 10) / 10,
        durationHours: t.hours,
        availableDates: limited && availableDates.length === 0 ? [days[1] ?? days[0]!] : availableDates,
        priceCents: roundCents(t.usd * c.costLevel * between(rand, [0.85, 1.2]) * req.travelers),
        currency: "USD" as const,
      };
    });
  }

  async getDailyCosts(req: TripRequest): Promise<DailyCostIndex> {
    const level = city(req.destination).costLevel;
    return {
      destination: req.destination,
      foodPerPersonPerDayCents: {
        budget: roundCents(35 * level),
        standard: roundCents(60 * level),
        luxury: roundCents(110 * level),
      },
      localTransportPerPersonPerDayCents: roundCents(12 * level),
    };
  }
}

export function cityName(code: string): string {
  return city(code).name;
}
