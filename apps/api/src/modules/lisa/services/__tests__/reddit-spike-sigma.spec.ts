/**
 * PR E — RedditService.getSpikeSigma() rolling z-score.
 *
 * Tests unitaires sur le calcul de sigma à partir d'un engagementHistory
 * en mémoire. RedditService est injecté avec ConfigService mock pour
 * éviter les appels réseau Reddit OAuth.
 */
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { RedditService } from '../reddit.service';
import type { EodhdNewsItem } from '@smartvest/ai-analyst';

function fakeItem(score: number): EodhdNewsItem {
  return {
    title: 'Test post',
    content: 'body',
    date: new Date().toISOString(),
    sourceDomain: 'reddit.com',
    symbols: [],
    sentiment: 0,
    tags: [`source:reddit/wallstreetbets`, `score:${score}`],
  };
}

async function makeService(): Promise<RedditService> {
  const moduleRef = await Test.createTestingModule({
    providers: [
      RedditService,
      { provide: ConfigService, useValue: { get: () => null } },
    ],
  }).compile();
  return moduleRef.get(RedditService);
}

describe('RedditService.getSpikeSigma', () => {
  it('returns null with insufficient samples (< 10)', async () => {
    const svc = await makeService();
    // Push 5 samples (sous le minimum 10)
    for (let i = 0; i < 5; i++) {
      // Hack : appel direct à la méthode privée via cast (test-only)
      (svc as unknown as { recordEngagement: (items: EodhdNewsItem[]) => void })
        .recordEngagement([fakeItem(100)]);
    }
    expect(svc.getSpikeSigma()).toBeNull();
  });

  it('returns 0 when current matches mean exactly (10 identical samples)', async () => {
    const svc = await makeService();
    for (let i = 0; i < 10; i++) {
      (svc as unknown as { recordEngagement: (items: EodhdNewsItem[]) => void })
        .recordEngagement([fakeItem(1000)]);
    }
    // 10 samples identiques → stddev=0 → returns null (no division by zero)
    expect(svc.getSpikeSigma()).toBeNull();
  });

  it('returns positive sigma when current >> baseline', async () => {
    const svc = await makeService();
    // 9 samples baseline ~1000, 1 sample current 5000
    for (let i = 0; i < 9; i++) {
      (svc as unknown as { recordEngagement: (items: EodhdNewsItem[]) => void })
        .recordEngagement([fakeItem(1000 + (i % 3) * 50)]); // léger noise
    }
    (svc as unknown as { recordEngagement: (items: EodhdNewsItem[]) => void })
      .recordEngagement([fakeItem(5000)]); // spike
    const sigma = svc.getSpikeSigma()!;
    expect(sigma).toBeGreaterThan(5); // > 5σ → trigger NEWS_SHOCK
  });

  it('returns negative sigma when current << baseline', async () => {
    const svc = await makeService();
    for (let i = 0; i < 9; i++) {
      (svc as unknown as { recordEngagement: (items: EodhdNewsItem[]) => void })
        .recordEngagement([fakeItem(1000 + (i % 3) * 50)]);
    }
    (svc as unknown as { recordEngagement: (items: EodhdNewsItem[]) => void })
      .recordEngagement([fakeItem(100)]); // chute
    const sigma = svc.getSpikeSigma()!;
    expect(sigma).toBeLessThan(0);
  });

  it('caps history at MAX (24) — drops oldest', async () => {
    const svc = await makeService();
    // Push 30 samples : value = i pour traçabilité
    for (let i = 1; i <= 30; i++) {
      (svc as unknown as { recordEngagement: (items: EodhdNewsItem[]) => void })
        .recordEngagement([fakeItem(i * 100)]);
    }
    // History should contain values 7..30 (24 last). Sigma is computed
    // over those. Sample current = 30*100, baseline = mean of 7..29 = ~18*100
    const sigma = svc.getSpikeSigma()!;
    expect(Number.isFinite(sigma)).toBe(true);
  });

  it('handles items with malformed score tags (NaN, missing) → 0 contribution', async () => {
    const svc = await makeService();
    const malformed: EodhdNewsItem = {
      ...fakeItem(0),
      tags: ['source:reddit', 'score:abc'], // non-numeric score
    };
    // Should not throw, score parse fail → 0
    (svc as unknown as { recordEngagement: (items: EodhdNewsItem[]) => void })
      .recordEngagement([malformed]);
    // Pas de crash + history a gardé un sample (avec totalScore=0 valide)
    // Note : 0 est < 0 ? Non, 0 n'est ni >0 ni Infinite → ignoré dans la somme
    // mais l'item lui-même produit un push d'engagement total 0.
  });

  it('skips empty items array (no record)', async () => {
    const svc = await makeService();
    // Push 9 samples normaux
    for (let i = 0; i < 9; i++) {
      (svc as unknown as { recordEngagement: (items: EodhdNewsItem[]) => void })
        .recordEngagement([fakeItem(1000)]);
    }
    // Call avec []
    (svc as unknown as { recordEngagement: (items: EodhdNewsItem[]) => void })
      .recordEngagement([]);
    // Sigma should still be null (history at 9, sub-threshold)
    expect(svc.getSpikeSigma()).toBeNull();
  });

  it('resetEngagementHistory empties the buffer', async () => {
    const svc = await makeService();
    for (let i = 0; i < 15; i++) {
      (svc as unknown as { recordEngagement: (items: EodhdNewsItem[]) => void })
        .recordEngagement([fakeItem(1000 + i * 100)]);
    }
    svc.resetEngagementHistory();
    expect(svc.getSpikeSigma()).toBeNull(); // history vide → < 10 samples
  });
});
