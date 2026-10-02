/**
 * Minimal Duffel Flights API client (https://duffel.com/docs/api/v2).
 * Shared by the planner (search) and the booking executor (re-quote, order, cancel).
 * Use a test-mode token (duffel_test_...) for sandbox bookings.
 */

const DUFFEL_BASE_URL = "https://api.duffel.com";

export interface DuffelSegment {
  departing_at: string;
  arriving_at: string;
  duration?: string | null;
  marketing_carrier?: { name: string; iata_code?: string };
  marketing_carrier_flight_number?: string;
}

export interface DuffelSlice {
  duration?: string | null;
  segments: DuffelSegment[];
}

export interface DuffelOffer {
  id: string;
  total_amount: string;
  total_currency: string;
  expires_at?: string;
  owner: { name: string; iata_code?: string };
  slices: DuffelSlice[];
  passengers: { id: string; type?: string }[];
  conditions?: { refund_before_departure?: { allowed: boolean } | null };
}

export interface DuffelOrder {
  id: string;
  booking_reference: string;
  total_amount: string;
  total_currency: string;
}

export interface DuffelPassengerInput {
  id: string;
  type: "adult";
  title: string;
  given_name: string;
  family_name: string;
  born_on: string;
  gender: string;
  email: string;
  phone_number: string;
}

export class DuffelError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "DuffelError";
  }

  get retryable(): boolean {
    return this.status === 429 || this.status >= 500;
  }
}

export class DuffelClient {
  constructor(
    private readonly accessToken: string,
    private readonly baseUrl = DUFFEL_BASE_URL,
  ) {}

  static fromEnv(): DuffelClient | undefined {
    const token = process.env.DUFFEL_ACCESS_TOKEN;
    return token ? new DuffelClient(token) : undefined;
  }

  private async request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        "Duffel-Version": "v2",
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify({ data: body }),
    });
    const json = (await res.json().catch(() => ({}))) as {
      data?: T;
      errors?: { message: string; code?: string }[];
    };
    if (!res.ok || json.data === undefined) {
      const err = json.errors?.[0];
      throw new DuffelError(err?.message ?? `Duffel ${method} ${path} failed`, res.status, err?.code);
    }
    return json.data;
  }

  /** Search round-trip (or one-way when returnDate is omitted) offers. */
  async searchOffers(params: {
    origin: string;
    destination: string;
    departureDate: string;
    returnDate?: string;
    adults: number;
    cabinClass?: "economy" | "premium_economy" | "business" | "first";
    maxConnections?: number;
  }): Promise<DuffelOffer[]> {
    const slices = [
      { origin: params.origin, destination: params.destination, departure_date: params.departureDate },
    ];
    if (params.returnDate) {
      slices.push({
        origin: params.destination,
        destination: params.origin,
        departure_date: params.returnDate,
      });
    }
    const data = await this.request<{ offers: DuffelOffer[] }>(
      "POST",
      "/air/offer_requests?return_offers=true&supplier_timeout=15000",
      {
        slices,
        passengers: Array.from({ length: params.adults }, () => ({ type: "adult" })),
        cabin_class: params.cabinClass ?? "economy",
        ...(params.maxConnections !== undefined ? { max_connections: params.maxConnections } : {}),
      },
    );
    return data.offers;
  }

  getOffer(offerId: string): Promise<DuffelOffer> {
    return this.request("GET", `/air/offers/${encodeURIComponent(offerId)}`);
  }

  createOrder(params: {
    offerId: string;
    passengers: DuffelPassengerInput[];
    amount: string;
    currency: string;
  }): Promise<DuffelOrder> {
    return this.request("POST", "/air/orders", {
      type: "instant",
      selected_offers: [params.offerId],
      passengers: params.passengers,
      payments: [{ type: "balance", amount: params.amount, currency: params.currency }],
    });
  }

  /** Two-step cancel: create a pending cancellation, then confirm it. */
  async cancelOrder(orderId: string): Promise<{ refundAmount: string; refundCurrency: string }> {
    const pending = await this.request<{ id: string; refund_amount: string; refund_currency: string }>(
      "POST",
      "/air/order_cancellations",
      { order_id: orderId },
    );
    await this.request("POST", `/air/order_cancellations/${pending.id}/actions/confirm`);
    return { refundAmount: pending.refund_amount, refundCurrency: pending.refund_currency };
  }
}

/**
 * Approximate FX for planning only. Duffel charges in the offer's currency from
 * the Duffel balance; these rates just let the planner compare offers in USD.
 */
const APPROX_USD_RATE: Record<string, number> = { USD: 1, EUR: 1.1, GBP: 1.3, CAD: 0.73, AUD: 0.66 };

export function approxUsdCents(amount: string, currency: string): number | undefined {
  const rate = APPROX_USD_RATE[currency.toUpperCase()];
  return rate === undefined ? undefined : Math.round(Number(amount) * rate * 100);
}

/** ISO-8601 duration ("PT7H35M" / "P1DT2H") to minutes. */
export function isoDurationToMinutes(duration: string | null | undefined): number {
  if (!duration) return 0;
  const m = /P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?/.exec(duration);
  if (!m) return 0;
  return Number(m[1] ?? 0) * 1440 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
}
