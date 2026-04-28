/**
 * P5-PIVOT-TOP-GAINERS — Scanner momentum cross-asset 24/7.
 *
 * Bypass complet du pipeline Lisa LLM / news / regime. Stratégie déterministe :
 *   - 15 min cron (24/7)
 *   - Fetch top gainers EODHD (multi-exchange : US/LSE/XETRA/PA/TSE/HK/AU/etc.)
 *   - Fetch crypto top gainers via BinanceMarketService (24h ticker)
 *   - Filter via evaluateTopGainerCandidate (asset-class adaptive thresholds)
 *   - Top 3 cross-asset par score → INSERT pseudo-proposal + paperBroker.openPosition
 *   - Audit dans top_gainers_log + lisa_decision_log
 *
 * Activation : env `STRATEGY_MODE=top_gainers` (par portfolio ou global).
 *
 * Out of scope ce PR (deferred PR2/PR3) :
 *   - Yahoo fallback / Coinbase / Kraken / OANDA / IBKR multi-currency
 *   - Indicateurs techniques avancés (RSI/MACD/EMA/BB/ATR/VWAP/Stoch/OBV/ADX)
 *   - UI banner + endpoint /api/top-gainers
 *   - Backtest /backtest/top-gainers + CSV export
 *   - Trailing stop +3% custom + time-stop 4h auto-close
 *   - Multi-currency portfolio (paperBroker actuel = USD only)
 */

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { SupabaseService } from '../../supabase/supabase.service';
import { LisaService } from './lisa.service';
import { DecisionLogService } from './decision-log.service';
import { BinanceMarketService } from './binance-market.service';
import {
  selectTopGainers,
  type TopGainerCandidate,
  type TopGainerAssetClass,
} from '@smartvest/ai-analyst';

interface EodhdScreenerRow {
  code: string;
  name?: string;
  exchange_short_name?: string;
  exchange_short?: string;
  exchange?: string;
  last_price?: number | string;
  high_price?: number | string;
  high?: number | string;
  low_price?: number | string;
  open?: number | string;
  change_p?: number | string;
  volume?: number | string;
  avgvol_50d?: number | string;
  avgvol_200d?: number | string;
  market_capitalization?: number | string;
  market_cap?: number | string;
}

/**
 * P5-PIVOT-TOP-GAINERS v1 — 13+ exchanges scannés en parallèle.
 *
 * Liste obligatoire confirmée (Promise.allSettled, 13+ entrées) :
 *   US        : NYSE/NASDAQ/AMEX (équities US)
 *   LSE       : London Stock Exchange
 *   XETRA     : Frankfurt
 *   PA        : Euronext Paris
 *   SW        : SIX Suisse
 *   MI        : Borsa Italiana
 *   MC, BME   : Bolsa Madrid (les 2 codes EODHD selon l'API version)
 *   AS, AMS   : Euronext Amsterdam (les 2 codes EODHD selon l'API version)
 *   TSE       : Tokyo
 *   HK        : Hong Kong
 *   AU        : Australian Securities Exchange (Sydney)
 *   KO        : Korea (Seoul)
 *   TO        : Toronto Stock Exchange
 *
 * Bonus : NSE (India), BSE (India) — pas dans la spec minimale mais
 * faible coût marginal (1 fetch parallèle de plus).
 */
const EODHD_EXCHANGES = [
  'US',
  'LSE', 'XETRA', 'PA', 'SW', 'MI', 'MC', 'BME', 'AS', 'AMS',
  'TSE', 'HK', 'AU', 'KO', 'TO',
  'NSE', 'BSE',
];
const CRYPTO_PAIRS = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT', 'ADAUSDT', 'AVAXUSDT', 'DOTUSDT', 'LINKUSDT', 'MATICUSDT'];

/**
 * P5-PIVOT-TOP-GAINERS v1 — Cap conservatif : 1 position/cycle.
 * Permet de valider end-to-end avant scaling à 3 (PR2).
 */
const MAX_POSITIONS_PER_CYCLE_V1 = 1;

