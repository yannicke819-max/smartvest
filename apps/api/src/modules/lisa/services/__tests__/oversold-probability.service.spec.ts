import { ConfigService } from '@nestjs/config';
import { OversoldProbabilityService } from '../oversold-probability.service';

// Phase 3b shadow — estimatePWin : reconstruction des poids depuis le JSONB plat
// {intercept, ...coefs} et prédiction. Supabase mocké.

function makeSupabase(row: { version: string; weights: Record<string, number> } | null) {
  const builder: Record<string, unknown> = {
    select: () => builder,
    like: () => builder,
    order: () => builder,
    limit: () => builder,
    eq: () => builder,
    not: () => builder,
    maybeSingle: () => Promise.resolve({ data: row, error: null }),
  };
  return {
    isReady: () => true,
    getClient: () => ({ from: () => builder }),
  } as never;
}

const config = { get: () => undefined } as unknown as ConfigService;

describe('OversoldProbabilityService.estimatePWin (Phase 3b shadow)', () => {
  it('reconstruit les poids plats et prédit p_win ∈ (0,1) + version', async () => {
    const svc = new OversoldProbabilityService(
      config,
      makeSupabase({
        version: 'oversold_a0000001_1750000000',
        // drop1d très négatif avec coef positif → p_win poussé au-dessus de l'intercept
        weights: { intercept: -0.5, drop1d: -0.2, vix: 0.01 },
      }),
    );
    // NB : pas de onModuleInit() ici — il armerait le setTimeout(45s) du boot-train
    // (handle ouvert → jest ne sort pas). `enabled` est true par défaut.
    const est = await svc.estimatePWin('a0000001-0000-0000-0000-000000000001', { drop1d: -8, vix: 20 });
    expect(est).not.toBeNull();
    expect(est!.version).toBe('oversold_a0000001_1750000000');
    expect(est!.pWin).toBeGreaterThan(0);
    expect(est!.pWin).toBeLessThan(1);
    // sigmoid(-0.5 + (-0.2×-8) + (0.01×20)) = sigmoid(1.3) ≈ 0.786
    expect(est!.pWin).toBeCloseTo(0.786, 2);
  });

  it('retourne null si aucun modèle persisté (jamais bloquant)', async () => {
    const svc = new OversoldProbabilityService(config, makeSupabase(null));
    const est = await svc.estimatePWin('c0000001-0000-0000-0000-000000000001', { drop1d: -6 });
    expect(est).toBeNull();
  });
});
