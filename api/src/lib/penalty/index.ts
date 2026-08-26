export interface PenaltyPolicy {
  // Penalty owed (integer FCFA) for a late installment. 0 today.
  penaltyFor(args: { installmentId: string; amountMinor: number; daysLate: number }): number;
}

export class NoPenaltyPolicy implements PenaltyPolicy {
  penaltyFor(_args: { installmentId: string; amountMinor: number; daysLate: number }): number {
    return 0;
  }
}
