/**
 * Mode OVERSOLD — Exit par durée (PR-3 de docs/mode-oversold-spec.md).
 *
 * Service ISOLÉ : NE TOUCHE PAS MechanicalTradingService. Le paper-broker écrit
 * bien `horizon_target_date` à l'open MAIS aucune logique existante ne ferme
 * dessus → c'est CE service qui pilote la sortie des positions oversold.
 *
 * Cadence : cron horaire. Pour chaque position open oversold :
 *   1. Exit HOLD : businessDaysSince(entry) >= hold_days → close (reason closed_expired)
 *   2. Stop CATASTROPHE : prix courant <= entry × (1 + stop_catastrophe_pct/100)
 *      → close (reason closed_stop) — filet large pour une 2e jambe structurelle
 *
 * Prix courant = dernier close EOD via EODHD (le mode est swing post-close, pas
 * de besoin d'intraday). Source 'eodhd_eod' (non-stale) pour passer le R5 guard.
 *
 * IDENTIFICATION DES POSITIONS OVERSOLD — point d'intégration à reviewer :
 * la colonne `lisa_positions.source` a un CHECK `('lisa','mechanical')` et le
 * paper-broker ne l'écrit PAS (il défaulte à 'lisa'). Le tag passé à
 * openPositionDirect (`source: 'scanner_oversold'`) est persisté par le broker
 * dans le JSONB `venue_fee_detail.source`. On filtre donc sur ce chemin JSONB
 * (`venue_fee_detail->>source = 'scanner_oversold'`), cohérent avec ce que le
 * broker écrit réellement, sans toucher au broker ni au schéma. Cf. note finale.
 *
 * Activation : env `OVERSOLD_EXIT_ENABLED` (default 'true').
 */

import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { SupabaseService } from '../../supabase/supabase.service';
import { LisaService } from './lisa.service';
import { DecisionLogService } from './decision-log.service';
import { businessDaysSince } from './oversold.helper';
import { isKnownMarketClosed } from './exchange-sessions.helper';

interface OpenOversoldPosition {
  id: string;
  portfolio_id: string;
  symbol: string;
  entry_price: string;
  entry_timestamp: string;
}

interface OversoldExitCfg {
  holdDays: number;
  stopCatastrophePct: number;
}

const DEFAULT_HOLD_DAYS = 10;
const DEFAULT_STOP_CATASTROPHE_PCT = -15;
const FETCH_TIMEOUT_MS = 8000;

@Injectable()
export class OversoldExitService {
  private readonly logger = new Logger(OversoldExitService.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly lisa: LisaService,
    private readonly decisionLog: DecisionLogService,
    private readonly config: ConfigService,
  ) {}

  private isEnabled(): boolean {
    return (this.config.get<string>('OVERSOLD_EXIT_ENABLED') ?? 'true').toLowerCase() === 'true';
  }

  /** PR #634 — garde anti-gaspillage : skip le fetch EODHD quand le marché du
   * ticker est connu+fermé. Réversible via OVERSOLD_EXIT_SKIP_MARKET_CLOSED. */
  private skipWhenClosed(): boolean {
    return (this.config.get<string>('OVERSOLD_EXIT_SKIP_MARKET_CLOSED') ?? 'true').toLowerCase() === 'true';
  }

