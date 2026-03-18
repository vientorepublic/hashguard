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

interface DifficultySignalsProvider {
  getChallengeRequestsPerMinute(ip: string): Promise<number>;
  getFailureRatePerMinute(ip: string): Promise<number>;
  getBurstRequestsPerMinute(ip: string): Promise<number>;
}

const DIFFICULTY_BITS_MIN = 1;
const DIFFICULTY_BITS_MAX = 255;

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
    this.validateDifficultyBounds(this.baseBits, this.maxBits);

    const rawTiers = config.get<string>('pow.rateTiersJson') ?? null;
    try {
      this.rateTiers = rawTiers
        ? this.parseAndValidateRateTiers(rawTiers)
        : DEFAULT_RATE_TIERS;
    } catch {
      this.logger.warn(
        'POW_RATE_TIERS_JSON is malformed or invalid; falling back to default rate tiers',
      );
      this.rateTiers = DEFAULT_RATE_TIERS;
    }
  }

  private validateDifficultyBounds(baseBits: number, maxBits: number): void {
    if (!Number.isInteger(baseBits) || !Number.isInteger(maxBits)) {
      throw new RangeError(
        'pow.baseDifficultyBits and pow.maxDifficultyBits must be integers',
      );
    }

    if (
      baseBits < DIFFICULTY_BITS_MIN ||
      baseBits > DIFFICULTY_BITS_MAX ||
      maxBits < DIFFICULTY_BITS_MIN ||
      maxBits > DIFFICULTY_BITS_MAX
    ) {
      throw new RangeError(
        `pow difficulty bits must be within [${DIFFICULTY_BITS_MIN}, ${DIFFICULTY_BITS_MAX}]`,
      );
    }

    if (baseBits > maxBits) {
      throw new RangeError(
        'pow.baseDifficultyBits must be <= pow.maxDifficultyBits',
      );
    }
  }

  private parseAndValidateRateTiers(rawTiers: string): RateTier[] {
    const parsed = JSON.parse(rawTiers) as unknown;

    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw new Error('pow.rateTiersJson must be a non-empty array');
    }

    const tiers = parsed.map((item) => {
      const minRpm = (item as RateTier).minRpm;
      const extraBits = (item as RateTier).extraBits;

      if (
        !Number.isFinite(minRpm) ||
        !Number.isFinite(extraBits) ||
        !Number.isInteger(minRpm) ||
        !Number.isInteger(extraBits)
      ) {
        throw new Error(
          'pow.rateTiersJson entries must use integer minRpm and extraBits',
        );
      }

      if (minRpm < 0 || extraBits < 0) {
        throw new Error('pow.rateTiersJson entries must be non-negative');
      }

      return { minRpm, extraBits };
    });

    const sorted = tiers.slice().sort((a, b) => b.minRpm - a.minRpm);
    if (!sorted.some((tier) => tier.minRpm === 0)) {
      throw new Error(
        'pow.rateTiersJson must include a base tier with minRpm=0',
      );
    }

    return sorted;
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
    const signalsProvider = this.rateWindow as DifficultySignalsProvider;
    const [rpm, failRpm, burstRpm]: [number, number, number] =
      await Promise.all([
        signalsProvider.getChallengeRequestsPerMinute(ip),
        signalsProvider.getFailureRatePerMinute(ip),
        signalsProvider.getBurstRequestsPerMinute(ip),
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
