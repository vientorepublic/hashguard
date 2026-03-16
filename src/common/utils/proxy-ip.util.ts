import { Request } from 'express';

/**
 * Extracts the real client IP from a request.
 *
 * Priority:
 *  1. CF-Connecting-IP  (Cloudflare)
 *  2. X-Forwarded-For first hop
 *  3. Express req.ip (trust proxy already configured)
 *  4. socket remote address
 */
export function extractClientIp(req: Request): string {
  const cf = req.headers['cf-connecting-ip'];
  if (typeof cf === 'string' && cf.trim()) {
    return cf.trim();
  }

  const xff = req.headers['x-forwarded-for'];
  if (xff) {
    const raw = Array.isArray(xff) ? xff[0] : xff;
    const first = raw.split(',')[0].trim();
    if (first) return first;
  }

  if (req.ip) return req.ip;

  return req.socket?.remoteAddress ?? '0.0.0.0';
}
