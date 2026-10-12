import { describe, it, expect } from 'vitest';
import { paymentReturnUrl } from '../src/modules/payments/payment-return.js';
describe('payment return destinations', () => {
  it('binds redirects to configured frontend and known order', () => {
    expect(paymentReturnUrl('https://frontend.example/', 'SUCCESS', 'order-1')).toBe(
      'https://frontend.example/payment/success?orderId=order-1',
    );
    expect(paymentReturnUrl('https://frontend.example/', 'CANCEL', 'order-1')).toBe(
      'https://frontend.example/payment/cancel?orderId=order-1',
    );
  });
  it('routes unknown transactions to generic status, not another order', () => {
    expect(paymentReturnUrl('https://frontend.example/', 'SUCCESS', null)).toBe(
      'https://frontend.example/payment/status',
    );
    expect(paymentReturnUrl('https://frontend.example/', 'FAIL', null)).toBe(
      'https://frontend.example/payment/status',
    );
  });
});
