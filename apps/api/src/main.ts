import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { createClient } from '@supabase/supabase-js';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/all-exceptions.filter';
import { BufferLogger } from './modules/admin/log-buffer.service';

/**
 * EODHD UNIVERSAL TRACER (DIAGNOSTIC 06/06/2026 — temporaire).
 *
 * Constat : EODHD /api/user facture 84 907 appels/jour alors que
 * `eodhd_request_log` n'en voit que ~2 300 « réels ». ~82k appels/jour
 * échappent à `logEodhdCall` (call-sites non instrumentés). Impossible
 * d'attribuer la consommation → on ne peut pas couper le gaspillage.
 *
 * Ce hook intercepte TOUT `fetch()` vers eodhd.com et écrit une ligne
 * `eodhd_request_log` avec `called_by='trace:<Classe.méthode@fichier.js:ligne>'`
 * + l'endpoint. On interroge ensuite `WHERE called_by LIKE 'trace:%'` groupé
 * par called_by → chaque consommateur devient visible, fichier+ligne à l'appui.
 *
 * Réversible : `EODHD_TRACE_ENABLED=false` désactive (default actif). À retirer
 * une fois le coupable identifié. Fire-and-forget : n'altère jamais le fetch
 * d'origine (lecture de res.ok/status uniquement, pas du body).
 */
function installEodhdTracer(): void {
  if ((process.env.EODHD_TRACE_ENABLED ?? 'true').toLowerCase() === 'false') return;
  const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return;

  const sb = createClient(url, key);
  const origFetch = globalThis.fetch;

  const record = (caller: string, endpoint: string, ticker: string, ok: boolean, status: number): void => {
    void sb.from('eodhd_request_log').insert({
      provider: 'eodhd',
      source: 'eodhd',
      called_by: `trace:${caller}`,
      endpoint,
      ticker,
      success: ok,
      status_code: status,
      timestamp: new Date().toISOString(),
    }).then(() => undefined, () => undefined);
  };

  const wrapped = function (this: unknown, input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    let trace: { caller: string; endpoint: string; ticker: string } | null = null;
    try {
      const u = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url ?? '';
      if (typeof u === 'string' && u.includes('eodhd.com/api/')) {
        const m = u.match(/eodhd\.com\/api\/([a-z0-9-]+)(?:\/([^?]+))?/i);
        const endpoint = m?.[1] ?? 'other';
        const ticker = m?.[2] ? decodeURIComponent(m[2]).slice(0, 40) : '';
        const frames = (new Error().stack ?? '').split('\n').slice(2);
        const frame = frames.find((l) => l.includes('/dist/') && !l.includes('node_modules') && !l.includes('main.js'))
          ?? frames.find((l) => !l.includes('node_modules') && !l.includes('main.js'))
          ?? '';
        const fn = frame.match(/at\s+(\S+)\s/)?.[1] ?? '?';
        const loc = frame.match(/([\w.-]+\.js:\d+)/)?.[1] ?? '?';
        trace = { caller: `${fn}@${loc}`.slice(0, 90), endpoint, ticker };
      }
    } catch {
      /* never break fetch */
    }

    const p = origFetch(input, init);
    if (trace) {
      const t = trace;
      void p.then(
        (res) => record(t.caller, t.endpoint, t.ticker, res.ok, res.status),
        () => record(t.caller, t.endpoint, t.ticker, false, 0),
      );
    }
    return p;
  };

  globalThis.fetch = wrapped as typeof fetch;
  Logger.log('[EODHD-TRACE] intercepteur universel ACTIF (diagnostic) → eodhd_request_log called_by=trace:*', 'EodhdTrace');
}

async function bootstrap() {
  // DIAGNOSTIC 06/06 — doit être installé AVANT toute requête (donc avant le boot Nest).
  installEodhdTracer();

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
