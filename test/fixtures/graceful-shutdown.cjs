// Container-only test fixture; this route is never part of the production image.
require('reflect-metadata');
const { NestFactory } = require('@nestjs/core');
const { AppModule } = require('./dist/app.module');
const { REDIS_CLIENT } = require('./dist/modules/redis/redis.module');
const { installGracefulShutdown } = require('./dist/common/graceful-shutdown');

(async () => {
  const app = await NestFactory.create(AppModule);
  installGracefulShutdown(app);
  const redis = app.get(REDIS_CLIENT);
  app.getHttpAdapter().get('/__test/slow', (_req, res) => {
    console.log('INFLIGHT_STARTED');
    setTimeout(() => {
      // Redis must still be available after the signal, until this response ends.
      redis
        .ping()
        .then((pong) => {
          res.json({ drained: true, redis: pong });
          console.log('INFLIGHT_FINISHED');
        })
        .catch((error) => {
          console.error(error);
          res.status(500).end();
        });
    }, 1500);
  });
  await app.listen(3000);
  console.log('FIXTURE_READY');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