const TOP_GAINERS_CRON_NAME = 'top-gainers-scanner';

@Injectable()
export class TopGainersScannerService implements OnModuleInit {
  private readonly logger = new Logger(TopGainersScannerService.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly lisa: LisaService,
    private readonly decisionLog: DecisionLogService,
    private readonly config: ConfigService,
    private readonly binanceMarket: BinanceMarketService,
    private readonly schedulerRegistry: SchedulerRegistry,
  ) {}

  /**
   * P5-PIVOT-TOP-GAINERS Guard 4 — Cron interval configurable via env
   * `SCAN_INTERVAL_MINUTES` (default 15). Range valide 1-1440 min.
   * Scheduling dynamique au boot : `fly secrets set SCAN_INTERVAL_MINUTES=5`
   * + reboot machine → cron tourne toutes les 5 min.
   *
   * UI dynamique (changement live sans reboot) = deferred PR2.
   */
  onModuleInit(): void {
    const raw = this.config.get<string>('SCAN_INTERVAL_MINUTES');
    const parsed = parseInt(String(raw ?? '15'), 10);
    const validated = Number.isFinite(parsed)
      ? Math.max(1, Math.min(1440, parsed))
      : 15;
    if (parsed !== validated) {
      this.logger.warn(
        `[top-gainers] SCAN_INTERVAL_MINUTES=${raw} hors range [1,1440] → clamp à ${validated}`,
      );
    }
    if (validated < 5) {
      this.logger.warn('[top-gainers] interval <5min — risque rate-limit EODHD/Binance');
    }
    if (validated > 60) {
      this.logger.warn('[top-gainers] interval >60min — opportunités intraday potentiellement ratées');
    }
    // Cron expression : "*/N * * * *" (minute granularité, secondes à 0 par cron lib).
    const cronExpr = `*/${validated} * * * *`;
    try {
      // Idempotent : si déjà enregistré (hot-reload dev), ne pas re-add
      this.schedulerRegistry.getCronJob(TOP_GAINERS_CRON_NAME);
      this.logger.log(`[top-gainers] cron already registered, skip`);
      return;
    } catch {
      // Pas encore enregistré — on continue
    }
    const job = new CronJob(cronExpr, () => {
      void this.runScanner().catch((e) =>
        this.logger.error(`[top-gainers] runScanner error: ${String(e).slice(0, 200)}`),
      );
    });
    this.schedulerRegistry.addCronJob(TOP_GAINERS_CRON_NAME, job);
    job.start();
    this.logger.log(
      `[top-gainers] scheduled every ${validated}min (cron='${cronExpr}', strategy_active=${this.isStrategyActive()})`,
    );
  }

  /**
   * Run scanner — gated by STRATEGY_MODE=top_gainers env. Sans le flag,
   * le cron tourne mais retourne immédiatement (pas de side-effect).
   */
  async runScanner(): Promise<void> {
    if (!this.isStrategyActive()) {
      // Stratégie pas active globalement — ignorer le tick
      return;
    }
    try {
      await this.runScannerInner();
    } catch (e) {
      this.logger.error(`[top-gainers] cycle failed: ${String(e).slice(0, 200)}`);
    }
  }

  /** Activation globale via env STRATEGY_MODE=top_gainers */
  isStrategyActive(): boolean {
    return this.config.get<string>('STRATEGY_MODE') === 'top_gainers';
  }

