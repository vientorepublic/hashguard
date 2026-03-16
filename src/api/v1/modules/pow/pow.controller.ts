import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
} from '@nestjs/common';
import { ApiBody, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { extractClientIp } from '../../../../common/utils/proxy-ip.util';
import { CreateChallengeDto } from './dto/create-challenge.dto';
import { IntrospectTokenDto } from './dto/introspect-token.dto';
import { VerifyChallengeDto } from './dto/verify-challenge.dto';
import { PowService } from './pow.service';

@ApiTags('pow')
@Controller('pow')
export class PowController {
  constructor(private readonly pow: PowService) {}

  // ── Challenge issuance ──────────────────────────────────────────────────

  @Post('challenges')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Issue a new PoW challenge' })
  @ApiBody({ type: CreateChallengeDto })
  @ApiResponse({
    status: 201,
    description:
      'Challenge created. Solve SHA-256(challengeId:seed:nonce) ≤ target, then POST /verifications.',
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
    return this.pow.issueChallenge(dto, extractClientIp(req));
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
  @ApiResponse({ status: 409, description: 'Too many failed attempts' })
  verifyChallenge(@Body() dto: VerifyChallengeDto, @Req() req: Request) {
    return this.pow.verifyChallenge(dto, extractClientIp(req));
  }

  // ── Token introspection ─────────────────────────────────────────────────

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
  introspectToken(@Body() dto: IntrospectTokenDto) {
    return this.pow.introspectToken(dto);
  }
}
