import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const logger = new Logger('Bootstrap');
  const config = app.get(ConfigService);
  const corsOrigins = config.get<string>('app.corsOrigins', '*');

  // Trust Cloudflare / upstream proxy
  app.getHttpAdapter().getInstance().set('trust proxy', 1);

  // CORS
  app.enableCors({
    origin:
      corsOrigins === '*' ? true : corsOrigins.split(',').map((o) => o.trim()),
    methods: ['GET', 'POST', 'OPTIONS'],
    credentials: true,
  });

  // Global route prefix
  app.setGlobalPrefix('v1');

  // Global validation pipe (strips unknown fields, enables class-validator)
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // Global exception filter (uniform JSON error responses)
  app.useGlobalFilters(new AllExceptionsFilter());

  // OpenAPI / Swagger
  const swaggerConfig = new DocumentBuilder()
    .setTitle('HashGuard PoW API')
    .setDescription(
      'Proof-of-Work CAPTCHA service to mitigate automated bot attacks. ' +
        'Clients solve a SHA-256 challenge before accessing protected resources.',
    )
    .setVersion('1.0')
    .addTag('pow', 'Challenge issuance and verification')
    .addTag('health', 'Health and readiness probes')
    .addTag('metrics', 'Operational metrics')
    .build();

  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('docs', app, document, {
    swaggerOptions: { persistAuthorization: true },
  });

  const port = config.get<number>('app.port', 3000);
  await app.listen(port);
  logger.log(`HashGuard listening on http://localhost:${port}`);
}

void bootstrap();
