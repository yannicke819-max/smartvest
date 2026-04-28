/**
 * P3-D fix 5 — Tests pour `capRetailSocialItems` (cap StockTwits/Reddit/
 * Twitter à 30% du briefing news).
 */
import { capRetailSocialItems } from '../news-aggregator.service';
import type { EodhdNewsItem, NewsProvider } from '../eodhd-enrichment.service';

function n(provider: NewsProvider, idx: number, withSym = true): EodhdNewsItem {
  return {
    title: `${provider} ${idx}`,
    date: new Date().toISOString(),
    symbols: withSym ? ['AAPL'] : [],
    sentiment: 0,
    tags: [],
    link: null,
    sourceDomain: provider,
    contentPreview: `body ${idx}`,
    provider,
  } as EodhdNewsItem;
}

describe('capRetailSocialItems', () => {
  it('returns empty when input empty', () => {
    expect(capRetailSocialItems([], 0.30)).toEqual([]);
  });

  it('keeps all when retail ratio already < cap', () => {
    const items = [n('eodhd', 1), n('eodhd', 2), n('eodhd', 3), n('stocktwits', 4)];
    const out = capRetailSocialItems(items, 0.30);
    expect(out).toHaveLength(4);
  });

  it('caps retail to 30% when overflow', () => {
    // 7 EODHD + 13 StockTwits = 20 total, 65% retail
    const items = [
      ...Array.from({ length: 7 }, (_, i) => n('eodhd', i)),
      ...Array.from({ length: 13 }, (_, i) => n('stocktwits', i)),
    ];
    const out = capRetailSocialItems(items, 0.30);
    // total cible = 7 / (1 - 0.30) = 10, retail garde 3
    expect(out).toHaveLength(10);
    expect(out.filter((x) => x.provider === 'eodhd')).toHaveLength(7);
    expect(out.filter((x) => x.provider === 'stocktwits')).toHaveLength(3);
  });

  it('drops retail items WITHOUT symbol first (priorité aux signaux ciblés)', () => {
    const items = [
      ...Array.from({ length: 5 }, (_, i) => n('eodhd', i)),
      n('stocktwits', 100, true),  // with symbol
      n('stocktwits', 101, true),  // with symbol
      n('stocktwits', 200, false), // no symbol
      n('stocktwits', 201, false), // no symbol
      n('stocktwits', 202, false), // no symbol
      n('stocktwits', 203, false), // no symbol
      n('stocktwits', 204, false), // no symbol
    ];
    const out = capRetailSocialItems(items, 0.30);
    // total cible = 5 / 0.7 ≈ 7, retail keep = 2 → 2 with-symbol gardés
    const keptRetail = out.filter((x) => x.provider === 'stocktwits');
    expect(keptRetail).toHaveLength(2);
    expect(keptRetail.every((x) => x.symbols && x.symbols.length > 0)).toBe(true);
  });

  it('handles maxRatio=0 (drops all retail)', () => {
    const items = [n('eodhd', 1), n('stocktwits', 2), n('reddit', 3)];
    const out = capRetailSocialItems(items, 0);
    expect(out).toHaveLength(1);
    expect(out[0].provider).toBe('eodhd');
  });

  it('handles maxRatio=1 (keeps all)', () => {
    const items = [n('eodhd', 1), n('stocktwits', 2), n('reddit', 3)];
    const out = capRetailSocialItems(items, 1);
    expect(out).toHaveLength(3);
  });

  it('treats reddit and twitter as retail (cap applied jointly)', () => {
    const items = [
      n('eodhd', 1),
      n('stocktwits', 2),
      n('reddit', 3),
      n('twitter', 4),
    ];
    const out = capRetailSocialItems(items, 0.30);
    // total cible = 1 / 0.7 ≈ 1, retail keep = 0
    expect(out).toHaveLength(1);
    expect(out[0].provider).toBe('eodhd');
  });

  it('preserves order : eodhd first, then retail kept', () => {
    const items = [
      n('eodhd', 1),
      n('stocktwits', 2),
      n('eodhd', 3),
      n('reddit', 4),
    ];
    const out = capRetailSocialItems(items, 0.30);
    expect(out[0].provider).toBe('eodhd');
    expect(out[1].provider).toBe('eodhd');
  });
});
