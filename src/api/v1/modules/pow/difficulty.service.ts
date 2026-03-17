import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HashService } from './hash.service';
import { RateWindowService } from './store/rate-window.service';

interface DifficultyResult {
  difficultyBits: number;
  targetHex: string;
}

interface RateTier {
  minRpm: number;
  extraBits: number;
}

/**
 * Default rate → extra difficulty bits mapping (used when POW_RATE_TIERS_JSON is not set).
 * Entries are sorted in descending order of minRpm.
 */
const DEFAULT_RATE_TIERS: RateTier[] = [
  { minRpm: 30, extraBits: 6 },
  { minRpm: 20, extraBits: 4 },
  { minRpm: 10, extraBits: 2 },
  { minRpm: 5, extraBits: 1 },
  { minRpm: 0, extraBits: 0 },
];

@Injectable()
export class DifficultyService {
  private readonly logger = new Logger(DifficultyService.name);
  private readonly baseBits: number;
  private readonly maxBits: number;
  private readonly rateTiers: RateTier[];

  constructor(
    private readonly config: ConfigService,
    private readonly rateWindow: RateWindowService,
    private readonly hash: HashService,
  ) {
    this.baseBits = config.get<number>('pow.baseDifficultyBits')!;
    this.maxBits = config.get<number>('pow.maxDifficultyBits')!;

    const rawTiers = config.get<string>('pow.rateTiersJson') ?? null;
    try {
      this.rateTiers = rawTiers
        ? (JSON.parse(rawTiers) as RateTier[])
            .slice()
            .sort((a, b) => b.minRpm - a.minRpm)
        : DEFAULT_RATE_TIERS;
    } catch {
      this.logger.warn(
        'POW_RATE_TIERS_JSON is malformed; falling back to default rate tiers',
      );
      this.rateTiers = DEFAULT_RATE_TIERS;
    }
  }

  /**
   * Calculates the appropriate PoW difficulty for a client IP.
   *
   * Algorithm:
   *  1. Query the IP's smoothed request rate (rpm), failure rate (failRpm),
   *     and short-burst rate (burstRpm, 10-second window normalized to RPM).
   *  2. Use effectiveRpm = max(rpm, burstRpm) for tier lookup so that burst
   *     traffic is penalised immediately without waiting for the 1-minute window.
   *  3. Add failure-rate penalty (each 5 failures/min → +2 bits).
   *  4. Clamp to [baseBits, maxBits].
   */
  async calculate(ip: string): Promise<DifficultyResult> {
    const [rpm, failRpm, burstRpm] = await Promise.all([
      this.rateWindow.getChallengeRequestsPerMinute(ip),
      this.rateWindow.getFailureRatePerMinute(ip),
      this.rateWindow.getBurstRequestsPerMinute(ip),
    ]);

    return this.calculateFromSignals(rpm, failRpm, burstRpm);
  }

  /**
   * Calculates difficulty from precomputed challenge/failure/burst rate signals.
   *
   * @param rpm       Smoothed 1-minute challenge request rate.
   * @param failRpm   Smoothed 1-minute proof failure rate.
   * @param burstRpm  Short-window (10 s) rate normalised to RPM equivalent.
   */
  calculateFromSignals(
    rpm: number,
    failRpm: number,
    burstRpm = 0,
  ): DifficultyResult {
    // Take the worse of the sustained and burst rate for tier selection.
    const effectiveRpm = Math.max(rpm, burstRpm);
    const rateTier = this.rateTiers.find(
      (tier) => effectiveRpm >= tier.minRpm,
    )!;
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
