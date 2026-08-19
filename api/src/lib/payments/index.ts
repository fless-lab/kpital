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

export interface PaymentProvider {
  payout(p: PayoutRequest): Promise<PayoutResult>;
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
}
