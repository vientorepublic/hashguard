import type { Request } from 'express';
import { extractClientIp } from '../src/common/utils/proxy-ip.util';

// Builds a minimal Express-like request with a controllable socket IP and
// optional (potentially forged) forwarded headers.
function fakeRequest(
  socketIp: string,
  headers: Record<string, string | string[]> = {},
): Request {
  return {
    ip: socketIp,
    headers,
    socket: { remoteAddress: socketIp },
  } as unknown as Request;
}

describe('extractClientIp trust boundary', () => {
  it('in "none" mode ignores forged x-forwarded-for and falls back to the socket IP', () => {
    const req = fakeRequest('198.51.100.7', {
      'x-forwarded-for': '6.6.6.6, 198.51.100.7',
    });
    expect(extractClientIp(req, 'none')).toBe('198.51.100.7');
  });

  it('in "none" mode ignores a forged cf-connecting-ip header', () => {
    const req = fakeRequest('198.51.100.9', { 'cf-connecting-ip': '6.6.6.6' });
    expect(extractClientIp(req, 'none')).toBe('198.51.100.9');
  });

  it('defaults to "none" and therefore never trusts forwarded headers', () => {
    const req = fakeRequest('198.51.100.10', {
      'x-forwarded-for': '6.6.6.6',
      'cf-connecting-ip': '6.6.6.6',
    });
    expect(extractClientIp(req)).toBe('198.51.100.10');
  });

  it('in "cloudflare" mode trusts cf-connecting-ip over the socket IP', () => {
    const req = fakeRequest('10.0.0.1', { 'cf-connecting-ip': '203.0.113.5' });
    expect(extractClientIp(req, 'cloudflare')).toBe('203.0.113.5');
  });

  it('in "cloudflare" mode falls back to the socket IP when the header is absent', () => {
    const req = fakeRequest('10.0.0.1');
    expect(extractClientIp(req, 'cloudflare')).toBe('10.0.0.1');
  });

  it('in "x-forwarded-for" mode uses the first hop and ignores later hops', () => {
    const req = fakeRequest('10.0.0.1', {
      'x-forwarded-for': '203.0.113.8, 203.0.113.9',
    });
    expect(extractClientIp(req, 'x-forwarded-for')).toBe('203.0.113.8');
  });

  it('handles IPv6 addresses without collapsing a /64 into one key', () => {
    const a = extractClientIp(fakeRequest('2001:db8:1::1'), 'none');
    const b = extractClientIp(fakeRequest('2001:db8:1::2'), 'none');
    expect(a).toBe('2001:db8:1::1');
    expect(b).toBe('2001:db8:1::2');
    expect(a).not.toBe(b);
  });

  it('never returns an empty string even with a blank socket address', () => {
    const req = fakeRequest('', {});
    // req.ip is '' (falsy), so it falls back to the socket remote address.
    expect(extractClientIp(req, 'none')).toBe('');
  });
});
