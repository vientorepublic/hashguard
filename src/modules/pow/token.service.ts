import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import Redis from 'ioredis';
import { PowErrors } from '../../common/exceptions/pow.exceptions';
import { REDIS_CLIENT } from '../redis/redis.module';
import { ProofTokenPayload } from './pow.types';

@Injectable()
export class TokenService {
  private readonly logger = new Logger(TokenService.name);
  private readonly secret: Buffer;
  private readonly ttlSeconds: number;

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly config: ConfigService,
  ) {
    this.secret = Buffer.from(config.get<string>('pow.tokenSecret')!);
    this.ttlSeconds = config.get<number>('pow.proofTokenTtlSeconds')!;
  }

  /** Issues a new single-use proof token bound to `ip` and `context`. */
  issue(ip: string, context: string): { token: string; expiresAt: number } {
    const nowSec = Math.floor(Date.now() / 1000);
    const payload: ProofTokenPayload = {
      jti: crypto.randomUUID(),
      sub: ip,
      ctx: context,
      iat: nowSec,
      exp: nowSec + this.ttlSeconds,
    };

    const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const sig = this.sign(data);
    return {
      token: `${data}.${sig}`,
      expiresAt: payload.exp * 1000, // return as Unix ms
    };
  }

  /**
   * Verifies a proof token.
   *
   * @param token  Raw token string.
   * @param consume  When true, marks the token as used in Redis (one-use policy).
   * @returns Decoded payload.
   * @throws HttpException on invalid/expired/used tokens.
   */
  async verify(token: string, consume = true): Promise<ProofTokenPayload> {
    const parts = token.split('.');
    if (parts.length !== 2) throw PowErrors.tokenInvalid();

    const [data, sig] = parts;

    // 1. Signature check (constant-time comparison)
    const expectedSig = this.sign(data);
    if (!this.timingSafeCompare(sig, expectedSig)) {
      throw PowErrors.tokenInvalid();
    }

    // 2. Decode payload
    let payload: ProofTokenPayload;
    try {
      payload = JSON.parse(
        Buffer.from(data, 'base64url').toString(),
      ) as ProofTokenPayload;
    } catch {
      throw PowErrors.tokenInvalid();
    }

    // 3. Expiry check
    const nowSec = Math.floor(Date.now() / 1000);
    if (!payload.exp || payload.exp < nowSec) {
      throw PowErrors.tokenExpired();
    }

    // 4. Replay check
    const usedKey = `token:used:${payload.jti}`;
    const isUsed = await this.redis.exists(usedKey);
    if (isUsed) throw PowErrors.tokenAlreadyUsed();

    // 5. Consume if requested
    if (consume) {
      const remaining = payload.exp - nowSec;
      try {
        await this.redis.set(usedKey, '1', 'EX', Math.max(remaining + 60, 60));
      } catch (err) {
        // Fail open: log but don't block the legitimate request
        this.logger.error(
          `Failed to mark token ${payload.jti} as used: ${(err as Error).message}`,
        );
      }
    }

    return payload;
  }

  private sign(data: string): string {
    return crypto
      .createHmac('sha256', this.secret)
      .update(data)
      .digest('base64url');
  }

  private timingSafeCompare(a: string, b: string): boolean {
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    if (bufA.length !== bufB.length) {
      // Perform dummy comparison to normalise timing, then reject
      crypto.timingSafeEqual(bufA, bufA);
      return false;
    }
    return crypto.timingSafeEqual(bufA, bufB);
  }
}
