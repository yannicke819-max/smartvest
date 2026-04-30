/**
 * test-secrets.ts — Smoke test exhaustif des secrets prod (P0/P1/P2).
 *
 * Lit les vars d'env locales (charge `.env.local` si présent, sinon vraie env)
 * et ping chaque provider. Retourne tableau OK/FAIL + exit-code 1 si ≥1 P0 KO.
 *
 * Usage :
 *   # 1) Charger l'env Fly localement (read-only)
 *   flyctl ssh console -a smartvest -C 'env' > /tmp/fly.env
 *   # 2) Run
 *   pnpm tsx scripts/test-secrets.ts
 *   # OU avec env inline :
 *   ANTHROPIC_API_KEY=sk-... GEMINI_API_KEY=... ... pnpm tsx scripts/test-secrets.ts
 *
 * Sortie : tableau markdown + exit 0 si tous P0 OK, 1 sinon.
 */

type Crit = 'P0' | 'P1' | 'P2' | 'P3';
type Status = 'OK' | 'FAIL' | 'MISSING' | 'SKIP';

interface SecretTest {
  name: string;
  crit: Crit;
  platform: string;
  usage: string;
  test: () => Promise<{ status: Status; detail: string }>;
}

const env = process.env;

function present(key: string): boolean {
  const v = env[key];
  return typeof v === 'string' && v.length > 0;
}

async function ping(url: string, init: RequestInit = {}, timeoutMs = 8000): Promise<Response> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctl.signal });
  } finally {
    clearTimeout(t);
  }
}

