import { NestExpressApplication } from '@nestjs/platform-express';

/** Shared by production bootstrap and HTTP regression tests. */
export function configureJsonBodyParser(app: NestExpressApplication): void {
  // A valid introspection body includes an ASCII JWT (up to 2048 bytes),
  // a context (up to 128 characters, or 768 JSON-escaped bytes), an IP
  // and field overhead. Keep parsing bounded without rejecting issued tokens.
  app.useBodyParser('json', { limit: '4kb' });
}
