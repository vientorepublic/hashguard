import { type MockInstance } from 'vitest';
import { Logger } from '@nestjs/common';
import { installGracefulShutdown } from '../src/common/graceful-shutdown';

describe('process shutdown handlers', () => {
  let dispose: (() => void) | undefined;
  let exit: MockInstance;

  beforeEach(() => {
    vi.useFakeTimers();
    exit = vi
      .spyOn(process, 'exit')
      .mockImplementation(() => undefined as never);
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    dispose?.();
    dispose = undefined;
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each(['SIGTERM', 'SIGINT'] as const)(
    '%s waits for cleanup and exits successfully',
    async (signal) => {
      let finish!: () => void;
      const close = vi.fn(
        () => new Promise<void>((resolve) => (finish = resolve)),
      );
      dispose = installGracefulShutdown({ close });
      process.emit(signal, signal);
      expect(close).toHaveBeenCalledWith(signal);
      expect(exit).not.toHaveBeenCalled();
      finish();
      await Promise.resolve();
      expect(exit).toHaveBeenCalledWith(0);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('ignores repeated and mixed signals while requests drain', async () => {
    let finish!: () => void;
    const close = vi.fn(
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
    const close = vi.fn().mockRejectedValue(new Error('close failed'));
    dispose = installGracefulShutdown({ close });
    process.emit('SIGTERM', 'SIGTERM');
    await Promise.resolve();
    expect(exit).toHaveBeenCalledWith(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds a hung shutdown with a forced failure exit', () => {
    const close = vi.fn(() => new Promise<void>(() => {}));
    dispose = installGracefulShutdown({ close }, 100);
    process.emit('SIGINT', 'SIGINT');
    vi.advanceTimersByTime(99);
    expect(exit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('removes only the listeners it installed', () => {
    const count = process.listenerCount('SIGTERM');
    dispose = installGracefulShutdown({ close: vi.fn() });
    expect(process.listenerCount('SIGTERM')).toBe(count + 1);
    dispose();
    expect(process.listenerCount('SIGTERM')).toBe(count);
  });
});
