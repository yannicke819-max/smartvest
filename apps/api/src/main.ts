import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/all-exceptions.filter';
import { BufferLogger } from './modules/admin/log-buffer.service';

async function bootstrap() {
  // P19x.6 (29/04/2026) — BufferLogger capture les Nest logs dans un ring
  // buffer in-memory (5000 lignes, rolls over). Exposé via /admin/logs/recent
  // pour grep des logs Fly sans flyctl auth (tooling user-side).
  const bufferLogger = new BufferLogger();
  // CORS : autorise les headers custom (x-user-id envoyé par apiFetch).
  const app = await NestFactory.create(AppModule, {
    logger: bufferLogger,
    cors: {
      origin: true,
      credentials: true,
      allowedHeaders: ['content-type', 'authorization', 'x-user-id'],
    },
  });
  app.useGlobalFilters(new AllExceptionsFilter());
  // Railway / Fly / Heroku injectent PORT ; en dev local on tombe sur API_PORT
  // puis 3001. Le bind sur 0.0.0.0 est indispensable en conteneur pour que le
  // reverse proxy puisse atteindre le serveur.
  const port = Number(process.env.PORT ?? process.env.API_PORT ?? 3001);
  await app.listen(port, '0.0.0.0');
  Logger.log(`SmartVest API écoute sur http://0.0.0.0:${port}`, 'Bootstrap');
}

void bootstrap();
