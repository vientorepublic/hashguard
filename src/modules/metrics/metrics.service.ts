import { Inject, Injectable, Logger } from '@nestjs/common';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../redis/redis.module';

export interface PowMetricsSnapshot {
  challengesIssued: number;
  verificationsSuccess: number;
  verificationsFailure: number;
  avgSolveTimeMs: number | null;
  difficultyDistribution: Record<string, number>;
}

@Injectable()
export class MetricsService {
  private readonly logger = new Logger(MetricsService.name);

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async recordChallengeIssued(difficultyBits: number): Promise<void> {
    const pipeline = this.redis.pipeline();
    pipeline.incr('metrics:challenges:issued');
    pipeline.incr(`metrics:difficulty:${difficultyBits}`);
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

    // Collect difficulty distribution keys
    const diffKeys = await this.redis.keys('*metrics:difficulty:*');

    const diffDist: Record<string, number> = {};
    if (diffKeys.length > 0) {
      // Strip the keyPrefix (ioredis adds prefix to keys returned by KEYS command too? No — KEYS returns raw keys including prefix)
      // We need to strip prefix from keys before calling mget, because mget will add the prefix again.
      // Actually ioredis does NOT strip the prefix from KEYS results, but DOES add it on GET.
      // So we need to strip the prefix when calling other commands.
      const prefix = (this.redis.options.keyPrefix as string) ?? '';
      const strippedKeys = diffKeys.map((k) => k.slice(prefix.length));
      const vals = await this.redis.mget(...strippedKeys);
      strippedKeys.forEach((k, i) => {
        const bits = k.replace('metrics:difficulty:', '');
        diffDist[bits] = vals[i] ? parseInt(vals[i], 10) : 0;
      });
    }

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
