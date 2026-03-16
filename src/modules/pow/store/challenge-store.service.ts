import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../../redis/redis.module';
import { StoredChallenge } from '../pow.types';

@Injectable()
export class ChallengeStoreService {
  private readonly logger = new Logger(ChallengeStoreService.name);
  private readonly ttlSeconds: number;
  private readonly maxFailures: number;

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly config: ConfigService,
  ) {
    this.ttlSeconds = config.get<number>('pow.challengeTtlSeconds')!;
    this.maxFailures = config.get<number>('pow.maxFailuresPerChallenge')!;
  }

  private challengeKey(id: string): string {
    return `challenge:${id}`;
  }

  private failKey(id: string): string {
    return `challenge:fail:${id}`;
  }

  async save(challenge: StoredChallenge): Promise<void> {
    await this.redis.set(
      this.challengeKey(challenge.id),
      JSON.stringify(challenge),
      'EX',
      this.ttlSeconds,
    );
  }

  async findById(id: string): Promise<StoredChallenge | null> {
    const raw = await this.redis.get(this.challengeKey(id));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as StoredChallenge;
    } catch {
      this.logger.warn(`Failed to parse challenge ${id}`);
      return null;
    }
  }

  /** Consume (delete) the challenge so it cannot be reused. */
  async consume(id: string): Promise<void> {
    await this.redis.del(this.challengeKey(id), this.failKey(id));
  }

  /**
   * Increments the failure counter for a challenge.
   * Returns the new failure count.
   */
  async incrementFailures(id: string): Promise<number> {
    const pipeline = this.redis.pipeline();
    pipeline.incr(this.failKey(id));
    pipeline.expire(this.failKey(id), this.ttlSeconds);
    const results = await pipeline.exec();
    return (results?.[0]?.[1] as number) ?? 1;
  }

  async getFailures(id: string): Promise<number> {
    const val = await this.redis.get(this.failKey(id));
    return val ? parseInt(val, 10) : 0;
  }

  get maxAllowedFailures(): number {
    return this.maxFailures;
  }
}
