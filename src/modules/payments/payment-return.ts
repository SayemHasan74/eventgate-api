export function paymentReturnUrl(
  frontendUrl: string,
  type: 'SUCCESS' | 'FAIL' | 'CANCEL',
  orderId: string | null,
) {
  const path = !orderId
    ? '/payment/status'
    : type === 'SUCCESS'
      ? '/payment/success'
      : '/payment/cancel';
  const url = new URL(path, frontendUrl);
  if (orderId) url.searchParams.set('orderId', orderId);
  return url.toString();
}
