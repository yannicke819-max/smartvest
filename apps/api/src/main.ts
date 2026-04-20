import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { cors: true });
  const port = Number(process.env.API_PORT ?? 3001);
  await app.listen(port);
  Logger.log(`SmartVest API écoute sur http://localhost:${port}`, 'Bootstrap');
}

void bootstrap();
