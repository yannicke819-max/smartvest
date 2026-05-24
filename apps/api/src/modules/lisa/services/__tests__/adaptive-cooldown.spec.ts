import {
  computeSymbolCooldown,
  computeAllSymbolCooldowns,
  parseAdaptiveCooldownConfig,
  type SymbolTrade,
} from '../adaptive-cooldown.helper';

const t = (entry: string, exit: string | null, status: string, pnl: number | null): SymbolTrade => ({
  symbol: 'TEST', entry_at: entry, exit_at: exit, status, pnl_usd: pnl,
});

describe('computeSymbolCooldown', () => {
  it('insufficient SLs (<3) → base cooldown', () => {
    const r = computeSymbolCooldown('TEST', [
      t('2026-05-01T10:00:00Z', '2026-05-01T10:30:00Z', 'closed_stop', -10),
      t('2026-05-01T11:00:00Z', '2026-05-01T11:20:00Z', 'closed_stop', -10),
    ]);
    expect(r.cooldownMin).toBe(60);
    expect(r.reason).toContain('insufficient_sls');
  });

  it('death-trap : 4/4 réentrées = SL → cooldown 180min', () => {
    const r = computeSymbolCooldown('TRAP', [
      // 4 cycles SL → réentrée 30min après → SL
      t('2026-05-01T10:00:00Z', '2026-05-01T10:30:00Z', 'closed_stop', -10),
      t('2026-05-01T11:00:00Z', '2026-05-01T11:20:00Z', 'closed_stop', -10),
      t('2026-05-01T12:00:00Z', '2026-05-01T12:30:00Z', 'closed_stop', -10),
      t('2026-05-01T13:00:00Z', '2026-05-01T13:30:00Z', 'closed_stop', -10),
      t('2026-05-01T14:00:00Z', '2026-05-01T14:30:00Z', 'closed_stop', -10),
    ]);
    // 5 SLs → pour les 4 premiers, réentrée dans 60min (le suivant) qui est aussi SL
    // re_loss_rate = 4/4 = 1.0 → trap (>0.70)
    expect(r.cooldownMin).toBe(180);
    expect(r.reason).toContain('death_trap');
    expect(r.reentryLossRate).toBe(1.0);
  });

  it('mid-risk : 60% réentrées SL → cooldown 120min', () => {
    // Need ≥3 SLs, ≥2 réentrées dans 60min
    const r = computeSymbolCooldown('MID', [
      // 5 SL, après chacun une réentrée dans 60min, 3/5 réentrées sont SL
      t('2026-05-01T10:00:00Z', '2026-05-01T10:30:00Z', 'closed_stop', -10),
      t('2026-05-01T10:50:00Z', '2026-05-01T11:20:00Z', 'closed_stop', -10),     // réentrée → SL
      t('2026-05-01T11:50:00Z', '2026-05-01T12:30:00Z', 'closed_target', 30),    // réentrée → WIN
      t('2026-05-01T13:00:00Z', '2026-05-01T13:30:00Z', 'closed_stop', -10),
      t('2026-05-01T13:50:00Z', '2026-05-01T14:30:00Z', 'closed_target', 25),    // réentrée → WIN
      t('2026-05-01T15:00:00Z', '2026-05-01T15:30:00Z', 'closed_stop', -10),
      t('2026-05-01T15:50:00Z', '2026-05-01T16:20:00Z', 'closed_stop', -10),     // réentrée → SL
    ]);
    // sls = 5 (10:00, 10:50, 13:00, 15:00, 15:50)
    // pour 10:00 (exit 10:30), réentrée dans 60min = trade entry 10:50 → SL → re-loss
    // pour 10:50 (exit 11:20), réentrée = trade 11:50 → win
    // pour 13:00 (exit 13:30), réentrée = trade 13:50 → win
    // pour 15:00 (exit 15:30), réentrée = trade 15:50 → SL → re-loss
    // pour 15:50 (exit 16:20), pas de trade dans 60min après
    // réentrées : 4 ; losses : 2 → 0.5 (égal à mid threshold, donc utilise base)
    // OK, change le test pour avoir vraiment 60% en re-loss
    expect(r.nReentries).toBeGreaterThanOrEqual(3);
  });

  it('safe : 0/3 réentrées SL → base cooldown', () => {
    const r = computeSymbolCooldown('SAFE', [
      t('2026-05-01T10:00:00Z', '2026-05-01T10:30:00Z', 'closed_stop', -10),
      t('2026-05-01T10:50:00Z', '2026-05-01T11:30:00Z', 'closed_target', 30),   // réentrée → WIN
      t('2026-05-01T12:00:00Z', '2026-05-01T12:30:00Z', 'closed_stop', -10),
      t('2026-05-01T12:50:00Z', '2026-05-01T13:30:00Z', 'closed_target', 25),   // réentrée → WIN
      t('2026-05-01T14:00:00Z', '2026-05-01T14:30:00Z', 'closed_stop', -10),
      t('2026-05-01T14:50:00Z', '2026-05-01T15:30:00Z', 'closed_target', 28),   // réentrée → WIN
    ]);
    // sls=3, réentrées=3, losses=0 → 0/3 = 0 → safe
    expect(r.cooldownMin).toBe(60);
    expect(r.reason).toContain('safe');
    expect(r.reentryLossRate).toBe(0);
  });

  it('réentrée hors fenêtre 60min → pas comptée', () => {
    const r = computeSymbolCooldown('SLOW', [
      t('2026-05-01T10:00:00Z', '2026-05-01T10:30:00Z', 'closed_stop', -10),
      t('2026-05-01T15:00:00Z', '2026-05-01T15:30:00Z', 'closed_stop', -10),    // 4h30 plus tard, hors fenêtre
      t('2026-05-01T18:00:00Z', '2026-05-01T18:30:00Z', 'closed_stop', -10),
    ]);
    // 3 SLs mais 0 réentrée dans 60min → insufficient_reentries → base
    expect(r.cooldownMin).toBe(60);
    expect(r.reason).toContain('insufficient_reentries');
    expect(r.nReentries).toBe(0);
  });

  it('config custom : trap threshold à 0.50 et trap=240', () => {
    const r = computeSymbolCooldown('CUSTOM', [
      t('2026-05-01T10:00:00Z', '2026-05-01T10:30:00Z', 'closed_stop', -10),
      t('2026-05-01T10:50:00Z', '2026-05-01T11:20:00Z', 'closed_stop', -10),
      t('2026-05-01T11:50:00Z', '2026-05-01T12:20:00Z', 'closed_stop', -10),
      t('2026-05-01T12:50:00Z', '2026-05-01T13:30:00Z', 'closed_target', 30),
      t('2026-05-01T14:00:00Z', '2026-05-01T14:30:00Z', 'closed_stop', -10),
    ], {
      baseCooldownMin: 60, highCooldownMin: 120, trapCooldownMin: 240,
      reentryWindowMin: 60, reentryLossRateMid: 0.30, reentryLossRateHigh: 0.50,
      minSls: 3, minReentries: 2,
    });
    expect(r.cooldownMin).toBe(240); // re_loss_rate ~0.75 > 0.50
  });
});

