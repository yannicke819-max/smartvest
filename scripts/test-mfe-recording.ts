/**
 * Test MFE recording health for TRADER positions.
 *
 * Polls every 60s for 30 min. For each open TRADER position :
 *  1. Read peak_pre_exit from DB
 *  2. Fetch live price
 *  3. If livePrice > entry_price * 1.002 (i.e. moved up 0.2%) ET peak_pre_exit
 *     n'a pas bougé pendant 3 cycles consécutifs → FAIL : recordMfe inopérant
 *  4. Si peak_pre_exit augmente quand livePrice augmente → PASS
 *
 * Si aucune position TRADER n'est ouverte pendant 30 min, exit avec
 * "INCONCLUSIVE" — relance le test à l'ouverture suivante.
 */

import 'dotenv/config';

const SUPA_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://mfuutigfhrawccotinpo.supabase.co';
const SUPA_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const EOD_KEY = process.env.EODHD_API_KEY || '69e6325aa2c162.98850425';
const TRADER_ID = 'b0000001-0000-0000-0000-000000000001';

type Pos = {
  id: string;
  symbol: string;
  entry_price: string;
  peak_pre_exit: string | null;
  entry_timestamp: string;
  direction: string;
};

async function supaGet(path: string): Promise<unknown[]> {
  const r = await fetch(`${SUPA_URL}/rest/v1/${path}`, {
    headers: { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}` },
  });
  return (await r.json()) as unknown[];
}

async function getLivePrice(symbol: string): Promise<number | null> {
  // EODHD real-time pour US/EU equities
  try {
    const r = await fetch(`https://eodhd.com/api/real-time/${symbol}?api_token=${EOD_KEY}&fmt=json`, {
      signal: AbortSignal.timeout(8000),
    });
    const j = (await r.json()) as { close?: number };
    const p = Number(j?.close);
    return Number.isFinite(p) && p > 0 ? p : null;
  } catch {
    return null;
  }
}

type Sample = { ts: number; peak: number; live: number | null };

async function main() {
  console.log(`[MFE TEST] start @ ${new Date().toISOString()}`);
  console.log(`[MFE TEST] watching TRADER portfolio ${TRADER_ID.slice(0, 8)} for 30 min...`);
  const startMs = Date.now();
  const DURATION_MS = 30 * 60_000;
  const samples = new Map<string, Sample[]>(); // positionId → samples

  while (Date.now() - startMs < DURATION_MS) {
    const positions = (await supaGet(
      `lisa_positions?select=id,symbol,entry_price,peak_pre_exit,entry_timestamp,direction&portfolio_id=eq.${TRADER_ID}&status=eq.open`,
    )) as Pos[];

    if (positions.length === 0) {
      console.log(`[${new Date().toISOString().slice(11, 19)}] no open TRADER positions, waiting...`);
    } else {
      for (const p of positions) {
        const peak = Number(p.peak_pre_exit ?? p.entry_price);
        const entry = Number(p.entry_price);
        const live = await getLivePrice(p.symbol);
        const arr = samples.get(p.id) ?? [];
        arr.push({ ts: Date.now(), peak, live });
        samples.set(p.id, arr);

        const liveStr = live !== null ? `$${live.toFixed(4)}` : 'N/A';
        const peakMoved = arr.length > 1 ? peak !== Number(arr[0].peak) : false;
        const liveMovedUp = live !== null && live > entry * 1.002;
        const flag = peakMoved ? '✅' : (liveMovedUp ? '⚠️' : ' ');
        console.log(
          `[${new Date().toISOString().slice(11, 19)}] ${flag} ${p.symbol.padEnd(14)} entry=$${entry.toFixed(4)} peak=$${peak.toFixed(4)} live=${liveStr} (samples=${arr.length})`,
        );

        // FAIL detection : live > entry+0.2% pendant 3 cycles consécutifs ET peak inchangé
        if (arr.length >= 3) {
          const last3 = arr.slice(-3);
          const allLiveUp = last3.every((s) => s.live !== null && s.live > entry * 1.002);
          const peakSticky = last3.every((s) => s.peak === arr[0].peak);
          if (allLiveUp && peakSticky) {
            console.log(
              `\n🔴 [MFE TEST FAIL] ${p.symbol} : live a dépassé entry+0.2% pendant 3 cycles MAIS peak_pre_exit n'a jamais bougé. recordMfe() est CASSÉ pour ce portfolio.\n`,
            );
            console.log(`   Action requise : vérifier MechanicalTradingService.runMechanicalCycle filter (lisa_session_configs autopilot_enabled + kill_switch_active = false).`);
            process.exit(1);
          }
        }
      }
    }

    await new Promise((r) => setTimeout(r, 60_000));
  }

  // Final verdict
  console.log(`\n[MFE TEST] 30 min écoulés. Verdict :`);
  if (samples.size === 0) {
    console.log(`  INCONCLUSIVE : aucune position TRADER n'a été ouverte pendant le test.`);
    console.log(`  Relancer pendant Asia 00:00-08:00 UTC ou US 13:30-21:00 UTC.`);
    process.exit(2);
  }
  let allPass = true;
  const entries = Array.from(samples.entries());
  for (const [id, arr] of entries) {
    if (arr.length < 2) continue;
    const peaks = arr.map((s) => s.peak);
    const uniquePeaks = Array.from(new Set(peaks));
    const moved = uniquePeaks.length > 1;
    const positionInfo = `id=${id.slice(0, 8)}`;
    if (moved) {
      console.log(`  ✅ PASS ${positionInfo} : peak_pre_exit a évolué (${uniquePeaks.length} valeurs uniques)`);
    } else {
      // peak n'a pas bougé — vérifier si live a vraiment monté
      const livesUp = arr.filter((s) => s.live !== null).map((s) => s.live!);
      const maxLive = livesUp.length > 0 ? Math.max(...livesUp) : 0;
      const entry = arr[0].peak; // proxy
      if (maxLive > entry * 1.002) {
        console.log(`  🔴 FAIL ${positionInfo} : peak fixe alors que live a monté jusqu'à $${maxLive.toFixed(4)} (entry=$${entry.toFixed(4)})`);
        allPass = false;
      } else {
        console.log(`  ⚪ INCONCLUSIVE ${positionInfo} : peak fixe + live n'a jamais monté significativement (MAE-only trade)`);
      }
    }
  }
  process.exit(allPass ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(3);
});
