import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { HealthCheck, HealthCheckService } from '@nestjs/terminus';
import { RedisHealthIndicator } from './redis-health.indicator';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly redisIndicator: RedisHealthIndicator,
  ) {}

  @Get()
  @HealthCheck()
  @ApiOperation({ summary: 'Readiness check (includes Redis connectivity)' })
  check() {
    return this.health.check([() => this.redisIndicator.isHealthy('redis')]);
  }

  @Get('liveness')
  @ApiOperation({
    summary: 'Liveness probe (always 200 if process is running)',
  })
  liveness() {
    return { status: 'ok' };
  }
}