const tests: SecretTest[] = [
  {
    name: 'ANTHROPIC_API_KEY',
    crit: 'P0',
    platform: 'Fly',
    usage: 'Lisa thesis_generation Opus 4.7 + scanner fallback ultime',
    test: async () => {
      if (!present('ANTHROPIC_API_KEY')) return { status: 'MISSING', detail: '' };
      const res = await ping('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': env.ANTHROPIC_API_KEY!,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: 'claude-opus-4-7',
          max_tokens: 4,
          messages: [{ role: 'user', content: 'ping' }],
        }),
      });
      if (res.ok) return { status: 'OK', detail: `200 OK model=claude-opus-4-7` };
      const body = await res.text();
      return { status: 'FAIL', detail: `${res.status} ${body.slice(0, 120)}` };
    },
  },
  {
    name: 'GEMINI_API_KEY',
    crit: 'P0',
    platform: 'Fly',
    usage: 'Scanner LLM router primaire (Gemini 2.5 Flash Lite)',
    test: async () => {
      if (!present('GEMINI_API_KEY')) return { status: 'MISSING', detail: '' };
      const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${env.GEMINI_API_KEY}`;
      const res = await ping(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: 'ping' }] }],
          generationConfig: { maxOutputTokens: 4 },
        }),
      });
      if (res.ok) return { status: 'OK', detail: '200 OK gemini-2.5-flash-lite' };
      const body = await res.text();
      return { status: 'FAIL', detail: `${res.status} ${body.slice(0, 120)}` };
    },
  },
  {
    name: 'EODHD_API_KEY',
    crit: 'P0',
    platform: 'Fly',
    usage: 'Toutes données marché US/EU/Asia',
    test: async () => {
      if (!present('EODHD_API_KEY')) return { status: 'MISSING', detail: '' };
      const res = await ping(`https://eodhd.com/api/user?api_token=${env.EODHD_API_KEY}&fmt=json`);
      if (res.ok) {
        const j: any = await res.json().catch(() => ({}));
        return {
          status: 'OK',
          detail: `apiRequests=${j.apiRequests ?? '?'}/${j.dailyRateLimit ?? '?'} subscriptionType=${j.subscriptionType ?? '?'}`,
        };
      }
      return { status: 'FAIL', detail: `${res.status}` };
    },
  },
  {
    name: 'SUPABASE_SERVICE_ROLE_KEY',
    crit: 'P0',
    platform: 'Fly',
    usage: 'Backend RLS-bypass writes/cron',
    test: async () => {
      if (!present('SUPABASE_SERVICE_ROLE_KEY') || !present('SUPABASE_URL')) {
        return { status: 'MISSING', detail: 'SUPABASE_URL or SERVICE_ROLE_KEY missing' };
      }
      const url = `${env.SUPABASE_URL!.replace(/\/$/, '')}/rest/v1/portfolios?select=id&limit=1`;
      const res = await ping(url, {
        headers: {
          apikey: env.SUPABASE_SERVICE_ROLE_KEY!,
          authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY!}`,
        },
      });
      if (res.ok) return { status: 'OK', detail: `200 OK on /portfolios` };
      const body = await res.text();
      return { status: 'FAIL', detail: `${res.status} ${body.slice(0, 120)}` };
    },
  },
  {
    name: 'NEXT_PUBLIC_SUPABASE_ANON_KEY',
    crit: 'P0',
    platform: 'Vercel',
    usage: 'Front Next.js Supabase auth',
    test: async () => {
      if (!present('NEXT_PUBLIC_SUPABASE_ANON_KEY') || !present('NEXT_PUBLIC_SUPABASE_URL')) {
        return { status: 'MISSING', detail: '' };
      }
      const url = `${env.NEXT_PUBLIC_SUPABASE_URL!.replace(/\/$/, '')}/auth/v1/health`;
      const res = await ping(url, { headers: { apikey: env.NEXT_PUBLIC_SUPABASE_ANON_KEY! } });
      return res.ok
        ? { status: 'OK', detail: '200 OK auth/v1/health' }
        : { status: 'FAIL', detail: `${res.status}` };
    },
  },
  {
    name: 'SCANNER_LLM_ROUTER_ENABLED',
    crit: 'P0',
    platform: 'Fly',
    usage: 'Toggle Phase 1 ADR-001 (doit être "true")',
    test: async () => {
      const v = env.SCANNER_LLM_ROUTER_ENABLED;
      if (!v) return { status: 'MISSING', detail: 'expected "true"' };
      if (v.toLowerCase() === 'true') return { status: 'OK', detail: 'true' };
      return { status: 'FAIL', detail: `got "${v}", expected "true" (Phase 1 ADR-001)` };
    },
  },
  {
    name: 'ADMIN_TOKEN',
    crit: 'P1',
    platform: 'Fly',
    usage: 'Header x-admin-token sur /admin/*',
    test: async () => {
      if (!present('ADMIN_TOKEN')) return { status: 'MISSING', detail: '' };
      return { status: 'OK', detail: `len=${env.ADMIN_TOKEN!.length}` };
    },
  },
  {
    name: 'FRED_API_KEY',
    crit: 'P1',
    platform: 'Fly',
    usage: 'Macro indicators (St. Louis Fed)',
    test: async () => {
      if (!present('FRED_API_KEY')) return { status: 'MISSING', detail: 'macro feature dégradé' };
      const url = `https://api.stlouisfed.org/fred/series?series_id=GDP&api_key=${env.FRED_API_KEY}&file_type=json`;
      const res = await ping(url);
      return res.ok ? { status: 'OK', detail: '200 OK series=GDP' } : { status: 'FAIL', detail: `${res.status}` };
    },
  },
  {
    name: 'BINANCE_API_KEY',
    crit: 'P2',
    platform: 'Fly',
    usage: 'Crypto exec (désactivé tant que BINANCE_EXECUTION_ENABLED=false)',
    test: async () => {
      if (!present('BINANCE_API_KEY')) return { status: 'SKIP', detail: 'crypto exec off' };
      const res = await ping('https://api.binance.com/api/v3/ping');
      return res.ok ? { status: 'OK', detail: 'reachable (key not validated, requires HMAC)' } : { status: 'FAIL', detail: `${res.status}` };
    },
  },
  {
    name: 'REDDIT_CLIENT_ID',
    crit: 'P2',
    platform: 'Fly',
    usage: 'News aggregator Reddit (fallback RSS si absent)',
    test: async () => {
      if (!present('REDDIT_CLIENT_ID') || !present('REDDIT_CLIENT_SECRET')) {
        return { status: 'SKIP', detail: 'fallback RSS' };
      }
      const auth = Buffer.from(`${env.REDDIT_CLIENT_ID}:${env.REDDIT_CLIENT_SECRET}`).toString('base64');
      const res = await ping('https://www.reddit.com/api/v1/access_token', {
        method: 'POST',
        headers: {
          authorization: `Basic ${auth}`,
          'content-type': 'application/x-www-form-urlencoded',
          'user-agent': env.REDDIT_USER_AGENT ?? 'smartvest/1.0',
        },
        body: 'grant_type=client_credentials',
      });
      return res.ok ? { status: 'OK', detail: 'OAuth2 token obtained' } : { status: 'FAIL', detail: `${res.status}` };
    },
  },
  {
    name: 'TWITTER_BEARER_TOKEN',
    crit: 'P2',
    platform: 'Fly',
    usage: 'Sentiment Twitter/X v2 (optionnel)',
    test: async () => {
      if (!present('TWITTER_BEARER_TOKEN')) return { status: 'SKIP', detail: 'sentiment Twitter off' };
      const res = await ping('https://api.x.com/2/tweets/search/recent?query=test&max_results=10', {
        headers: { authorization: `Bearer ${env.TWITTER_BEARER_TOKEN}` },
      });
      return res.ok ? { status: 'OK', detail: 'X v2 search OK' } : { status: 'FAIL', detail: `${res.status}` };
    },
  },
  {
    name: 'OPENAI_API_KEY',
    crit: 'P3',
    platform: 'Fly',
    usage: 'INTERDIT ADR-001 — doit être absent (Phase 4 cleanup)',
    test: async () => {
      if (!present('OPENAI_API_KEY')) return { status: 'OK', detail: 'absent (conforme ADR-001)' };
      return { status: 'FAIL', detail: 'présent — VIOLATION ADR-001, à unset' };
    },
  },
  {
    name: 'MISTRAL_API_KEY',
    crit: 'P3',
    platform: 'Fly',
    usage: 'INTERDIT ADR-001 — doit être absent (Phase 4 cleanup)',
    test: async () => {
      if (!present('MISTRAL_API_KEY')) return { status: 'OK', detail: 'absent (conforme ADR-001)' };
      return { status: 'FAIL', detail: 'présent — VIOLATION ADR-001, à unset' };
    },
  },
  {
    name: 'CLAUDE_MODEL_SONNET',
    crit: 'P3',
    platform: 'Fly',
    usage: 'INTERDIT ADR-001 — doit être absent (Phase 4 cleanup)',
    test: async () => {
      if (!present('CLAUDE_MODEL_SONNET')) return { status: 'OK', detail: 'absent (conforme ADR-001)' };
      return { status: 'FAIL', detail: 'présent — VIOLATION ADR-001, à unset' };
    },
  },
  {
    name: 'CLAUDE_MODEL_HAIKU',
    crit: 'P3',
    platform: 'Fly',
    usage: 'INTERDIT ADR-001 — doit être absent (Phase 4 cleanup)',
    test: async () => {
      if (!present('CLAUDE_MODEL_HAIKU')) return { status: 'OK', detail: 'absent (conforme ADR-001)' };
      return { status: 'FAIL', detail: 'présent — VIOLATION ADR-001, à unset' };
    },
  },
];

async function main() {
  const results: { secret: string; crit: Crit; platform: string; status: Status; detail: string; usage: string }[] = [];

  for (const t of tests) {
    process.stderr.write(`▶ ${t.name} ... `);
    try {
      const r = await t.test();
      results.push({ secret: t.name, crit: t.crit, platform: t.platform, status: r.status, detail: r.detail, usage: t.usage });
      process.stderr.write(`${r.status} ${r.detail}\n`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      results.push({ secret: t.name, crit: t.crit, platform: t.platform, status: 'FAIL', detail: `exception: ${msg.slice(0, 120)}`, usage: t.usage });
      process.stderr.write(`FAIL exception\n`);
    }
  }

  console.log('\n# Smoke test secrets — résultats\n');
  console.log(`Date : ${new Date().toISOString()}\n`);
  console.log('| Secret | Crit | Plateforme | Status | Détail |');
  console.log('|---|---|---|---|---|');
  for (const r of results) {
    console.log(`| \`${r.secret}\` | ${r.crit} | ${r.platform} | ${statusEmoji(r.status)} ${r.status} | ${r.detail} |`);
  }

  const p0Failures = results.filter((r) => r.crit === 'P0' && (r.status === 'FAIL' || r.status === 'MISSING'));
  if (p0Failures.length > 0) {
    console.error(`\n❌ ${p0Failures.length} P0 secret(s) KO — bloquant`);
    for (const f of p0Failures) console.error(`  - ${f.secret}: ${f.status} ${f.detail}`);
    process.exit(1);
  }

  const p1Issues = results.filter((r) => r.crit === 'P1' && (r.status === 'FAIL' || r.status === 'MISSING'));
  if (p1Issues.length > 0) {
    console.error(`\n⚠️  ${p1Issues.length} P1 secret(s) KO — feature dégradée mais non-bloquant`);
  }

  console.log('\n✅ Tous P0 OK');
  process.exit(0);
}

function statusEmoji(s: Status): string {
  return { OK: '✅', FAIL: '❌', MISSING: '⛔', SKIP: '⏭️' }[s];
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