  /**
   * Cron toutes les 30 min. Owner unique des exits oversold (hold J+10 + stop
   * catastrophe -15%) depuis que le mode oversold est sorti de la boucle
   * mécanique 60s (incident 04/06 : 26 positions US polled/60s = saturation I/O
   * Fly). 30 min = backstop -15% réactif sans charge (26 fetches × 2/h vs
   * 26 × 60/h dans l'ancienne boucle).
   */
  @Cron(CronExpression.EVERY_30_MINUTES, { name: 'oversold-exit', timeZone: 'UTC' })
  async runExitCycle(): Promise<void> {
    try {
      if (!this.isEnabled()) {
        this.logger.debug('[oversold-exit] OVERSOLD_EXIT_ENABLED=false → skip cycle');
        return;
      }

      const positions = await this.loadOpenOversoldPositions();
      if (positions.length === 0) return;

      // Cache config par portfolio (évite N requêtes pour N positions).
      const cfgCache = new Map<string, OversoldExitCfg>();
      const now = new Date();

      for (const pos of positions) {
        try {
          let cfg = cfgCache.get(pos.portfolio_id);
          if (!cfg) {
            cfg = await this.loadExitConfig(pos.portfolio_id);
            cfgCache.set(pos.portfolio_id, cfg);
          }
          await this.evaluatePosition(pos, cfg, now);
        } catch (err) {
          this.logger.warn(
            `[oversold-exit] position ${pos.symbol} (${pos.id.slice(0, 8)}) échouée: ${String(err).slice(0, 200)}`,
          );
        }
      }
    } catch (err) {
      this.logger.error(`[oversold-exit] runExitCycle exception globale: ${String(err).slice(0, 300)}`);
    }
  }

  /** Évalue une position : hold expiré OU stop catastrophe. */
  private async evaluatePosition(
    pos: OpenOversoldPosition,
    cfg: OversoldExitCfg,
    now: Date,
  ): Promise<void> {
    // PR #634 — skip si le marché du ticker est connu ET fermé (week-end, hors
    // session DST-aware, férié bourse). Le close EOD serait figé → ni stop
    // catastrophe (0 mouvement marché fermé) ni nouvelle info ; le hold J+10 se
    // ferme à la prochaine séance (swing, retard de quelques h négligeable).
    if (this.skipWhenClosed() && isKnownMarketClosed(pos.symbol, now)) {
      this.logger.debug(`[oversold-exit] ${pos.symbol} marché fermé → skip ce cycle (économie EODHD)`);
      return;
    }

    const heldDays = businessDaysSince(pos.entry_timestamp, now);
    const holdExpired = heldDays >= cfg.holdDays;

    // On a besoin du prix courant pour le stop ET pour la close hold.
    const price = await this.fetchLastClose(pos.symbol);
    if (price == null) {
      // Pas de prix frais : on ne ferme pas (évite close break-even artificiel).
      // Le hold sera ré-évalué au prochain cycle horaire.
      this.logger.debug(`[oversold-exit] pas de prix frais pour ${pos.symbol} → skip ce cycle`);
      return;
    }

    const entry = parseFloat(pos.entry_price);
    const stopThreshold = entry * (1 + cfg.stopCatastrophePct / 100);

    // 1. Stop catastrophe prioritaire (coupe une 2e jambe avant le hold).
    if (Number.isFinite(entry) && entry > 0 && price <= stopThreshold) {
      await this.closePosition(
        pos,
        price,
        'closed_stop',
        'oversold_stop_catastrophe',
        `Stop catastrophe ${cfg.stopCatastrophePct}% touché: prix=$${price.toFixed(4)} <= seuil=$${stopThreshold.toFixed(4)} (entry=$${entry.toFixed(4)})`,
      );
      return;
    }

    // 2. Hold expiré → close au dernier close EOD.
    if (holdExpired) {
      await this.closePosition(
        pos,
        price,
        'closed_expired',
        'oversold_hold_expired',
        `Hold J+${cfg.holdDays} atteint (${heldDays} jours ouvrés écoulés): close à $${price.toFixed(4)}`,
      );
    }
  }

