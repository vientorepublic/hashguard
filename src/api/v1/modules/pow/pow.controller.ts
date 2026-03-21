import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiBody, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import {
  extractClientIp,
  TrustedProxyMode,
} from '../../../../common/utils/proxy-ip.util';
import { CreateChallengeDto } from './dto/create-challenge.dto';
import { IntrospectTokenDto } from './dto/introspect-token.dto';
import { VerifyChallengeDto } from './dto/verify-challenge.dto';
import { PowService } from './pow.service';
import type { VerificationKeyResponse } from './pow.service';
import { TokenService } from './token.service';

interface VerificationKeyProvider {
  getVerificationKey(): VerificationKeyResponse;
}

@ApiTags('pow')
@Controller('pow')
export class PowController {
  private readonly trustedProxyMode: TrustedProxyMode;
  private readonly verificationKeyProvider: VerificationKeyProvider;

  constructor(
    private readonly pow: PowService,
    token: TokenService,
    private readonly config: ConfigService,
  ) {
    this.verificationKeyProvider = token;
    const raw = this.config.get<string>('app.trustedProxy', 'cloudflare');
    this.trustedProxyMode =
      raw === 'none' || raw === 'x-forwarded-for' ? raw : 'cloudflare';
  }

  // ── Challenge issuance ──────────────────────────────────────────────────

  @Post('challenges')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Issue a new PoW challenge' })
  @ApiBody({ type: CreateChallengeDto })
  @ApiResponse({
    status: 201,
    description:
      'Challenge created. Solve `SHA-256(challengeId:seed:nonce) ≤ target`, then POST /verifications.',
    schema: {
      example: {
        challengeId: 'a1b2c3d4-…',
        algorithm: 'sha256',
        seed: 'deadbeef…',
        difficultyBits: 20,
        target: '00000fffff…',
        issuedAt: '2026-03-16T10:00:00.000Z',
        expiresAt: '2026-03-16T10:10:00.000Z',
      },
    },
  })
  @ApiResponse({ status: 400, description: 'Validation error' })
  issueChallenge(@Body() dto: CreateChallengeDto, @Req() req: Request) {
    return this.pow.issueChallenge(
      dto,
      extractClientIp(req, this.trustedProxyMode),
    );
  }

  // ── Proof verification ──────────────────────────────────────────────────

  @Post('verifications')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Submit a PoW solution and receive a proof token' })
  @ApiBody({ type: VerifyChallengeDto })
  @ApiResponse({
    status: 200,
    description: 'Solution accepted. The returned proofToken is single-use.',
    schema: {
      example: {
        proofToken: 'eyJ….eyJ….SIG',
        expiresAt: '2026-03-16T10:05:00.000Z',
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Invalid proof or validation error',
  })
  @ApiResponse({ status: 403, description: 'IP mismatch' })
  @ApiResponse({
    status: 404,
    description: 'Challenge not found / expired / already used',
  })
  @ApiResponse({ status: 429, description: 'Too many failed attempts' })
  verifyChallenge(@Body() dto: VerifyChallengeDto, @Req() req: Request) {
    return this.pow.verifyChallenge(
      dto,
      extractClientIp(req, this.trustedProxyMode),
    );
  }

  // ── Token introspection ─────────────────────────────────────────────────

  @Get('assertions/verification-key')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Get the public JWK for stateless proof-token verification',
    description:
      'SDKs can fetch this EC P-256 public key and verify proof-token JWT signatures locally without a server round-trip.',
  })
  @ApiResponse({
    status: 200,
    description: 'Public JWK used to verify ES256 proof-token signatures.',
    schema: {
      example: {
        kty: 'EC',
        crv: 'P-256',
        x: 'v8xGz4mM2jvM0xv7e9j7V0rF6qWf2Lx6Fv0t3P3m1lA',
        y: 'N3QvK7t6Q2mWjzYp6Qj0yQ8l4lP5sT7m9kQ3jL5rX2c',
        use: 'sig',
        alg: 'ES256',
        kid: '4hJz5J6Nq1v8X0a9S9o4XzU3fS0S6WqXb8vR8vK2p0Q',
      },
    },
  })
  getVerificationKey(): VerificationKeyResponse {
    return this.verificationKeyProvider.getVerificationKey();
  }

  @Post('assertions/introspect')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Verify (and optionally consume) a proof token',
    description:
      'External services call this endpoint to validate a client-supplied proof token. ' +
      'By default the token is consumed on success (one-use policy). ' +
      'Pass consume=false for read-only inspection.',
  })
  @ApiBody({ type: IntrospectTokenDto })
  @ApiResponse({
    status: 200,
    description: 'Token is valid.',
    schema: {
      example: {
        valid: true,
        subject: '203.0.113.42',
        context: 'login',
        issuedAt: '2026-03-16T10:00:00.000Z',
        expiresAt: '2026-03-16T10:05:00.000Z',
      },
    },
  })
  @ApiResponse({ status: 401, description: 'Token invalid or expired' })
  @ApiResponse({ status: 409, description: 'Token already consumed' })
  @ApiResponse({
    status: 503,
    description: 'Token state could not be verified safely',
  })
  introspectToken(@Body() dto: IntrospectTokenDto) {
    return this.pow.introspectToken(dto);
  }
}
