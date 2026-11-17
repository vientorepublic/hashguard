import { Global, Logger, Module, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ModuleRef } from '@nestjs/core';
import Redis from 'ioredis';

export const REDIS_CLIENT = Symbol('REDIS_CLIENT');
export const REDIS_SHUTDOWN_TIMEOUT_MS = 5_000;

@Global()
@Module({
  providers: [
    {
      provide: REDIS_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService): Redis => {
        return new Redis({
          host: config.get<string>('redis.host'),
          port: config.get<number>('redis.port'),
          password: config.get<string | undefined>('redis.password'),
          db: config.get<number>('redis.db'),
          keyPrefix: config.get<string>('redis.keyPrefix'),
          maxRetriesPerRequest: 3,
          enableReadyCheck: true,
          lazyConnect: false,
          // ioredis 6's default retryStrategy is exponential (50 × 2^(n-1), 5s cap)
          // with 30s TCP keepAlive. A transient Redis hiccup could then block a
          // command for ~15s (3 retries × 5s), stalling the E2E PoW tests past
          // their timeout. Bound each reconnect at 500ms so a hiccup can't hang
          // the event loop for seconds.
          retryStrategy: (times: number) => Math.min(times * 100, 500),
          keepAlive: 0,
        });
      },
    },
  ],
  exports: [REDIS_CLIENT],
})
export class RedisModule implements OnApplicationShutdown {
  private readonly logger = new Logger(RedisModule.name);

  constructor(private readonly moduleRef: ModuleRef) {}

  async onApplicationShutdown(): Promise<void> {
    const client = this.moduleRef.get<Redis>(REDIS_CLIENT);
    if (client.status === 'end') return;

    let timeout: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        client.quit(),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error('Redis QUIT timed out')),
            REDIS_SHUTDOWN_TIMEOUT_MS,
          );
          timeout.unref();
        }),
      ]);
      this.logger.log('Redis connection closed');
    } catch (error) {
      this.logger.warn(
        `Redis QUIT failed; disconnecting: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      if (timeout) clearTimeout(timeout);
      // Also disables reconnects when QUIT fails or Redis is unavailable.
      client.disconnect(false);
    }
  }
}
