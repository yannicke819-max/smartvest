/**
 * Micro-momentum probe — collecteur shadow d'entrée haute fréquence (crypto).
 *
 * Mesure pure, ZÉRO trade. Gated OFF par défaut (MICRO_MOMENTUM_ENABLED).
 *
 * Pipeline :
 *   1. Sampler (setInterval ~2s) : prix spot Binance (batch 1 appel) → ring buffer
 *      par symbole. Détecte un trigger (run haussier + vélocité, cf.
 *      micro-momentum.helper) → INSERT une probe (entry, run, vélocité, accel).
 *      Cooldown par symbole pour ne pas flooder le même run.
 *   2. Resolver (cron 5 min) : pour chaque probe dont l'horizon max est écoulé,
 *      calcule le forward-return net de frais à 1/3/5/15 min via les klines 1m,
 *      et marque resolved.
 *
 * On croise ensuite (offline) run_length × vélocité × forward_return_net pour
 * répondre : existe-t-il un (run, vélocité) où l'espérance nette de frais est
 * franchement positive ? Si oui → candidat à un vrai signal d'entrée. Sinon →
 * réfuté sans avoir risqué un dollar.
 */

import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { SupabaseService } from '../../supabase/supabase.service';
import { BinanceMarketService } from './binance-market.service';
import { PriceSample, evaluateMicroTrigger, forwardReturnNet, computeMicroFeatures } from './micro-momentum.helper';

const DEFAULT_MAJORS = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT', 'ADAUSDT', 'AVAXUSDT', 'DOTUSDT', 'LINKUSDT', 'POLUSDT'];
const HORIZONS_MIN = [1, 3, 5, 15];
const MAX_RESOLVE_PER_CYCLE = 100;

