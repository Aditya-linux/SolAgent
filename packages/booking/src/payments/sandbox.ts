import {
  formatUsd,
  newId,
  type Category,
  type Cents,
  type PaymentGateway,
  type PaymentReceipt,
  type SpendAuthorization,
  type SpendRequest,
} from "@solagent/shared";

/**
 * Off-chain stand-in for the payments & wallet layer, so planning and booking
 * can be built and demoed before the Solana program is ready. It enforces the
 * same kinds of rules the real layer will (category caps, daily limit, merchant
 * allowlist, human approval above a threshold) but moves no money.
 *
 * The real implementation only has to satisfy PaymentGateway from @solagent/shared.
 */

export interface SpendingRules {
  /** Max total spend per category for the trip (usually the plan's envelopes). */
  categoryCapsCents?: Partial<Record<Category, Cents>>;
  /** Max authorized + captured per UTC day. */
  dailyLimitCents?: Cents;
  /** Only these merchants (supplier names) can be paid. */
  merchantAllowlist?: string[];
  /** Spends at or below this are pre-approved; above it the user must sign. */
  autoApproveUpToCents?: Cents;
}

interface AuthRecord extends SpendAuthorization {
  request: SpendRequest;
  createdAt: string;
  state: "pending_user" | "authorized" | "captured" | "voided" | "rejected";
}

export class SandboxPaymentGateway implements PaymentGateway {
  private readonly rules = new Map<string, SpendingRules>();
  private readonly auths = new Map<string, AuthRecord>();
  private readonly byIdempotencyKey = new Map<string, string>();
  private readonly receipts = new Map<string, PaymentReceipt & { refundedCents: Cents }>();

  setRules(tripId: string, rules: SpendingRules): void {
    this.rules.set(tripId, rules);
  }

  getRules(tripId: string): SpendingRules {
    return this.rules.get(tripId) ?? {};
  }

  /** Money held or spent for a trip: authorized + pending + captured. */
  private outstanding(tripId: string, filter: (a: AuthRecord) => boolean = () => true): Cents {
    let total = 0;
    for (const a of this.auths.values()) {
      if (a.request.tripId !== tripId || !filter(a)) continue;
      if (a.state === "authorized" || a.state === "captured" || a.state === "pending_user") total += a.amountCents;
    }
    return total;
  }

  async authorize(req: SpendRequest): Promise<SpendAuthorization> {
    const existingId = this.byIdempotencyKey.get(req.idempotencyKey);
    const existing = existingId ? this.auths.get(existingId) : undefined;
    if (existing && existing.state !== "voided" && existing.state !== "rejected") return publicView(existing);

    const rules = this.getRules(req.tripId);
    const reject = (reason: string) => this.record(req, "rejected", reason);

    if (req.amountCents <= 0) return reject("Amount must be positive");
    if (rules.merchantAllowlist && !rules.merchantAllowlist.includes(req.merchant)) {
      return reject(`Merchant "${req.merchant}" is not on the allowlist`);
    }
    const cap = rules.categoryCapsCents?.[req.category];
    if (cap !== undefined) {
      const spent = this.outstanding(req.tripId, (a) => a.request.category === req.category);
      if (spent + req.amountCents > cap) {
        return reject(
          `${req.category} cap ${formatUsd(cap)} exceeded (${formatUsd(spent)} already committed, ${formatUsd(req.amountCents)} requested)`,
        );
      }
    }
    if (rules.dailyLimitCents !== undefined) {
      const today = new Date().toISOString().slice(0, 10);
      const spentToday = this.outstanding(req.tripId, (a) => a.createdAt.startsWith(today));
      if (spentToday + req.amountCents > rules.dailyLimitCents) {
        return reject(`Daily limit ${formatUsd(rules.dailyLimitCents)} exceeded`);
      }
    }
    const needsUser = rules.autoApproveUpToCents !== undefined && req.amountCents > rules.autoApproveUpToCents;
    return this.record(req, needsUser ? "pending_user" : "authorized", needsUser ? "Above auto-approve limit" : undefined);
  }

  /** The user signed the request (in the real layer: a wallet signature). */
  async approvePending(authorizationId: string): Promise<SpendAuthorization> {
    const a = this.auths.get(authorizationId);
    if (!a) throw new Error(`Unknown authorization ${authorizationId}`);
    if (a.state === "pending_user") {
      a.state = "authorized";
      a.status = "authorized";
      a.reason = undefined;
    }
    return publicView(a);
  }

  async getAuthorization(authorizationId: string): Promise<SpendAuthorization | undefined> {
    const a = this.auths.get(authorizationId);
    return a && publicView(a);
  }

  async capture(authorizationId: string, finalAmountCents: Cents): Promise<PaymentReceipt> {
    const a = this.auths.get(authorizationId);
    // Idempotent: capturing an already-captured hold returns the original receipt.
    const prior = [...this.receipts.values()].find((r) => r.authorizationId === authorizationId);
    if (a?.state === "captured" && prior) return prior;
    if (!a || a.state !== "authorized") throw new Error(`Authorization ${authorizationId} is not capturable`);
    if (finalAmountCents > a.amountCents) {
      throw new Error(`Capture ${formatUsd(finalAmountCents)} exceeds authorized ${formatUsd(a.amountCents)}`);
    }
    a.state = "captured";
    a.amountCents = finalAmountCents;
    const receipt = {
      id: newId("rcpt"),
      authorizationId,
      amountCents: finalAmountCents,
      txRef: newId("sandbox_tx"),
      settledAt: new Date().toISOString(),
      refundedCents: 0,
    };
    this.receipts.set(receipt.id, receipt);
    return receipt;
  }

  async void(authorizationId: string): Promise<void> {
    const a = this.auths.get(authorizationId);
    if (a && (a.state === "authorized" || a.state === "pending_user")) a.state = "voided";
  }

  async refund(receiptId: string, amountCents: Cents): Promise<PaymentReceipt> {
    const r = this.receipts.get(receiptId);
    if (!r) throw new Error(`Unknown receipt ${receiptId}`);
    const refundable = r.amountCents - r.refundedCents;
    const amount = Math.min(amountCents, refundable);
    r.refundedCents += amount;
    const a = this.auths.get(r.authorizationId);
    if (a) a.amountCents -= amount;
    return {
      id: newId("rfnd"),
      authorizationId: r.authorizationId,
      amountCents: amount,
      txRef: newId("sandbox_tx"),
      settledAt: new Date().toISOString(),
    };
  }

  private record(req: SpendRequest, state: AuthRecord["state"], reason?: string): SpendAuthorization {
    const status = state === "rejected" ? "rejected" : state === "pending_user" ? "pending_user" : "authorized";
    const rec: AuthRecord = {
      id: newId("auth"),
      status,
      amountCents: req.amountCents,
      reason,
      request: req,
      createdAt: new Date().toISOString(),
      state,
    };
    this.auths.set(rec.id, rec);
    this.byIdempotencyKey.set(req.idempotencyKey, rec.id);
    return publicView(rec);
  }
}

function publicView(a: AuthRecord): SpendAuthorization {
  return { id: a.id, status: a.status, amountCents: a.amountCents, reason: a.reason };
}
