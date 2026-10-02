import type { Cents, Offer, TravelerProfile } from "@solagent/shared";

export interface QuoteResult {
  available: boolean;
  /** Current total price in cents (USD). */
  priceCents: Cents;
  reason?: string;
}

export interface BookRequest {
  offer: Offer;
  tripId: string;
  itemId: string;
  travelers: number;
  profiles?: TravelerProfile[];
  /** Same key => same booking. Suppliers must not double-book on retry. */
  idempotencyKey: string;
  /** The price we authorized; suppliers that support it should refuse to charge more. */
  expectedPriceCents: Cents;
}

export interface SupplierBooking {
  confirmationCode: string;
  supplierOrderId: string;
  pricePaidCents: Cents;
}

export type SupplierErrorKind = "transient" | "unavailable" | "price_changed" | "invalid";

export class SupplierError extends Error {
  constructor(
    message: string,
    readonly kind: SupplierErrorKind,
    readonly quotedCents?: Cents,
  ) {
    super(message);
    this.name = "SupplierError";
  }
}

/** One real-world supplier (airline aggregator, hotel API, activity marketplace). */
export interface SupplierAdapter {
  readonly name: string;
  /** Re-price and check availability right before booking. */
  quote(offer: Offer): Promise<QuoteResult>;
  book(req: BookRequest): Promise<SupplierBooking>;
  cancel(supplierOrderId: string): Promise<{ refundCents: Cents }>;
}

export class SupplierRegistry {
  private readonly adapters = new Map<string, SupplierAdapter>();

  constructor(adapters: SupplierAdapter[] = []) {
    for (const a of adapters) this.register(a);
  }

  register(adapter: SupplierAdapter): this {
    this.adapters.set(adapter.name, adapter);
    return this;
  }

  get(name: string): SupplierAdapter {
    const adapter = this.adapters.get(name);
    if (!adapter) throw new SupplierError(`No supplier adapter registered for "${name}"`, "invalid");
    return adapter;
  }
}
