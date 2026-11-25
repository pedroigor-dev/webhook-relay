import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import 'reflect-metadata';
import { AppModule } from './app.module';

export async function createApplication() {
  for (const key of ['API_KEY', 'WEBHOOK_SECRET']) {
    if (!process.env[key] || process.env[key]!.length < 32) {
      throw new Error(key + ' deve conter pelo menos 32 caracteres');
    }
  }
  if (!process.env.ALLOWED_WEBHOOK_ORIGINS) {
    throw new Error('ALLOWED_WEBHOOK_ORIGINS é obrigatório');
  }
  const app = await NestFactory.create(AppModule, {
    logger: ['error', 'warn'],
  });
  app.use(helmet());
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.enableShutdownHooks();
  const options = new DocumentBuilder()
    .setTitle('webhook-relay')
    .setVersion('1.0.0')
    .addApiKey({ type: 'apiKey', in: 'header', name: 'X-Api-Key' }, 'api-key')

    .build();
  SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, options), {
    customSiteTitle: 'webhook-relay | API',
  });
  return app;
}
