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
        return {
          [key]: { status: 'down', message: 'Redis ping did not return PONG' },
        };
      }
      return { [key]: { status: 'up' } };
    } catch (err) {
      // Return a DOWN status rather than throwing: terminus v12 routes a
      // returned 'down' to the failed-indicator list (-> 503), while a thrown
      // error bypasses that and surfaces as a 500 "Internal server error".
      return {
        [key]: {
          status: 'down',
          message: err instanceof Error ? err.message : 'unknown',
        },
      };
    }
  }
}
