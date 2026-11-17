import { type MockInstance } from 'vitest';
import { Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import {
  RedisModule,
  REDIS_SHUTDOWN_TIMEOUT_MS,
} from '../src/modules/redis/redis.module';

describe('Redis shutdown lifecycle', () => {
  let warn: MockInstance;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function fixture(quit = vi.fn().mockResolvedValue('OK'), status = 'ready') {
    const client = { quit, status, disconnect: vi.fn() };
    const moduleRef = { get: () => client } as unknown as ModuleRef;
    return { client, module: new RedisModule(moduleRef) };
  }

  it('sends QUIT and disables reconnection after successful cleanup', async () => {
    const { client, module } = fixture();
    await module.onApplicationShutdown();
    expect(client.quit).toHaveBeenCalledTimes(1);
    expect(client.disconnect).toHaveBeenCalledWith(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('disconnects if QUIT fails', async () => {
    const { client, module } = fixture(
      vi.fn().mockRejectedValue(new Error('offline')),
    );
    await module.onApplicationShutdown();
    expect(client.disconnect).toHaveBeenCalledWith(false);
    expect(warn).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('disconnects if QUIT never resolves during reconnect', async () => {
    const { client, module } = fixture(
      vi.fn(() => new Promise(() => {})),
      'reconnecting',
    );
    const shutdown = module.onApplicationShutdown();
    await vi.advanceTimersByTimeAsync(REDIS_SHUTDOWN_TIMEOUT_MS);
    await shutdown;
    expect(client.disconnect).toHaveBeenCalledWith(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('timed out'));
  });

  it('does not send QUIT to an already ended client', async () => {
    const { client, module } = fixture(undefined, 'end');
    await module.onApplicationShutdown();
    expect(client.quit).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
