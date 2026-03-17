import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../../../../modules/redis/redis.module';
import { INCR_DIFFICULTY_DISTRIBUTION_SCRIPT } from './scripts/incr-difficulty-distribution.script';

const METRICS_CONFIG_KEYS = {
  maxDifficultyDistributionKeys: 'metrics.maxDifficultyDistributionKeys',
} as const;

const METRIC_KEYS = {
  challengesIssued: 'metrics:challenges:issued',
  verificationsSuccess: 'metrics:verifications:success',
  verificationsFailure: 'metrics:verifications:failure',
  solveTimeSum: 'metrics:solvetime:sum',
  solveTimeCount: 'metrics:solvetime:count',
  difficultyDistribution: 'metrics:difficulty:distribution',
} as const;

const DEFAULT_MAX_DIFFICULTY_DISTRIBUTION_KEYS = 64;
const DISTRIBUTION_INCR_SCRIPT_KEY_COUNT = 1;

type MetricCounterValue = string | null;
type DifficultyDistributionRaw = Record<string, string>;

export interface PowMetricsSnapshot {
  challengesIssued: number;
  verificationsSuccess: number;
  verificationsFailure: number;
  avgSolveTimeMs: number | null;
  difficultyDistribution: Record<string, number>;
}

@Injectable()
export class MetricsService {
  private readonly maxDifficultyDistributionKeys: number;

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly config: ConfigService,
  ) {
    const configured = this.config.get<number>(
      METRICS_CONFIG_KEYS.maxDifficultyDistributionKeys,
    );
    this.maxDifficultyDistributionKeys =
      configured != null && configured > 0
        ? Math.floor(configured)
        : DEFAULT_MAX_DIFFICULTY_DISTRIBUTION_KEYS;
  }

  async recordChallengeIssued(difficultyBits: number): Promise<void> {
    await this.redis.incr(METRIC_KEYS.challengesIssued);
    await this.redis.eval(
      INCR_DIFFICULTY_DISTRIBUTION_SCRIPT,
      DISTRIBUTION_INCR_SCRIPT_KEY_COUNT,
      METRIC_KEYS.difficultyDistribution,
      difficultyBits.toString(),
      this.maxDifficultyDistributionKeys.toString(),
    );
  }

  async recordVerificationSuccess(
    solveTimeMs: number | undefined,
  ): Promise<void> {
    const pipeline = this.redis.pipeline();
    pipeline.incr(METRIC_KEYS.verificationsSuccess);
    if (solveTimeMs != null && solveTimeMs > 0) {
      pipeline.incrby(METRIC_KEYS.solveTimeSum, Math.round(solveTimeMs));
      pipeline.incr(METRIC_KEYS.solveTimeCount);
    }
    await pipeline.exec();
  }

  async recordVerificationFailure(): Promise<void> {
    await this.redis.incr(METRIC_KEYS.verificationsFailure);
  }

  async getSnapshot(): Promise<PowMetricsSnapshot> {
    const [
      issued,
      success,
      failure,
      solveSum,
      solveCount,
    ]: MetricCounterValue[] = await this.redis.mget(
      METRIC_KEYS.challengesIssued,
      METRIC_KEYS.verificationsSuccess,
      METRIC_KEYS.verificationsFailure,
      METRIC_KEYS.solveTimeSum,
      METRIC_KEYS.solveTimeCount,
    );

    const difficultyDistributionRaw: DifficultyDistributionRaw =
      await this.redis.hgetall(METRIC_KEYS.difficultyDistribution);
    const diffDist = this.parseDifficultyDistribution(
      difficultyDistributionRaw,
    );

    const sumVal = this.parseCounter(solveSum);
    const countVal = this.parseCounter(solveCount);

    return {
      challengesIssued: this.parseCounter(issued),
      verificationsSuccess: this.parseCounter(success),
      verificationsFailure: this.parseCounter(failure),
      avgSolveTimeMs: countVal > 0 ? Math.round(sumVal / countVal) : null,
      difficultyDistribution: diffDist,
    };
  }

  private parseCounter(value: MetricCounterValue): number {
    return value ? parseInt(value, 10) : 0;
  }

  private parseDifficultyDistribution(
    raw: DifficultyDistributionRaw,
  ): Record<string, number> {
    return Object.fromEntries(
      Object.entries(raw).map(([bits, count]) => [bits, parseInt(count, 10)]),
    );
  }
}
