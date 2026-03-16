import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { MetricsService } from './metrics.service';

@ApiTags('metrics')
@Controller('metrics')
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Get('pow')
  @ApiOperation({ summary: 'Current PoW operational metrics snapshot' })
  getMetrics() {
    return this.metrics.getSnapshot();
  }
}
