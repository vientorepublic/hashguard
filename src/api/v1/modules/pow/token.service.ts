import { HttpException, Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import Redis from 'ioredis';
import { PowErrors } from '../../../../common/exceptions/pow.exceptions';
import { REDIS_CLIENT } from '../../../../modules/redis/redis.module';
import { ProofTokenPayload } from './pow.types';

interface JwtHeader {
  alg: 'HS256';
  typ: 'JWT';
}

@Injectable()
export class TokenService {
  private readonly logger = new Logger(TokenService.name);
  private readonly secret: Buffer;
  private readonly ttlSeconds: number;

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly config: ConfigService,
  ) {
    const rawSecret = config.get<string>('pow.tokenSecret')!;
    this.secret = Buffer.from(rawSecret, 'utf8');
    this.ttlSeconds = config.get<number>('pow.proofTokenTtlSeconds')!;

    if (this.secret.length < 32) {
      throw new Error('POW_TOKEN_SECRET must be at least 32 bytes');
    }

    const nodeEnv = config.get<string>('app.nodeEnv', 'development');
    if (
      nodeEnv === 'production' &&
      rawSecret === 'CHANGE_ME_IN_PRODUCTION_use_32_plus_random_bytes'
    ) {
      throw new Error('POW_TOKEN_SECRET must be explicitly set in production');
    }
  }

  /** Issues a new single-use proof token bound to `ip` and `context`. */
  issue(ip: string, context: string): { token: string; expiresAt: number } {
    const nowSec = Math.floor(Date.now() / 1000);
    const payload: ProofTokenPayload = {
      jti: crypto.randomUUID(),
      sub: ip,
      context,
      iat: nowSec,
      exp: nowSec + this.ttlSeconds,
    };

    const header: JwtHeader = { alg: 'HS256', typ: 'JWT' };
    const encodedHeader = Buffer.from(JSON.stringify(header)).toString(
      'base64url',
    );
    const encodedPayload = Buffer.from(JSON.stringify(payload)).toString(
      'base64url',
    );
    const signingInput = `${encodedHeader}.${encodedPayload}`;
    const sig = this.sign(signingInput);

    return {
      token: `${signingInput}.${sig}`,
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
    if (parts.length !== 3) throw PowErrors.tokenInvalid();

    const [encodedHeader, encodedPayload, sig] = parts;
    const signingInput = `${encodedHeader}.${encodedPayload}`;

    // 1. Signature check (constant-time comparison)
    const expectedSig = this.sign(signingInput);
    if (!this.timingSafeCompare(sig, expectedSig)) {
      throw PowErrors.tokenInvalid();
    }

    // 2. Decode header + payload
    let header: JwtHeader;
    let payload: ProofTokenPayload;
    try {
      header = JSON.parse(
        Buffer.from(encodedHeader, 'base64url').toString(),
      ) as JwtHeader;
      payload = JSON.parse(
        Buffer.from(encodedPayload, 'base64url').toString(),
      ) as ProofTokenPayload;
    } catch {
      throw PowErrors.tokenInvalid();
    }

    if (header.alg !== 'HS256' || header.typ !== 'JWT') {
      throw PowErrors.tokenInvalid();
    }

    if (
      !payload.jti ||
      !payload.sub ||
      typeof payload.context !== 'string' ||
      !payload.iat ||
      !payload.exp
    ) {
      throw PowErrors.tokenInvalid();
    }

    // 3. Expiry check
    const nowSec = Math.floor(Date.now() / 1000);
    if (!payload.exp || payload.exp < nowSec) {
      throw PowErrors.tokenExpired();
    }

    // 4. Replay check / consume
    const usedKey = `token:used:${payload.jti}`;
    const remaining = payload.exp - nowSec;
    const ttlSeconds = Math.max(remaining + 60, 60);

    if (consume) {
      try {
        const consumed = await this.redis.set(
          usedKey,
          '1',
          'EX',
          ttlSeconds,
          'NX',
        );
        if (consumed !== 'OK') {
          throw PowErrors.tokenAlreadyUsed();
        }
      } catch (err) {
        if (err instanceof HttpException) {
          throw err;
        }
        this.logger.error(
          `Failed to atomically consume token ${payload.jti}: ${(err as Error).message}`,
        );
        throw PowErrors.tokenStateUnavailable();
      }
    } else {
      try {
        const isUsed = await this.redis.exists(usedKey);
        if (isUsed) throw PowErrors.tokenAlreadyUsed();
      } catch (err) {
        if (err instanceof HttpException) {
          throw err;
        }
        this.logger.error(
          `Failed to verify token usage state ${payload.jti}: ${(err as Error).message}`,
        );
        throw PowErrors.tokenStateUnavailable();
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
