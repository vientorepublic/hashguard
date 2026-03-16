import { Inject, Injectable } from '@nestjs/common';
import {
  HealthCheckError,
  HealthIndicator,
  HealthIndicatorResult,
} from '@nestjs/terminus';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../redis/redis.module';

@Injectable()
export class RedisHealthIndicator extends HealthIndicator {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {
    super();
  }

  async isHealthy(key: string): Promise<HealthIndicatorResult> {
    try {
      const pong = await this.redis.ping();
      const up = pong === 'PONG';
      const result = this.getStatus(key, up);
      if (!up) throw new HealthCheckError('Redis ping failed', result);
      return result;
    } catch (err) {
      const result = this.getStatus(key, false, {
        message: err instanceof Error ? err.message : 'unknown',
      });
      throw new HealthCheckError('Redis health check failed', result);
    }
  }
}
