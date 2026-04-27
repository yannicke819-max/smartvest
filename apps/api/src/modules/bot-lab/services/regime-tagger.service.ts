import { Injectable, Logger } from '@nestjs/common';
import { SupabaseService } from '../../supabase/supabase.service';
import { BOT_LAB_CONSTANTS } from '../types/bot-lab.types';

/**
 * RegimeTaggerService — tag chaque trade avec le contexte de marché à l'entry.
 *
 * Phase 2 simple :
 *  - VIX bucket : si VIX disponible (depuis le CSV ou l'historique market data)
 *  - Asset class (déjà dans bot_paper_trades.asset_class)
 *  - Time of day : YYYY-MM-DD HH bucket par heure
 *  - Day of week : MON/TUE/.../SUN
 *
 * Le regime "macro" complet (risk_on, geopolitical_stress, etc.) requiert
 * un dataset historique daily de VIX/SP500/DXY. Phase 2 utilise une
 * heuristique simple basée uniquement sur VIX bucket (si présent).
 *
 * Phase 3 ajoutera un cross-référencement avec lisa_proposals.detected_regime
 * pour les périodes où Lisa a tourné en parallèle.
 */
@Injectable()
export class RegimeTaggerService {
  private readonly logger = new Logger(RegimeTaggerService.name);

  constructor(private readonly supabase: SupabaseService) {}

  /**
   * Tag tous les trades d'un bot avec leur VIX bucket si disponible.
   * Utile après import CSV qui contient une colonne 'vix_at_entry'.
   *
   * Phase 2 : pas de fetch externe — utilise les valeurs si présentes
   * dans raw_payload du trade (fournies par CSV) ou dans market_regime.
   */
  async tagBotTrades(botId: string): Promise<{ tagged: number; total: number }> {
    const { data: trades } = await this.supabase.getClient()
      .from('bot_paper_trades')
      .select('id, raw_payload, vix_at_entry, market_regime')
      .eq('bot_id', botId);

    if (!trades || trades.length === 0) return { tagged: 0, total: 0 };

    let tagged = 0;
    const updates: Array<{ id: string; vix_at_entry?: number; market_regime?: string }> = [];

    for (const trade of trades) {
      // Skip si déjà taggé
      if (trade.vix_at_entry != null && trade.market_regime != null) continue;

      const update: { id: string; vix_at_entry?: number; market_regime?: string } = {
        id: trade.id as string,
      };

      // 1. Tente de récupérer VIX depuis raw_payload (fourni par CSV)
      const raw = trade.raw_payload as Record<string, unknown> | null;
      if (raw && trade.vix_at_entry == null) {
        const vix = this.extractNumeric(raw, ['vix', 'vix_at_entry', 'vix_open']);
        if (vix != null && vix >= 5 && vix <= 100) {
          update.vix_at_entry = vix;
        }
      }

      // 2. Tente de récupérer regime depuis raw_payload
      if (raw && trade.market_regime == null) {
        const regime = this.extractString(raw, ['regime', 'market_regime', 'context']);
        if (regime) {
          update.market_regime = regime.slice(0, 50);
        } else if (update.vix_at_entry != null || trade.vix_at_entry != null) {
          // Heuristique de fallback : regime inferré depuis VIX bucket
          const vix = update.vix_at_entry ?? Number(trade.vix_at_entry);
          update.market_regime = this.vixBucketLabel(vix);
        }
      }

      // Skip si rien à tagguer
      if (update.vix_at_entry == null && update.market_regime == null) continue;

      updates.push(update);
      tagged++;
    }

    // Batch update
    if (updates.length > 0) {
      // Supabase ne supporte pas update bulk — on fait par lots de 50
      const batchSize = 50;
      for (let i = 0; i < updates.length; i += batchSize) {
        const batch = updates.slice(i, i + batchSize);
        await Promise.all(batch.map((u) => {
          const { id, ...rest } = u;
          return this.supabase.getClient()
            .from('bot_paper_trades')
            .update(rest)
            .eq('id', id);
        }));
      }
    }

    this.logger.log(`[REGIME_TAG] bot=${botId.slice(0, 8)} tagged=${tagged}/${trades.length}`);
    return { tagged, total: trades.length };
  }

  /**
   * Helper : retourne le label du VIX bucket pour une valeur donnée.
   */
  private vixBucketLabel(vix: number): string {
    for (const bucket of BOT_LAB_CONSTANTS.VIX_BUCKETS) {
      if (vix < bucket.max) return bucket.label;
    }
    return 'vix_extreme';
  }

  private extractNumeric(obj: Record<string, unknown>, keys: string[]): number | null {
    for (const key of keys) {
      const val = obj[key];
      if (val != null) {
        const n = typeof val === 'number' ? val : parseFloat(String(val).replace(',', '.'));
        if (Number.isFinite(n)) return n;
      }
    }
    return null;
  }

  private extractString(obj: Record<string, unknown>, keys: string[]): string | null {
    for (const key of keys) {
      const val = obj[key];
      if (typeof val === 'string' && val.trim().length > 0) return val.trim();
    }
    return null;
  }
}
