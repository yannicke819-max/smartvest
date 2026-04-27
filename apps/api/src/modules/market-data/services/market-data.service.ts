import { Injectable, Logger } from '@nestjs/common';
import { SupabaseService } from '../../supabase/supabase.service';
import { ProviderRegistryService } from './provider-registry.service';
import { ProviderAsset } from '../providers/market-data-provider.interface';
import { InstrumentQuote } from '../dto/instrument-quote.dto';
import { PriceBar } from '../dto/price-bar.dto';
import { symbolToProviderAsset } from '../helpers/symbol-to-eodhd.helper';

@Injectable()
export class MarketDataService {
  private readonly logger = new Logger(MarketDataService.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly registry: ProviderRegistryService,
  ) {}

  async getProviderAssets(): Promise<ProviderAsset[]> {
    if (!this.supabase.isReady()) return [];
    const { data, error } = await this.supabase
      .getClient()
      .from('assets')
      .select('id, ticker, currency, provider_tickers')
      .not('provider_tickers', 'eq', '{}');

    if (error) {
      this.logger.error('getProviderAssets error', error.message);
      return [];
    }

    const assets: ProviderAsset[] = [];
    for (const row of data ?? []) {
      const pt = (row.provider_tickers as Record<string, string>) ?? {};
      const providerTicker = pt['eodhd'];
      if (providerTicker) {
        assets.push({
          assetId: row.id as string,
          ticker: row.ticker as string,
          providerTicker,
          currency: row.currency as string,
        });
      }
    }
    return assets;
  }

  /**
   * INCIDENT 27/04/2026 — Union avec les `lisa_positions` ouvertes pour
   * que le quote refresh ne soit pas stérile quand la table `assets` n'a
   * pas (ou plus) de mappings provider_tickers pour les tickers actifs.
   *
   * Avant le fix : `getProviderAssets()` filtrait `provider_tickers != '{}'`
   * sur la table `assets` qui retournait 0 row → bot aveugle aux prix
   * live → stops/TP jamais évalués sur les positions effectivement
   * tenues (BTC, RTX 27/04).
   *
   * Sémantique : on UNION (déduplication par providerTicker) :
   *   - mappings statiques de la table `assets` (préservé pour watchlist)
   *   - mappings dérivés des `lisa_positions WHERE status='open'` via
   *     symbolToProviderAsset (heuristique crypto_/.US/.FOREX)
   */
  async getActiveSymbolsForRefresh(): Promise<ProviderAsset[]> {
    const staticAssets = await this.getProviderAssets();
    const positionAssets = await this.getOpenPositionAssets();

    // Déduplication par providerTicker (le mapping statique prend le pas
    // sur l'heuristique car il porte un assetId DB stable et une devise
    // potentiellement non-USD précise).
    const byTicker = new Map<string, ProviderAsset>();
    for (const a of positionAssets) byTicker.set(a.providerTicker, a);
    for (const a of staticAssets) byTicker.set(a.providerTicker, a);
    return Array.from(byTicker.values());
  }

  /**
   * Charge les positions ouvertes de `lisa_positions` et construit un
   * ProviderAsset par ligne via `symbolToProviderAsset`. Filtre les rows
   * dont la combinaison symbol/asset_class n'est pas reconnue (helper
   * retourne null).
   */
  private async getOpenPositionAssets(): Promise<ProviderAsset[]> {
    if (!this.supabase.isReady()) return [];
    const { data, error } = await this.supabase
      .getClient()
      .from('lisa_positions')
      .select('id, symbol, asset_class')
      .eq('status', 'open');
    if (error) {
      this.logger.warn(`getOpenPositionAssets read failed: ${error.message}`);
      return [];
    }
    const out: ProviderAsset[] = [];
    for (const row of data ?? []) {
      const a = symbolToProviderAsset(
        String(row.id),
        String(row.symbol ?? ''),
        (row.asset_class as string | null | undefined) ?? null,
      );
      if (a) out.push(a);
    }
    return out;
  }

