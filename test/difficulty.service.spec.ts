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

function makeConfigWithRateTiers(
  base: number,
  max: number,
  rateTiersJson: string,
): ConfigService {
  return {
    get: (key: string) => {
      if (key === 'pow.baseDifficultyBits') return base;
      if (key === 'pow.maxDifficultyBits') return max;
      if (key === 'pow.rateTiersJson') return rateTiersJson;
      return undefined;
    },
  } as unknown as ConfigService;
}

function makeRateWindow(
  rpm: number,
  failRpm = 0,
  burstRpm = 0,
): RateWindowService {
  return {
    getChallengeRequestsPerMinute: jest.fn().mockResolvedValue(rpm),
    getFailureRatePerMinute: jest.fn().mockResolvedValue(failRpm),
    getBurstRequestsPerMinute: jest.fn().mockResolvedValue(burstRpm),
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

  it('should use burst rpm when it exceeds sustained rpm', async () => {
    // sustained rpm=2 (base tier), burstRpm=30 → tier +6 bits
    const svc = new DifficultyService(
      makeConfig(20, 32),
      makeRateWindow(2, 0, 30),
      hash,
    );
    const result = await svc.calculate('1.2.3.4');
    expect(result.difficultyBits).toBe(26); // base + 6 from burst tier
  });

  it('should use sustained rpm when it exceeds burst rpm', async () => {
    // sustained rpm=20 (tier +4), burstRpm=5 → sustained wins
    const svc = new DifficultyService(
      makeConfig(20, 32),
      makeRateWindow(20, 0, 5),
      hash,
    );
    const result = await svc.calculate('1.2.3.4');
    expect(result.difficultyBits).toBe(24); // base + 4
  });

  it('should accept custom rate tiers from config', () => {
    const tiersJson = JSON.stringify([
      { minRpm: 10, extraBits: 8 },
      { minRpm: 0, extraBits: 0 },
    ]);
    const config = makeConfigWithRateTiers(20, 32, tiersJson);
    const svc = new DifficultyService(config, makeRateWindow(10), hash);
    const result = svc.calculateFromSignals(10, 0);
    expect(result.difficultyBits).toBe(28); // base 20 + custom 8
  });

  it('should fall back to default tiers when POW_RATE_TIERS_JSON is malformed', () => {
    const svc = new DifficultyService(
      makeConfigWithRateTiers(20, 32, '{not-json}'),
      makeRateWindow(30),
      hash,
    );
    const result = svc.calculateFromSignals(30, 0);
    expect(result.difficultyBits).toBe(26); // default tier at 30 rpm gives +6
  });

  it('should fall back to default tiers when custom tiers are empty', () => {
    const svc = new DifficultyService(
      makeConfigWithRateTiers(20, 32, '[]'),
      makeRateWindow(20),
      hash,
    );
    const result = svc.calculateFromSignals(20, 0);
    expect(result.difficultyBits).toBe(24); // default tier at 20 rpm gives +4
  });

  it('should fall back to default tiers when minRpm=0 base tier is missing', () => {
    const svc = new DifficultyService(
      makeConfigWithRateTiers(
        20,
        32,
        JSON.stringify([{ minRpm: 10, extraBits: 5 }]),
      ),
      makeRateWindow(0),
      hash,
    );
    const result = svc.calculateFromSignals(0, 0);
    expect(result.difficultyBits).toBe(20); // default base tier
  });

  it('should throw when baseDifficultyBits is below supported range', () => {
    expect(
      () => new DifficultyService(makeConfig(0, 20), makeRateWindow(1), hash),
    ).toThrow(RangeError);
  });

  it('should throw when maxDifficultyBits is above supported range', () => {
    expect(
      () => new DifficultyService(makeConfig(20, 256), makeRateWindow(1), hash),
    ).toThrow(RangeError);
  });

  it('should throw when baseDifficultyBits exceeds maxDifficultyBits', () => {
    expect(
      () => new DifficultyService(makeConfig(30, 20), makeRateWindow(1), hash),
    ).toThrow(RangeError);
  });
});
