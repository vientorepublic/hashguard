import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { AdaptiveRiskService } from '../src/api/v1/modules/pow/adaptive-risk.service';
import { DifficultyService } from '../src/api/v1/modules/pow/difficulty.service';
import { HashService } from '../src/api/v1/modules/pow/hash.service';
import { RateWindowService } from '../src/api/v1/modules/pow/store/rate-window.service';

// Redis responses represent measured traffic; these tests exercise policy decisions.
describe('Adaptive policy', () => {
  const config = new ConfigService({
    pow: {
      riskKeySecret: 'test-secret',
      contextCostsJson: '{"search":3}',
      baseDifficultyBits: 16,
      maxDifficultyBits: 24,
    },
  });
  const evalMock = jest.fn<
    Promise<string[]>,
    [string, number, string, string, number, number, number, number, number]
  >();
  const risk = new AdaptiveRiskService(
    { eval: evalMock } as unknown as Redis,
    config,
  );
  beforeEach(() => evalMock.mockReset());

  it('allows a new IP without work and never stores its raw address in a risk key', async () => {
    evalMock.mockResolvedValue(['1', '1', '1', '0', '0', '1']);
    expect(await risk.assess('203.0.113.1', '')).toEqual({
      riskScore: 0,
      challengeRequired: false,
    });
    expect(evalMock.mock.calls[0][2]).toMatch(/^risk:[a-f0-9]{64}$/);
    expect(evalMock.mock.calls[0][2]).not.toContain('203.0.113.1');
  });

  it('does not challenge an isolated expensive request solely because of its cost', async () => {
    const service = new AdaptiveRiskService(
      { eval: evalMock } as unknown as Redis,
      new ConfigService({
        pow: {
          riskKeySecret: 'test-secret',
          contextCostsJson: '{"export":20}',
        },
      }),
    );
    evalMock.mockResolvedValue(['1', '20', '20', '0', '0', '1']);
    expect(
      (await service.assess('203.0.113.1', 'export')).challengeRequired,
    ).toBe(false);
  });

  it('challenges a burst and raises difficulty further with sustained traffic and failures', async () => {
    evalMock.mockResolvedValueOnce(['16', '18', '18', '0', '0', '1']);
    const burst = await risk.assess('203.0.113.1', 'search');
    expect(burst.challengeRequired).toBe(true);
    expect(evalMock.mock.calls[0].slice(3, 5)).toEqual(['request', 3]);
    evalMock.mockResolvedValueOnce(['30', '100', '25', '5', '0', '1']);
    const attack = await risk.assess('203.0.113.1', '');
    const difficulty = new DifficultyService(
      config,
      {} as RateWindowService,
      new HashService(),
    );
    expect(
      difficulty.calculateFromRisk(attack.riskScore).difficultyBits,
    ).toBeGreaterThan(
      difficulty.calculateFromRisk(burst.riskScore).difficultyBits,
    );
    expect(
      difficulty.calculateFromRisk(100).difficultyBits,
    ).toBeLessThanOrEqual(24);
  });

  it('does not reset counters by changing context; hard limits override the decision', async () => {
    evalMock.mockResolvedValue(['61', '61', '1', '0', '0', '0']);
    await expect(
      risk.assess('203.0.113.1', 'new-context'),
    ).rejects.toMatchObject({ status: 429 });
  });

  it('limits verification before a challenge lookup', async () => {
    evalMock.mockResolvedValue(['0', '0', '0', '0', '121', '0']);
    await expect(
      risk.checkVerificationRate('203.0.113.1'),
    ).rejects.toMatchObject({ status: 429 });
  });

  it('fails closed on Redis errors or malformed replies', async () => {
    evalMock
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(['bad']);
    await expect(risk.assess('203.0.113.1', '')).rejects.toMatchObject({
      status: 503,
    });
    await expect(risk.assess('203.0.113.1', '')).rejects.toMatchObject({
      status: 503,
    });
  });
});
