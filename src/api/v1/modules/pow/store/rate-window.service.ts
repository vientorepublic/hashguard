import { Inject, Injectable } from '@nestjs/common';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../../../../../modules/redis/redis.module';

/**
 * Tracks per-IP challenge-request rate using Redis sliding windows.
 *
 * Two complementary windows are maintained:
 *
 * 1-minute fixed window (sustained rate)
 *   Key: rate:challenges:{ip}:{minute_epoch}
 *   TTL: 2 minutes. "Effective RPM" is a weighted average of the current
 *   and previous window counts to smooth across window boundaries.
 *
 * 10-second burst window
 *   Key: rate:burst:{ip}:{10s_epoch}
 *   TTL: 30 seconds. Normalised to an RPM equivalent (count × 6) so it
 *   can be fed directly into the same RATE_TIERS lookup as sustained RPM.
 *   This allows the difficulty to react to sudden spikes within seconds
 *   rather than waiting for the 1-minute window to fill up.
 */
@Injectable()
export class RateWindowService {
  /** Sustained window size in seconds (1 minute). */
  private static readonly WINDOW_SECONDS = 60;
  private static readonly KEY_TTL_SECONDS = 120;

  /** Burst window size in seconds (10 seconds). */
  private static readonly BURST_WINDOW_SECONDS = 10;
  private static readonly BURST_KEY_TTL_SECONDS = 30;

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
   * Returns the current 10-second burst count normalised to a per-minute
   * equivalent (count × 6). A single burst window is sufficient because
   * the intent is to detect sudden spikes, not sustained throughput.
   */
  async getBurstRequestsPerMinute(ip: string): Promise<number> {
    const epoch = Math.floor(
      Date.now() / (RateWindowService.BURST_WINDOW_SECONDS * 1000),
    );
    const key = `rate:burst:${ip}:${epoch}`;
    const val = await this.redis.get(key);
    const count = val ? parseInt(val, 10) : 0;
    return count * (60 / RateWindowService.BURST_WINDOW_SECONDS);
  }

  /**
   * Atomically increments the sustained and burst challenge counters, then
   * returns smoothed challenge RPM, failure RPM, and burst RPM for difficulty
   * decisions.
   */
  async incrementChallengeAndGetRates(
    ip: string,
  ): Promise<{ rpm: number; failRpm: number; burstRpm: number }> {
    const now = Date.now();
    const epoch = Math.floor(now / (RateWindowService.WINDOW_SECONDS * 1000));
    const prevEpoch = epoch - 1;
    const burstEpoch = Math.floor(
      now / (RateWindowService.BURST_WINDOW_SECONDS * 1000),
    );

    const challengeCurrentKey = this.windowKey(ip, epoch);
    const challengePrevKey = this.windowKey(ip, prevEpoch);
    const failCurrentKey = `rate:failures:${ip}:${epoch}`;
    const failPrevKey = `rate:failures:${ip}:${prevEpoch}`;
    const burstKey = `rate:burst:${ip}:${burstEpoch}`;

    const tx = this.redis.multi();
    tx.incr(challengeCurrentKey); // [0] new sustained count
    tx.expire(challengeCurrentKey, RateWindowService.KEY_TTL_SECONDS); // [1]
    tx.get(challengePrevKey); // [2]
    tx.get(failCurrentKey); // [3]
    tx.get(failPrevKey); // [4]
    tx.incr(burstKey); // [5] new burst count
    tx.expire(burstKey, RateWindowService.BURST_KEY_TTL_SECONDS); // [6]

    const results = await tx.exec();

    const challengeCurrent = this.asInt(results?.[0]?.[1]);
    const challengePrev = this.asInt(results?.[2]?.[1]);
    const failCurrent = this.asInt(results?.[3]?.[1]);
    const failPrev = this.asInt(results?.[4]?.[1]);
    const burstCount = this.asInt(results?.[5]?.[1]);

    const windowProgress =
      (now % (RateWindowService.WINDOW_SECONDS * 1000)) /
      (RateWindowService.WINDOW_SECONDS * 1000);

    return {
      rpm: challengePrev * (1 - windowProgress) + challengeCurrent,
      failRpm: failPrev * (1 - windowProgress) + failCurrent,
      burstRpm: burstCount * (60 / RateWindowService.BURST_WINDOW_SECONDS),
    };
  }

  /**
   * Increments the verification-failure counter for the given IP.
   * High failure rates are used as an abuse signal.
   *
   * Uses MULTI/EXEC to guarantee that EXPIRE always runs after INCR.
   * A pipeline() race (INCR succeeds, EXPIRE dropped on disconnect) would
   * leave a TTL-less key that accumulates indefinitely.
   */
  async incrementFailureCount(ip: string): Promise<void> {
    const epoch = this.currentWindowEpoch();
    const key = `rate:failures:${ip}:${epoch}`;
    const tx = this.redis.multi();
    tx.incr(key);
    tx.expire(key, RateWindowService.KEY_TTL_SECONDS);
    await tx.exec();
  }

  /**
   * Returns a smoothed failure rate per minute for the given IP.
   * Applies the same weighted-average smoothing as getChallengeRequestsPerMinute
   * to avoid a step-change at window boundaries.
   */
  async getFailureRatePerMinute(ip: string): Promise<number> {
    const now = Date.now();
    const epoch = Math.floor(now / (RateWindowService.WINDOW_SECONDS * 1000));
    const prevEpoch = epoch - 1;

    const [currentRaw, prevRaw] = await this.redis.mget(
      `rate:failures:${ip}:${epoch}`,
      `rate:failures:${ip}:${prevEpoch}`,
    );

    const current = currentRaw ? parseInt(currentRaw, 10) : 0;
    const prev = prevRaw ? parseInt(prevRaw, 10) : 0;

    const windowProgress =
      (now % (RateWindowService.WINDOW_SECONDS * 1000)) /
      (RateWindowService.WINDOW_SECONDS * 1000);

    return prev * (1 - windowProgress) + current;
  }
}
