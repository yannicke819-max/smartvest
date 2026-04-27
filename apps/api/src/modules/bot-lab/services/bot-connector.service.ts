import { Injectable, Logger } from '@nestjs/common';
import { SupabaseService } from '../../supabase/supabase.service';
import { JournalNormalizerService } from './journal-normalizer.service';
import type {
  BotDefinition,
  BotDefinitionDraft,
  RawTradeImport,
  BotSourceType,
} from '../types/bot-lab.types';

/**
 * BotConnectorService — point d'entrée des imports de bots externes.
 *
 * Phase 1 supporte :
 *  - CSV import (parser inline, format simple : symbol, direction, entry_*, exit_*)
 *  - Manual definition (création vide pour saisie progressive)
 *
 * Phase 2 ajoutera :
 *  - API external (REST/WebSocket vers TradingView, MetaTrader, ccxt etc.)
 *  - Lisa replay (rejouer ses propres trades fermés comme un bot externe)
 *
 * Toujours via JournalNormalizer pour garantir cohérence des coûts.
 */
@Injectable()
export class BotConnectorService {
  private readonly logger = new Logger(BotConnectorService.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly normalizer: JournalNormalizerService,
  ) {}

  // ───────────────────────────────────────────────────────────────────
  // BOT CRUD
  // ───────────────────────────────────────────────────────────────────

  async createBot(userId: string, draft: BotDefinitionDraft): Promise<BotDefinition> {
    const { data, error } = await this.supabase.getClient()
      .from('bot_definitions')
      .insert({
        user_id: userId,
        name: draft.name,
        description: draft.description ?? null,
        source_type: draft.sourceType,
        source_metadata: draft.sourceMetadata ?? null,
        capital_base_usd: draft.capitalBaseUsd.toFixed(2),
        start_date: draft.startDate ?? null,
        end_date: draft.endDate ?? null,
        tags: draft.tags ?? [],
      })
      .select('*')
      .single();

    if (error || !data) {
      throw new Error(`Bot creation failed: ${error?.message ?? 'unknown'}`);
    }

    this.logger.log(`[BOT_LAB] Created bot ${draft.name} (${draft.sourceType}) for user ${userId.slice(0, 8)}`);
    return this.mapRowToBot(data);
  }

