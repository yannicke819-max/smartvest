import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { cors: true });
  // Railway / Fly / Heroku injectent PORT ; en dev local on tombe sur API_PORT
  // puis 3001. Le bind sur 0.0.0.0 est indispensable en conteneur pour que le
  // reverse proxy puisse atteindre le serveur.
  const port = Number(process.env.PORT ?? process.env.API_PORT ?? 3001);
  await app.listen(port, '0.0.0.0');
  Logger.log(`SmartVest API écoute sur http://0.0.0.0:${port}`, 'Bootstrap');
}

void bootstrap();
