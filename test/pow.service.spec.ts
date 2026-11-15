import { ConfigService } from '@nestjs/config';
import { PowService } from '../src/api/v1/modules/pow/pow.service';
import { HashService } from '../src/api/v1/modules/pow/hash.service';
import { StoredChallenge } from '../src/api/v1/modules/pow/pow.types';

describe('Adaptive PoW flow', () => {
  function setup() {
    const challenge: StoredChallenge = {
      id: 'test',
      seed: 'seed',
      algorithm: 'sha256',
      difficultyBits: 1,
      targetHex: 'f'.repeat(64),
      clientIp: 'ip',
      context: 'search',
      issuedAt: Date.now() - 100,
      expiresAt: Date.now() + 10000,
    };
    const store = {
      findById: jest.fn().mockResolvedValue(challenge),
      consume: jest.fn().mockResolvedValue(true),
      save: jest.fn(),
    };
    const rates = {
      incrementChallengeAndGetRates: jest
        .fn()
        .mockResolvedValue({ rpm: 1, failRpm: 0, burstRpm: 1 }),
    };
    const risk = {
      assess: jest
        .fn()
        .mockResolvedValue({ riskScore: 0, challengeRequired: false }),
      checkVerificationRate: jest.fn(),
      recordFailure: jest.fn(),
    };
    const token = {
      issue: jest
        .fn()
        .mockReturnValue({ token: 'signed', expiresAt: Date.now() + 10000 }),
    };
    const metrics = {
      recordVerificationSuccess: jest.fn(),
      recordChallengeIssued: jest.fn(),
    };
    const difficulty = {
      calculateFromSignals: jest
        .fn()
        .mockReturnValue({ difficultyBits: 16, targetHex: 'f'.repeat(64) }),
      calculateFromRisk: jest
        .fn()
        .mockReturnValue({ difficultyBits: 18, targetHex: '0'.repeat(64) }),
    };
    const svc = new PowService(
      new ConfigService({
        pow: {
          minSolveTimeMs: 0,
          challengeTtlSeconds: 300,
          maxChallengeRpm: 60,
        },
      }),
      store as never,
      rates as never,
      difficulty as never,
      new HashService(),
      token as never,
      metrics as never,
      risk as never,
    );
    return { svc, store, risk, token, challenge };
  }
  it('returns an assertion without allocating a challenge for low risk', async () => {
    const { svc, store } = setup();
    expect(await svc.assessRequest({ context: 'search' }, 'ip')).toMatchObject({
      action: 'allow',
      verification: { proofToken: 'signed' },
    });
    expect(store.save).not.toHaveBeenCalled();
  });
  it('issues work without issuing a token when risk is high', async () => {
    const { svc, risk, token, store } = setup();
    risk.assess.mockResolvedValue({ riskScore: 30, challengeRequired: true });
    expect(await svc.assessRequest({ context: 'search' }, 'ip')).toMatchObject({
      action: 'challenge',
      challenge: { difficultyBits: 18 },
    });
    expect(store.save).toHaveBeenCalled();
    expect(token.issue).not.toHaveBeenCalled();
  });
  it('keeps the explicit-work endpoint at least as difficult as the risk policy', async () => {
    const { svc, risk } = setup();
    risk.assess.mockResolvedValue({ riskScore: 60, challengeRequired: true });
    expect(
      (await svc.issueChallenge({ context: 'search' }, 'ip')).difficultyBits,
    ).toBe(18);
  });

  it('issues only one token when concurrent verifications race to consume', async () => {
    const { svc, store, token } = setup();
    store.consume.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const results = await Promise.allSettled([
      svc.verifyChallenge({ challengeId: 'test', nonce: '0' }, 'ip'),
      svc.verifyChallenge({ challengeId: 'test', nonce: '0' }, 'ip'),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(token.issue).toHaveBeenCalledTimes(1);
  });
  it('checks explicit expiry even if Redis retains a stale record', async () => {
    const { svc, challenge, token } = setup();
    challenge.expiresAt = Date.now();
    await expect(
      svc.verifyChallenge({ challengeId: 'test', nonce: '0' }, 'ip'),
    ).rejects.toMatchObject({ status: 404 });
    expect(token.issue).not.toHaveBeenCalled();
  });
});
