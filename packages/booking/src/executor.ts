import {
  formatUsd,
  type BookingOutcome,
  type BookingRecord,
  type Cents,
  type PaymentGateway,
  type PlanItem,
  type TravelerProfile,
} from "@solagent/shared";
import { SupplierError, type SupplierRegistry } from "./suppliers/types.ts";

/**
 * Turns an approved plan item into a real reservation.
 *
 *   1. Re-quote with the supplier. Unavailable -> "unavailable". Price above the
 *      approved amount (beyond tolerance) -> "price_changed"; nothing is charged
 *      and the planner decides whether to re-approve or swap.
 *   2. Authorize the spend with the payments layer (spending rules run here).
 *      Needs a user signature -> "awaiting_user"; call execute() again once signed.
 *   3. Book with the supplier using a deterministic idempotency key, retrying
 *      transient errors with backoff.
 *   4. Capture the payment. If capture fails, cancel the supplier booking so we
 *      never hold a reservation we didn't pay for.
 *   Any failure after authorization voids the hold, so no money moves for
 *   bookings that didn't happen.
 */

export interface ExecutorOptions {
  /** Accept quotes up to this fraction above the approved price... */
  priceTolerancePct?: number;
  /** ...or this many cents above it, whichever is larger. */
  priceToleranceCents?: Cents;
  maxAttempts?: number;
  /** Delay before retry n (ms). */
  backoffMs?: (attempt: number) => number;
}

export interface BookingContext {
  tripId: string;
  travelers: number;
  profiles?: TravelerProfile[];
}

export class BookingExecutor {
  private readonly opts: Required<ExecutorOptions>;

  constructor(
    private readonly suppliers: SupplierRegistry,
    private readonly payments: PaymentGateway,
    opts: ExecutorOptions = {},
  ) {
    this.opts = {
      priceTolerancePct: opts.priceTolerancePct ?? 0.02,
      priceToleranceCents: opts.priceToleranceCents ?? 500,
      maxAttempts: opts.maxAttempts ?? 3,
      backoffMs: opts.backoffMs ?? ((n) => 250 * 2 ** n),
    };
  }

  /** Highest price that's still covered by the user's approval of `approvedCents`. */
  maxAcceptable(approvedCents: Cents): Cents {
    return approvedCents + Math.max(this.opts.priceToleranceCents, Math.round(approvedCents * this.opts.priceTolerancePct));
  }

  idempotencyKey(ctx: BookingContext, item: PlanItem): string {
    return `${ctx.tripId}:${item.id}:${item.offer?.id}`;
  }

  /**
   * Safe to call repeatedly for the same item: the idempotency key resumes the
   * same payment authorization (e.g. after the user signs) and the same booking.
   */
  async execute(ctx: BookingContext, item: PlanItem): Promise<BookingOutcome> {
    const offer = item.offer;
    if (item.kind !== "booking" || !offer) {
      return { status: "failed", itemId: item.id, reason: "Item is an estimate, not a bookable offer" };
    }
    if (item.status === "booked" && item.booking) return { status: "booked", itemId: item.id, record: item.booking };

    let supplier;
    try {
      supplier = this.suppliers.get(offer.supplier);
    } catch (err) {
      return { status: "failed", itemId: item.id, reason: (err as Error).message };
    }

    // 1. Re-quote.
    let quotedCents: Cents;
    try {
      const quote = await this.withRetry(() => supplier.quote(offer));
      if (!quote.available) return { status: "unavailable", itemId: item.id, reason: quote.reason ?? "Not available" };
      quotedCents = quote.priceCents;
    } catch (err) {
      return this.failure(item.id, err);
    }
    if (quotedCents > this.maxAcceptable(item.priceCents)) {
      return { status: "price_changed", itemId: item.id, quotedCents, approvedCents: item.priceCents };
    }

    // 2. Authorize (or resume a previously authorized/signed spend).
    const idempotencyKey = this.idempotencyKey(ctx, item);
    const auth = await this.payments.authorize({
      tripId: ctx.tripId,
      itemId: item.id,
      category: item.category,
      merchant: offer.supplier,
      amountCents: Math.max(quotedCents, item.priceCents),
      description: `${item.title} (${formatUsd(quotedCents)})`,
      idempotencyKey,
    });
    if (auth.status === "rejected") {
      return { status: "payment_rejected", itemId: item.id, reason: auth.reason ?? "Rejected by spending rules" };
    }
    if (auth.status === "pending_user") return { status: "awaiting_user", itemId: item.id, authorizationId: auth.id };

    // 3. Book.
    let booking;
    try {
      booking = await this.withRetry(() =>
        supplier.book({
          offer,
          tripId: ctx.tripId,
          itemId: item.id,
          travelers: ctx.travelers,
          profiles: ctx.profiles,
          idempotencyKey,
          expectedPriceCents: auth.amountCents,
        }),
      );
    } catch (err) {
      await this.payments.void(auth.id);
      if (err instanceof SupplierError && err.kind === "price_changed") {
        return {
          status: "price_changed",
          itemId: item.id,
          quotedCents: err.quotedCents ?? quotedCents,
          approvedCents: item.priceCents,
        };
      }
      return this.failure(item.id, err);
    }

    // 4. Capture; compensate if it fails.
    let receiptId: string;
    try {
      const receipt = await this.payments.capture(auth.id, booking.pricePaidCents);
      receiptId = receipt.id;
    } catch (err) {
      await supplier.cancel(booking.supplierOrderId).catch(() => undefined);
      await this.payments.void(auth.id).catch(() => undefined);
      return { status: "failed", itemId: item.id, reason: `Payment capture failed: ${(err as Error).message}` };
    }

    const record: BookingRecord = {
      supplier: supplier.name,
      confirmationCode: booking.confirmationCode,
      supplierOrderId: booking.supplierOrderId,
      pricePaidCents: booking.pricePaidCents,
      paymentReceiptId: receiptId,
      bookedAt: new Date().toISOString(),
    };
    return { status: "booked", itemId: item.id, record };
  }

  /** Current supplier price for an item, without booking (used for price monitoring). */
  async quote(item: PlanItem): Promise<{ available: boolean; priceCents: Cents; reason?: string }> {
    if (!item.offer) return { available: false, priceCents: 0, reason: "Not bookable" };
    const supplier = this.suppliers.get(item.offer.supplier);
    return this.withRetry(() => supplier.quote(item.offer!));
  }

  /** Cancel a booked item and refund whatever the supplier gives back. */
  async cancel(item: PlanItem): Promise<{ refundCents: Cents }> {
    if (!item.booking) throw new Error(`Item ${item.id} is not booked`);
    const supplier = this.suppliers.get(item.booking.supplier);
    const { refundCents } = await this.withRetry(() => supplier.cancel(item.booking!.supplierOrderId));
    if (refundCents > 0 && item.booking.paymentReceiptId) {
      await this.payments.refund(item.booking.paymentReceiptId, refundCents);
    }
    return { refundCents };
  }

  private failure(itemId: string, err: unknown): BookingOutcome {
    if (err instanceof SupplierError && err.kind === "unavailable") {
      return { status: "unavailable", itemId, reason: err.message };
    }
    return { status: "failed", itemId, reason: err instanceof Error ? err.message : String(err) };
  }

  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn();
      } catch (err) {
        const transient = err instanceof SupplierError && err.kind === "transient";
        if (!transient || attempt + 1 >= this.opts.maxAttempts) throw err;
        await new Promise((r) => setTimeout(r, this.opts.backoffMs(attempt)));
      }
    }
  }
}