  async listBots(userId: string, activeOnly = false): Promise<BotDefinition[]> {
    let query = this.supabase.getClient()
      .from('bot_definitions')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });
    if (activeOnly) query = query.eq('is_active', true);
    const { data } = await query;
    return (data ?? []).map((r) => this.mapRowToBot(r));
  }

  async getBot(userId: string, botId: string): Promise<BotDefinition | null> {
    const { data } = await this.supabase.getClient()
      .from('bot_definitions')
      .select('*')
      .eq('id', botId)
      .eq('user_id', userId)
      .maybeSingle();
    return data ? this.mapRowToBot(data) : null;
  }

  async updateBot(userId: string, botId: string, updates: Partial<BotDefinitionDraft>): Promise<void> {
    const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (updates.name !== undefined) update.name = updates.name;
    if (updates.description !== undefined) update.description = updates.description;
    if (updates.tags !== undefined) update.tags = updates.tags;
    if (updates.endDate !== undefined) update.end_date = updates.endDate;

    const { error } = await this.supabase.getClient()
      .from('bot_definitions')
      .update(update)
      .eq('id', botId)
      .eq('user_id', userId);

    if (error) throw new Error(`Bot update failed: ${error.message}`);
  }

  async deleteBot(userId: string, botId: string): Promise<void> {
    // CASCADE supprime aussi les trades / metrics / observations
    const { error } = await this.supabase.getClient()
      .from('bot_definitions')
      .delete()
      .eq('id', botId)
      .eq('user_id', userId);
    if (error) throw new Error(`Bot delete failed: ${error.message}`);
  }

  // ───────────────────────────────────────────────────────────────────
  // CSV IMPORT
  // ───────────────────────────────────────────────────────────────────

  /**
   * Parse un CSV (texte brut) et importe les trades.
   *
   * Format attendu (header obligatoire, séparateur virgule ou point-virgule) :
   *   symbol,direction,entry_timestamp,entry_price,quantity,exit_timestamp,exit_price[,asset_class][,exit_reason]
   *
   * Exemples acceptés :
   *   - direction : long, short, buy, sell, long_call, long_put
   *   - entry_timestamp : ISO (2025-01-15T14:30:00Z) ou date YYYY-MM-DD
   *   - entry_price/exit_price : nombre décimal (point ou virgule)
   *
   * Lignes invalides skip + warning log. Idempotent via external_id.
   */
  async importCsv(
    userId: string,
    botId: string,
    csvText: string,
  ): Promise<{ inserted: number; skipped: number; errors: number; totalParsed: number }> {
    // Vérifier que le bot appartient à l'utilisateur
    const bot = await this.getBot(userId, botId);
    if (!bot) throw new Error(`Bot ${botId} non trouvé ou non autorisé`);

    const trades = this.parseCsv(csvText);
    if (trades.length === 0) {
      return { inserted: 0, skipped: 0, errors: 0, totalParsed: 0 };
    }

    const result = await this.normalizer.normalizeAndInsert(botId, trades);
    this.logger.log(
      `[BOT_LAB] CSV import bot=${botId.slice(0, 8)} parsed=${trades.length} inserted=${result.inserted} skipped=${result.skipped} errors=${result.errors}`,
    );

    // Update bot stats
    await this.updateBotStats(botId);

    return { ...result, totalParsed: trades.length };
  }

  /**
   * Parser CSV minimaliste — pas de dépendance externe (papaparse, csv-parse).
   * Gère :
   *  - Header sur la 1re ligne (case-insensitive)
   *  - Séparateur , ou ;
   *  - Champs optionnels avec quotes "..."
   *  - Lignes vides skip
   */
  private parseCsv(csvText: string): RawTradeImport[] {
    const lines = csvText.split(/\r?\n/).filter((l) => l.trim().length > 0);
    if (lines.length < 2) return [];

    // Detecte séparateur (compte virgules vs point-virgules dans header)
    const headerRaw = lines[0];
    const sep = headerRaw.split(';').length > headerRaw.split(',').length ? ';' : ',';
    const header = this.splitCsvLine(headerRaw, sep).map((h) => h.toLowerCase().trim());

    const trades: RawTradeImport[] = [];
    for (let i = 1; i < lines.length; i++) {
      try {
        const cells = this.splitCsvLine(lines[i], sep);
        const obj: Record<string, unknown> = {};
        header.forEach((key, idx) => {
          const val = cells[idx]?.trim();
          if (val !== undefined && val !== '') obj[key] = val;
        });
        // Validation minimale : symbol + direction + entry_*
        if (!obj.symbol || !obj.direction || !obj.entry_timestamp || !obj.entry_price) {
          this.logger.debug(`Skip CSV line ${i + 1}: missing required fields`);
          continue;
        }
        // Convert numeric fields (accept comma decimal)
        for (const k of ['entry_price', 'exit_price', 'quantity', 'entry_notional_usd', 'entry_cost_usd', 'exit_cost_usd', 'net_pnl_usd']) {
          if (obj[k] != null) {
            const s = String(obj[k]).replace(',', '.');
            const n = parseFloat(s);
            if (Number.isFinite(n)) obj[k] = n;
          }
        }
        trades.push(obj as RawTradeImport);
      } catch (e) {
        this.logger.debug(`CSV line ${i + 1} parse error: ${String(e).slice(0, 80)}`);
      }
    }
    return trades;
  }

  /**
   * Split une ligne CSV en respectant les quotes "..." pour les champs
   * contenant le séparateur.
   */
  private splitCsvLine(line: string, sep: string): string[] {
    const cells: string[] = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') {
        // "" inside quoted field = literal quote
        if (inQuotes && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (c === sep && !inQuotes) {
        cells.push(current);
        current = '';
      } else {
        current += c;
      }
    }
    cells.push(current);
    return cells;
  }

  // ───────────────────────────────────────────────────────────────────
  // STATS
  // ───────────────────────────────────────────────────────────────────

  /**
   * Recalcule les stats agrégées d'un bot (total_trades + total_realized_pnl).
   * Appelé après import ou recalcul manuel.
   */
  async updateBotStats(botId: string): Promise<void> {
    const { data: stats } = await this.supabase.getClient()
      .from('bot_paper_trades')
      .select('net_pnl_usd, exit_timestamp')
      .eq('bot_id', botId);

    if (!stats) return;

    const totalTrades = stats.length;
    const totalPnl = stats.reduce((sum, t) => {
      const pnl = t.net_pnl_usd != null ? parseFloat(String(t.net_pnl_usd)) : 0;
      return sum + (Number.isFinite(pnl) ? pnl : 0);
    }, 0);

    await this.supabase.getClient()
      .from('bot_definitions')
      .update({
        total_trades: totalTrades,
        total_realized_pnl_usd: totalPnl.toFixed(2),
        updated_at: new Date().toISOString(),
      })
      .eq('id', botId);
  }

  // ───────────────────────────────────────────────────────────────────
  // HELPERS
  // ───────────────────────────────────────────────────────────────────

  private mapRowToBot(row: Record<string, unknown>): BotDefinition {
    return {
      id: row.id as string,
      userId: row.user_id as string,
      portfolioId: (row.portfolio_id as string | null) ?? null,
      name: row.name as string,
      description: (row.description as string | null) ?? null,
      sourceType: row.source_type as BotSourceType,
      sourceMetadata: (row.source_metadata as Record<string, unknown> | null) ?? null,
      capitalBaseUsd: String(row.capital_base_usd),
      startDate: (row.start_date as string | null) ?? null,
      endDate: (row.end_date as string | null) ?? null,
      isActive: (row.is_active as boolean) ?? true,
      tags: (row.tags as string[]) ?? [],
      totalTrades: Number(row.total_trades ?? 0),
      totalRealizedPnlUsd: String(row.total_realized_pnl_usd ?? '0'),
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    };
  }
}
