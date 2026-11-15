import { HttpException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { createHash, createHmac, randomUUID } from 'crypto';
import Redis from 'ioredis';
import { AppModule } from '../src/app.module';
import { PowService } from '../src/api/v1/modules/pow/pow.service';
import { AdaptiveRiskService } from '../src/api/v1/modules/pow/adaptive-risk.service';
import { REDIS_CLIENT } from '../src/modules/redis/redis.module';

// Uses a real Redis instance; all keys live under a unique, expiring test prefix.
describe('Adaptive policy with Redis', () => {
  let module: TestingModule;
  let pow: PowService;
  let risk: AdaptiveRiskService;
  let redis: Redis;
  const secret = 'adaptive-test-secret-at-least-32-characters';
  const savedEnv = { ...process.env };
  beforeAll(async () => {
    Object.assign(process.env, {
      REDIS_KEY_PREFIX: `hg-test:${randomUUID()}:`,
      POW_RISK_KEY_SECRET: secret,
      POW_BASE_DIFFICULTY_BITS: '4',
      POW_MAX_DIFFICULTY_BITS: '12',
      POW_MIN_SOLVE_TIME_MS: '0',
      POW_MAX_CHALLENGE_RPM: '60',
      POW_SOFT_LIMIT_UNITS: '30',
      POW_HARD_LIMIT_UNITS: '120',
      POW_BURST_SOFT_LIMIT_UNITS: '5',
      POW_BURST_HARD_LIMIT_UNITS: '30',
      POW_MAX_VERIFICATION_RPM: '120',
      POW_CHALLENGE_RISK_THRESHOLD: '20',
      POW_CONTEXT_COSTS_JSON: '{"search":3,"query":5,"export":20}',
    });
    module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    pow = module.get(PowService);
    risk = module.get(AdaptiveRiskService);
    redis = module.get(REDIS_CLIENT);
    await redis.ping();
  });
  afterAll(async () => {
    if (module) await module.close();
    process.env = savedEnv;
  });

  it('allows low risk without work and consumes the assertion exactly once', async () => {
    const result = await pow.assessRequest(
      { context: 'search' },
      '198.51.100.1',
    );
    expect(result.action).toBe('allow');
    if (result.action !== 'allow') throw new Error('Expected allow');
    expect(
      await pow.introspectToken({ proofToken: result.verification.proofToken }),
    ).toMatchObject({ valid: true, context: 'search' });
    await expect(
      pow.introspectToken({ proofToken: result.verification.proofToken }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('switches a burst to work, solves it, and accepts only one concurrent verification', async () => {
    for (let i = 0; i < 15; i++) await risk.assess('198.51.100.2', '');
    const result = await pow.assessRequest(
      { context: 'query' },
      '198.51.100.2',
    );
    expect(result.action).toBe('challenge');
    if (result.action !== 'challenge') throw new Error('Expected challenge');
    const c = result.challenge;
    let nonce = 0;
    while (
      createHash('sha256')
        .update(`${c.challengeId}:${c.seed}:${nonce}`)
        .digest('hex') > c.target
    )
      nonce++;
    const results = await Promise.allSettled([
      pow.verifyChallenge(
        { challengeId: c.challengeId, nonce: String(nonce) },
        '198.51.100.2',
      ),
      pow.verifyChallenge(
        { challengeId: c.challengeId, nonce: String(nonce) },
        '198.51.100.2',
      ),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });

  it('keeps hard limits atomic across concurrent assessments and context changes', async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 80 }, (_, i) =>
        pow.assessRequest({ context: `rotating-${i}` }, '198.51.100.3'),
      ),
    );
    expect(
      results.filter((r) => r.status === 'fulfilled').length,
    ).toBeLessThanOrEqual(60);
    expect(
      results.some(
        (r) =>
          r.status === 'rejected' &&
          r.reason instanceof HttpException &&
          r.reason.getStatus() === 429,
      ),
    ).toBe(true);
  });

  it('decays old verification failures instead of permanently challenging a client', async () => {
    const ip = '198.51.100.4';
    for (let i = 0; i < 6; i++) await risk.recordFailure(ip);
    expect((await risk.assess(ip, '')).challengeRequired).toBe(true);
    const key = `risk:${createHmac('sha256', secret)
      .update('ip\0' + ip)
      .digest('hex')}`;
    const [seconds] = await redis.time();
    await redis.hset(key, 'failedAt', String(Number(seconds) - 1800));
    expect((await risk.assess(ip, '')).challengeRequired).toBe(false);
  });

  it('preserves previous-window burst history at a boundary', async () => {
    const ip = '198.51.100.5';
    const key = `risk:${createHmac('sha256', secret)
      .update('ip\0' + ip)
      .digest('hex')}`;
    const [seconds] = await redis.time();
    await redis.hset(
      key,
      'burst:epoch',
      String(Math.floor(Number(seconds) / 5) - 1),
      'burst:current',
      '1000000000',
    );
    // History affects risk, while hard limits are checked by separate buckets.
    expect((await risk.assess(ip, 'export')).challengeRequired).toBe(true);
  });

  it('does not reset hard buckets at a fixed-window boundary or partially debit on rejection', async () => {
    const ip = '198.51.100.6';
    const key = `risk:${createHmac('sha256', secret)
      .update('ip\0' + ip)
      .digest('hex')}`;
    const [seconds, micros] = await redis.time();
    const now = Number(seconds) + Number(micros) / 1e6;
    await redis.hset(
      key,
      'hard:units:tokens',
      '0',
      'hard:units:at',
      String(now),
    );
    await expect(risk.assess(ip, 'export')).rejects.toMatchObject({
      status: 429,
    });
    expect(Number(await redis.hget(key, 'hard:requests:tokens'))).toBe(60);
    expect(Number(await redis.hget(key, 'hard:burst:tokens'))).toBe(30);
  });
});
