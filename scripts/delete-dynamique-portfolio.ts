/**
 * Suppression contrôlée du portfolio Dynamique (4c7b284f-d51f-46a4-bcaa-ccd074195b53).
 *
 * Garde-fous (cf. incident TRADER 48 trades supprimés) :
 *   1. Backup JSON local des 2 rows AVANT toute modification.
 *   2. Mandate révoqué (UPDATE) avant DELETE — pas de race condition.
 *   3. DELETE portfolio en dernier — si FK violation, on s'arrête.
 *   4. Vérification post-delete (les rows doivent être absentes).
 *
 * Restauration : voir scripts/backup-dynamique-*.json pour le payload original.
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import * as fs from 'fs';
import * as path from 'path';

const PID = '4c7b284f-d51f-46a4-bcaa-ccd074195b53';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function main() {
  console.log('===== STEP 1 — BACKUP =====');
  const { data: portfolioRow, error: e1 } = await sb.from('portfolios').select('*').eq('id', PID).maybeSingle();
  if (e1 || !portfolioRow) throw new Error('Cannot fetch portfolio: ' + (e1?.message ?? 'not found'));
  console.log('Portfolio row OK:', portfolioRow.name);

  const { data: mandateRows, error: e2 } = await sb.from('autonomy_mandates').select('*').eq('portfolio_id', PID);
  if (e2) throw new Error('Cannot fetch mandates: ' + e2.message);
  console.log(`Mandate rows: ${mandateRows?.length ?? 0}`);

  const backup = {
    backed_up_at: new Date().toISOString(),
    portfolio_id: PID,
    portfolios_row: portfolioRow,
    autonomy_mandates_rows: mandateRows ?? [],
  };
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
  const backupPath = path.resolve(`scripts/backup-dynamique-${stamp}.json`);
  fs.writeFileSync(backupPath, JSON.stringify(backup, null, 2));
  console.log(`Backup written: ${backupPath}`);
  console.log(`Backup size: ${fs.statSync(backupPath).size} bytes`);
  console.log();

  console.log('===== STEP 2 — REVOKE MANDATE(S) =====');
  if ((mandateRows?.length ?? 0) > 0) {
    const { data: updated, error: e3 } = await sb
      .from('autonomy_mandates')
      .update({ revoked_at: new Date().toISOString(), kill_switch_active: true })
      .eq('portfolio_id', PID)
      .select('id,revoked_at,kill_switch_active');
    if (e3) throw new Error('Mandate revoke failed: ' + e3.message);
    console.log(`Updated ${updated?.length ?? 0} mandate(s):`);
    (updated ?? []).forEach((r: { id: string; revoked_at: string; kill_switch_active: boolean }) =>
      console.log(`  ${r.id} revoked_at=${r.revoked_at} kill_switch=${r.kill_switch_active}`),
    );
  } else {
    console.log('(no mandate to revoke)');
  }
  console.log();

  console.log('===== STEP 3 — DELETE PORTFOLIO =====');
  const { data: deleted, error: e4 } = await sb.from('portfolios').delete().eq('id', PID).select('id,name');
  if (e4) {
    console.error(`❌ DELETE failed: ${e4.message}`);
    console.error('   Si FK violation → le mandate est révoqué mais portfolio toujours présent.');
    console.error('   À traiter manuellement.');
    process.exit(1);
  }
  console.log(`Deleted ${deleted?.length ?? 0} portfolio(s):`, deleted);
  console.log();

  console.log('===== STEP 4 — VERIFICATION =====');
  const { data: stillThere } = await sb.from('portfolios').select('id').eq('id', PID).maybeSingle();
  console.log(`Portfolio query post-delete: ${stillThere ? '⚠️ STILL PRESENT (bug)' : '✅ ABSENT (success)'}`);

  const { data: mandatesStill } = await sb.from('autonomy_mandates').select('id,revoked_at').eq('portfolio_id', PID);
  console.log(`Mandates still linked: ${mandatesStill?.length ?? 0}`);
  (mandatesStill ?? []).forEach((m: { id: string; revoked_at: string }) =>
    console.log(`  ${m.id} (revoked at ${m.revoked_at}) — orphan, à nettoyer si besoin`),
  );

  console.log();
  console.log('===== DONE =====');
  console.log(`Backup: ${backupPath} (à conserver pour restore éventuel)`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
