import { Injectable } from '@nestjs/common';
import { SupabaseService } from '../../supabase/supabase.service';
import { NormalizedImportRow } from '../dto/import-row.dto';

@Injectable()
export class AssetMatcherService {
  constructor(private readonly supabase: SupabaseService) {}

  /**
   * Enriches rows with assetId and matchedAssetConfidence.
   * Matching strategy, in decreasing priority:
   *   1. ISIN exact match
   *   2. Ticker exact match (uppercase)
   *   3. Ticker prefix match (> 3 chars)
   * Confidence: 1.0 for ISIN, 0.9 for exact ticker, 0.6 for prefix.
   */
  async enrich(rows: NormalizedImportRow[]): Promise<NormalizedImportRow[]> {
    if (!this.supabase.isReady() || rows.length === 0) return rows;

    const client = this.supabase.getClient();
    const { data: assets, error } = await client
      .from('assets')
      .select('id, ticker, isin');

    if (error || !assets) return rows;

    const byIsin = new Map<string, string>();
    const byTicker = new Map<string, string>();
    for (const a of assets) {
      const ticker = a.ticker as string | null;
      const isin = a.isin as string | null;
      const id = a.id as string;
      if (isin) byIsin.set(isin.toUpperCase(), id);
      if (ticker) byTicker.set(ticker.toUpperCase(), id);
    }

    return rows.map((r) => {
      if (r.isin && byIsin.has(r.isin.toUpperCase())) {
        return { ...r, assetId: byIsin.get(r.isin.toUpperCase())!, matchedAssetConfidence: 1.0 };
      }
      if (r.ticker && byTicker.has(r.ticker.toUpperCase())) {
        return { ...r, assetId: byTicker.get(r.ticker.toUpperCase())!, matchedAssetConfidence: 0.9 };
      }
      if (r.ticker && r.ticker.length > 3) {
        for (const [ticker, id] of byTicker.entries()) {
          if (ticker.startsWith(r.ticker.toUpperCase())) {
            return { ...r, assetId: id, matchedAssetConfidence: 0.6 };
          }
        }
      }
      return r;
    });
  }
}
