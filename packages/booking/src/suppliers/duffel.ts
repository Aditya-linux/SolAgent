import {
  approxUsdCents,
  DuffelError,
  type Cents,
  type DuffelClient,
  type Offer,
} from "@solagent/shared";
import {
  SupplierError,
  type BookRequest,
  type QuoteResult,
  type SupplierAdapter,
  type SupplierBooking,
} from "./types.ts";

/**
 * Real flight bookings through Duffel. In test mode (duffel_test_ token) orders
 * are placed against Duffel's sandbox airline and paid from the test balance.
 * The Solana payment captured by our payments layer settles the traveler's side;
 * Duffel balance top-ups are an operator concern.
 */
export class DuffelFlightSupplier implements SupplierAdapter {
  readonly name = "duffel";
  private readonly byIdempotencyKey = new Map<string, SupplierBooking>();

  constructor(private readonly client: DuffelClient) {}

  private toSupplierError(err: unknown): never {
    if (err instanceof DuffelError) {
      if (err.retryable) throw new SupplierError(err.message, "transient");
      if (err.status === 404 || err.status === 410 || err.code === "offer_no_longer_available") {
        throw new SupplierError(err.message, "unavailable");
      }
      if (err.code === "price_changed") throw new SupplierError(err.message, "price_changed");
      throw new SupplierError(err.message, "invalid");
    }
    if (err instanceof TypeError) throw new SupplierError(`Network error: ${err.message}`, "transient");
    throw err;
  }

  async quote(offer: Offer): Promise<QuoteResult> {
    try {
      const o = await this.client.getOffer(offer.supplierRef);
      if (o.expires_at && Date.parse(o.expires_at) < Date.now()) {
        return { available: false, priceCents: 0, reason: "Offer expired" };
      }
      const priceCents = approxUsdCents(o.total_amount, o.total_currency);
      if (priceCents === undefined) return { available: false, priceCents: 0, reason: `Unsupported currency ${o.total_currency}` };
      return { available: true, priceCents };
    } catch (err) {
      if (err instanceof DuffelError && !err.retryable) {
        return { available: false, priceCents: 0, reason: err.message };
      }
      return this.toSupplierError(err);
    }
  }

  async book(req: BookRequest): Promise<SupplierBooking> {
    const existing = this.byIdempotencyKey.get(req.idempotencyKey);
    if (existing) return existing;
    const profiles = req.profiles ?? [];
    try {
      const offer = await this.client.getOffer(req.offer.supplierRef);
      if (profiles.length < offer.passengers.length) {
        throw new SupplierError(
          `Duffel needs ${offer.passengers.length} traveler profile(s), got ${profiles.length}`,
          "invalid",
        );
      }
      const priceCents = approxUsdCents(offer.total_amount, offer.total_currency);
      if (priceCents !== undefined && priceCents > req.expectedPriceCents) {
        throw new SupplierError("Fare increased since approval", "price_changed", priceCents);
      }
      const order = await this.client.createOrder({
        offerId: offer.id,
        amount: offer.total_amount,
        currency: offer.total_currency,
        passengers: offer.passengers.map((p, i) => {
          const t = profiles[i]!;
          return {
            id: p.id,
            type: "adult",
            title: t.title ?? (t.gender === "m" ? "mr" : "ms"),
            given_name: t.givenName,
            family_name: t.familyName,
            born_on: t.bornOn,
            gender: t.gender ?? "f",
            email: t.email,
            phone_number: t.phone,
          };
        }),
      });
      const booking: SupplierBooking = {
        confirmationCode: order.booking_reference,
        supplierOrderId: order.id,
        pricePaidCents: approxUsdCents(order.total_amount, order.total_currency) ?? req.expectedPriceCents,
      };
      this.byIdempotencyKey.set(req.idempotencyKey, booking);
      return booking;
    } catch (err) {
      if (err instanceof SupplierError) throw err;
      return this.toSupplierError(err);
    }
  }

  async cancel(supplierOrderId: string): Promise<{ refundCents: Cents }> {
    try {
      const r = await this.client.cancelOrder(supplierOrderId);
      return { refundCents: approxUsdCents(r.refundAmount, r.refundCurrency) ?? 0 };
    } catch (err) {
      return this.toSupplierError(err);
    }
  }
}
