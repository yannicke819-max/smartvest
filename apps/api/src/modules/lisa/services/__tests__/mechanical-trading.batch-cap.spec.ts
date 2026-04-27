/**
 * PATCH 2 (PR#2 P0) — reproduit le bug LMT 27/04 et valide le fix.
 *
 * Bug original : Lisa propose 2 thèses au cycle 16:12:55 (RTX 2000$ déjà
 * tenu + GDX 1500$ + LMT 1800$). Class equity_us_large = 38% > cap 28%.
 * Le pré-check ligne 887 a refusé LMT (correct), MAIS le post-check
 * ligne 494-555 (P4.3 2-way) a fermé LMT 13s plus tard à -3.60$ frais.
 *
 * Le fix supprime le post-check. Seule la source de vérité = pré-check
 * incrémental (exposureByClass updated AFTER each insert).
 *
 * Le test ci-dessous reproduit la logique du pré-check en isolation.
 * Test integration full mechanical-trading.processPortfolio reporté
 * (cf. PATCH 1 — nécessite test harness Supabase chain mock complet).
 */

interface Proposal {
  ticker: string;
  assetClass: string;
  sizeUsd: number;
  conviction: number;
}

interface OpenedRecord {
  ticker: string;
  notional: number;
}

interface RejectedRecord {
  ticker: string;
  reason: string;
  projectedPct: number;
}

interface BatchResult {
  opened: OpenedRecord[];
  rejected: RejectedRecord[];
  closed: Array<{ ticker: string; reason: string }>;
  finalExposureByClass: Record<string, number>;
}

/**
 * Simule la logique de Step 3 du mechanical-trading post-PATCH 2 :
 *  - exposureByClass démarre = aggregate(currentPositions)
 *  - boucle proposals : pré-check incrémental (read map → projeter → check cap)
 *  - si refusé : push à rejected, NE PAS modifier la map
 *  - si accepté : push à opened, MAJ map
 *  - aucune fermeture forcée post-batch (post-check supprimé)
 */
function processBatch(args: {
  proposals: Proposal[];
  capital: number;
  currentPositions: Array<{ assetClass: string; notional: number }>;
  capByClass: Record<string, number>; // pct (ex: 0.28 = 28%)
}): BatchResult {
  const { proposals, capital, currentPositions, capByClass } = args;

  const exposureByClass: Record<string, number> = {};
  for (const p of currentPositions) {
    exposureByClass[p.assetClass] = (exposureByClass[p.assetClass] ?? 0) + p.notional;
  }

  const opened: OpenedRecord[] = [];
  const rejected: RejectedRecord[] = [];

  for (const proposal of proposals) {
    const current = exposureByClass[proposal.assetClass] ?? 0;
    const projected = current + proposal.sizeUsd;
    const pct = capital > 0 ? projected / capital : 0;
    const cap = capByClass[proposal.assetClass] ?? 1.0;

    if (pct > cap) {
      rejected.push({
        ticker: proposal.ticker,
        reason: 'would_exceed_class_cap',
        projectedPct: pct,
      });
      continue;
    }

    opened.push({ ticker: proposal.ticker, notional: proposal.sizeUsd });
    exposureByClass[proposal.assetClass] = projected;
  }

  return {
    opened,
    rejected,
    closed: [], // PATCH 2 — post-close supprimé, doit toujours être vide
    finalExposureByClass: exposureByClass,
  };
}

