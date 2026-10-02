import type {
  ActivityOffer,
  DailyCostIndex,
  FlightOffer,
  HotelOffer,
  TripRequest,
} from "@solagent/shared";

/**
 * Search/price data source. Each method may be backed by a different supplier
 * (Duffel for flights, a hotel aggregator for lodging, ...); see CompositeSearchProvider.
 */
export interface SearchProvider {
  searchFlights(req: TripRequest): Promise<FlightOffer[]>;
  searchHotels(req: TripRequest): Promise<HotelOffer[]>;
  searchActivities(req: TripRequest): Promise<ActivityOffer[]>;
  getDailyCosts(req: TripRequest): Promise<DailyCostIndex>;
}

/** Everything the optimizer needs, fetched once per (re)plan. */
export interface CandidateSet {
  flights: FlightOffer[];
  hotels: HotelOffer[];
  activities: ActivityOffer[];
  costIndex: DailyCostIndex;
}

export async function gatherCandidates(
  provider: SearchProvider,
  req: TripRequest,
): Promise<CandidateSet> {
  const [flights, hotels, activities, costIndex] = await Promise.all([
    req.origin ? provider.searchFlights(req) : Promise.resolve([]),
    provider.searchHotels(req),
    provider.searchActivities(req),
    provider.getDailyCosts(req),
  ]);
  return { flights, hotels, activities, costIndex };
}

/** Route each search to its own provider. */
export class CompositeSearchProvider implements SearchProvider {
  constructor(
    private readonly parts: {
      flights: Pick<SearchProvider, "searchFlights">;
      hotels: Pick<SearchProvider, "searchHotels">;
      activities: Pick<SearchProvider, "searchActivities">;
      costs: Pick<SearchProvider, "getDailyCosts">;
    },
  ) {}

  searchFlights(req: TripRequest) {
    return this.parts.flights.searchFlights(req);
  }
  searchHotels(req: TripRequest) {
    return this.parts.hotels.searchHotels(req);
  }
  searchActivities(req: TripRequest) {
    return this.parts.activities.searchActivities(req);
  }
  getDailyCosts(req: TripRequest) {
    return this.parts.costs.getDailyCosts(req);
  }
}
