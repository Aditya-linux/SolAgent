import { newId, type Cents, type Offer } from "@solagent/shared";
import {
  SupplierError,
  type BookRequest,
  type QuoteResult,
  type SupplierAdapter,
  type SupplierBooking,
  type SupplierErrorKind,
} from "./types.ts";

/**
 * In-memory supplier for Phase 0/1: books anything the mock search provider
 * returns, and lets tests and the demo inject real-world failure modes
 * (price drift, sell-outs, flaky APIs).
 */
export class SandboxSupplier implements SupplierAdapter {
  readonly name: string;
  private readonly prices = new Map<string, Cents>();
  private readonly soldOut = new Set<string>();
  private readonly failures = new Map<string, { remaining: number; kind: SupplierErrorKind }>();
  private readonly byIdempotencyKey = new Map<string, SupplierBooking>();
  private readonly orders = new Map<string, { offerId: string; pricePaidCents: Cents; cancelled: boolean }>();

  constructor(name = "sandbox") {
    this.name = name;
  }

  // --- failure injection -----------------------------------------------------

  /** The offer now costs this much (simulates a fare/rate change). */
  setPrice(offerId: string, priceCents: Cents): void {
    this.prices.set(offerId, priceCents);
  }

  markSoldOut(offerId: string): void {
    this.soldOut.add(offerId);
  }

  /** Fail the next `times` book() calls for this offer. */
  failNext(offerId: string, times: number, kind: SupplierErrorKind = "transient"): void {
    this.failures.set(offerId, { remaining: times, kind });
  }

  // --- SupplierAdapter -------------------------------------------------------

  private currentPrice(offer: Offer): Cents {
    return this.prices.get(offer.id) ?? offer.priceCents;
  }

  async quote(offer: Offer): Promise<QuoteResult> {
    if (this.soldOut.has(offer.id)) return { available: false, priceCents: 0, reason: "Sold out" };
    return { available: true, priceCents: this.currentPrice(offer) };
  }

  async book(req: BookRequest): Promise<SupplierBooking> {
    const existing = this.byIdempotencyKey.get(req.idempotencyKey);
    if (existing) return existing;

    const failure = this.failures.get(req.offer.id);
    if (failure && failure.remaining > 0) {
      failure.remaining--;
      throw new SupplierError(`Injected ${failure.kind} failure`, failure.kind);
    }
    if (this.soldOut.has(req.offer.id)) throw new SupplierError("Sold out", "unavailable");
    const price = this.currentPrice(req.offer);
    if (price > req.expectedPriceCents) {
      throw new SupplierError("Price changed since quote", "price_changed", price);
    }

    const booking: SupplierBooking = {
      confirmationCode: newId("SBX").slice(4, 12).toUpperCase(),
      supplierOrderId: newId("ord"),
      pricePaidCents: price,
    };
    this.byIdempotencyKey.set(req.idempotencyKey, booking);
    this.orders.set(booking.supplierOrderId, { offerId: req.offer.id, pricePaidCents: price, cancelled: false });
    return booking;
  }

  async cancel(supplierOrderId: string): Promise<{ refundCents: Cents }> {
    const order = this.orders.get(supplierOrderId);
    if (!order) throw new SupplierError(`Unknown order ${supplierOrderId}`, "invalid");
    if (order.cancelled) return { refundCents: 0 };
    order.cancelled = true;
    return { refundCents: order.pricePaidCents };
  }

  /** Number of live (non-cancelled) orders, for tests. */
  get activeOrderCount(): number {
    return [...this.orders.values()].filter((o) => !o.cancelled).length;
  }
}
