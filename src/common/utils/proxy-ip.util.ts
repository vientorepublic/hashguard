import { Request } from 'express';

export type TrustedProxyMode = 'cloudflare' | 'x-forwarded-for' | 'none';

/**
 * Extracts the real client IP from a request.
 *
 * Header priority is mode-dependent:
 *  - cloudflare: CF-Connecting-IP, then req.ip
 *  - x-forwarded-for: first X-Forwarded-For hop, then req.ip
 *  - none: req.ip only
 */
export function extractClientIp(
  req: Request,
  mode: TrustedProxyMode = 'cloudflare',
): string {
  if (mode === 'cloudflare') {
    const cf = req.headers['cf-connecting-ip'];
    if (typeof cf === 'string' && cf.trim()) {
      return cf.trim();
    }
  }

  if (mode === 'x-forwarded-for') {
    const xff = req.headers['x-forwarded-for'];
    if (xff) {
      const raw = Array.isArray(xff) ? xff[0] : xff;
      const first = raw.split(',')[0].trim();
      if (first) return first;
    }
  }

  if (req.ip) return req.ip;

  return req.socket?.remoteAddress ?? '0.0.0.0';
}
