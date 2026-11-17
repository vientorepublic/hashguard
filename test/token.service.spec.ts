import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { TokenService } from '../src/api/v1/modules/pow/token.service';

describe('Assertion binding', () => {
  const set = jest.fn().mockResolvedValue('OK');
  const service = new TokenService(
    { set } as unknown as Redis,
    new ConfigService({ pow: { proofTokenTtlSeconds: 300 } }),
  );
  beforeEach(() => set.mockClear());

  it('checks expected subject and scope before spending the assertion', async () => {
    const { token } = service.issue('203.0.113.1', 'search');
    for (const expected of [
      { expectedSubject: '203.0.113.2' },
      { expectedContext: 'export' },
    ]) {
      await expect(service.verify(token, true, expected)).rejects.toMatchObject(
        { status: 403 },
      );
    }
    expect(set).not.toHaveBeenCalled();
    await expect(
      service.verify(token, true, {
        expectedSubject: '203.0.113.1',
        expectedContext: 'search',
      }),
    ).resolves.toMatchObject({ sub: '203.0.113.1', context: 'search' });
    expect(set).toHaveBeenCalledTimes(1);
  });

  it('rejects the expiration second before consuming', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-11-15T00:00:00Z'));
    try {
      const { token } = service.issue('203.0.113.1', 'search');
      jest.advanceTimersByTime(300_000);
      await expect(service.verify(token)).rejects.toMatchObject({
        status: 401,
      });
      expect(set).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('rejects a token whose iat lies far in the future without consuming it', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-11-15T12:00:00Z'));
    try {
      const { token } = service.issue('203.0.113.1', 'search');
      // The verifier clock is now two hours behind: the iat is 2h ahead.
      jest.setSystemTime(new Date('2026-11-15T10:00:00Z'));
      await expect(service.verify(token)).rejects.toMatchObject({
        status: 401,
      });
      expect(set).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('honors a configured iat future-skew window', async () => {
    jest.useFakeTimers();
    try {
      const mk = (skewSeconds: number) =>
        new TokenService(
          { set } as unknown as Redis,
          new ConfigService({
            pow: {
              proofTokenTtlSeconds: 300,
              iatFutureSkewSeconds: skewSeconds,
            },
          }),
        );

      // A large tolerance admits a token whose iat is two hours ahead.
      const generous = mk(10_000);
      jest.setSystemTime(new Date('2026-11-15T12:00:00Z'));
      const { token: generousToken } = generous.issue('203.0.113.1', 'search');
      jest.setSystemTime(new Date('2026-11-15T10:00:00Z'));
      await expect(generous.verify(generousToken)).resolves.toMatchObject({
        sub: '203.0.113.1',
      });

      // A zero tolerance rejects the same far-future iat for a self-issued token.
      const strict = mk(0);
      jest.setSystemTime(new Date('2026-11-15T12:00:00Z'));
      const { token: strictToken } = strict.issue('203.0.113.1', 'search');
      jest.setSystemTime(new Date('2026-11-15T11:00:00Z'));
      await expect(strict.verify(strictToken)).rejects.toMatchObject({
        status: 401,
      });
    } finally {
      jest.useRealTimers();
    }
  });
});
