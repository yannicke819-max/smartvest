const TD_KEY = '1304e11cb4f648b196e9b6b2182705ab';

// Tickers we just closed, in TD format (.KO → :KRX, .KQ → :KRX, .SHE → :SZSE, .SHG → :SSE)
const PROBES = [
  { ours: '092220.KO',  td: '092220:KRX'  },
  { ours: '009190.KO',  td: '009190:KRX'  },
  { ours: '011230.KO',  td: '011230:KRX'  },
  { ours: '001820.KO',  td: '001820:KRX'  },
  { ours: '052710.KQ',  td: '052710:KRX'  },
  { ours: '048410.KQ',  td: '048410:KRX'  },
  { ours: '002613.SHE', td: '002613:SZSE' },
  { ours: '300286.SHE', td: '300286:SZSE' },
  { ours: '300041.SHE', td: '300041:SZSE' },
  { ours: '000518.SHE', td: '000518:SZSE' },
  { ours: '300196.SHE', td: '300196:SZSE' },
  { ours: '600863.SHG', td: '600863:SSE'  },
  { ours: '603001.SHG', td: '603001:SSE'  },
];

const STORED_ENTRY: Record<string, number> = {
  '092220.KO': 6790, '009190.KO': 1550, '011230.KO': 2680, '001820.KO': 102000,
  '052710.KQ': 22800, '048410.KQ': 13450,
  '002613.SHE': 4.59, '300286.SHE': 32.27, '300041.SHE': 14.25, '000518.SHE': 4.54, '300196.SHE': 23.92,
  '600863.SHG': 5.93, '603001.SHG': 10.66,
};

(async () => {
  console.log(`Now UTC: ${new Date().toISOString()}\n`);
  console.log(`Market hours (UTC):`);
  console.log(`  Tokyo  00:00-06:00   Korea 00:00-06:30   Shanghai/Shenzhen 01:30-07:00   HK 01:30-08:00\n`);
  console.log(`${'symbol'.padEnd(13)} ${'TD ts UTC'.padEnd(20)} ${'age'.padStart(10)} ${'close'.padStart(12)} ${'stored entry'.padStart(12)} ${'diff%'.padStart(8)} is_open`);
  console.log('-'.repeat(110));

  for (const { ours, td } of PROBES) {
    try {
      const r = await fetch(`https://api.twelvedata.com/quote?symbol=${encodeURIComponent(td)}&apikey=${TD_KEY}`);
      const j: any = await r.json();
      if (j.code === 400 || j.code === 404 || j.status === 'error') {
        console.log(`${ours.padEnd(13)} ERROR ${j.code ?? ''} ${j.message?.slice(0, 60) ?? ''}`);
        continue;
      }
      const tsSec = j.timestamp ? Number(j.timestamp) : null;
      const ts = tsSec ? new Date(tsSec * 1000).toISOString().slice(0, 19) + 'Z' : 'null';
      const ageSec = tsSec ? Math.floor(Date.now() / 1000 - tsSec) : null;
      const ageStr = ageSec === null ? '?' : ageSec < 3600 ? `${(ageSec/60).toFixed(1)}min` : ageSec < 86400 ? `${(ageSec/3600).toFixed(1)}h` : `${(ageSec/86400).toFixed(2)}d`;
      const close = j.close ? Number(j.close) : null;
      const entry = STORED_ENTRY[ours] ?? 0;
      const diffPct = close && entry ? ((close - entry) / entry * 100).toFixed(2) : '?';
      const open = j.is_market_open ?? '?';
      console.log(`${ours.padEnd(13)} ${ts.padEnd(20)} ${ageStr.padStart(10)} ${String(close).padStart(12)} ${String(entry).padStart(12)} ${String(diffPct).padStart(7)}% ${open}`);
    } catch (e: any) {
      console.log(`${ours.padEnd(13)} EXC ${e.message}`);
    }
  }

  // Also probe one crypto for control (markets always open)
  console.log(`\n=== Control: BTC/USD (markets 24/7) ===`);
  try {
    const r = await fetch(`https://api.twelvedata.com/quote?symbol=BTC/USD&apikey=${TD_KEY}`);
    const j: any = await r.json();
    const tsSec = j.timestamp ? Number(j.timestamp) : null;
    const ageSec = tsSec ? Math.floor(Date.now() / 1000 - tsSec) : null;
    console.log(`BTC/USD close=${j.close} age=${ageSec}s is_market_open=${j.is_market_open}`);
  } catch (e: any) { console.log(`BTC ERR: ${e.message}`); }
})();
