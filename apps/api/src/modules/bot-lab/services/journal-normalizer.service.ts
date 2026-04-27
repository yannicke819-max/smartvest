import { Injectable, Logger } from '@nestjs/common';
import Decimal from 'decimal.js';
import { SupabaseService } from '../../supabase/supabase.service';
import type {
  RawTradeImport,
  TradeDirection,
  BotPaperTrade,
} from '../types/bot-lab.types';
import { BOT_LAB_CONSTANTS } from '../types/bot-lab.types';

/**
 * JournalNormalizerService — transforme les trades raw (CSV, API, replay)
 * en format unifié `bot_paper_trades`.
 *
 * Calcule les coûts manquants avec les MÊMES hypothèses que paper-broker
 * (10 bps entry + 10 bps exit) pour que les comparaisons cross-bot soient
 * cohérentes avec Lisa.
 *
 * Idempotent : un trade avec le même `external_id` n'est inséré qu'une
 * seule fois (UNIQUE constraint en DB + ON CONFLICT skip).
 */
@Injectable()
export class JournalNormalizerService {
  private readonly logger = new Logger(JournalNormalizerService.name);

  constructor(private readonly supabase: SupabaseService) {}

  /**
   * Normalise + insère un batch de trades pour un bot.
   * Retourne le nombre de trades effectivement insérés (peut être < input
   * si certains avaient déjà été importés).
   */
  async normalizeAndInsert(botId: string, rawTrades: RawTradeImport[]): Promise<{
    inserted: number;
    skipped: number;
    errors: number;
  }> {
    let inserted = 0;
    let skipped = 0;
    let errors = 0;

    const batchSize = 500;
    for (let i = 0; i < rawTrades.length; i += batchSize) {
      const batch = rawTrades.slice(i, i + batchSize);
      const normalized = batch
        .map((raw) => {
          try {
            return this.normalizeTrade(botId, raw);
          } catch (e) {
            this.logger.warn(`Skip invalid trade ${raw.external_id ?? raw.symbol}: ${String(e).slice(0, 100)}`);
            errors++;
            return null;
          }
        })
        .filter((t): t is Record<string, unknown> => t !== null);

      if (normalized.length === 0) continue;

      const { data, error } = await this.supabase.getClient()
        .from('bot_paper_trades')
        .upsert(normalized, { onConflict: 'bot_id,external_id', ignoreDuplicates: true })
        .select('id');

      if (error) {
        this.logger.warn(`Batch insert failed: ${error.message}`);
        errors += normalized.length;
      } else {
        inserted += data?.length ?? 0;
        skipped += normalized.length - (data?.length ?? 0);
      }
    }

    return { inserted, skipped, errors };
  }

  /**
   * Normalise un trade brut en row prête à insérer.
   * Calcule les costs et P&L si non fournis.
   */
  private normalizeTrade(botId: string, raw: RawTradeImport): Record<string, unknown> {
    // Validation minimale
    if (!raw.symbol) throw new Error('symbol manquant');
    if (!raw.entry_timestamp) throw new Error('entry_timestamp manquant');
    if (raw.entry_price == null) throw new Error('entry_price manquant');
    if (!raw.direction) throw new Error('direction manquante');

    const direction = this.normalizeDirection(raw.direction);
    const entryPrice = new Decimal(raw.entry_price);
    if (entryPrice.lte(0)) throw new Error(`entry_price invalide: ${entryPrice.toString()}`);

    // Quantity OU notional doit être fourni
    let quantity: Decimal;
    let entryNotional: Decimal;
    if (raw.quantity != null) {
      quantity = new Decimal(raw.quantity);
      entryNotional = raw.entry_notional_usd != null
        ? new Decimal(raw.entry_notional_usd)
        : entryPrice.mul(quantity);
    } else if (raw.entry_notional_usd != null) {
      entryNotional = new Decimal(raw.entry_notional_usd);
      quantity = entryNotional.div(entryPrice);
    } else {
      throw new Error('quantity ou entry_notional_usd requis');
    }

    if (quantity.lte(0)) throw new Error(`quantity invalide: ${quantity.toString()}`);

    // Costs : si fourni, utilise; sinon calcule avec hypothèses paper-broker
    const entryCost = raw.entry_cost_usd != null
      ? new Decimal(raw.entry_cost_usd)
      : entryNotional.mul(BOT_LAB_CONSTANTS.DEFAULT_ENTRY_COST_BPS).div(10000);

    // Exit (optionnel — trade peut être encore ouvert)
    let exitPrice: Decimal | null = null;
    let exitCost: Decimal | null = null;
    let grossPnl: Decimal | null = null;
    let netPnl: Decimal | null = null;
    let netPnlPct: number | null = null;

    if (raw.exit_price != null && raw.exit_timestamp) {
      exitPrice = new Decimal(raw.exit_price);
      const exitNotional = exitPrice.mul(quantity);
      exitCost = raw.exit_cost_usd != null
        ? new Decimal(raw.exit_cost_usd)
        : exitNotional.mul(BOT_LAB_CONSTANTS.DEFAULT_EXIT_COST_BPS).div(10000);

      // P&L (long/short asymétrique)
      const isLong = direction === 'long' || direction === 'long_call' || direction === 'long_put';
      const priceDelta = isLong ? exitPrice.minus(entryPrice) : entryPrice.minus(exitPrice);
      grossPnl = priceDelta.mul(quantity);

      // Net = gross - costs (sauf si fourni explicitement)
      netPnl = raw.net_pnl_usd != null
        ? new Decimal(raw.net_pnl_usd)
        : grossPnl.minus(entryCost).minus(exitCost);

      netPnlPct = entryNotional.isZero()
        ? 0
        : netPnl.div(entryNotional).mul(100).toNumber();
    }

    // Asset class : si non fourni, infère depuis symbol
    const assetClass = raw.asset_class ?? this.inferAssetClass(raw.symbol);

    // External ID : génère un fallback déterministe si absent (idempotence)
    const externalId = raw.external_id
      ?? `${raw.symbol}_${raw.entry_timestamp}_${entryPrice.toFixed(4)}`;

    return {
      bot_id: botId,
      external_id: externalId,
      symbol: raw.symbol.toUpperCase(),
      asset_class: assetClass,
      direction,
      entry_timestamp: new Date(raw.entry_timestamp).toISOString(),
      entry_price: entryPrice.toFixed(10),
      quantity: quantity.toFixed(10),
      entry_notional_usd: entryNotional.toFixed(2),
      exit_timestamp: raw.exit_timestamp ? new Date(raw.exit_timestamp).toISOString() : null,
      exit_price: exitPrice ? exitPrice.toFixed(10) : null,
      exit_reason: raw.exit_reason ?? null,
      entry_cost_usd: entryCost.toFixed(2),
      exit_cost_usd: exitCost ? exitCost.toFixed(2) : null,
      gross_pnl_usd: grossPnl ? grossPnl.toFixed(2) : null,
      net_pnl_usd: netPnl ? netPnl.toFixed(2) : null,
      net_pnl_pct: netPnlPct,
      raw_payload: raw,
    };
  }

