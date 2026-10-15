import { createHmac, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import type { Request } from 'express';
import { env } from '../../config/env.js';

export function verifiedVisitorIp(request: Request): string | null {
  const ip = request.get('x-eventgate-client-ip');
  const timestamp = request.get('x-eventgate-proxy-time');
  const signature = request.get('x-eventgate-proxy-signature');
  if (
    !env.BFF_PROXY_SECRET ||
    !ip ||
    !isIP(ip) ||
    !timestamp ||
    !/^\d{13}$/.test(timestamp) ||
    Math.abs(Date.now() - Number(timestamp)) > 30000 ||
    !signature ||
    !/^[a-f0-9]{64}$/.test(signature)
  )
    return null;
  const expected = createHmac('sha256', env.BFF_PROXY_SECRET)
    .update(`${timestamp}\n${request.method}\n${request.originalUrl}\n${ip}`)
    .digest();
  return timingSafeEqual(expected, Buffer.from(signature, 'hex')) ? ip : null;
}