  async refreshQuotes(): Promise<{ succeeded: number; failed: number }> {
    // Union : assets statiques + positions ouvertes (fix incident 27/04).
    const assets = await this.getActiveSymbolsForRefresh();
    if (assets.length === 0) return { succeeded: 0, failed: 0 };

    const quotes = await this.registry.fetchQuotesWithFailover(assets);
    return this.saveQuotes(quotes, assets.length);
  }

  async refreshDailyBars(fromDate: string, toDate: string): Promise<{ succeeded: number; failed: number }> {
    const assets = await this.getActiveSymbolsForRefresh();
    if (assets.length === 0) return { succeeded: 0, failed: 0 };

    const bars = await this.registry.fetchDailyBarsWithFailover(assets, fromDate, toDate);
    return this.saveBars(bars, assets.length);
  }

  async getLatestQuotes(assetIds?: string[]): Promise<InstrumentQuote[]> {
    if (!this.supabase.isReady()) return [];
    let query = this.supabase.getClient().from('latest_quotes').select('*');
    if (assetIds && assetIds.length > 0) {
      query = query.in('asset_id', assetIds);
    }
    const { data, error } = await query;
    if (error) return [];
    return (data ?? []).map((row) => ({
      assetId: row.asset_id as string,
      ticker: '',
      price: String(row.price),
      currency: row.currency as string,
      asOf: row.as_of as string,
      provider: (row.provider as string) ?? 'manual',
      marketState: (row.market_state as InstrumentQuote['marketState']) ?? 'unknown',
      previousClose: row.previous_close ? String(row.previous_close) : undefined,
      changeAbsolute: row.change_absolute ? String(row.change_absolute) : undefined,
      rawPayload: undefined,
      changePercent: row.change_percent ? String(row.change_percent) : undefined,
    }));
  }

  private async saveQuotes(
    quotes: InstrumentQuote[],
    assetsRequested: number,
  ): Promise<{ succeeded: number; failed: number }> {
    if (!this.supabase.isReady() || quotes.length === 0) {
      return { succeeded: 0, failed: assetsRequested };
    }

    const rows = quotes.map((q) => ({
      asset_id: q.assetId,
      price: q.price,
      currency: q.currency,
      as_of: q.asOf,
      source: 'market_feed',
      provider: q.provider,
      market_state: q.marketState,
      previous_close: q.previousClose ?? null,
      change_absolute: q.changeAbsolute ?? null,
      change_percent: q.changePercent ?? null,
      fetched_at: new Date().toISOString(),
      raw_payload: q.rawPayload ?? null,
    }));

    const { error } = await this.supabase
      .getClient()
      .from('quotes')
      .upsert(rows, { onConflict: 'asset_id,as_of' });

    if (error) {
      this.logger.error('saveQuotes error', error.message);
      return { succeeded: 0, failed: assetsRequested };
    }
    return { succeeded: quotes.length, failed: assetsRequested - quotes.length };
  }

  private async saveBars(
    bars: PriceBar[],
    assetsRequested: number,
  ): Promise<{ succeeded: number; failed: number }> {
    if (!this.supabase.isReady() || bars.length === 0) {
      return { succeeded: 0, failed: assetsRequested };
    }

    const rows = bars.map((b) => ({
      asset_id: b.assetId,
      provider: b.provider,
      date: b.date,
      open: b.open ?? null,
      high: b.high ?? null,
      low: b.low ?? null,
      close: b.close,
      adjusted_close: b.adjustedClose ?? null,
      volume: b.volume ?? null,
      currency: b.currency,
      fetched_at: new Date().toISOString(),
    }));

    const { error } = await this.supabase
      .getClient()
      .from('bars_daily')
      .upsert(rows, { onConflict: 'asset_id,provider,date' });

    if (error) {
      this.logger.error('saveBars error', error.message);
      return { succeeded: 0, failed: assetsRequested };
    }

    const succeededAssets = new Set(bars.map((b) => b.assetId)).size;
    return { succeeded: succeededAssets, failed: assetsRequested - succeededAssets };
  }
}
