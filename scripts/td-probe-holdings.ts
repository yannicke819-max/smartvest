import * as fs from 'fs';
const env = fs.readFileSync('.env', 'utf8').split('\n').reduce((acc, l) => {
  const m = l.match(/^([A-Z_][A-Z0-9_]*)=(.+)$/); if (m) acc[m[1]] = m[2]; return acc;
}, {} as Record<string, string>);
const KEY = env.TWELVEDATA_API_KEY;
if (!KEY) { console.log('⚠️ TWELVEDATA_API_KEY absent .env local — probe impossible (mais ça marche sur Fly).'); process.exit(0); }

const symbols = [
  { td: 'RMV:LSE', name: 'RMV.LSE Rightmove' },
  { td: 'EZJ:LSE', name: 'EZJ.LSE easyJet' },
  { td: 'AJB:LSE', name: 'AJB.LSE AJ Bell' },
  { td: 'BOY:LSE', name: 'BOY.LSE Bodycote' },
  { td: 'NANO:Euronext', name: 'NANO.PA Nanobiotix' },
  { td: 'AMS:SIX', name: 'AMS.SW ams-OSRAM' },
  { td: 'AAPL', name: 'AAPL US (control)' },
];

(async () => {
  console.log(`\n=== TwelveData /quote probe — ${new Date().toISOString()} ===\n`);
  for (const s of symbols) {
    try {
      const url = `https://api.twelvedata.com/quote?symbol=${encodeURIComponent(s.td)}&apikey=${KEY}`;
      const res = await fetch(url);
      const d = await res.json() as any;
      const ts = d.timestamp ? new Date(Number(d.timestamp) * 1000).toISOString() : 'n/a';
      const ageH = d.timestamp ? ((Date.now() - Number(d.timestamp) * 1000) / 3_600_000).toFixed(1) : 'n/a';
      const close = d.close ?? 'n/a';
      const datetime = d.datetime ?? 'n/a';
      const isOpen = d.is_market_open;
      const exchange = d.exchange ?? 'n/a';
      const status = d.status === 'error' ? `ERROR: ${d.message ?? '?'}` : 'ok';
      console.log(`${s.name.padEnd(28)} close=${String(close).padStart(10)} datetime=${datetime.padStart(20)} ts_age=${ageH}h marketOpen=${isOpen} ex=${exchange} ${status}`);
    } catch (e) {
      console.log(`${s.name.padEnd(28)} ERROR ${String(e).slice(0, 100)}`);
    }
  }
})();
