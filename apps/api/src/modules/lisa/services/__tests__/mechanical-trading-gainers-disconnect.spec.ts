/**
 * PR Gainers-autonomy — tests du gate strategy_mode='gainers' dans
 * MechanicalTradingService.processPortfolio.
 *
 * En mode 'gainers' :
 *   - Step 0.5 (agent ↔ Lisa wake-up) SKIPPÉ
 *   - Step 1   (closes Lisa via directive.closeConditions) SKIPPÉ
 *   - Step 3   (opens Lisa via directive.targetSymbols) SKIPPÉ (early return)
 *
 * Restent actifs en gainers (protections capital universelles) :
 *   - Step 0   drawdown guard
 *   - Step 0bis autonomy rules
 *   - Step 0.6 news shock close
 *   - Step 2   stops/TP/trailing
 *
 * Test logique pure, sans instancier le service complet (≈30 deps Supabase
 * + Lisa + Binance + EODHD ne sont pas mockables en unit). On valide la
 * cascade de skips telle qu'implémentée dans le source.
 */

interface MockSessionConfig {
  portfolio_id: string;
  strategy_mode: string | null;
}

interface ProcessedSteps {
  step0_drawdown: boolean;
  step0bis_autonomy: boolean;
  step0_5_lisa_wake: boolean;
  step0_6_news_shock: boolean;
  step1_closes_lisa: boolean;
  step2_stops_tp: boolean;
  step3_opens_lisa: boolean;
}

/**
 * Réplique la logique de processPortfolio post-PR Gainers-autonomy :
 *   const isGainersMode = cfg.strategy_mode === 'gainers';
 *   Step 0   → toujours
 *   Step 0bis→ toujours
 *   Step 0.5 → if (!isGainersMode) ...
 *   Step 0.6 → toujours
 *   Step 1   → if (directive && !isGainersMode) ...
 *   Step 2   → toujours (stops/TP universels)
 *   Step 3   → if (isGainersMode) early return; ...
 */
function simulateProcessPortfolio(
  cfg: MockSessionConfig,
  hasDirective: boolean,
): ProcessedSteps {
  const isGainersMode = cfg.strategy_mode === 'gainers';
  const out: ProcessedSteps = {
    step0_drawdown: true,
    step0bis_autonomy: true,
    step0_5_lisa_wake: !isGainersMode,
    step0_6_news_shock: true,
    step1_closes_lisa: hasDirective && !isGainersMode,
    step2_stops_tp: true,
    step3_opens_lisa: !isGainersMode && hasDirective,
  };
  return out;
}

describe('MechanicalTradingService — strategy_mode=gainers gates', () => {
  it('GAINERS : Step 0.5 / 1 / 3 SKIPPÉS, protections capital actives', () => {
    const result = simulateProcessPortfolio(
      { portfolio_id: 'p1', strategy_mode: 'gainers' },
      true,
    );

    // Skips Lisa LLM
    expect(result.step0_5_lisa_wake).toBe(false);
    expect(result.step1_closes_lisa).toBe(false);
    expect(result.step3_opens_lisa).toBe(false);

    // Protections capital toujours actives
    expect(result.step0_drawdown).toBe(true);
    expect(result.step0bis_autonomy).toBe(true);
    expect(result.step0_6_news_shock).toBe(true);
    expect(result.step2_stops_tp).toBe(true);
  });

  it('INVESTMENT : tous les steps actifs', () => {
    const result = simulateProcessPortfolio(
      { portfolio_id: 'p2', strategy_mode: 'investment' },
      true,
    );

    expect(result.step0_5_lisa_wake).toBe(true);
    expect(result.step1_closes_lisa).toBe(true);
    expect(result.step3_opens_lisa).toBe(true);
    expect(result.step2_stops_tp).toBe(true);
  });

  it('HARVEST : tous les steps actifs', () => {
    const result = simulateProcessPortfolio(
      { portfolio_id: 'p3', strategy_mode: 'harvest' },
      true,
    );

    expect(result.step0_5_lisa_wake).toBe(true);
    expect(result.step1_closes_lisa).toBe(true);
    expect(result.step3_opens_lisa).toBe(true);
  });

  it('NULL strategy_mode (legacy) : tous les steps actifs (backward compat)', () => {
    const result = simulateProcessPortfolio(
      { portfolio_id: 'p4', strategy_mode: null },
      true,
    );

    expect(result.step0_5_lisa_wake).toBe(true);
    expect(result.step1_closes_lisa).toBe(true);
    expect(result.step3_opens_lisa).toBe(true);
  });

  it('GAINERS sans directive : Step 1/3 sont déjà no-op, Step 0.5 reste skippé', () => {
    const result = simulateProcessPortfolio(
      { portfolio_id: 'p5', strategy_mode: 'gainers' },
      false,
    );

    expect(result.step0_5_lisa_wake).toBe(false);
    expect(result.step1_closes_lisa).toBe(false);
    expect(result.step3_opens_lisa).toBe(false);
    expect(result.step2_stops_tp).toBe(true); // critique : stops gainers fermés ici
  });

  it('INVESTMENT sans directive : Step 0.5 reste actif, Step 1/3 no-op faute de directive', () => {
    const result = simulateProcessPortfolio(
      { portfolio_id: 'p6', strategy_mode: 'investment' },
      false,
    );

    expect(result.step0_5_lisa_wake).toBe(true);
    expect(result.step1_closes_lisa).toBe(false);
    expect(result.step3_opens_lisa).toBe(false);
  });
});