  private async runScannerInner(): Promise<void> {
    // Charge tous les portfolios actifs en mode top_gainers
    const { data: configs, error } = await this.supabase
      .getClient()
      .from('lisa_session_configs')
      .select('user_id, portfolio_id')
      .eq('autopilot_enabled', true)
      .eq('kill_switch_active', false);
    if (error) {
      this.logger.error(`[top-gainers] fetch configs failed: ${error.message}`);
      return;
    }
    if (!configs || configs.length === 0) return;

    // Fetch global candidates UNE SEULE fois (partagé entre tous les portfolios)
    const candidates = await this.fetchAllCandidates();
    if (candidates.length === 0) {
      this.logger.warn('[top-gainers] 0 candidate fetched — skip cycle');
      return;
    }

    const top = selectTopGainers(candidates, 3);
    this.logger.log(
      `[top-gainers] ${candidates.length} scanned → ${top.length} retained: ${top.map((t) => `${t.symbol}(${t.assetClass},${t.changePct.toFixed(1)}%,score=${t.score})`).join(', ')}`,
    );

    // Persist log entries pour les top retenus + filtered samples (audit)
    await this.persistLog(candidates, top);

    if (top.length === 0) return;

    // Pour chaque portfolio, ouvre les top 3
    for (const cfg of configs) {
      try {
        await this.scanPortfolio(
          cfg.user_id as string,
          cfg.portfolio_id as string,
          top,
        );
      } catch (e) {
        this.logger.warn(
          `[top-gainers] portfolio ${String(cfg.portfolio_id).slice(0, 8)} failed: ${String(e).slice(0, 120)}`,
        );
      }
    }
  }

  /**
   * Fetch candidates depuis toutes les sources : EODHD multi-exchange + Binance crypto.
   * Yahoo / Coinbase / Kraken / OANDA → deferred PR.
   */
  private async fetchAllCandidates(): Promise<TopGainerCandidate[]> {
    const apiKey = this.config.get<string>('EODHD_API_KEY');
    const tasks: Promise<TopGainerCandidate[]>[] = [];

    if (apiKey) {
      // Iterate over exchanges in parallel
      for (const ex of EODHD_EXCHANGES) {
        tasks.push(this.fetchEodhdScreener(ex, apiKey).catch(() => []));
      }
    } else {
      this.logger.warn('[top-gainers] EODHD_API_KEY missing — skip equity scan');
    }

    // Crypto via Binance
    tasks.push(this.fetchBinanceGainers().catch(() => []));

    const results = await Promise.allSettled(tasks);
    return results
      .filter((r): r is PromiseFulfilledResult<TopGainerCandidate[]> => r.status === 'fulfilled')
      .flatMap((r) => r.value);
  }

