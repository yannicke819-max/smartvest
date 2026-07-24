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
  manual_control: boolean | null;
  manual_control_since: string | null;
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

    // ── SENTINELLE US (24/07, SHADOW — mesure seule, AUCUNE action) ──
    // Règle mesurée sur 286 trades labellisés : pnl ≤ −6% dès J+1 ET news
    // POSITIVES à l'entrée (≥3 articles, sentiment ≥ +0.3) → 96% finissent
    // négatifs à J+10, 71% en désastre ≤−10%, trajectoire moyenne −15.1% (n=24).
    // Et la recovery post-deadline montre que ces profondes CONTINUENT de couler
    // après J+10 (RKLB −33% de plus, GFS −21%…) → la seule action rationnelle
    // serait une COUPE PRÉCOCE à J+1 — mais c'est un auto-close de perdant
    // (ligne rouge user) → SHADOW d'abord, décision humaine au check-in 04-08/08.
    // Env : OVERSOLD_SENTINEL_MODE=off|shadow (default shadow), OVERSOLD_SENTINEL_PNL_PCT (-6).
    await this.maybeFlagSentinel(pos, price, entry).catch(() => undefined);

    // ─── DANGER-ZONE OVERSOLD → MISE EN MANU (demande user 07/06) ─────────────
    // À l'APPROCHE du stop catastrophe, on bascule la position en manual_control
    // (l'humain décide : tenir le rebond ou couper) AU LIEU de couper auto.
    // Filet : re-arm après MANUAL_CONTROL_REARM_MIN (20min) → le stop auto reprend.
    let rearmedThisCycle = false;
    if (Number.isFinite(entry) && entry > 0) {
      const rearmMin = Number(this.config.get<string>('MANUAL_CONTROL_REARM_MIN') ?? '20');
      const dangerRatio = Number(this.config.get<string>('OVERSOLD_DANGER_ZONE_RATIO') ?? '0.80');
      const dangerThreshold = entry * (1 + (cfg.stopCatastrophePct * dangerRatio) / 100);

      // A. Déjà en Manu : re-arm si périmé, sinon l'humain garde la main (0 close auto).
      if (pos.manual_control === true) {
        // #2 (30/06) — la DEADLINE J+10 ferme MÊME une position en MANU. La fenêtre de
        // mean-reversion est écoulée → tenir plus n'est plus dans la stratégie et le
        // capital gelé doit être libéré. C'est une sortie d'HORIZON, PAS le stop
        // catastrophe -15% (que l'user refuse). allowManualControlled=true passe le chokepoint.
        if (holdExpired) {
          this.logger.warn(`[oversold-exit] ${pos.symbol} en MANU MAIS deadline J+${cfg.holdDays} atteinte (${heldDays}j) → close deadline (capital libéré, PAS un catastrophe)`);
          await this.closePosition(
            pos, price, 'closed_expired', 'oversold_hold_expired',
            `Hold J+${cfg.holdDays} atteint (${heldDays}j ouvrés) en MANU: close deadline à $${price.toFixed(4)} (fenêtre mean-reversion écoulée)`,
            true,
          );
          return;
        }
        const since = pos.manual_control_since ? new Date(pos.manual_control_since).getTime() : null;
        if (since == null) {
          await this.supabase.getClient().from('lisa_positions')
            .update({ manual_control_since: new Date().toISOString() }).eq('id', pos.id)
            .then(() => undefined, () => undefined);
          return; // chrono démarré, on attend
        }
        const stuckMin = (now.getTime() - since) / 60_000;
        if (stuckMin < rearmMin) {
          this.logger.debug(`[oversold-exit] ${pos.symbol} manual_control ${stuckMin.toFixed(0)}min → humain décide, pas de close auto`);
          return; // dans la fenêtre → ni catastrophe ni hold
        }
        // FIX 24/06 — NE PAS ré-armer tant que la position est ENCORE en danger
        // (≤ danger-zone). Avant : le re-arm rendait la main au stop auto même à
        // -14%/-15% → catastrophe-close (MSTR -$1159, ETL, SOI, ON). Le gain-picker
        // étant gains-only, un loser n'est JAMAIS « résolu » → ré-armé puis liquidé à
        // -15% en boucle. Désormais : tant que price ≤ danger, la position RESTE en
        // MANU (l'humain décide, 0 close auto). On ne ré-arme QUE si elle a RÉCUPÉRÉ
        // au-dessus de la danger-zone.
        if (price <= dangerThreshold) {
          this.logger.warn(
            `[oversold-exit] ${pos.symbol} MANU périmé (${stuckMin.toFixed(0)}min) MAIS toujours en danger-zone ` +
              `(${(((price - entry) / entry) * 100).toFixed(1)}%) → reste en MANU, PAS de ré-arm (catastrophe bloqué, l'humain décide)`,
          );
          return;
        }
        // récupérée au-dessus de la danger-zone → on rend la main au stop auto CE cycle
        await this.supabase.getClient().from('lisa_positions')
          .update({ manual_control: false, manual_control_since: null, manual_control_reason: null }).eq('id', pos.id)
          .then(() => undefined, () => undefined);
        await this.decisionLog.append({
          portfolioId: pos.portfolio_id,
          kind: 'manual_control_rearmed',
          summary: `[OVERSOLD_REARM] ${pos.symbol} stop auto ré-armé après ${stuckMin.toFixed(0)}min sans résolution`,
          rationale: `manual_control oversold non résolu depuis ${stuckMin.toFixed(0)}min (≥ ${rearmMin}min). Le stop catastrophe ${cfg.stopCatastrophePct}% / hold J+${cfg.holdDays} reprend la main ce cycle.`,
          payload: { symbol: pos.symbol, stuck_minutes: Math.round(stuckMin), rearm_min: rearmMin },
          triggeredBy: 'autopilot_cron',
        }).catch(() => null);
        rearmedThisCycle = true; // bloque la re-bascule immédiate ci-dessous
      }

      // B. À/sous la danger-zone → MANU. Le `price > stopThreshold` a été RETIRÉ
      // (fix 24/06) : un gap qui passe SOUS le stop catastrophe doit AUSSI basculer
      // en MANU, pas filer à l'auto-close -15% (même bug que le RiskMonitor).
      if (!rearmedThisCycle && pos.manual_control !== true && price <= dangerThreshold) {
        const lossPct = ((price - entry) / entry) * 100;
        await this.supabase.getClient().from('lisa_positions')
          .update({ manual_control: true, manual_control_since: new Date().toISOString(), manual_control_reason: 'oversold_danger_zone' }).eq('id', pos.id)
          .then(() => undefined, () => undefined);
        this.logger.warn(`[oversold-exit] ${pos.symbol} DANGER-ZONE (${lossPct.toFixed(1)}%, ≥${(dangerRatio * 100).toFixed(0)}% du chemin vers stop ${cfg.stopCatastrophePct}%) → mise en MANU`);
        await this.decisionLog.append({
          portfolioId: pos.portfolio_id,
          kind: 'oversold_danger_zone_manual',
          summary: `[OVERSOLD_DANGER_ZONE] ${pos.symbol} → mise en Manu (${lossPct.toFixed(1)}%)`,
          rationale: `Position à ${lossPct.toFixed(1)}% (≥ ${(dangerRatio * 100).toFixed(0)}% du chemin vers le stop ${cfg.stopCatastrophePct}%). Bascule en manual_control : 0 close auto, l'humain décide (tenir le rebond ou couper). Re-arm auto après ${rearmMin}min si non résolu.`,
          payload: { symbol: pos.symbol, loss_pct: Number(lossPct.toFixed(2)), danger_threshold: dangerThreshold, stop_threshold: stopThreshold },
          triggeredBy: 'autopilot_cron',
        }).catch(() => null);
        return; // basculé en Manu, pas de close ce cycle
      }
    }

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
  /** Cache news-à-l'entrée par position (30 min) — évite 1 query paper_trades par cycle. */
  private readonly sentinelNewsCache = new Map<string, { newsPos: boolean; at: number }>();

  private async maybeFlagSentinel(pos: OpenOversoldPosition, price: number, entry: number): Promise<void> {
    const mode = (this.config.get<string>('OVERSOLD_SENTINEL_MODE') ?? 'shadow').toLowerCase();
    if (mode === 'off') return;
    if (!pos.symbol.endsWith('.US')) return; // règle validée US uniquement (EU illisible tôt)
    if (!(entry > 0) || !(price > 0)) return;
    const lossPct = (price / entry - 1) * 100;
    const thr = Number(this.config.get<string>('OVERSOLD_SENTINEL_PNL_PCT') ?? '-6');
    if (!(lossPct <= thr)) return;
    const heldDays = businessDaysSince(pos.entry_timestamp, new Date());
    if (heldDays < 1) return; // le signal est défini au close J+1, pas intraday J+0

    // News à l'entrée (cache 30 min)
    const cached = this.sentinelNewsCache.get(pos.id);
    let newsPos: boolean;
    if (cached && Date.now() - cached.at < 30 * 60_000) {
      newsPos = cached.newsPos;
    } else {
      const { data } = await this.supabase.getClient()
        .from('paper_trades')
        .select('features_at_entry')
        .eq('scanner_position_id', pos.id)
        .maybeSingle();
      const f = (data?.features_at_entry ?? {}) as Record<string, unknown>;
      newsPos = (Number(f.newsCount) || 0) >= 3 && (Number(f.newsAvgSentiment) || 0) >= 0.3;
      this.sentinelNewsCache.set(pos.id, { newsPos, at: Date.now() });
    }
    if (!newsPos) return;

    this.logger.warn(
      `[sentinelle-us:${mode}] 🚨 ${pos.symbol} pnl=${lossPct.toFixed(1)}% J+${heldDays} avec news POSITIVES à l'entrée ` +
        `→ profil 96% négatif à J+10 (71% désastre, moy −15.1%, n=24) — SIGNAL LOGGÉ, AUCUNE ACTION (shadow)`,
    );
  }

  private async closePosition(
    pos: OpenOversoldPosition,
    price: number,
    status: 'closed_stop' | 'closed_expired',
    exitLabel: 'oversold_hold_expired' | 'oversold_stop_catastrophe',
    rationale: string,
    allowManualControlled = false,
  ): Promise<void> {
    await this.lisa.getPaperBroker().closePosition({
      positionId: pos.id,
      reason: status,
      livePrice: String(price),
      rationale: `[${exitLabel}] ${rationale}`,
      livePriceSource: 'eodhd_eod',
      // Marché US fermé hors session : le close EOD est le last close valide.
      marketClosed: true,
      // #2 (30/06) — la deadline J+10 ferme MÊME une position en MANU (cf. bloc A).
      allowManualControlled,
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
    // Filtre sur le JSONB venue_fee_detail->>source, car le broker n'écrit pas
    // la colonne `source` (CHECK lisa/mechanical). Inclut le scanner intraday
    // (`scanner_oversold_intraday`) : ces positions ont aussi besoin du J+10 +
    // stop catastrophe, sinon elles seraient orphelines de toute gestion d'exit.
    const { data, error } = await this.supabase
      .getClient()
      .from('lisa_positions')
      .select('id, portfolio_id, symbol, entry_price, entry_timestamp, manual_control, manual_control_since')
      .in('venue_fee_detail->>source', ['scanner_oversold', 'scanner_oversold_intraday'])
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
