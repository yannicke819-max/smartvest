import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL || '',
  process.env.SUPABASE_SERVICE_ROLE_KEY || '',
);

async function main() {
  const now = new Date();
  console.log(`[validation] @ ${now.toISOString()} — checking crypto_alt persistence post PR #512+#514\n`);

  for (const minutes of [10, 30, 60, 360, 1440]) {
    const since = new Date(now.getTime() - minutes * 60_000).toISOString();
    const { data, error } = await sb
      .from('gainers_user_shadow_signals')
      .select('symbol,asset_class,created_at')
      .gte('created_at', since)
      .in('asset_class', ['crypto_major', 'crypto_alt']);

    if (error) {
      console.error(`[${minutes}min] ERROR:`, error.message);
      continue;
    }

    const rows = data ?? [];
    const majors = new Set(rows.filter(r => r.asset_class === 'crypto_major').map(r => r.symbol));
    const alts = new Set(rows.filter(r => r.asset_class === 'crypto_alt').map(r => r.symbol));

    console.log(`[last ${String(minutes).padStart(4)} min]  total_signals=${rows.length}  majors_distinct=${majors.size}  alts_distinct=${alts.size}`);
    if (alts.size > 0) console.log(`              alts seen: ${[...alts].sort().join(', ')}`);
    if (majors.size > 0) console.log(`              majors:    ${[...majors].sort().join(', ')}`);
    console.log();
  }
}

main().catch(e => { console.error(e); process.exit(1); });