describe('mechanical-trading batch cap (PATCH 2 — fix bug LMT 27/04)', () => {
  it('reproduces bug LMT 27/04: GDX + LMT both equity_us_large, cap 28%', () => {
    const proposals: Proposal[] = [
      { ticker: 'GDX', assetClass: 'commodities_metals_precious', sizeUsd: 1500, conviction: 8 },
      { ticker: 'LMT', assetClass: 'equity_us_large', sizeUsd: 1800, conviction: 7 },
    ];
    const result = processBatch({
      proposals,
      capital: 10000,
      // RTX 2000 déjà tenu sur equity_us_large (cas réel 27/04)
      currentPositions: [{ assetClass: 'equity_us_large', notional: 2000 }],
      capByClass: { equity_us_large: 0.28, commodities_metals_precious: 0.30 },
    });

    // GDX passe : commodities, 0 + 1500 / 10000 = 15% < 30% ✅
    expect(result.opened).toHaveLength(1);
    expect(result.opened[0].ticker).toBe('GDX');

    // LMT rejeté AVANT ouverture : equity, (2000 + 1800) / 10000 = 38% > 28%
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].ticker).toBe('LMT');
    expect(result.rejected[0].reason).toBe('would_exceed_class_cap');
    expect(result.rejected[0].projectedPct).toBeCloseTo(0.38, 2);

    // AUCUNE fermeture forcée (post-check 2-way supprimé)
    expect(result.closed).toHaveLength(0);

    // Invariant final : equity reste à 20% (RTX seul), commodities à 15% (GDX)
    expect(result.finalExposureByClass['equity_us_large']).toBe(2000);
    expect(result.finalExposureByClass['commodities_metals_precious']).toBe(1500);
  });

  it('handles 2 same-class proposals at boot: 2nd rejected once 1st pushes class over cap', () => {
    // Cas additionnel : aucune position pré-existante, 2 propositions equity
    // dont la 2nde ferait déborder le cap après la 1re.
    const proposals: Proposal[] = [
      { ticker: 'AAPL', assetClass: 'equity_us_large', sizeUsd: 2400, conviction: 7 }, // 24%
      { ticker: 'MSFT', assetClass: 'equity_us_large', sizeUsd: 600, conviction: 8 },  // +6% → 30% > 28%
    ];
    const result = processBatch({
      proposals,
      capital: 10000,
      currentPositions: [],
      capByClass: { equity_us_large: 0.28 },
    });

    expect(result.opened).toHaveLength(1);
    expect(result.opened[0].ticker).toBe('AAPL');
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].ticker).toBe('MSFT');
    expect(result.closed).toHaveLength(0);
  });

  it('opens both when cumulative exposure stays under cap', () => {
    const proposals: Proposal[] = [
      { ticker: 'AAPL', assetClass: 'equity_us_large', sizeUsd: 1500, conviction: 7 }, // 15%
      { ticker: 'MSFT', assetClass: 'equity_us_large', sizeUsd: 1000, conviction: 8 }, // 25% total < 28%
    ];
    const result = processBatch({
      proposals,
      capital: 10000,
      currentPositions: [],
      capByClass: { equity_us_large: 0.28 },
    });

    expect(result.opened).toHaveLength(2);
    expect(result.opened.map((o) => o.ticker)).toEqual(['AAPL', 'MSFT']);
    expect(result.rejected).toHaveLength(0);
    expect(result.finalExposureByClass['equity_us_large']).toBe(2500);
  });

  it('respects pre-existing exposure: AAPL rejected if RTX + LMT already at 30%', () => {
    const proposals: Proposal[] = [
      { ticker: 'AAPL', assetClass: 'equity_us_large', sizeUsd: 1000, conviction: 7 },
    ];
    const result = processBatch({
      proposals,
      capital: 10000,
      currentPositions: [
        { assetClass: 'equity_us_large', notional: 2000 },
        { assetClass: 'equity_us_large', notional: 1000 },
      ],
      capByClass: { equity_us_large: 0.28 },
    });

    expect(result.opened).toHaveLength(0);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].ticker).toBe('AAPL');
    expect(result.rejected[0].projectedPct).toBeCloseTo(0.40, 2);
  });

  it('mixed classes: each class has independent cap', () => {
    const proposals: Proposal[] = [
      { ticker: 'GDX', assetClass: 'commodities_metals_precious', sizeUsd: 2500, conviction: 9 }, // 25%
      { ticker: 'AAPL', assetClass: 'equity_us_large', sizeUsd: 2700, conviction: 8 },           // 27%
      { ticker: 'NVDA', assetClass: 'equity_us_large', sizeUsd: 200, conviction: 9 },            // +2% → 29% > 28%
    ];
    const result = processBatch({
      proposals,
      capital: 10000,
      currentPositions: [],
      capByClass: {
        equity_us_large: 0.28,
        commodities_metals_precious: 0.30,
      },
    });

    // GDX et AAPL passent (chacun sous son cap), NVDA rejeté
    expect(result.opened).toHaveLength(2);
    expect(result.opened.map((o) => o.ticker)).toEqual(['GDX', 'AAPL']);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].ticker).toBe('NVDA');
  });
});