@Injectable()
export class MicroMomentumProbeService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MicroMomentumProbeService.name);

  private readonly enabled = process.env.MICRO_MOMENTUM_ENABLED === 'true';
  private readonly sampleMs = Number(process.env.MICRO_SAMPLE_MS ?? '2000');
  private readonly bufferSize = Number(process.env.MICRO_BUFFER_SIZE ?? '30');
  private readonly minRunLength = Number(process.env.MICRO_MIN_RUN ?? '5');
  private readonly minVelocityPctPerS = Number(process.env.MICRO_MIN_VELOCITY_PCT_S ?? '0.0003');
  private readonly feeRoundtripPct = Number(process.env.MICRO_FEE_ROUNDTRIP_PCT ?? '0.002');
  private readonly triggerCooldownMs = Number(process.env.MICRO_TRIGGER_COOLDOWN_MS ?? '60000');
  private readonly symbols = (process.env.MICRO_SYMBOLS ?? DEFAULT_MAJORS.join(','))
    .split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);

  private readonly buffers = new Map<string, PriceSample[]>();
  private readonly lastTriggerMs = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly supabase: SupabaseService,
    private readonly binance: BinanceMarketService,
  ) {}

  onModuleInit(): void {
    if (!this.enabled) return;
    this.logger.log(
      `[micro-momentum] ENABLED — sample=${this.sampleMs}ms minRun=${this.minRunLength} ` +
      `minVel=${this.minVelocityPctPerS}/s symbols=${this.symbols.length}`,
    );
    this.timer = setInterval(() => {
      void this.sampleTick().catch((e) =>
        this.logger.warn(`[micro-momentum] sample tick failed: ${String(e).slice(0, 120)}`),
      );
    }, this.sampleMs);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /**
   * Miracle #2 — Expose la vélocité instantanée d'un symbole pour gating à
   * l'entrée par le scanner. Lit depuis le buffer mémoire local (probe cron).
   *
   * Retourne null si :
   *   - probe désactivé (MICRO_MOMENTUM_ENABLED=false)
   *   - symbole pas dans la liste tracked (probe ne sait pas)
   *   - buffer trop court pour calculer (<3 samples)
   *
   * Le caller décide quoi faire de null (typiquement allow par défaut).
   */
  getRecentVelocity(symbol: string): { velocityPctPerS: number; runLength: number; samples: number } | null {
    if (!this.enabled) return null;
    const buf = this.buffers.get(symbol.toUpperCase());
    if (!buf || buf.length < 3) return null;
    const f = computeMicroFeatures(buf);
    return {
      velocityPctPerS: f.velocityPctPerS,
      runLength: f.runLength,
      samples: buf.length,
    };
  }

  /** Un tick d'échantillonnage : fetch batch, push buffers, détecte triggers. */
  private async sampleTick(): Promise<void> {
    const prices = await this.binance.getSpotPrices(this.symbols);
    if (prices.size === 0) return;
    const now = Date.now();
    for (const [symbol, price] of prices) {
      const buf = this.buffers.get(symbol) ?? [];
      buf.push({ ts: now, price });
      while (buf.length > this.bufferSize) buf.shift();
      this.buffers.set(symbol, buf);

      const trig = evaluateMicroTrigger(buf, {
        minRunLength: this.minRunLength,
        minVelocityPctPerS: this.minVelocityPctPerS,
      });
      if (!trig.triggered) continue;

      const lastTrig = this.lastTriggerMs.get(symbol) ?? 0;
      if (now - lastTrig < this.triggerCooldownMs) continue;
      this.lastTriggerMs.set(symbol, now);
      await this.insertProbe(symbol, price, now, trig.runLength, trig.velocityPctPerS, trig.accelerationPctPerS2);
    }
  }

  private async insertProbe(
    symbol: string,
    entryPrice: number,
    triggerMs: number,
    runLength: number,
    velocityPctPerS: number,
    accelerationPctPerS2: number | null,
  ): Promise<void> {
    if (!this.supabase.isReady()) return;
    const { error } = await this.supabase
      .getClient()
      .from('micro_momentum_probes')
      .insert({
        symbol,
        trigger_ts: new Date(triggerMs).toISOString(),
        entry_price: entryPrice,
        run_length: runLength,
        sample_interval_ms: this.sampleMs,
        velocity_pct_per_s: velocityPctPerS,
        acceleration_pct_per_s2: accelerationPctPerS2,
      });
    if (error) this.logger.debug(`[micro-momentum] probe insert failed: ${error.message}`);
    else this.logger.log(`[micro-momentum] probe ${symbol} run=${runLength} vel=${(velocityPctPerS * 100).toFixed(4)}%/s @${entryPrice}`);
  }

  /** Résout les forward-returns des probes dont l'horizon max est écoulé. */
  @Cron('*/5 * * * *')
  async resolveProbes(): Promise<void> {
    if (!this.enabled || !this.supabase.isReady()) return;
    const maxHorizonMs = Math.max(...HORIZONS_MIN) * 60_000;
    const readyBefore = new Date(Date.now() - maxHorizonMs).toISOString();

    const { data, error } = await this.supabase
      .getClient()
      .from('micro_momentum_probes')
      .select('id, symbol, trigger_ts, entry_price')
      .eq('resolved', false)
      .lte('trigger_ts', readyBefore)
      .order('trigger_ts', { ascending: true })
      .limit(MAX_RESOLVE_PER_CYCLE);
    if (error || !data || data.length === 0) return;

    let resolved = 0;
    for (const p of data as Array<{ id: number; symbol: string; trigger_ts: string; entry_price: number }>) {
      try {
        const triggerMs = new Date(p.trigger_ts).getTime();
        const fromMs = triggerMs;
        const toMs = triggerMs + maxHorizonMs + 60_000;
        const candles = await this.binance.getKlinesRange(p.symbol, '1m', fromMs, toMs);
        if (!candles || candles.length === 0) continue;
        const forwardReturns = HORIZONS_MIN.map((h) => {
          const target = triggerMs + h * 60_000;
          // Dernière bougie dont l'open <= target (close à cet horizon).
          let chosen = candles[0];
          for (const c of candles) {
            if (c.openTime <= target) chosen = c;
            else break;
          }
          const r = forwardReturnNet(p.entry_price, chosen.close, this.feeRoundtripPct);
          return r ? { horizon_min: h, ret_pct: r.retPct, ret_net_pct: r.retNetPct } : null;
        }).filter((x) => x !== null);

        const { error: upErr } = await this.supabase
          .getClient()
          .from('micro_momentum_probes')
          .update({ forward_returns: forwardReturns, resolved: true })
          .eq('id', p.id);
        if (!upErr) resolved++;
      } catch (e) {
        this.logger.debug(`[micro-momentum] resolve ${p.symbol} failed: ${String(e).slice(0, 80)}`);
      }
    }
    if (resolved > 0) this.logger.log(`[micro-momentum] resolved ${resolved} probes`);
  }
}
