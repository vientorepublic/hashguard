import { ConfigService } from '@nestjs/config';
import { HashService } from '../src/api/v1/modules/pow/hash.service';
import { DifficultyService } from '../src/api/v1/modules/pow/difficulty.service';
import { RateWindowService } from '../src/api/v1/modules/pow/store/rate-window.service';

function makeConfig(base = 20, max = 26): ConfigService {
  return {
    get: (key: string) => {
      if (key === 'pow.baseDifficultyBits') return base;
      if (key === 'pow.maxDifficultyBits') return max;
      return undefined;
    },
  } as unknown as ConfigService;
}

function makeRateWindow(rpm: number, failRpm = 0): RateWindowService {
  return {
    getChallengeRequestsPerMinute: jest.fn().mockResolvedValue(rpm),
    getFailureRatePerMinute: jest.fn().mockResolvedValue(failRpm),
  } as unknown as RateWindowService;
}

describe('DifficultyService', () => {
  const hash = new HashService();

  it('should return base difficulty when request rate is low', async () => {
    const svc = new DifficultyService(
      makeConfig(20, 26),
      makeRateWindow(2),
      hash,
    );
    const result = await svc.calculate('1.2.3.4');
    expect(result.difficultyBits).toBe(20);
  });

  it('should increase difficulty at 5 rpm', async () => {
    const svc = new DifficultyService(
      makeConfig(20, 26),
      makeRateWindow(5),
      hash,
    );
    const result = await svc.calculate('1.2.3.4');
    expect(result.difficultyBits).toBe(21); // base + 1
  });

  it('should increase difficulty at 10 rpm', async () => {
    const svc = new DifficultyService(
      makeConfig(20, 26),
      makeRateWindow(10),
      hash,
    );
    const result = await svc.calculate('1.2.3.4');
    expect(result.difficultyBits).toBe(22); // base + 2
  });

  it('should increase difficulty at 20 rpm', async () => {
    const svc = new DifficultyService(
      makeConfig(20, 26),
      makeRateWindow(20),
      hash,
    );
    const result = await svc.calculate('1.2.3.4');
    expect(result.difficultyBits).toBe(24); // base + 4
  });

  it('should reach max difficulty at 30+ rpm', async () => {
    const svc = new DifficultyService(
      makeConfig(20, 26),
      makeRateWindow(35),
      hash,
    );
    const result = await svc.calculate('1.2.3.4');
    expect(result.difficultyBits).toBe(26); // base + 6 = 26, capped at max
  });

  it('should never exceed maxDifficultyBits', async () => {
    const svc = new DifficultyService(
      makeConfig(20, 22),
      makeRateWindow(100, 100),
      hash,
    );
    const result = await svc.calculate('1.2.3.4');
    expect(result.difficultyBits).toBeLessThanOrEqual(22);
  });

  it('should add failure rate penalty', async () => {
    // failRpm=5 → +2 bits
    const svc = new DifficultyService(
      makeConfig(20, 26),
      makeRateWindow(0, 5),
      hash,
    );
    const result = await svc.calculate('1.2.3.4');
    expect(result.difficultyBits).toBe(22); // base + 0 + 2
  });

  it('should return a valid 64-char target hex', async () => {
    const svc = new DifficultyService(
      makeConfig(20, 26),
      makeRateWindow(0),
      hash,
    );
    const result = await svc.calculate('1.2.3.4');
    expect(result.targetHex).toHaveLength(64);
    expect(/^[0-9a-f]{64}$/.test(result.targetHex)).toBe(true);
  });
});
