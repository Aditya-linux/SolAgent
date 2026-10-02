import { describe, expect, it } from "vitest";
import type { HotelOffer, PlanItem } from "@solagent/shared";
import { BookingExecutor, SandboxPaymentGateway, SandboxSupplier, SupplierRegistry } from "../src/index.ts";

const offer: HotelOffer = {
  id: "off_1",
  supplier: "sandbox",
  supplierRef: "ht_1",
  category: "lodging",
  title: "Hotel Test",
  priceCents: 80_000,
  currency: "USD",
  style: "standard",
  rating: 4.4,
  distanceKm: 1,
  neighborhood: "Center",
  nights: 4,
  freeCancellation: true,
  amenities: [],
};

const item: PlanItem = {
  id: "item_1",
  category: "lodging",
  kind: "booking",
  title: offer.title,
  priceCents: offer.priceCents,
  status: "approved",
  offer,
  rationale: "",
  alternativeOfferIds: [],
};

const ctx = { tripId: "trip_1", travelers: 2 };

function setup() {
  const supplier = new SandboxSupplier();
  const payments = new SandboxPaymentGateway();
  const executor = new BookingExecutor(new SupplierRegistry([supplier]), payments, { backoffMs: () => 0 });
  return { supplier, payments, executor };
}

describe("BookingExecutor", () => {
  it("books and captures payment", async () => {
    const { executor, supplier } = setup();
    const r = await executor.execute(ctx, item);
    expect(r.status).toBe("booked");
    if (r.status !== "booked") return;
    expect(r.record.pricePaidCents).toBe(80_000);
    expect(r.record.paymentReceiptId).toBeDefined();
    expect(supplier.activeOrderCount).toBe(1);
  });

  it("books through small price drift within tolerance and charges the real price", async () => {
    const { executor, supplier } = setup();
    supplier.setPrice(offer.id, 80_400);
    const r = await executor.execute(ctx, item);
    expect(r.status).toBe("booked");
    if (r.status === "booked") expect(r.record.pricePaidCents).toBe(80_400);
  });

  it("stops before charging when the price moved beyond tolerance", async () => {
    const { executor, supplier } = setup();
    supplier.setPrice(offer.id, 95_000);
    const r = await executor.execute(ctx, item);
    expect(r).toEqual({ status: "price_changed", itemId: item.id, quotedCents: 95_000, approvedCents: 80_000 });
    expect(supplier.activeOrderCount).toBe(0);
  });

  it("reports sold-out offers as unavailable without holding money", async () => {
    const { executor, supplier, payments } = setup();
    payments.setRules(ctx.tripId, { categoryCapsCents: { lodging: 80_000 } });
    supplier.markSoldOut(offer.id);
    expect((await executor.execute(ctx, item)).status).toBe("unavailable");
    // The cap is still fully available: nothing was authorized.
    supplier.setPrice(offer.id, 80_000);
    const other = { ...item, id: "item_2", offer: { ...offer, id: "off_2" } };
    expect((await executor.execute(ctx, other)).status).toBe("booked");
  });

  it("retries transient supplier errors", async () => {
    const { executor, supplier } = setup();
    supplier.failNext(offer.id, 2, "transient");
    expect((await executor.execute(ctx, item)).status).toBe("booked");
  });

  it("gives up after max attempts and voids the hold", async () => {
    const { executor, supplier, payments } = setup();
    payments.setRules(ctx.tripId, { categoryCapsCents: { lodging: 80_500 } });
    supplier.failNext(offer.id, 5, "transient");
    expect((await executor.execute(ctx, item)).status).toBe("failed");
    const auth = await payments.authorize({
      tripId: ctx.tripId,
      itemId: "x",
      category: "lodging",
      merchant: "sandbox",
      amountCents: 80_000,
      description: "",
      idempotencyKey: "fresh",
    });
    expect(auth.status).toBe("authorized");
  });

  it("waits for the user's signature above the auto-approve limit, then resumes", async () => {
    const { executor, payments, supplier } = setup();
    payments.setRules(ctx.tripId, { autoApproveUpToCents: 50_000 });
    const first = await executor.execute(ctx, item);
    expect(first.status).toBe("awaiting_user");
    expect(supplier.activeOrderCount).toBe(0);
    if (first.status !== "awaiting_user") return;
    await payments.approvePending(first.authorizationId);
    expect((await executor.execute(ctx, item)).status).toBe("booked");
  });

  it("rejects spends that break category caps or the merchant allowlist", async () => {
    const { executor, payments } = setup();
    payments.setRules(ctx.tripId, { categoryCapsCents: { lodging: 50_000 } });
    const capped = await executor.execute(ctx, item);
    expect(capped.status).toBe("payment_rejected");

    payments.setRules(ctx.tripId, { merchantAllowlist: ["duffel"] });
    const r = await executor.execute(ctx, { ...item, id: "item_3" });
    expect(r.status === "payment_rejected" && r.reason).toMatch(/allowlist/);
  });

  it("is idempotent: executing twice never double-books", async () => {
    const { executor, supplier } = setup();
    const a = await executor.execute(ctx, item);
    const b = await executor.execute(ctx, item);
    expect(a.status === "booked" && b.status === "booked" && a.record.confirmationCode).toBe(
      b.status === "booked" && b.record.confirmationCode,
    );
    expect(supplier.activeOrderCount).toBe(1);
  });

  it("cancels the supplier booking if payment capture fails", async () => {
    const { supplier } = setup();
    const failingPayments = new SandboxPaymentGateway();
    failingPayments.capture = async () => {
      throw new Error("RPC node down");
    };
    const executor = new BookingExecutor(new SupplierRegistry([supplier]), failingPayments, { backoffMs: () => 0 });
    const r = await executor.execute(ctx, item);
    expect(r.status).toBe("failed");
    expect(supplier.activeOrderCount).toBe(0);
  });

  it("cancels and refunds a booked item", async () => {
    const { executor } = setup();
    const r = await executor.execute(ctx, item);
    if (r.status !== "booked") throw new Error("expected booking");
    const { refundCents } = await executor.cancel({ ...item, status: "booked", booking: r.record });
    expect(refundCents).toBe(80_000);
  });
});
