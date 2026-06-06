import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/all-exceptions.filter';
import { BufferLogger } from './modules/admin/log-buffer.service';

// ─── 06/06 TRACE EODHD (TEMPORAIRE — à retirer une fois le coupable trouvé) ───
// Wrappe fetch global pour attribuer TOUT appel eodhd.com/api/* (endpoint +
// caller via la stack) → dump du top toutes les 60s via le Nest Logger (capté
// par BufferLogger → grep via /admin/logs?pattern=eodhd-trace). Sert à
// pinpointer le consommateur EODHD invisible (résiduel ~4-5k/h hors instrument).
// Gated EODHD_TRACE_ENABLED (default 'true').
if ((process.env.EODHD_TRACE_ENABLED ?? 'true').toLowerCase() === 'true') {
  const _origFetch = globalThis.fetch;
  const eodhdCounts = new Map<string, number>();
  globalThis.fetch = function (
    input: Parameters<typeof _origFetch>[0],
    init?: Parameters<typeof _origFetch>[1],
  ): ReturnType<typeof _origFetch> {
    try {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('eodhd.com/api/')) {
        const m = url.match(/eodhd\.com\/api\/([a-z0-9-]+)/i);
        const ep = m ? m[1] : 'unknown';
        const frames = (new Error().stack ?? '')
          .split('\n')
          .slice(2, 7)
          .map((s) => s.trim().replace(/^at /, ''));
        const caller =
          frames.find((s) => /\.service\.|scanner|oversold|ohlcv|atr|macro|lisa/.test(s)) ?? frames[0] ?? '?';
        const key = `${ep} | ${caller.replace(/\s*\(.*$/, '').slice(0, 60)}`;
        eodhdCounts.set(key, (eodhdCounts.get(key) ?? 0) + 1);
      }
    } catch {
      /* never break fetch */
    }
    return _origFetch(input, init);
  };
  const eodhdTraceLogger = new Logger('eodhd-trace');
  setInterval(() => {
    if (eodhdCounts.size === 0) return;
    const entries = [...eodhdCounts.entries()].sort((a, b) => b[1] - a[1]);
    const total = entries.reduce((s, [, v]) => s + v, 0);
    const top = entries.slice(0, 12).map(([k, v]) => `${v}× ${k}`).join('  ||  ');
    eodhdTraceLogger.log(`[eodhd-trace] 60s total=${total} || ${top}`);
    eodhdCounts.clear();
  }, 60_000).unref();
}

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
