// payment.v1 -> the penalty ChargeGateway. payment runs the 3 phases (claim, gateway call outside
// any unit with key "<requestId>-<attempt>", write-back); penalty reuses its own id as requestId,
// so a retry reconciles the same gateway intent and never charges twice.
import type { PaymentV1 } from '@lazytax/payment-contract/v1';
import type { ChargeGateway, ChargeOutcome, PenaltyDto } from '../domain/model';

export const paymentGateway = (payment: PaymentV1): ChargeGateway => ({
  async charge(p: PenaltyDto): Promise<ChargeOutcome> {
    const r = await payment.charge(
      p.id,
      p.userId,
      p.amountCents,
      p.currency,
      'penalty',
      `Habit penalty ${p.habitExecutionId}`,
    );
    switch (r.status) {
      case 'succeeded':
        return { kind: 'succeeded', paymentIntentId: r.intentId ?? p.id };
      case 'pending':
        return { kind: 'pending', paymentIntentId: r.intentId, status: r.detail ?? 'pending' };
      case 'no_consent':
        return { kind: 'noConsent' };
      case 'declined':
        return { kind: 'error', message: r.detail ?? 'declined' };
    }
  },
});
