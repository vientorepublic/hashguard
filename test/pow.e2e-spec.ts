import { INestApplication, ValidationPipe } from '@nestjs/common';
import type { Express } from 'express';
import type { Server } from 'http';
import { Test, TestingModule } from '@nestjs/testing';
import * as crypto from 'crypto';
import request, { Response } from 'supertest';
import { AppModule } from './../src/app.module';
import { AllExceptionsFilter } from './../src/common/filters/all-exceptions.filter';

interface ChallengeApiResponse {
  challengeId: string;
  algorithm: 'sha256';
  seed: string;
  difficultyBits: number;
  target: string;
  issuedAt: string;
  expiresAt: string;
}

interface VerificationApiResponse {
  proofToken: string;
  expiresAt: string;
}

interface ErrorApiResponse {
  code: string;
  message: string | string[];
  statusCode: number;
  timestamp: string;
  path: string;
}

interface IntrospectionApiResponse {
  valid: boolean;
  subject?: string;
  context?: string;
  issuedAt?: string;
  expiresAt?: string;
}

interface HealthApiResponse {
  status: string;
}

function bodyOf<T>(response: Response): T {
  return response.body as unknown as T;
}

/**
 * Brute-forces a nonce that satisfies SHA-256(id:seed:nonce) ≤ target.
 * Only used in tests with a very easy target.
 */
function solveChallenge(id: string, seed: string, target: string): string {
  for (let n = 0; n < 10_000_000; n++) {
    const nonce = n.toString();
    const hash = crypto
      .createHash('sha256')
      .update(`${id}:${seed}:${nonce}`, 'utf8')
      .digest('hex');
    if (hash <= target) return nonce;
  }
  throw new Error('Could not solve challenge within iteration budget');
}

