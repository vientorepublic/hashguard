import { Logger } from '@nestjs/common';
import { installGracefulShutdown } from '../src/common/graceful-shutdown';

describe('process shutdown handlers', () => {
  let dispose: (() => void) | undefined;
  let exit: jest.SpyInstance;

  beforeEach(() => {
    jest.useFakeTimers();
    exit = jest
      .spyOn(process, 'exit')
      .mockImplementation(() => undefined as never);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    dispose?.();
    dispose = undefined;
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it.each(['SIGTERM', 'SIGINT'] as const)(
    '%s waits for cleanup and exits successfully',
    async (signal) => {
      let finish!: () => void;
      const close = jest.fn(
        () => new Promise<void>((resolve) => (finish = resolve)),
      );
      dispose = installGracefulShutdown({ close });
      process.emit(signal, signal);
      expect(close).toHaveBeenCalledWith(signal);
      expect(exit).not.toHaveBeenCalled();
      finish();
      await Promise.resolve();
      expect(exit).toHaveBeenCalledWith(0);
      expect(jest.getTimerCount()).toBe(0);
    },
  );

  it('ignores repeated and mixed signals while requests drain', async () => {
    let finish!: () => void;
    const close = jest.fn(
      () => new Promise<void>((resolve) => (finish = resolve)),
    );
    dispose = installGracefulShutdown({ close });
    process.emit('SIGTERM', 'SIGTERM');
    process.emit('SIGINT', 'SIGINT');
    process.emit('SIGTERM', 'SIGTERM');
    expect(close).toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalled();
    finish();
    await Promise.resolve();
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('exits 1 when cleanup rejects', async () => {
    const close = jest.fn().mockRejectedValue(new Error('close failed'));
    dispose = installGracefulShutdown({ close });
    process.emit('SIGTERM', 'SIGTERM');
    await Promise.resolve();
    expect(exit).toHaveBeenCalledWith(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('bounds a hung shutdown with a forced failure exit', () => {
    const close = jest.fn(() => new Promise<void>(() => {}));
    dispose = installGracefulShutdown({ close }, 100);
    process.emit('SIGINT', 'SIGINT');
    jest.advanceTimersByTime(99);
    expect(exit).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('removes only the listeners it installed', () => {
    const count = process.listenerCount('SIGTERM');
    dispose = installGracefulShutdown({ close: jest.fn() });
    expect(process.listenerCount('SIGTERM')).toBe(count + 1);
    dispose();
    expect(process.listenerCount('SIGTERM')).toBe(count);
  });
});
