import { HttpException, Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import Redis from 'ioredis';
import { PowErrors } from '../../../../common/exceptions/pow.exceptions';
import { REDIS_CLIENT } from '../../../../modules/redis/redis.module';
import {
  ProofTokenJwks,
  ProofTokenPayload,
  ProofTokenVerificationKey,
} from './pow.types';

interface JwtHeader {
  alg: 'ES256';
  typ: 'JWT';
  kid: string;
}

@Injectable()
export class TokenService {
  private readonly logger = new Logger(TokenService.name);
  private readonly privateKey: crypto.KeyObject;
  private readonly publicKey: crypto.KeyObject;
  private readonly verificationKey: ProofTokenVerificationKey;
  private readonly keyId: string;
  private readonly ttlSeconds: number;

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly config: ConfigService,
  ) {
    this.ttlSeconds = config.get<number>('pow.proofTokenTtlSeconds')!;
    const nodeEnv = config.get<string>('app.nodeEnv', 'development');

    const configuredPem = this.resolvePrivateKeyPem(
      config.get<string>('pow.tokenPrivateKeyPem'),
      config.get<string>('pow.tokenPrivateKeyBase64'),
    );

    if (configuredPem) {
      this.privateKey = this.createPrivateKey(configuredPem);
    } else if (nodeEnv === 'production') {
      throw new Error(
        'POW_TOKEN_PRIVATE_KEY_PEM or POW_TOKEN_PRIVATE_KEY_BASE64 must be set in production',
      );
    } else {
      const generatedKeyPair = crypto.generateKeyPairSync('ec', {
        namedCurve: 'prime256v1',
      });
      this.privateKey = generatedKeyPair.privateKey;
      this.logger.warn(
        'Generated ephemeral ES256 proof-token signing key because no private key was configured.',
      );
    }

    this.publicKey = crypto.createPublicKey(this.privateKey);
    this.keyId = this.computeKeyId(this.publicKey);
    this.verificationKey = this.exportVerificationKey(
      this.publicKey,
      this.keyId,
    );
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

    const header: JwtHeader = { alg: 'ES256', typ: 'JWT', kid: this.keyId };
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

    // 1. Signature check
    if (!this.verifySignature(signingInput, sig)) {
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

    if (
      header.alg !== 'ES256' ||
      header.typ !== 'JWT' ||
      header.kid !== this.keyId
    ) {
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

  getVerificationKey(): ProofTokenVerificationKey {
    return { ...this.verificationKey };
  }

  getJwks(): ProofTokenJwks {
    return {
      keys: [this.getVerificationKey()],
    };
  }

  private sign(data: string): string {
    return crypto
      .sign('sha256', Buffer.from(data, 'utf8'), {
        key: this.privateKey,
        dsaEncoding: 'ieee-p1363',
      })
      .toString('base64url');
  }

  private verifySignature(data: string, encodedSignature: string): boolean {
    const signature = Buffer.from(encodedSignature, 'base64url');
    if (signature.length === 0) {
      return false;
    }

    return crypto.verify(
      'sha256',
      Buffer.from(data, 'utf8'),
      {
        key: this.publicKey,
        dsaEncoding: 'ieee-p1363',
      },
      signature,
    );
  }

  private resolvePrivateKeyPem(
    rawPem?: string,
    rawBase64?: string,
  ): string | undefined {
    if (rawPem) {
      return rawPem.replace(/\\n/g, '\n').trim();
    }

    if (rawBase64) {
      return Buffer.from(rawBase64, 'base64').toString('utf8').trim();
    }

    return undefined;
  }

  private createPrivateKey(pem: string): crypto.KeyObject {
    try {
      return crypto.createPrivateKey({ key: pem, format: 'pem' });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Invalid ES256 private key configuration: ${message}`, {
        cause: error,
      });
    }
  }

  private computeKeyId(publicKey: crypto.KeyObject): string {
    const spkiDer = publicKey.export({ type: 'spki', format: 'der' });
    return crypto.createHash('sha256').update(spkiDer).digest('base64url');
  }

  private exportVerificationKey(
    publicKey: crypto.KeyObject,
    kid: string,
  ): ProofTokenVerificationKey {
    const exported = publicKey.export({ format: 'jwk' }) as {
      kty?: string;
      crv?: string;
      x?: string;
      y?: string;
    };

    if (
      exported.kty !== 'EC' ||
      exported.crv !== 'P-256' ||
      !exported.x ||
      !exported.y
    ) {
      throw new Error('Failed to export ES256 verification key as JWK');
    }

    return {
      kty: 'EC',
      crv: 'P-256',
      x: exported.x,
      y: exported.y,
      use: 'sig',
      alg: 'ES256',
      kid,
      key_ops: ['verify'],
    };
  }
}