describe('PoW E2E', () => {
  let app: INestApplication;
  let httpServer: Server;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    const expressApp = app.getHttpAdapter().getInstance() as Express;
    expressApp.set('trust proxy', 1);
    app.setGlobalPrefix('v1');
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
    httpServer = app.getHttpServer() as Server;
  });

  afterAll(async () => {
    await app.close();
  });

  // ── Challenge issuance ─────────────────────────────────────────────────

  describe('POST /v1/pow/challenges', () => {
    it('should issue a challenge with correct shape', async () => {
      const res = await request(httpServer)
        .post('/v1/pow/challenges')
        .send({ context: 'test' })
        .expect(201);

      const body = bodyOf<ChallengeApiResponse>(res);

      expect(body.algorithm).toBe('sha256');
      expect(typeof body.difficultyBits).toBe('number');
      expect(body.target).toMatch(/^[0-9a-f]{64}$/);
      expect(body.seed).toMatch(/^[0-9a-f]{64}$/);
      expect(body.challengeId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
    });

    it('should reject unknown body fields', async () => {
      await request(httpServer)
        .post('/v1/pow/challenges')
        .send({ unknown: 'field' })
        .expect(400);
    });

    it('should reject whitespace-only context', async () => {
      await request(httpServer)
        .post('/v1/pow/challenges')
        .send({ context: '   ' })
        .expect(400);
    });
  });

  // ── Full solve + verify + consume flow ────────────────────────────────

  describe('POST /v1/pow/verifications', () => {
    it('should accept a valid proof and return a proof token', async () => {
      // 1. Issue challenge
      const challengeRes = await request(httpServer)
        .post('/v1/pow/challenges')
        .send({ context: 'e2e-test' })
        .expect(201);

      const challenge = bodyOf<ChallengeApiResponse>(challengeRes);

      // 2. Solve
      const nonce = solveChallenge(
        challenge.challengeId,
        challenge.seed,
        challenge.target,
      );

      // 3. Verify
      const verifyRes = await request(httpServer)
        .post('/v1/pow/verifications')
        .send({
          challengeId: challenge.challengeId,
          nonce,
          clientMetrics: { solveTimeMs: 500 },
        })
        .expect(200);

      const body = bodyOf<VerificationApiResponse>(verifyRes);

      expect(typeof body.proofToken).toBe('string');
      expect(typeof body.expiresAt).toBe('string');
    });

    it('should reject an invalid nonce with 400 POW_INVALID_PROOF', async () => {
      const challengeRes = await request(httpServer)
        .post('/v1/pow/challenges')
        .send({})
        .expect(201);

      const { challengeId } = bodyOf<ChallengeApiResponse>(challengeRes);
      const res = await request(httpServer)
        .post('/v1/pow/verifications')
        .send({ challengeId, nonce: 'definitely-wrong-nonce-000' })
        .expect(400);

      expect(bodyOf<ErrorApiResponse>(res).code).toBe('POW_INVALID_PROOF');
    });

    it('should reject a replay (same challenge used twice)', async () => {
      const challengeRes = await request(httpServer)
        .post('/v1/pow/challenges')
        .send({})
        .expect(201);

      const challenge = bodyOf<ChallengeApiResponse>(challengeRes);

      const nonce = solveChallenge(
        challenge.challengeId,
        challenge.seed,
        challenge.target,
      );

      // First use — should succeed
      await request(httpServer)
        .post('/v1/pow/verifications')
        .send({ challengeId: challenge.challengeId, nonce })
        .expect(200);

      // Second use — challenge is consumed
      const res = await request(httpServer)
        .post('/v1/pow/verifications')
        .send({ challengeId: challenge.challengeId, nonce })
        .expect(404);

      expect(bodyOf<ErrorApiResponse>(res).code).toBe(
        'POW_CHALLENGE_NOT_FOUND',
      );
    });

    it('should reject a nonce with invalid characters', async () => {
      const challengeRes = await request(httpServer)
        .post('/v1/pow/challenges')
        .send({})
        .expect(201);

      const { challengeId } = bodyOf<ChallengeApiResponse>(challengeRes);

      await request(httpServer)
        .post('/v1/pow/verifications')
        .send({ challengeId, nonce: 'bad nonce!' })
        .expect(400);
    });

    it('should reject non-integer solveTimeMs', async () => {
      const challengeRes = await request(httpServer)
        .post('/v1/pow/challenges')
        .send({})
        .expect(201);

      const { challengeId, seed, target } =
        bodyOf<ChallengeApiResponse>(challengeRes);
      const nonce = solveChallenge(challengeId, seed, target);

      await request(httpServer)
        .post('/v1/pow/verifications')
        .send({
          challengeId,
          nonce,
          clientMetrics: { solveTimeMs: 12.5 },
        })
        .expect(400);
    });
  });

  // ── Proof token introspection ─────────────────────────────────────────

  describe('POST /v1/pow/assertions/introspect', () => {
    async function obtainToken(): Promise<string> {
      const challengeRes = await request(httpServer)
        .post('/v1/pow/challenges')
        .send({ context: 'introspect-test' })
        .expect(201);

      const challenge = bodyOf<ChallengeApiResponse>(challengeRes);

      const nonce = solveChallenge(
        challenge.challengeId,
        challenge.seed,
        challenge.target,
      );

      const verifyRes = await request(httpServer)
        .post('/v1/pow/verifications')
        .send({ challengeId: challenge.challengeId, nonce })
        .expect(200);

      return bodyOf<VerificationApiResponse>(verifyRes).proofToken;
    }

    it('should validate and consume a valid proof token', async () => {
      const token = await obtainToken();

      const res = await request(httpServer)
        .post('/v1/pow/assertions/introspect')
        .send({ proofToken: token, consume: true })
        .expect(200);

      expect(bodyOf<IntrospectionApiResponse>(res)).toMatchObject({
        valid: true,
        context: 'introspect-test',
      });
    });

    it('should reject consumed token on second use', async () => {
      const token = await obtainToken();

      // First call — consume
      await request(httpServer)
        .post('/v1/pow/assertions/introspect')
        .send({ proofToken: token })
        .expect(200);

      // Second call — already used
      const res = await request(httpServer)
        .post('/v1/pow/assertions/introspect')
        .send({ proofToken: token })
        .expect(409);

      expect(bodyOf<ErrorApiResponse>(res).code).toBe('POW_TOKEN_ALREADY_USED');
    });

    it('should inspect without consuming when consume=false', async () => {
      const token = await obtainToken();

      // Read-only
      await request(httpServer)
        .post('/v1/pow/assertions/introspect')
        .send({ proofToken: token, consume: false })
        .expect(200);

      // Token should still be valid (not consumed)
      await request(httpServer)
        .post('/v1/pow/assertions/introspect')
        .send({ proofToken: token, consume: false })
        .expect(200);
    });

    it('should reject a tampered token', async () => {
      const token = await obtainToken();
      const tampered = token.slice(0, -4) + 'XXXX';

      await request(httpServer)
        .post('/v1/pow/assertions/introspect')
        .send({ proofToken: tampered })
        .expect(401);
    });

    it('should reject non-boolean consume value', async () => {
      const token = await obtainToken();

      await request(httpServer)
        .post('/v1/pow/assertions/introspect')
        .send({ proofToken: token, consume: 'true' })
        .expect(400);
    });
  });

  // ── Health endpoint ───────────────────────────────────────────────────

  describe('GET /v1/health', () => {
    it('should return health status with redis check', async () => {
      const res = await request(httpServer).get('/v1/health').expect(200);
      expect(bodyOf<HealthApiResponse>(res).status).toBe('ok');
    });

    it('liveness should always return ok', async () => {
      await request(httpServer).get('/v1/health/liveness').expect(200);
    });
  });
});
