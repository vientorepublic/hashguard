import { INestApplication, ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'crypto';
import type { Server } from 'http';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureJsonBodyParser } from '../src/common/configure-json-body-parser';
import { GlobalExceptionsFilter } from '../src/common/filters/global-exceptions.filter';

// Run against a dedicated Redis instance, never an application database.
describe('Production JSON parsing contract', () => {
  let app: INestApplication;
  let server: Server;
  const savedEnv = { ...process.env };

  beforeAll(async () => {
    Object.assign(process.env, {
      REDIS_KEY_PREFIX: `hg-body-test:${randomUUID()}:`,
      TRUSTED_PROXY: 'none',
      POW_RISK_KEY_SECRET: 'body-test-secret-at-least-32-characters',
      POW_CHALLENGE_RISK_THRESHOLD: '20',
    });
    const module = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = module.createNestApplication<NestExpressApplication>();
    configureJsonBodyParser(app as NestExpressApplication);
    app.setGlobalPrefix('v1');
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(new GlobalExceptionsFilter());
    await app.init();
    server = app.getHttpServer() as Server;
  });

  afterAll(async () => {
    if (app) await app.close();
    process.env = savedEnv;
  });

  it('consumes a legitimately issued assertion with escape-heavy context and both bindings', async () => {
    const context = '\u0001'.repeat(127) + 'x';
    const issued = await request(server)
      .post('/v1/pow/assessments')
      .send({ context })
      .expect(200);
    const body = issued.body as {
      action: string;
      verification: { proofToken: string };
    };
    expect(body.action).toBe('allow');
    const proofToken = body.verification.proofToken;
    const payload = JSON.parse(
      Buffer.from(proofToken.split('.')[1], 'base64url').toString(),
    ) as { sub: string };
    const input = {
      proofToken,
      consume: true,
      expectedContext: context,
      expectedSubject: payload.sub,
    };
    expect(Buffer.byteLength(JSON.stringify(input))).toBeGreaterThan(2048);
    await request(server)
      .post('/v1/pow/assertions/introspect')
      .send({ ...input, expectedContext: 'wrong' })
      .expect(403);
    const consumed = await request(server)
      .post('/v1/pow/assertions/introspect')
      .send(input)
      .expect(200);
    expect(consumed.body).toMatchObject({
      valid: true,
      context,
      subject: payload.sub,
    });
    await request(server)
      .post('/v1/pow/assertions/introspect')
      .send(input)
      .expect(409);
  });

  it('still rejects JSON above the bounded 4 KiB limit with a sanitized 413', async () => {
    const res = await request(server)
      .post('/v1/pow/assessments')
      .send({ context: 'x'.repeat(4096) })
      .expect(413);
    expect(res.body).toMatchObject({ statusCode: 413 });
    expect(JSON.stringify(res.body)).not.toContain('stack');
  });

  it('still rejects malformed JSON with 400', async () => {
    await request(server)
      .post('/v1/pow/assessments')
      .set('Content-Type', 'application/json')
      .send('{"context":')
      .expect(400);
  });
});
