import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HashService } from './hash.service';
import { RateWindowService } from './store/rate-window.service';

interface DifficultyResult {
  difficultyBits: number;
  targetHex: string;
}

/**
 * Rate → extra difficulty bits mapping.
 * Entries are evaluated in descending order of minRpm.
 */
const RATE_TIERS: Array<{ minRpm: number; extraBits: number }> = [
  { minRpm: 30, extraBits: 6 },
  { minRpm: 20, extraBits: 4 },
  { minRpm: 10, extraBits: 2 },
  { minRpm: 5, extraBits: 1 },
  { minRpm: 0, extraBits: 0 },
];

@Injectable()
export class DifficultyService {
  private readonly baseBits: number;
  private readonly maxBits: number;

  constructor(
    private readonly config: ConfigService,
    private readonly rateWindow: RateWindowService,
    private readonly hash: HashService,
  ) {
    this.baseBits = config.get<number>('pow.baseDifficultyBits')!;
    this.maxBits = config.get<number>('pow.maxDifficultyBits')!;
  }

  /**
   * Calculates the appropriate PoW difficulty for a client IP.
   *
   * Algorithm:
   *  1. Query the IP's smoothed request rate (rpm).
   *  2. Look up the appropriate extra-bits penalty from RATE_TIERS.
   *  3. Add failure-rate penalty (each 5 failures/min → +2 bits).
   *  4. Clamp to [baseBits, maxBits].
   */
  async calculate(ip: string): Promise<DifficultyResult> {
    const [rpm, failRpm] = await Promise.all([
      this.rateWindow.getChallengeRequestsPerMinute(ip),
      this.rateWindow.getFailureRatePerMinute(ip),
    ]);

    const rateTier = RATE_TIERS.find((tier) => rpm >= tier.minRpm)!;
    const failPenalty = Math.floor(failRpm / 5) * 2;

    const bits = Math.min(
      this.baseBits + rateTier.extraBits + failPenalty,
      this.maxBits,
    );

    return {
      difficultyBits: bits,
      targetHex: this.hash.computeTarget(bits),
    };
  }
}
