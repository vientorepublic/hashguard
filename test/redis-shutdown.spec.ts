import { Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import {
  RedisModule,
  REDIS_SHUTDOWN_TIMEOUT_MS,
} from '../src/modules/redis/redis.module';

describe('Redis shutdown lifecycle', () => {
  let warn: jest.SpyInstance;
  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  function fixture(quit = jest.fn().mockResolvedValue('OK'), status = 'ready') {
    const client = { quit, status, disconnect: jest.fn() };
    const moduleRef = { get: () => client } as unknown as ModuleRef;
    return { client, module: new RedisModule(moduleRef) };
  }

  it('sends QUIT and disables reconnection after successful cleanup', async () => {
    const { client, module } = fixture();
    await module.onApplicationShutdown();
    expect(client.quit).toHaveBeenCalledTimes(1);
    expect(client.disconnect).toHaveBeenCalledWith(false);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('disconnects if QUIT fails', async () => {
    const { client, module } = fixture(
      jest.fn().mockRejectedValue(new Error('offline')),
    );
    await module.onApplicationShutdown();
    expect(client.disconnect).toHaveBeenCalledWith(false);
    expect(warn).toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('disconnects if QUIT never resolves during reconnect', async () => {
    const { client, module } = fixture(
      jest.fn(() => new Promise(() => {})),
      'reconnecting',
    );
    const shutdown = module.onApplicationShutdown();
    await jest.advanceTimersByTimeAsync(REDIS_SHUTDOWN_TIMEOUT_MS);
    await shutdown;
    expect(client.disconnect).toHaveBeenCalledWith(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('timed out'));
  });

  it('does not send QUIT to an already ended client', async () => {
    const { client, module } = fixture(undefined, 'end');
    await module.onApplicationShutdown();
    expect(client.quit).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });
});
