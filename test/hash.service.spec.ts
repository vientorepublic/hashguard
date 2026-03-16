import { HashService } from '../src/modules/pow/hash.service';

describe('HashService', () => {
  let svc: HashService;

  beforeEach(() => {
    svc = new HashService();
  });

  describe('computeTarget', () => {
    it('should produce a 64-char hex string', () => {
      expect(svc.computeTarget(20)).toHaveLength(64);
    });

    it('should have the correct number of leading zero bits', () => {
      const target = svc.computeTarget(20); // top 20 bits zero
      // First 2 bytes (4 hex chars) must be '0000'
      expect(target.slice(0, 4)).toBe('0000');
      // 3rd byte top nibble must be '0' (next 4 bits zero)
      expect(target.slice(4, 6)).toBe('0f');
    });

    it('should handle byte-aligned difficulties', () => {
      const target16 = svc.computeTarget(16);
      expect(target16.slice(0, 4)).toBe('0000');
      expect(target16[4]).not.toBe('0');
    });

    it('should produce a lower target for higher difficulty', () => {
      const t20 = svc.computeTarget(20);
      const t24 = svc.computeTarget(24);
      expect(t24 < t20).toBe(true);
    });

    it('should throw for out-of-range difficulty', () => {
      expect(() => svc.computeTarget(0)).toThrow(RangeError);
      expect(() => svc.computeTarget(256)).toThrow(RangeError);
    });
  });

  describe('verifyProof', () => {
    it('should accept a valid nonce', () => {
      // Use a very easy target (all ff) so any nonce passes
      const easyTarget = 'f'.repeat(64);
      expect(svc.verifyProof('id', 'seed', '0', easyTarget)).toBe(true);
    });

    it('should reject when hash exceeds target', () => {
      // Use all-zero target — almost impossible to satisfy
      const impossibleTarget = '0'.repeat(64);
      expect(svc.verifyProof('id', 'seed', '99999999', impossibleTarget)).toBe(
        false,
      );
    });

    it('should produce consistent results for the same inputs', () => {
      const target = svc.computeTarget(16);
      const r1 = svc.verifyProof('abc', 'def', '123', target);
      const r2 = svc.verifyProof('abc', 'def', '123', target);
      expect(r1).toBe(r2);
    });
  });
});