  /**
   * Ferme une position via le paper-broker + audit decision_log.
   *
   * @param status   valeur du CHECK PaperPositionStatus écrite en `status`
   *                 (closed_stop / closed_expired) — le label oversold métier
   *                 (`exitLabel`) n'est PAS une valeur d'enum valide, on le
   *                 garde pour le decision_log uniquement.
   * @param exitLabel libellé métier oversold (kind decision_log).
   */
  private async closePosition(
    pos: OpenOversoldPosition,
    price: number,
    status: 'closed_stop' | 'closed_expired',
    exitLabel: 'oversold_hold_expired' | 'oversold_stop_catastrophe',
    rationale: string,
  ): Promise<void> {
    await this.lisa.getPaperBroker().closePosition({
      positionId: pos.id,
      reason: status,
      livePrice: String(price),
      rationale: `[${exitLabel}] ${rationale}`,
      livePriceSource: 'eodhd_eod',
      // Marché US fermé hors session : le close EOD est le last close valide.
      marketClosed: true,
    });

    await this.decisionLog
      .append({
        portfolioId: pos.portfolio_id,
        kind: exitLabel,
        summary: `Oversold close ${pos.symbol}: ${exitLabel}`,
        rationale,
        payload: {
          symbol: pos.symbol,
          position_id: pos.id,
          exit_price: price,
          entry_price: pos.entry_price,
          status,
          exit_label: exitLabel,
        },
        triggeredBy: 'mechanical_cron',
        watchlistSource: 'mechanical',
        market: 'us_equity',
      })
      .catch((e) =>
        this.logger.warn(`[oversold-exit] decision_log append failed: ${String(e).slice(0, 160)}`),
      );

    this.logger.log(`[oversold-exit] closed ${pos.symbol} (${exitLabel}/${status}) @ $${price.toFixed(4)}`);
  }

  /** Charge les positions oversold ouvertes (toutes portfolios). */
  private async loadOpenOversoldPositions(): Promise<OpenOversoldPosition[]> {
    // Filtre sur le JSONB venue_fee_detail->>source (= 'scanner_oversold'),
    // car le broker n'écrit pas la colonne `source` (CHECK lisa/mechanical).
    const { data, error } = await this.supabase
      .getClient()
      .from('lisa_positions')
      .select('id, portfolio_id, symbol, entry_price, entry_timestamp')
      .eq('venue_fee_detail->>source', 'scanner_oversold')
      .eq('status', 'open');
    if (error) {
      this.logger.warn(`[oversold-exit] load positions failed: ${error.message}`);
      return [];
    }
    return (data ?? []) as unknown as OpenOversoldPosition[];
  }

  /** Charge hold_days + stop_catastrophe_pct du portfolio (defaults si NULL). */
  private async loadExitConfig(portfolioId: string): Promise<OversoldExitCfg> {
    const { data } = await this.supabase
      .getClient()
      .from('lisa_session_configs')
      .select('oversold_hold_days, oversold_stop_catastrophe_pct')
      .eq('portfolio_id', portfolioId)
      .maybeSingle();
    const holdDays = data?.oversold_hold_days ?? DEFAULT_HOLD_DAYS;
    const rawStop = data?.oversold_stop_catastrophe_pct;
    const stop =
      rawStop == null ? DEFAULT_STOP_CATASTROPHE_PCT : Number(rawStop);
    return {
      holdDays: Number.isFinite(Number(holdDays)) ? Number(holdDays) : DEFAULT_HOLD_DAYS,
      stopCatastrophePct: Number.isFinite(stop) ? stop : DEFAULT_STOP_CATASTROPHE_PCT,
    };
  }

  /**
   * Récupère le dernier close EOD d'un symbole via EODHD (fetch direct).
   * Clé JAMAIS loggée. Retourne null si indisponible.
   */
  private async fetchLastClose(symbol: string): Promise<number | null> {
    const apiKey = this.config.get<string>('EODHD_API_KEY');
    if (!apiKey) return null;

    const to = new Date();
    const from = new Date(to.getTime() - 8 * 86_400_000);
    const fromStr = from.toISOString().slice(0, 10);
    const toStr = to.toISOString().slice(0, 10);
    const url =
      `https://eodhd.com/api/eod/${encodeURIComponent(symbol)}` +
      `?from=${fromStr}&to=${toStr}&api_token=${apiKey}&fmt=json`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) return null;
      const json = (await res.json()) as Array<Record<string, unknown>>;
      if (!Array.isArray(json) || json.length === 0) return null;
      // Dernière barre = close courant.
      const sorted = json
        .map((b) => ({
          date: String(b.date ?? ''),
          close: Number(b.close ?? b.adjusted_close ?? NaN),
        }))
        .filter((b) => b.date.length > 0 && Number.isFinite(b.close) && b.close > 0)
        .sort((a, b) => a.date.localeCompare(b.date));
      if (sorted.length === 0) return null;
      return sorted[sorted.length - 1].close;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}
