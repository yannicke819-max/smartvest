import { canOpen } from '@smartvest/ai-analyst';

/**
 * PATCH 3 (PR#3 P1) — theme caps via canOpen() helper.
 *
 * Le test ci-dessous valide que le cap par thème agit en plus du cap
 * par classe d'actif : une nouvelle position est rejetée si elle ferait
 * dépasser le cap thème, MÊME si le cap classe est OK.
 *
 * Cas réel anticipé : geopolitical_safehaven peut concentrer GDX (equity),
 * SLV (commodity), RTX (equity) en respectant chaque cap individuel mais
 * en saturant le thème transverse à 60% du portfolio.
 */
describe('canOpen — theme caps (PATCH 3)', () => {
  it('rejects new position exceeding theme cap even if class cap OK', () => {
    const positions = [
      {
        ticker: 'GDX',
        assetClass: 'equity_us_large',
        sizeUsd: 2000,
        themes: ['geopolitical_safehaven' as const],
      },
      {
        ticker: 'SLV',
        assetClass: 'commodities_metals_precious',
        sizeUsd: 2000,
        themes: ['geopolitical_safehaven' as const],
      },
    ];
    const proposal = {
      ticker: 'RTX',
      assetClass: 'equity_us_large',
      sizeUsd: 1500,
      themes: ['geopolitical_safehaven' as const],
    };

    const result = canOpen(proposal, positions, {
      capital: 10000,
      maxAssetClassPct: { equity_us_large: 0.50 },        // permissif (35% projeté < 50%)
      maxThemePct: { geopolitical_safehaven: 0.40 },      // serré (55% projeté > 40%)
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('would_exceed_theme_cap');
    expect(result.details?.theme).toBe('geopolitical_safehaven');
    expect(result.details?.projected_pct).toBeCloseTo(0.55, 2);
    expect(result.details?.cap_pct).toBe(0.40);
  });

  it('rejects when class cap is breached but theme cap would be OK', () => {
    // Symétrie : cap classe casse, cap thème ok → la fonction doit retourner
    // would_exceed_class_cap (le check classe vient avant)
    const positions = [
      {
        ticker: 'AAPL',
        assetClass: 'equity_us_large',
        sizeUsd: 2500,
        themes: ['ai_megacap' as const],
      },
    ];
    const proposal = {
      ticker: 'NVDA',
      assetClass: 'equity_us_large',
      sizeUsd: 600,
      themes: ['ai_megacap' as const],
    };

    const result = canOpen(proposal, positions, {
      capital: 10000,
      maxAssetClassPct: { equity_us_large: 0.28 },  // cassé (31% > 28%)
      maxThemePct: { ai_megacap: 0.50 },             // ok
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('would_exceed_class_cap');
    expect(result.details?.asset_class).toBe('equity_us_large');
  });

  it('accepts when both caps are respected', () => {
    const positions = [
      {
        ticker: 'GDX',
        assetClass: 'equity_us_large',
        sizeUsd: 1500,
        themes: ['geopolitical_safehaven' as const],
      },
    ];
    const proposal = {
      ticker: 'SLV',
      assetClass: 'commodities_metals_precious',
      sizeUsd: 1000,
      themes: ['geopolitical_safehaven' as const],
    };

    const result = canOpen(proposal, positions, {
      capital: 10000,
      maxAssetClassPct: { equity_us_large: 0.28, commodities_metals_precious: 0.30 },
      maxThemePct: { geopolitical_safehaven: 0.40 },  // 25% projeté < 40%
    });

    expect(result.ok).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it('multiple themes on a position: any cap break rejects', () => {
    const positions = [
      {
        ticker: 'XOM',
        assetClass: 'equity_us_large',
        sizeUsd: 2500,
        themes: ['geopolitical_safehaven' as const, 'energy_disruption' as const],
      },
    ];
    // Nouvelle position pure energy_disruption qui pousse le thème energy_disruption au-delà du cap
    const proposal = {
      ticker: 'USO',
      assetClass: 'commodities_energy',
      sizeUsd: 1500,
      themes: ['energy_disruption' as const],
    };

    const result = canOpen(proposal, positions, {
      capital: 10000,
      maxAssetClassPct: { commodities_energy: 0.40 },  // ok (15%)
      maxThemePct: {
        geopolitical_safehaven: 0.50,                  // ok (25%)
        energy_disruption: 0.30,                       // cassé (40% > 30%)
      },
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('would_exceed_theme_cap');
    expect(result.details?.theme).toBe('energy_disruption');
  });

  it('no theme caps configured: never blocks on theme', () => {
    const positions = [
      {
        ticker: 'GDX',
        assetClass: 'equity_us_large',
        sizeUsd: 4000,
        themes: ['geopolitical_safehaven' as const],
      },
    ];
    const proposal = {
      ticker: 'SLV',
      assetClass: 'commodities_metals_precious',
      sizeUsd: 4000,
      themes: ['geopolitical_safehaven' as const],
    };

    const result = canOpen(proposal, positions, {
      capital: 10000,
      maxAssetClassPct: { equity_us_large: 0.50, commodities_metals_precious: 0.50 },
      // maxThemePct intentionnellement vide
    });

    expect(result.ok).toBe(true); // 80% sur le thème mais aucun cap configuré
  });

  it('proposal with no themes: only class cap is checked', () => {
    const positions = [
      {
        ticker: 'AAPL',
        assetClass: 'equity_us_large',
        sizeUsd: 1500,
        themes: ['ai_megacap' as const],
      },
    ];
    const proposal = {
      ticker: 'JNJ',
      assetClass: 'equity_us_large',
      sizeUsd: 1000,
      // pas de themes
    };

    const result = canOpen(proposal, positions, {
      capital: 10000,
      maxAssetClassPct: { equity_us_large: 0.28 },
      maxThemePct: { ai_megacap: 0.20 },
    });

    expect(result.ok).toBe(true); // 25% classe < 28%, position pas taguée → pas de check thème
  });

  it('returns invalid_capital when capital <= 0', () => {
    const result = canOpen(
      { ticker: 'X', assetClass: 'equity_us_large', sizeUsd: 100 },
      [],
      { capital: 0 },
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('invalid_capital');
  });
});
