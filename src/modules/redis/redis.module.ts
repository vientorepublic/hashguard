import { Global, Module, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ModuleRef } from '@nestjs/core';
import Redis from 'ioredis';

export const REDIS_CLIENT = Symbol('REDIS_CLIENT');

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
        });
      },
    },
  ],
  exports: [REDIS_CLIENT],
})
export class RedisModule implements OnApplicationShutdown {
  constructor(private readonly moduleRef: ModuleRef) {}

  async onApplicationShutdown(): Promise<void> {
    const client = this.moduleRef.get<Redis>(REDIS_CLIENT);
    await client.quit();
  }
}
