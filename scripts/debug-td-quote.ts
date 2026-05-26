/**
 * Debug TD /quote pour 5 tickers US — dump RAW response.
 * Pas de hypothèse, juste les facts.
 *
 * Usage : TWELVEDATA_API_KEY=xxx npx tsx scripts/debug-td-quote.ts
 * (ou tu shar la clé TD et je le run)
 */
async function probeTd(apiKey: string, symbol: string): Promise<void> {
  const url = `https://api.twelvedata.com/quote?symbol=${encodeURIComponent(symbol)}&apikey=${apiKey}`;
  const t0 = Date.now();
  const res = await fetch(url);
  const data: any = await res.json();
  const elapsed = Date.now() - t0;
  const nowSec = Math.floor(Date.now() / 1000);

  console.log(`\n=== ${symbol} (HTTP ${res.status}, ${elapsed}ms) ===`);
  console.log(`Raw keys: ${Object.keys(data).join(', ')}`);

  // Champs critiques
  const fields = ['symbol', 'name', 'exchange', 'currency', 'datetime', 'timestamp', 'open', 'high', 'low', 'close', 'volume', 'previous_close', 'change', 'percent_change', 'is_market_open', 'fifty_two_week'];
  for (const f of fields) {
    if (data[f] !== undefined) {
      const v = typeof data[f] === 'object' ? JSON.stringify(data[f]).slice(0, 80) : data[f];
      console.log(`  ${f.padEnd(20)} = ${v}`);
    }
  }

  // Calcul age si timestamp present
  if (data.timestamp != null) {
    const tsNum = Number(data.timestamp);
    const ageSec = nowSec - tsNum;
    const flag = ageSec > 180 ? '❌ STALE (>180s)' : '✅ FRESH';
    console.log(`  → timestamp age: ${ageSec}s ${flag}`);
  }

  // Calcul age si datetime present (parsing brut UTC vs parsing offset)
  if (typeof data.datetime === 'string') {
    const parsedAsUtc = Date.parse(data.datetime.replace(' ', 'T') + 'Z') / 1000;
    const ageAsUtc = nowSec - parsedAsUtc;
    console.log(`  → datetime parsé EN UTC age: ${ageAsUtc}s (notre code actuel)`);
    // Et si on suppose NYSE EDT (UTC-4)
    const parsedAsEdt = Date.parse(data.datetime.replace(' ', 'T') + '-04:00') / 1000;
    const ageAsEdt = nowSec - parsedAsEdt;
    console.log(`  → datetime parsé COMME NYSE EDT (UTC-4) age: ${ageAsEdt}s`);
  }
}

(async () => {
  const apiKey = process.env.TWELVEDATA_API_KEY;
  if (!apiKey) {
    console.error('❌ TWELVEDATA_API_KEY env var required');
    console.error('Run: TWELVEDATA_API_KEY=<your-key> npx tsx scripts/debug-td-quote.ts');
    process.exit(1);
  }
  console.log(`Now UTC: ${new Date().toISOString()}`);
  console.log(`Now unix: ${Math.floor(Date.now() / 1000)}`);

  for (const sym of ['AAPL', 'EL', 'LOGI', 'VUZI', 'NTAP']) {
    await probeTd(apiKey, sym);
  }

  console.log('\n=== Conclusion attendue ===');
  console.log('- Si `timestamp` field manque pour certains symboles → fallback datetime');
  console.log('- Si `datetime` parsé UTC donne 14400s d\'age (4h) → bug timezone EDT');
  console.log('- Si `timestamp` présent et age < 180s → notre code marche, autre source du bug');
})();
