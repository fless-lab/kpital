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

export interface PaymentProvider {
  payout(p: PayoutRequest): Promise<PayoutResult>;
  collectFunds(p: CollectRequest): Promise<CollectResult>;
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
}
