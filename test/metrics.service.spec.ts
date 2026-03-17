import Redis from 'ioredis';
import { ConfigService } from '@nestjs/config';
import { MetricsService } from '../src/api/v1/modules/metrics/metrics.service';

const DIFFICULTY_DISTRIBUTION_KEY = 'metrics:difficulty:distribution';

type MockPipeline = {
  incr: jest.Mock;
  incrby: jest.Mock;
  exec: jest.Mock;
};

type MockRedis = {
  incr: jest.Mock;
  incrby: jest.Mock;
  eval: jest.Mock;
  mget: jest.Mock;
  hgetall: jest.Mock;
  pipeline: jest.Mock;
};

function makeRedisMocks(): { redis: Redis; mockRedis: MockRedis } {
  const pipeline: MockPipeline = {
    incr: jest.fn().mockReturnThis(),
    incrby: jest.fn().mockReturnThis(),
    exec: jest.fn().mockResolvedValue([]),
  };

  const mockRedis: MockRedis = {
    incr: jest.fn().mockResolvedValue(1),
    incrby: jest.fn().mockResolvedValue(1),
    eval: jest.fn().mockResolvedValue(1),
    mget: jest.fn().mockResolvedValue(['10', '7', '3', '3200', '8']),
    hgetall: jest.fn().mockResolvedValue({ '20': '3', '21': '4' }),
    pipeline: jest.fn().mockReturnValue(pipeline),
  };

  return {
    redis: mockRedis as unknown as Redis,
    mockRedis,
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
    const { redis, mockRedis } = makeRedisMocks();
    const service = new MetricsService(redis, makeConfig());

    await service.recordChallengeIssued(24);

    expect(mockRedis.incr).toHaveBeenCalledWith('metrics:challenges:issued');
    expect(mockRedis.eval).toHaveBeenCalledWith(
      expect.stringContaining("redis.call('HEXISTS'"),
      1,
      DIFFICULTY_DISTRIBUTION_KEY,
      '24',
      '64',
    );
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
    const { redis, mockRedis } = makeRedisMocks();
    const service = new MetricsService(redis, makeConfig(12));

    await service.recordChallengeIssued(25);

    expect(mockRedis.eval).toHaveBeenCalledWith(
      expect.any(String),
      1,
      DIFFICULTY_DISTRIBUTION_KEY,
      '25',
      '12',
    );
  });
});
