import * as fs from 'fs';
const env = fs.readFileSync('.env', 'utf8').split('\n').reduce((acc, l) => {
  const m = l.match(/^([A-Z_][A-Z0-9_]*)=(.+)$/); if (m) acc[m[1]] = m[2]; return acc;
}, {} as Record<string, string>);

const KEY = env.TWELVEDATA_API_KEY;
if (!KEY) { console.error('No TWELVEDATA_API_KEY in .env'); process.exit(1); }

const symbols = ['RMV:LSE', 'EZJ:LSE', 'AJB:LSE', 'NANO:Euronext', 'AMS:SIX', 'AAPL', 'BTC/USD'];
(async () => {
  console.log(`Test : maintenant = ${new Date().toISOString()}\n`);
  for (const sym of symbols) {
    const url = `https://api.twelvedata.com/quote?symbol=${encodeURIComponent(sym)}&apikey=${KEY}`;
    try {
      const res = await fetch(url);
      const d = await res.json() as any;
      const ts = d.timestamp ? new Date(Number(d.timestamp) * 1000).toISOString() : 'n/a';
      const ageH = d.timestamp ? ((Date.now() - Number(d.timestamp) * 1000) / 3_600_000).toFixed(1) : 'n/a';
      const close = d.close ?? 'n/a';
      const exch = d.exchange ?? 'n/a';
      const eod = d.is_market_open;
      const dateClose = d.datetime ?? 'n/a';
      console.log(`${sym.padEnd(15)} close=${String(close).padStart(10)} datetime=${dateClose} ts=${ts} age=${ageH}h  marketOpen=${eod} exch=${exch}`);
    } catch (e) {
      console.log(`${sym.padEnd(15)} ERROR ${e}`);
    }
  }
})();
