import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { config } from './config';
import { countRequest } from './health/metrics.controller';

export async function createApp(opts: { logger?: boolean } = {}): Promise<INestApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { rawBody: true, logger: opts.logger === false ? false : ['log', 'warn', 'error'] });
  app.setGlobalPrefix('api');
  app.set('trust proxy', 1);
  app.use(helmet());
  app.use(cookieParser());
  app.use((req: any, res: any, next: () => void) => {
    const t = Date.now();
    res.on('finish', () => countRequest(req.method, res.statusCode, Date.now() - t));
    next();
  });
  app.enableCors({ origin: config().CORS_ORIGIN.split(','), credentials: true, allowedHeaders: ['content-type', 'authorization', 'x-athos-csrf'] });
  app.enableShutdownHooks();
  const doc = new DocumentBuilder().setTitle('AthosBet API').setDescription('AthosBet sandbox sports betting API').setVersion('0.1.0').addBearerAuth().addCookieAuth('ab_at').build();
  SwaggerModule.setup('api/docs', app, SwaggerModule.createDocument(app, doc));
  return app;
}
