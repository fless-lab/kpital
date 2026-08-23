export type PayoutMethod = { type: string; [k: string]: unknown };

export interface PayoutRequest {
  accountId: string;
  amountMinor: number;
  method: PayoutMethod;
}

export interface PayoutResult {
  ok: boolean;
  ref: string;
}

export interface CollectRequest {
  accountId: string;
  amountMinor: number;
  // Optional: an investor paying from a saved instrument may not pass one.
  method?: PayoutMethod;
}

export interface CollectResult {
  ok: boolean;
  ref: string;
}

export interface DepositRequest {
  accountId: string;
  amountMinor: number;
  method?: PayoutMethod;
  idempotencyKey: string;
}

export interface DepositResult {
  ok: boolean;
  ref: string;
  status: "pending" | "settled";
}

export interface ReleaseRequest {
  depositRef: string;
  payeeAccountId: string;
  amountMinor: number;
  idempotencyKey: string;
}

export interface RefundRequest {
  depositRef: string;
  amountMinor: number;
  idempotencyKey: string;
}

export interface EscrowMoveResult {
  ok: boolean;
  ref: string;
}

export interface PaymentProvider {
  payout(p: PayoutRequest): Promise<PayoutResult>;
  collectFunds(p: CollectRequest): Promise<CollectResult>; // kept until Task 4
  initiateDeposit(p: DepositRequest): Promise<DepositResult>;
  releaseEscrow(p: ReleaseRequest): Promise<EscrowMoveResult>;
  refundEscrow(p: RefundRequest): Promise<EscrowMoveResult>;
}

// Deterministic mock payout: succeeds and returns a monotonically increasing
// ref. A counter (not Date.now/Math.random) keeps refs unique and stable so
// concurrent withdrawals in a test never collide on the same reference string.
export class MockPaymentProvider implements PaymentProvider {
  private seq = 0;

  async payout(_p: PayoutRequest): Promise<PayoutResult> {
    this.seq += 1;
    return { ok: true, ref: `mock-payout-${this.seq}` };
  }

  // Deterministic mock collection: always succeeds. A per-instance counter (not
  // Date.now/Math.random) keeps refs unique and stable so concurrent
  // investments in a test never collide on the same reference string.
  async collectFunds(_p: CollectRequest): Promise<CollectResult> {
    this.collectSeq += 1;
    return { ok: true, ref: `mock-collect-${this.collectSeq}` };
  }

  private collectSeq = 0;

  depositMode: "settled" | "pending" = "settled";
  private depositSeq = 0;
  private releaseSeq = 0;
  private refundSeq = 0;
  // Deterministic idempotency: a replayed key returns the prior result, never a
  // new ref, mirroring how a real provider dedupes by idempotency key.
  private memo = new Map<string, { ref: string; status?: "pending" | "settled" }>();

  async initiateDeposit(p: DepositRequest): Promise<DepositResult> {
    const prior = this.memo.get(p.idempotencyKey);
    if (prior) return { ok: true, ref: prior.ref, status: prior.status ?? "settled" };
    this.depositSeq += 1;
    const ref = `mock-deposit-${this.depositSeq}`;
    this.memo.set(p.idempotencyKey, { ref, status: this.depositMode });
    return { ok: true, ref, status: this.depositMode };
  }

  async releaseEscrow(p: ReleaseRequest): Promise<EscrowMoveResult> {
    const prior = this.memo.get(p.idempotencyKey);
    if (prior) return { ok: true, ref: prior.ref };
    this.releaseSeq += 1;
    const ref = `mock-release-${this.releaseSeq}`;
    this.memo.set(p.idempotencyKey, { ref });
    return { ok: true, ref };
  }

  async refundEscrow(p: RefundRequest): Promise<EscrowMoveResult> {
    const prior = this.memo.get(p.idempotencyKey);
    if (prior) return { ok: true, ref: prior.ref };
    this.refundSeq += 1;
    const ref = `mock-refund-${this.refundSeq}`;
    this.memo.set(p.idempotencyKey, { ref });
    return { ok: true, ref };
  }
}
