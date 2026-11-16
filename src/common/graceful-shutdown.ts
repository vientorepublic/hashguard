import { Logger, ShutdownSignal } from '@nestjs/common';
import type { NestApplicationContext } from '@nestjs/core';

// Leave time for Docker's stop_grace_period (30s) to collect the exit status.
export const SHUTDOWN_TIMEOUT_MS = 20_000;

/** Own signal handling here; do not also call app.enableShutdownHooks(). */
export function installGracefulShutdown(
  app: Pick<NestApplicationContext, 'close'>,
  timeoutMs = SHUTDOWN_TIMEOUT_MS,
): () => void {
  const logger = new Logger('GracefulShutdown');
  let shuttingDown = false;

  const shutdown = async (signal: ShutdownSignal): Promise<void> => {
    // Keep both listeners installed during drain; repeated signals must not
    // trigger Node's default termination or close resources twice.
    if (shuttingDown) return;
    shuttingDown = true;
    logger.log(`Received ${signal}; draining HTTP requests`);
    const deadline = setTimeout(() => {
      logger.error(`Shutdown exceeded ${timeoutMs}ms; forcing exit`);
      process.exit(1);
    }, timeoutMs);
    // Keep the deadline referenced even if a hung hook has no active handles.

    try {
      // Nest closes the HTTP server (waiting for in-flight requests) before
      // onApplicationShutdown, where Redis is released.
      await app.close(signal);
      clearTimeout(deadline);
      logger.log(`Graceful shutdown complete (${signal})`);
      process.exit(0);
    } catch (error) {
      clearTimeout(deadline);
      logger.error('Graceful shutdown failed', error);
      process.exit(1);
    }
  };

  const onTerm = () => void shutdown(ShutdownSignal.SIGTERM);
  const onInt = () => void shutdown(ShutdownSignal.SIGINT);
  process.on(ShutdownSignal.SIGTERM, onTerm);
  process.on(ShutdownSignal.SIGINT, onInt);

  // Allows an embedding application or a test to release only our listeners.
  return () => {
    process.off(ShutdownSignal.SIGTERM, onTerm);
    process.off(ShutdownSignal.SIGINT, onInt);
  };
}
