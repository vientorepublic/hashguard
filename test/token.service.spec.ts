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
});
