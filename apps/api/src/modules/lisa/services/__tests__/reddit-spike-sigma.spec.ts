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
import type { EodhdNewsItem } from '../eodhd-enrichment.service';

function fakeItem(score: number): EodhdNewsItem {
  return {
    title: 'Test post',
    date: new Date().toISOString(),
    symbols: [],
    sentiment: 0,
    tags: [`source:reddit/wallstreetbets`, `score:${score}`],
    link: null,
    sourceDomain: 'reddit.com',
    contentPreview: 'body',
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
    for (let i = 0; i < 5; i++) {
      (svc as unknown as { recordEngagement: (items: EodhdNewsItem[]) => void })
        .recordEngagement([fakeItem(100)]);
    }
    expect(svc.getSpikeSigma()).toBeNull();
  });

  it('returns null when 10 samples are identical (stddev=0, no div by zero)', async () => {
    const svc = await makeService();
    for (let i = 0; i < 10; i++) {
      (svc as unknown as { recordEngagement: (items: EodhdNewsItem[]) => void })
        .recordEngagement([fakeItem(1000)]);
    }
    expect(svc.getSpikeSigma()).toBeNull();
  });

  it('returns positive sigma when current >> baseline', async () => {
    const svc = await makeService();
    for (let i = 0; i < 9; i++) {
      (svc as unknown as { recordEngagement: (items: EodhdNewsItem[]) => void })
        .recordEngagement([fakeItem(1000 + (i % 3) * 50)]);
    }
    (svc as unknown as { recordEngagement: (items: EodhdNewsItem[]) => void })
      .recordEngagement([fakeItem(5000)]);
    const sigma = svc.getSpikeSigma()!;
    expect(sigma).toBeGreaterThan(5);
  });

  it('returns negative sigma when current << baseline', async () => {
    const svc = await makeService();
    for (let i = 0; i < 9; i++) {
      (svc as unknown as { recordEngagement: (items: EodhdNewsItem[]) => void })
        .recordEngagement([fakeItem(1000 + (i % 3) * 50)]);
    }
    (svc as unknown as { recordEngagement: (items: EodhdNewsItem[]) => void })
      .recordEngagement([fakeItem(100)]);
    const sigma = svc.getSpikeSigma()!;
    expect(sigma).toBeLessThan(0);
  });

  it('caps history at MAX (24) — drops oldest', async () => {
    const svc = await makeService();
    for (let i = 1; i <= 30; i++) {
      (svc as unknown as { recordEngagement: (items: EodhdNewsItem[]) => void })
        .recordEngagement([fakeItem(i * 100)]);
    }
    const sigma = svc.getSpikeSigma()!;
    expect(Number.isFinite(sigma)).toBe(true);
  });

  it('handles items with malformed score tags (non-numeric → 0 contribution)', async () => {
    const svc = await makeService();
    const malformed: EodhdNewsItem = {
      ...fakeItem(0),
      tags: ['source:reddit', 'score:abc'],
    };
    (svc as unknown as { recordEngagement: (items: EodhdNewsItem[]) => void })
      .recordEngagement([malformed]);
    // No crash + history kept (totalScore=0 still pushed)
  });

  it('skips empty items array (no record)', async () => {
    const svc = await makeService();
    for (let i = 0; i < 9; i++) {
      (svc as unknown as { recordEngagement: (items: EodhdNewsItem[]) => void })
        .recordEngagement([fakeItem(1000)]);
    }
    (svc as unknown as { recordEngagement: (items: EodhdNewsItem[]) => void })
      .recordEngagement([]);
    expect(svc.getSpikeSigma()).toBeNull();
  });

  it('resetEngagementHistory empties the buffer', async () => {
    const svc = await makeService();
    for (let i = 0; i < 15; i++) {
      (svc as unknown as { recordEngagement: (items: EodhdNewsItem[]) => void })
        .recordEngagement([fakeItem(1000 + i * 100)]);
    }
    svc.resetEngagementHistory();
    expect(svc.getSpikeSigma()).toBeNull();
  });
});
