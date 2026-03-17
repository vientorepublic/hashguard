import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import { PowErrors } from '../../../../common/exceptions/pow.exceptions';
import { MetricsService } from '../metrics/metrics.service';
import { CreateChallengeDto } from './dto/create-challenge.dto';
import { IntrospectTokenDto } from './dto/introspect-token.dto';
import { VerifyChallengeDto } from './dto/verify-challenge.dto';
import { DifficultyService } from './difficulty.service';
import { HashService } from './hash.service';
import { ChallengeStoreService } from './store/challenge-store.service';
import { RateWindowService } from './store/rate-window.service';
import { TokenService } from './token.service';
import { ProofTokenPayload, StoredChallenge } from './pow.types';

export interface ChallengeResponse {
  challengeId: string;
  algorithm: 'sha256';
  seed: string;
  difficultyBits: number;
  target: string;
  issuedAt: string; // ISO 8601
  expiresAt: string; // ISO 8601
}

export interface VerificationResponse {
  proofToken: string;
  expiresAt: string; // ISO 8601
}

export interface IntrospectResponse {
  valid: boolean;
  subject?: string;
  context?: string;
  issuedAt?: string;
  expiresAt?: string;
}

@Injectable()
export class PowService {
  private readonly logger = new Logger(PowService.name);
  private readonly minSolveTimeMs: number;

  constructor(
    private readonly config: ConfigService,
    private readonly challengeStore: ChallengeStoreService,
    private readonly rateWindow: RateWindowService,
    private readonly difficulty: DifficultyService,
    private readonly hash: HashService,
    private readonly token: TokenService,
    private readonly metrics: MetricsService,
  ) {
    this.minSolveTimeMs = config.get<number>('pow.minSolveTimeMs')!;
  }

  async issueChallenge(
    dto: CreateChallengeDto,
    clientIp: string,
  ): Promise<ChallengeResponse> {
    const { rpm, failRpm } =
      await this.rateWindow.incrementChallengeAndGetRates(clientIp);
    const { difficultyBits, targetHex } = this.difficulty.calculateFromSignals(
      rpm,
      failRpm,
    );
    const ttlSeconds = this.config.get<number>('pow.challengeTtlSeconds')!;

    const id = crypto.randomUUID();
    const seed = crypto.randomBytes(32).toString('hex');
    const now = Date.now();
    const expiresAt = now + ttlSeconds * 1000;

    const challenge: StoredChallenge = {
      id,
      seed,
      targetHex,
      difficultyBits,
      algorithm: 'sha256',
      clientIp,
      context: dto.context ?? '',
      issuedAt: now,
      expiresAt,
    };

    await this.challengeStore.save(challenge);
    await this.metrics.recordChallengeIssued(difficultyBits);

    this.logger.debug(
      `Challenge issued id=${id} ip=${clientIp} bits=${difficultyBits}`,
    );

    return {
      challengeId: id,
      algorithm: 'sha256',
      seed,
      difficultyBits,
      target: targetHex,
      issuedAt: new Date(now).toISOString(),
      expiresAt: new Date(expiresAt).toISOString(),
    };
  }

  async verifyChallenge(
    dto: VerifyChallengeDto,
    clientIp: string,
  ): Promise<VerificationResponse> {
    const challenge = await this.challengeStore.findById(dto.challengeId);
    if (!challenge) throw PowErrors.challengeNotFound();

    // IP binding check
    if (challenge.clientIp !== clientIp) throw PowErrors.challengeIpMismatch();

    // Suspicious solve-time check (server-observed timing is authoritative).
    const serverSolveTimeMs = Math.max(0, Date.now() - challenge.issuedAt);
    if (this.minSolveTimeMs > 0 && serverSolveTimeMs < this.minSolveTimeMs) {
      await this.rateWindow.incrementFailureCount(clientIp);
      throw PowErrors.solveTooFast();
    }

    // Proof verification
    const valid = this.hash.verifyProof(
      challenge.id,
      challenge.seed,
      dto.nonce,
      challenge.targetHex,
    );

    if (!valid) {
      const failures = await this.challengeStore.incrementFailures(
        challenge.id,
      );
      await this.rateWindow.incrementFailureCount(clientIp);
      await this.metrics.recordVerificationFailure();

      if (failures >= this.challengeStore.maxAllowedFailures) {
        // Consume the challenge to prevent brute-force
        await this.challengeStore.consume(challenge.id);
        throw PowErrors.tooManyFailures();
      }

      throw PowErrors.invalidProof();
    }

    // Consume challenge (prevents replay)
    await this.challengeStore.consume(challenge.id);
    await this.metrics.recordVerificationSuccess(serverSolveTimeMs);

    const { token, expiresAt } = this.token.issue(
      challenge.clientIp,
      challenge.context,
    );

    this.logger.debug(`Challenge verified id=${challenge.id} ip=${clientIp}`);

    return {
      proofToken: token,
      expiresAt: new Date(expiresAt).toISOString(),
    };
  }

  async introspectToken(dto: IntrospectTokenDto): Promise<IntrospectResponse> {
    const consume = dto.consume !== false; // default: true
    const payload: ProofTokenPayload = await this.token.verify(
      dto.proofToken,
      consume,
    );

    return {
      valid: true,
      subject: payload.sub,
      context: payload.context,
      issuedAt: new Date(payload.iat * 1000).toISOString(),
      expiresAt: new Date(payload.exp * 1000).toISOString(),
    };
  }
}
