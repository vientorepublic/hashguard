import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import configuration from './config/configuration';
import { validateEnvironment } from './config/env.validation';
import { HealthModule } from './api/v1/modules/health/health.module';
import { MetricsModule } from './api/v1/modules/metrics/metrics.module';
import { PowModule } from './api/v1/modules/pow/pow.module';
import { RedisModule } from './modules/redis/redis.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      load: [configuration],
      validate: validateEnvironment,
      isGlobal: true,
      envFilePath: ['.env', '.env.local'],
    }),
    RedisModule,
    PowModule,
    MetricsModule,
    HealthModule,
  ],
})
export class AppModule {}
