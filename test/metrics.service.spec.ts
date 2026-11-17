import { type Mock } from 'vitest';
import Redis from 'ioredis';
import { ConfigService } from '@nestjs/config';
import { MetricsService } from '../src/api/v1/modules/metrics/metrics.service';

const DIFFICULTY_DISTRIBUTION_KEY = 'metrics:difficulty:distribution';

type MockPipeline = {
  incr: Mock;
  incrby: Mock;
  eval: Mock;
  exec: Mock;
};

type MockRedis = {
  incr: Mock;
  incrby: Mock;
  eval: Mock;
  mget: Mock;
  hgetall: Mock;
  pipeline: Mock;
};

function makeRedisMocks(): {
  redis: Redis;
  mockRedis: MockRedis;
  pipeline: MockPipeline;
} {
  const pipeline: MockPipeline = {
    incr: vi.fn().mockReturnThis(),
    incrby: vi.fn().mockReturnThis(),
    eval: vi.fn().mockReturnThis(),
    exec: vi.fn().mockResolvedValue([]),
  };

  const mockRedis: MockRedis = {
    incr: vi.fn().mockResolvedValue(1),
    incrby: vi.fn().mockResolvedValue(1),
    eval: vi.fn().mockResolvedValue(1),
    mget: vi.fn().mockResolvedValue(['10', '7', '3', '3200', '8']),
    hgetall: vi.fn().mockResolvedValue({ '20': '3', '21': '4' }),
    pipeline: vi.fn().mockReturnValue(pipeline),
  };

  return {
    redis: mockRedis as unknown as Redis,
    mockRedis,
    pipeline,
  };
}

function makeConfig(maxDifficultyDistributionKeys = 64): ConfigService {
  return {
    get: (key: string) => {
      if (key === 'metrics.maxDifficultyDistributionKeys') {
        return maxDifficultyDistributionKeys;
      }
      return undefined;
    },
  } as unknown as ConfigService;
}

describe('MetricsService', () => {
  it('should cap difficulty distribution key count when recording challenge', async () => {
    const { redis, pipeline } = makeRedisMocks();
    const service = new MetricsService(redis, makeConfig());

    await service.recordChallengeIssued(24);

    expect(pipeline.incr).toHaveBeenCalledWith('metrics:challenges:issued');
    expect(pipeline.eval).toHaveBeenCalledWith(
      expect.stringContaining("redis.call('HEXISTS'"),
      1,
      DIFFICULTY_DISTRIBUTION_KEY,
      '24',
      '64',
    );
    expect(pipeline.exec).toHaveBeenCalled();
  });

  it('should build metrics snapshot from redis values', async () => {
    const { redis } = makeRedisMocks();
    const service = new MetricsService(redis, makeConfig());

    const snapshot = await service.getSnapshot();

    expect(snapshot).toEqual({
      challengesIssued: 10,
      verificationsSuccess: 7,
      verificationsFailure: 3,
      avgSolveTimeMs: 400,
      difficultyDistribution: {
        '20': 3,
        '21': 4,
      },
    });
  });

  it('should use configured distribution key cap value', async () => {
    const { redis, pipeline, mockRedis } = makeRedisMocks();
    const service = new MetricsService(redis, makeConfig(12));

    await service.recordChallengeIssued(25);

    expect(pipeline.eval).toHaveBeenCalledWith(
      expect.any(String),
      1,
      DIFFICULTY_DISTRIBUTION_KEY,
      '25',
      '12',
    );
    // Both counters must collapse into a single pipeline round-trip.
    expect(pipeline.exec).toHaveBeenCalledTimes(1);
    expect(mockRedis.incr).not.toHaveBeenCalled();
    expect(mockRedis.eval).not.toHaveBeenCalled();
  });
});
