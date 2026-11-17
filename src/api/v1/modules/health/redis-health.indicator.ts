import { Inject, Injectable } from '@nestjs/common';
import { HealthIndicatorResult } from '@nestjs/terminus';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../../../../modules/redis/redis.module';

@Injectable()
export class RedisHealthIndicator {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async isHealthy(key: string): Promise<HealthIndicatorResult> {
    try {
      const pong = await this.redis.ping();
      if (pong !== 'PONG') {
        throw new Error('Redis ping failed');
      }
      return { [key]: { status: 'up' } };
    } catch (err) {
      throw new Error(
        `Redis health check failed: ${err instanceof Error ? err.message : 'unknown'}`,
        { cause: err },
      );
    }
  }
}
