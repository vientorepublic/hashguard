import { Inject, Injectable } from '@nestjs/common';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../../../../modules/redis/redis.module';

const DIFFICULTY_DISTRIBUTION_KEY = 'metrics:difficulty:distribution';

export interface PowMetricsSnapshot {
  challengesIssued: number;
  verificationsSuccess: number;
  verificationsFailure: number;
  avgSolveTimeMs: number | null;
  difficultyDistribution: Record<string, number>;
}

@Injectable()
export class MetricsService {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async recordChallengeIssued(difficultyBits: number): Promise<void> {
    const pipeline = this.redis.pipeline();
    pipeline.incr('metrics:challenges:issued');
    pipeline.hincrby(DIFFICULTY_DISTRIBUTION_KEY, difficultyBits.toString(), 1);
    await pipeline.exec();
  }

  async recordVerificationSuccess(
    solveTimeMs: number | undefined,
  ): Promise<void> {
    const pipeline = this.redis.pipeline();
    pipeline.incr('metrics:verifications:success');
    if (solveTimeMs != null && solveTimeMs > 0) {
      pipeline.incrby('metrics:solvetime:sum', Math.round(solveTimeMs));
      pipeline.incr('metrics:solvetime:count');
    }
    await pipeline.exec();
  }

  async recordVerificationFailure(): Promise<void> {
    await this.redis.incr('metrics:verifications:failure');
  }

  async getSnapshot(): Promise<PowMetricsSnapshot> {
    const [issued, success, failure, solveSum, solveCount] =
      await this.redis.mget(
        'metrics:challenges:issued',
        'metrics:verifications:success',
        'metrics:verifications:failure',
        'metrics:solvetime:sum',
        'metrics:solvetime:count',
      );

    const difficultyDistributionRaw = await this.redis.hgetall(
      DIFFICULTY_DISTRIBUTION_KEY,
    );
    const diffDist = Object.fromEntries(
      Object.entries(difficultyDistributionRaw).map(([bits, count]) => [
        bits,
        parseInt(count, 10),
      ]),
    );

    const sumVal = solveSum ? parseInt(solveSum, 10) : 0;
    const countVal = solveCount ? parseInt(solveCount, 10) : 0;

    return {
      challengesIssued: issued ? parseInt(issued, 10) : 0,
      verificationsSuccess: success ? parseInt(success, 10) : 0,
      verificationsFailure: failure ? parseInt(failure, 10) : 0,
      avgSolveTimeMs: countVal > 0 ? Math.round(sumVal / countVal) : null,
      difficultyDistribution: diffDist,
    };
  }
}