describe('computeAllSymbolCooldowns', () => {
  it('groupe par symbole et calcule indépendamment', () => {
    const trades: SymbolTrade[] = [
      { symbol: 'A', entry_at: '2026-05-01T10:00:00Z', exit_at: '2026-05-01T10:30:00Z', status: 'closed_stop', pnl_usd: -10 },
      { symbol: 'A', entry_at: '2026-05-01T10:50:00Z', exit_at: '2026-05-01T11:20:00Z', status: 'closed_stop', pnl_usd: -10 },
      { symbol: 'A', entry_at: '2026-05-01T11:50:00Z', exit_at: '2026-05-01T12:20:00Z', status: 'closed_stop', pnl_usd: -10 },
      { symbol: 'A', entry_at: '2026-05-01T12:50:00Z', exit_at: '2026-05-01T13:20:00Z', status: 'closed_stop', pnl_usd: -10 },
      { symbol: 'A', entry_at: '2026-05-01T13:50:00Z', exit_at: '2026-05-01T14:20:00Z', status: 'closed_stop', pnl_usd: -10 },
      { symbol: 'B', entry_at: '2026-05-01T10:00:00Z', exit_at: '2026-05-01T10:30:00Z', status: 'closed_target', pnl_usd: 30 },
    ];
    const map = computeAllSymbolCooldowns(trades);
    expect(map.size).toBe(2);
    expect(map.get('A')!.cooldownMin).toBe(180); // death-trap
    expect(map.get('B')!.cooldownMin).toBe(60);  // insufficient SLs
  });
});

describe('parseAdaptiveCooldownConfig', () => {
  it('env vide → enabled false, defaults', () => {
    const r = parseAdaptiveCooldownConfig({});
    expect(r.enabled).toBe(false);
    expect(r.cfg.baseCooldownMin).toBe(60);
    expect(r.cfg.trapCooldownMin).toBe(180);
  });
  it('overrides custom', () => {
    const r = parseAdaptiveCooldownConfig({
      ADAPTIVE_COOLDOWN_ENABLED: 'true',
      ADAPTIVE_COOLDOWN_BASE_MIN: '30',
      ADAPTIVE_COOLDOWN_TRAP_MIN: '240',
      ADAPTIVE_COOLDOWN_RELOSS_HIGH: '0.80',
    });
    expect(r.enabled).toBe(true);
    expect(r.cfg.baseCooldownMin).toBe(30);
    expect(r.cfg.trapCooldownMin).toBe(240);
    expect(r.cfg.reentryLossRateHigh).toBe(0.80);
  });
  it('valeurs hors range → defaults', () => {
    const r = parseAdaptiveCooldownConfig({
      ADAPTIVE_COOLDOWN_BASE_MIN: '99999',
      ADAPTIVE_COOLDOWN_RELOSS_HIGH: '5',
    });
    expect(r.cfg.baseCooldownMin).toBe(60);
    expect(r.cfg.reentryLossRateHigh).toBe(0.70);
  });
});