  /**
   * EODHD Screener API : top gainers > 5% par exchange.
   * Doc : https://eodhd.com/financial-apis/stock-market-screener-api
   */
  private async fetchEodhdScreener(exchange: string, apiKey: string): Promise<TopGainerCandidate[]> {
    const filters = encodeURIComponent(JSON.stringify([
      ['change_p', '>', 3],
      ['close', '>', 1],
      ['avgvol_200d', '>', 100_000],
    ]));
    const url = `https://eodhd.com/api/screener?api_token=${encodeURIComponent(apiKey)}&filters=${filters}&exchange=${encodeURIComponent(exchange)}&sort=change_p.desc&limit=20&fmt=json`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) {
        this.logger.debug(`[top-gainers] eodhd ${exchange} HTTP ${res.status}`);
        return [];
      }
      const json = await res.json() as { data?: EodhdScreenerRow[] } | EodhdScreenerRow[];
      const rows: EodhdScreenerRow[] = Array.isArray(json) ? json : (json.data ?? []);
      return rows
        .map((r) => this.mapEodhdRow(r, exchange))
        .filter((c): c is TopGainerCandidate => c !== null);
    } catch (e) {
      this.logger.debug(`[top-gainers] eodhd ${exchange} fetch error: ${String(e).slice(0, 120)}`);
      return [];
    }
  }

  private mapEodhdRow(r: EodhdScreenerRow, exchange: string): TopGainerCandidate | null {
    const symbol = r.code;
    if (!symbol) return null;
    const close = num(r.last_price);
    const high = num(r.high_price ?? r.high) || close;
    const changePct = num(r.change_p);
    const volume = num(r.volume);
    const avgVol50d = num(r.avgvol_50d ?? r.avgvol_200d);
    const marketCap = num(r.market_capitalization ?? r.market_cap);
    if (!Number.isFinite(close) || close <= 0) return null;
    return {
      symbol,
      exchange,
      close,
      high,
      changePct,
      volume,
      avgVol50d,
      marketCap,
    };
  }

  /**
   * Binance crypto top gainers via ticker24hr existant
   * (BinanceMarketService.getTicker24h already wired).
   */
  private async fetchBinanceGainers(): Promise<TopGainerCandidate[]> {
    const out: TopGainerCandidate[] = [];
    for (const pair of CRYPTO_PAIRS) {
      try {
        const t = await this.binanceMarket.getTicker24h(pair);
        if (!t) continue;
        out.push({
          symbol: pair,
          exchange: 'BINANCE',
          close: t.lastPrice,
          high: t.high ?? t.lastPrice,
          changePct: t.priceChangePct,
          volume: t.quoteVolume ?? 0,
          avgVol50d: 0,
          marketCap: 0, // Crypto major filter ne nécessite pas marketCap si on whitelist top pairs
        });
      } catch (e) {
        this.logger.debug(`[top-gainers] binance ${pair} error: ${String(e).slice(0, 80)}`);
      }
    }
    return out;
  }

  private async scanPortfolio(
    userId: string,
    portfolioId: string,
    top: Array<TopGainerCandidate & { score: number; assetClass: TopGainerAssetClass }>,
  ): Promise<void> {
    // Garde-fou : count current open positions
    const { data: openPositions } = await this.supabase
      .getClient()
      .from('lisa_positions')
      .select('symbol')
      .eq('portfolio_id', portfolioId)
      .eq('status', 'open');
    const openSymbols = new Set((openPositions ?? []).map((p) => String(p.symbol).toUpperCase()));
    const maxOpen = 3;
    const slotsAvailable = Math.max(0, maxOpen - (openPositions?.length ?? 0));
    if (slotsAvailable === 0) {
      this.logger.log(`[top-gainers] ${portfolioId.slice(0, 8)}: no slots (${openPositions?.length}/3 open)`);
      return;
    }

    // Guard 3 v1 — cap conservatif : 1 position/cycle (test prudent avant
    // bump à 3 dans v2). Permet de valider le pipeline end-to-end.
    const maxThisCycle = Math.min(slotsAvailable, MAX_POSITIONS_PER_CYCLE_V1);
    let opened = 0;
    for (const cand of top) {
      if (opened >= maxThisCycle) break;
      const baseSym = cand.symbol.replace(/USDT$|USDC$/, '').toUpperCase();
      if (openSymbols.has(cand.symbol.toUpperCase()) || openSymbols.has(baseSym)) continue;

      const insertedPosId = await this.openTopGainerPosition(
        userId,
        portfolioId,
        cand,
      ).catch((e) => {
        this.logger.warn(
          `[top-gainers] open ${cand.symbol} failed: ${String(e).slice(0, 120)}`,
        );
        return null;
      });
      if (insertedPosId) {
        opened++;
        await this.markLogOpened(cand.symbol, portfolioId, insertedPosId).catch(() => null);
      }
    }
  }

  /**
   * Crée une pseudo-proposal + thèse minimale, puis call paperBroker.openPosition.
   * Le paperBroker existant exige (proposalId, thesisId) → on synthétise ces 2.
   */
  private async openTopGainerPosition(
    userId: string,
    portfolioId: string,
    cand: TopGainerCandidate & { score: number; assetClass: TopGainerAssetClass },
  ): Promise<string | null> {
    const proposalId = randomUUID();
    const thesisId = randomUUID();

    // Pseudo-thèse minimale + pseudo-allocation 30% capital.
    const thesis = {
      id: thesisId,
      summary: `TopGainer ${cand.symbol} +${cand.changePct.toFixed(1)}% (${cand.assetClass})`,
      conviction: 0.7,
      conviction_score: 7,
      category: 'flow_timing',
      kind: 'momentum',
      preferredExpressionIndex: 0,
      expressions: [
        {
          symbol: cand.symbol,
          assetClass: cand.assetClass,
          direction: 'long',
          venue: cand.exchange ?? 'unknown',
          stopLossPct: 1.5,
          takeProfitPct: 3.0,
          horizonDays: 1,
        },
      ],
    };
    const allocations = [
      { thesisId, pctCapital: 30, amountUsd: '3000.00' },
    ];

    // INSERT pseudo-proposal
    const { error: insErr } = await this.supabase.getClient().from('lisa_proposals').insert({
      id: proposalId,
      portfolio_id: portfolioId,
      user_id: userId,
      capital_usd: '10000.00',
      base_currency: 'USD',
      detected_regime: 'momentum_top_gainers',
      market_momentum: 'bullish_strong',
      regime_summary: `TopGainer scanner candidate: ${cand.symbol} ${cand.assetClass}`,
      favored_pockets: [],
      avoided_pockets: [],
      theses: [thesis],
      allocations,
      cash_reserve_pct: 70,
      warnings: [],
      status: 'proposed',
      claude_cost_usd: 0,
      generated_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 4 * 3600 * 1000).toISOString(),
    });
    if (insErr) {
      this.logger.warn(`[top-gainers] insert pseudo-proposal failed: ${insErr.message}`);
      return null;
    }

    // Call approveProposal (réutilise toute la logique cooldown / max_pos /
    // cash buffer / fallback price guard / decision_log position_opened).
    try {
      const result = await this.lisa.approveProposal(userId, proposalId);
      if (result.openedPositions.length === 0) {
        this.logger.log(`[top-gainers] ${cand.symbol}: approveProposal returned 0 (rejected by gates)`);
        return null;
      }
      this.logger.log(
        `[top-gainers] ${cand.symbol} opened (${result.openedPositions.length} pos, score=${cand.score})`,
      );
      return result.openedPositions[0].id;
    } catch (e) {
      this.logger.warn(`[top-gainers] approveProposal ${cand.symbol} failed: ${String(e).slice(0, 120)}`);
      return null;
    }
  }

  /**
   * Persist log entries dans top_gainers_log.
   * Logge tous les top retenus (decision='passed') + sample de filtered (audit).
   */
  private async persistLog(
    allCandidates: TopGainerCandidate[],
    top: Array<TopGainerCandidate & { score: number; assetClass: TopGainerAssetClass }>,
  ): Promise<void> {
    const topSet = new Set(top.map((t) => t.symbol));
    const rows: Record<string, unknown>[] = [];
    for (const t of top) {
      rows.push({
        symbol: t.symbol,
        market: t.assetClass,
        exchange: t.exchange ?? 'unknown',
        close_price: String(t.close),
        high_price: String(t.high),
        change_pct: String(t.changePct),
        volume: t.volume,
        avg_vol_50d: t.avgVol50d,
        market_cap_usd: String(t.marketCap),
        score: String(t.score),
        decision: 'passed',
        detected_asset_class: t.assetClass,
      });
    }
    // Sample 10 filtered candidates pour audit
    const filtered = allCandidates.filter((c) => !topSet.has(c.symbol)).slice(0, 10);
    for (const c of filtered) {
      rows.push({
        symbol: c.symbol,
        market: 'us_equity_small_mid', // best-effort, asset class non recalculée pour log
        exchange: c.exchange ?? 'unknown',
        close_price: String(c.close),
        high_price: String(c.high),
        change_pct: String(c.changePct),
        volume: c.volume,
        avg_vol_50d: c.avgVol50d,
        market_cap_usd: String(c.marketCap),
        score: '0',
        decision: 'filtered',
      });
    }
    if (rows.length === 0) return;
    const { error } = await this.supabase.getClient().from('top_gainers_log').insert(rows);
    if (error) this.logger.debug(`[top-gainers] persistLog failed: ${error.message}`);
  }

  /**
   * Met à jour le log row avec opened_position_id après ouverture position.
   */
  private async markLogOpened(symbol: string, portfolioId: string, positionId: string): Promise<void> {
    await this.supabase.getClient()
      .from('top_gainers_log')
      .update({ decision: 'opened', opened_position_id: positionId, portfolio_id: portfolioId })
      .eq('symbol', symbol)
      .eq('decision', 'passed')
      .gte('captured_at', new Date(Date.now() - 60_000).toISOString());
  }
}

function num(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}
