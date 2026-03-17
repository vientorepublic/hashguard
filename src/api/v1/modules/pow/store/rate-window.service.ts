import { Inject, Injectable } from '@nestjs/common';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../../../../../modules/redis/redis.module';

/**
 * Tracks per-IP challenge-request rate using Redis sliding windows.
 *
 * Strategy: simple fixed-window counter.
 *   Key: rate:challenges:{ip}:{minute_epoch}
 *   TTL: 2 minutes (covers previous + current window for rate calculation).
 *
 * The "effective RPM" is calculated as a weighted sum of the
 * current-window count and the previous-window count so that the
 * rate measurement is smooth across window boundaries.
 */
@Injectable()
export class RateWindowService {
  /** Window size in seconds (1 minute). */
  private static readonly WINDOW_SECONDS = 60;
  private static readonly KEY_TTL_SECONDS = 120;

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  private asInt(value: unknown): number {
    if (typeof value === 'number') return value;
    if (typeof value === 'string') {
      const parsed = parseInt(value, 10);
      return Number.isNaN(parsed) ? 0 : parsed;
    }
    return 0;
  }

  private windowKey(ip: string, windowEpoch: number): string {
    return `rate:challenges:${ip}:${windowEpoch}`;
  }

  private currentWindowEpoch(): number {
    return Math.floor(Date.now() / (RateWindowService.WINDOW_SECONDS * 1000));
  }

  /**
   * Increments the challenge-request counter for the given IP.
   * Call this each time a new challenge is issued to an IP.
   */
  async incrementChallengeCount(ip: string): Promise<void> {
    const epoch = this.currentWindowEpoch();
    const key = this.windowKey(ip, epoch);
    const pipeline = this.redis.pipeline();
    pipeline.incr(key);
    pipeline.expire(key, RateWindowService.KEY_TTL_SECONDS);
    await pipeline.exec();
  }

  /**
   * Returns a smoothed requests-per-minute value for the given IP.
   * Uses the weighted average of the current and previous window counts.
   */
  async getChallengeRequestsPerMinute(ip: string): Promise<number> {
    const now = Date.now();
    const epoch = Math.floor(now / (RateWindowService.WINDOW_SECONDS * 1000));
    const prevEpoch = epoch - 1;

    const [currentRaw, prevRaw] = await this.redis.mget(
      this.windowKey(ip, epoch),
      this.windowKey(ip, prevEpoch),
    );

    const current = currentRaw ? parseInt(currentRaw, 10) : 0;
    const prev = prevRaw ? parseInt(prevRaw, 10) : 0;

    // How far into the current window are we? (0 = start, 1 = end)
    const windowProgress =
      (now % (RateWindowService.WINDOW_SECONDS * 1000)) /
      (RateWindowService.WINDOW_SECONDS * 1000);

    // Weighted average: smoothly transitions from prev to current
    const smoothed = prev * (1 - windowProgress) + current;
    return smoothed;
  }

  /**
   * Atomically increments current challenge counter, then returns smoothed
   * challenge RPM and failure RPM for difficulty decisions.
   */
  async incrementChallengeAndGetRates(
    ip: string,
  ): Promise<{ rpm: number; failRpm: number }> {
    const now = Date.now();
    const epoch = Math.floor(now / (RateWindowService.WINDOW_SECONDS * 1000));
    const prevEpoch = epoch - 1;

    const challengeCurrentKey = this.windowKey(ip, epoch);
    const challengePrevKey = this.windowKey(ip, prevEpoch);
    const failCurrentKey = `rate:failures:${ip}:${epoch}`;
    const failPrevKey = `rate:failures:${ip}:${prevEpoch}`;

    const tx = this.redis.multi();
    tx.incr(challengeCurrentKey);
    tx.expire(challengeCurrentKey, RateWindowService.KEY_TTL_SECONDS);
    tx.get(challengeCurrentKey);
    tx.get(challengePrevKey);
    tx.get(failCurrentKey);
    tx.get(failPrevKey);

    const results = await tx.exec();

    const challengeCurrent = this.asInt(results?.[2]?.[1]);
    const challengePrev = this.asInt(results?.[3]?.[1]);
    const failCurrent = this.asInt(results?.[4]?.[1]);
    const failPrev = this.asInt(results?.[5]?.[1]);

    const windowProgress =
      (now % (RateWindowService.WINDOW_SECONDS * 1000)) /
      (RateWindowService.WINDOW_SECONDS * 1000);

    return {
      rpm: challengePrev * (1 - windowProgress) + challengeCurrent,
      failRpm: failPrev * (1 - windowProgress) + failCurrent,
    };
  }

  /**
   * Increments the verification-failure counter for the given IP.
   * High failure rates are used as an abuse signal.
   */
  async incrementFailureCount(ip: string): Promise<void> {
    const epoch = this.currentWindowEpoch();
    const key = `rate:failures:${ip}:${epoch}`;
    const pipeline = this.redis.pipeline();
    pipeline.incr(key);
    pipeline.expire(key, RateWindowService.KEY_TTL_SECONDS);
    await pipeline.exec();
  }

  async getFailureRatePerMinute(ip: string): Promise<number> {
    const epoch = this.currentWindowEpoch();
    const val = await this.redis.get(`rate:failures:${ip}:${epoch}`);
    return val ? parseInt(val, 10) : 0;
  }
}