  /**
   * Normalise les variantes de direction acceptées (long, LONG, buy, BUY,
   * sell, short, etc.) vers le set canonique.
   */
  private normalizeDirection(input: string): TradeDirection {
    const v = input.toLowerCase().trim();
    if (v === 'long' || v === 'buy' || v === 'b') return 'long';
    if (v === 'short' || v === 'sell' || v === 's') return 'short';
    if (v === 'long_call' || v === 'call') return 'long_call';
    if (v === 'long_put' || v === 'put') return 'long_put';
    throw new Error(`direction invalide: ${input}`);
  }

  /**
   * Infère asset_class depuis le symbol (heuristique simple).
   */
  private inferAssetClass(symbol: string): string {
    const s = symbol.toUpperCase();
    const cryptoNative = ['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'ADA', 'DOGE', 'AVAX', 'DOT', 'MATIC'];
    if (cryptoNative.includes(s) || s.endsWith('USDT') || s.endsWith('USD')) return 'crypto';

    const preciousMetals = ['GLD', 'SLV', 'GDX', 'GDXJ', 'IAU', 'PSLV', 'NEM'];
    if (preciousMetals.includes(s)) return 'commodities_metals_precious';

    const energyEtfs = ['USO', 'XLE', 'XOM', 'CVX'];
    if (energyEtfs.includes(s)) return 'commodities_energy';

    const broadEtfs = ['SPY', 'QQQ', 'IWM', 'DIA', 'VTI', 'VOO'];
    if (broadEtfs.includes(s)) return 'equity_us_broad';

    return 'equity_us_large'; // fallback
  }

  /**
   * Récupère les trades normalisés d'un bot (CRUD lecture).
   */
  async listTrades(botId: string, limit = 100): Promise<BotPaperTrade[]> {
    const { data } = await this.supabase.getClient()
      .from('bot_paper_trades')
      .select('*')
      .eq('bot_id', botId)
      .order('entry_timestamp', { ascending: false })
      .limit(limit);

    return (data ?? []).map((row) => this.mapRowToTrade(row));
  }

  private mapRowToTrade(row: Record<string, unknown>): BotPaperTrade {
    return {
      id: row.id as string,
      botId: row.bot_id as string,
      externalId: (row.external_id as string | null) ?? null,
      symbol: row.symbol as string,
      assetClass: row.asset_class as string,
      direction: row.direction as TradeDirection,
      entryTimestamp: row.entry_timestamp as string,
      entryPrice: String(row.entry_price),
      quantity: String(row.quantity),
      entryNotionalUsd: String(row.entry_notional_usd),
      exitTimestamp: (row.exit_timestamp as string | null) ?? null,
      exitPrice: row.exit_price != null ? String(row.exit_price) : null,
      exitReason: (row.exit_reason as string | null) ?? null,
      entryCostUsd: String(row.entry_cost_usd ?? 0),
      exitCostUsd: row.exit_cost_usd != null ? String(row.exit_cost_usd) : '0',
      grossPnlUsd: row.gross_pnl_usd != null ? String(row.gross_pnl_usd) : null,
      netPnlUsd: row.net_pnl_usd != null ? String(row.net_pnl_usd) : null,
      netPnlPct: (row.net_pnl_pct as number | null) ?? null,
      marketRegime: (row.market_regime as string | null) ?? null,
      vixAtEntry: row.vix_at_entry != null ? String(row.vix_at_entry) : null,
      dxyAtEntry: row.dxy_at_entry != null ? String(row.dxy_at_entry) : null,
      rawPayload: (row.raw_payload as Record<string, unknown> | null) ?? null,
      importedAt: row.imported_at as string,
    };
  }
}
