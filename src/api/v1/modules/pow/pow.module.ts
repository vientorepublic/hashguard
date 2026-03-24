import { Module } from '@nestjs/common';
import { JwksController } from './jwks.controller';
import { MetricsModule } from '../metrics/metrics.module';
import { DifficultyService } from './difficulty.service';
import { HashService } from './hash.service';
import { PowController } from './pow.controller';
import { PowService } from './pow.service';
import { ChallengeStoreService } from './store/challenge-store.service';
import { RateWindowService } from './store/rate-window.service';
import { TokenService } from './token.service';

@Module({
  imports: [MetricsModule],
  controllers: [PowController, JwksController],
  providers: [
    PowService,
    HashService,
    DifficultyService,
    TokenService,
    ChallengeStoreService,
    RateWindowService,
  ],
  exports: [PowService, HashService],
})
export class PowModule {}
