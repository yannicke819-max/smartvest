import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TwelveDataService } from './twelve-data.service';
import { EodhdIntradayService, type CandleSeries } from './eodhd-intraday.service';
import { TickerBlacklistService } from './ticker-blacklist.service';
import { eodhdToTdSymbol, eodhdToCboeEuropeSymbol } from './td-symbol-mapper';
import { SupabaseService } from '../../supabase/supabase.service';

/**
 * PR #352 (original) — Routeur intraday TwelveData-first avec fallback EODHD.
 * PR #353 (cette PR) — Cablage universel + asia mapping + dual-call.
 *
 * Activation :
 *   TWELVEDATA_INTRADAY_SCANNER_ENABLED  bool string  (default false)
 *   TWELVEDATA_INTRADAY_AB_TEST_RATIO    float [0..1] (default 1.0 = 100% TD)
 *
 * Architecture dual-call (PR #353) :
 *   Quand TD est éligible (flag ON + ratio + symbol mappable + pas de
 *   fenêtre historique fromTs/toTs), on appelle EODHD ET TD en parallèle
 *   via Promise.allSettled — pas de fallback séquentiel.
 *
 *   - Préfère TD si retour non vide et valide
 *   - Sinon EODHD comme source de vérité
 *   - EODHD reste TOUJOURS appelé (contrainte user "ZERO offload")
 *   - Log structuré `intraday_router_dual_call` sur chaque appel
 *
 * Branche EODHD-only (pas de TD) si :
 *   - flag OFF / pas de TwelveDataService injecté
 *   - symbol non mappable TD (suffixe inconnu)
 *   - hash % 100 >= ratio*100 (A/B négatif sur ce symbol)
 *   - options.fromTs ou options.toTs présent (TD ne supporte pas time-range
 *     simple dans notre wrapper, historique = EODHD only)
 *
 * Kill-switch instantané :
 *   flyctl secrets set TWELVEDATA_INTRADAY_SCANNER_ENABLED=false --app smartvest
 */

export interface IntradayQuote {
  price: number;
  changePct: number;
  timestamp: number;
  provider: 'td' | 'eodhd';
}

export type IntradayCandleSeries = CandleSeries & { provider: 'td' | 'eodhd' };

export interface IntradayCandlesOptions {
  /** Historical window start (epoch seconds). Si présent → EODHD only. */
  fromTs?: number;
  /** Historical window end (epoch seconds). Si présent → EODHD only. */
  toTs?: number;
  /** Étiquette du caller pour logs Supabase (twelve_data_request_log.called_by). */
  calledBy?: string;
}

@Injectable()
export class IntradayProviderRouter implements OnModuleInit {
  private readonly logger = new Logger(IntradayProviderRouter.name);
  // PR #354 — first-call witness pour confirmer que le router est invoqué.
  // Loggue un événement unique au premier passage dans getCandles/getQuote
  // après le boot. Si jamais loggué post-deploy → cron scanner ne fait pas
  // d'intraday du tout (donc TD inactif par construction).
  private firstCallLogged = false;

  constructor(
    private readonly config: ConfigService,
    private readonly eodhd: EodhdIntradayService,
    // PR #356 — @Optional() retiré sur td : en prod v569 le DI silencieusement
    // injectait null malgré TwelveDataService instancié OK ailleurs (apiKey=set
    // dans logs init). Résultat : 100% des appels router avec
    // td_skip_reason="td_not_injected". Sans @Optional, NestJS crash boot
    // visible si DI échoue → diagnostic immédiat. Tests doivent désormais
    // injecter un mock TwelveDataService explicite (cf. .spec.ts mise à jour).
    private readonly td: TwelveDataService,
    // PR #355 — check blacklist avant TD pour ne pas reporter le gaspillage
    // côté TD (avant : EODHD short-circuit dans this.eodhd.getCandles, mais
    // TD était appelé en parallèle sans aucun check).
    // PR #357 — @Optional() retiré sur blacklist (même bug DI que td en PR #356).
    // Post-deploy v570, /admin/providers-status retournait blacklist_injected=false
    // malgré TickerBlacklistService bien exporté depuis LisaModule. Cause :
    // forwardRef(LisaModule ↔ AdminModule) + @Optional() = NestJS injecte null.
    // Fix identique à PR #356 sur td : suppression @Optional + tests mis à jour
    // pour passer un mock TickerBlacklistService (4 args obligatoires).
    private readonly blacklist: TickerBlacklistService,
    // PR #366 — instrumentation comparative TD vs EODHD. Singleton stable
    // (SupabaseModule importé), insert fire-and-forget non bloquant.
    private readonly supabase: SupabaseService,
  ) {
    const enabled = this.isEnabled();
    const ratio = this.getRatio();
    this.logger.log(
      `[intraday-router] init enabled=${enabled} ratio=${ratio} td=${this.td ? 'available' : 'unavailable'} blacklist=${this.blacklist ? 'available' : 'unavailable'}`,
    );
  }

  /**
   * PR #356 — assertion post-boot. Si td ou blacklist sont null malgré
   * la suppression de @Optional (cas pathologique DI), on log un ERROR
   * explicite plutôt que d'échouer silencieusement.
   */
  onModuleInit(): void {
    if (!this.td) {
      // Ne devrait JAMAIS arriver depuis PR #356 (td required par DI).
      // Si on voit ce log en prod → NestJS DI cassé critique.
      this.logger.error(
        '[intraday-router] FATAL onModuleInit: TwelveDataService not injected. Vérifier LisaModule providers et imports SupabaseModule global.',
      );
    }
    if (!this.blacklist) {
      // PR #357 — @Optional() retiré, ce log ne devrait plus jamais apparaître.
      // Si visible : NestJS DI cassé critique sur TickerBlacklistService.
      this.logger.error(
        '[intraday-router] FATAL onModuleInit: TickerBlacklistService not injected. Vérifier LisaModule exports.',
      );
    }
  }

  private isEnabled(): boolean {
    // PR #356 — guard défensif conservé : td est désormais required par DI,
    // mais on garde un faux-fail si jamais une instance custom contourne le
    // graph DI (ex : test mal isolé qui passerait undefined).
    if (!this.td) return false;
    return (
      (this.config.get<string>('TWELVEDATA_INTRADAY_SCANNER_ENABLED') ?? 'false').toLowerCase() ===
      'true'
    );
  }

  /**
   * PR #356 — état d'injection pour endpoint /admin/providers-status.
   * Permet une vérification post-deploy en 1 curl pour confirmer que le DI
   * a bien câblé TwelveDataService et TickerBlacklistService. À combiner
   * avec apikey_set du TwelveDataService pour diag complet.
   */
  getInjectionStatus(): {
    td_injected: boolean;
    blacklist_injected: boolean;
    enabled: boolean;
    ratio: number;
    flag_raw: string | undefined;
  } {
    return {
      td_injected: !!this.td,
      blacklist_injected: !!this.blacklist,
      enabled: this.isEnabled(),
      ratio: this.getRatio(),
      flag_raw: this.config.get<string>('TWELVEDATA_INTRADAY_SCANNER_ENABLED'),
    };
  }

  private getRatio(): number {
    const raw = this.config.get<string>('TWELVEDATA_INTRADAY_AB_TEST_RATIO') ?? '1.0';
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0 || n > 1) return 1.0;
    return n;
  }

  /**
   * Hash déterministe FNV-1a (32 bits) → stabilité A/B par symbol :
   * un symbol donné est toujours routé sur le même provider tant que le
   * ratio est inchangé.
   */
  shouldRouteToTd(symbol: string): boolean {
    if (!this.isEnabled()) return false;
    const ratio = this.getRatio();
    if (ratio >= 1.0) return true;
    if (ratio <= 0.0) return false;
    let hash = 2166136261;
    for (let i = 0; i < symbol.length; i++) {
      hash ^= symbol.charCodeAt(i);
      hash = (hash * 16777619) >>> 0;
    }
    return hash % 100 < ratio * 100;
  }

  /**
   * PR #354 — Loggue une seule fois le premier passage dans le router
   * post-boot. Si on n'observe jamais ce log → confirme que le cron
   * scanner ne traverse pas le router (ex : pas de cycle, pas de candidat
   * filteredTop, mtfPersistence pas appelée). Différent du log dual_call
   * qui peut être noyé sous la masse — celui-ci sort UNE seule fois.
   */
  private logFirstCallOnce(endpoint: 'quote' | 'time_series', symbol: string, calledBy: string): void {
    if (this.firstCallLogged) return;
    this.firstCallLogged = true;
    this.logger.log(
      `[intraday-router] first_call endpoint=${endpoint} symbol=${symbol} called_by=${calledBy} enabled=${this.isEnabled()} ratio=${this.getRatio()} td=${this.td ? 'available' : 'unavailable'}`,
    );
  }

  /**
   * Calcule la raison pour laquelle TD n'est PAS attempted, pour logs.
   * Retourne null si TD doit être tenté (eligible).
   *
   * PR #354 — observabilité distinguant les 3 causes de `td_attempted: false`
   * pour faciliter le diagnostic prod (ex : confondu avec un bug de mapping).
   */
  private computeTdSkipReason(
    eodhdTicker: string,
    hasTimeWindow: boolean,
  ): 'flag_off' | 'td_not_injected' | 'time_window_present' | 'ab_test_sent_to_eodhd' | 'unsupported_suffix' | 'ticker_blacklisted' | null {
    if (!this.td) return 'td_not_injected';
    if (
      (this.config.get<string>('TWELVEDATA_INTRADAY_SCANNER_ENABLED') ?? 'false').toLowerCase() !==
      'true'
    ) {
      return 'flag_off';
    }
    // PR #355 — éviter de tirer TD sur les tickers déjà skippés EODHD-side
    // pour cause de blacklist (statique ou dynamique R10). Sinon TD répète
    // les calls inutiles que EODHD a évités.
    if (this.blacklist?.isBlacklisted(eodhdTicker)) return 'ticker_blacklisted';
    if (hasTimeWindow) return 'time_window_present';
    if (!this.shouldRouteToTd(eodhdTicker)) return 'ab_test_sent_to_eodhd';
    if (this.convertToTdSymbol(eodhdTicker) === null) return 'unsupported_suffix';
    return null;
  }

  /**
   * Quote temps réel. Caller passe un ticker EODHD-style (ex `AAPL.US`,
   * `005930.KO`). Dual-call EODHD+TD si éligible.
   */
  async getQuote(eodhdTicker: string, calledBy = 'intraday_router'): Promise<IntradayQuote | null> {
    this.logFirstCallOnce('quote', eodhdTicker, calledBy);
    const tdSkipReason = this.computeTdSkipReason(eodhdTicker, false);
    const tdSymbol = tdSkipReason === null ? this.convertToTdSymbol(eodhdTicker) : null;
    const tdEligible = tdSymbol !== null && this.td !== null;

    const eodhdPromise = this.eodhd.getQuote(eodhdTicker);
    const tdPromise = tdEligible
      ? this.td!.getQuote(tdSymbol!, calledBy)
      : Promise.resolve(null);

    const [eodhdResult, tdResult] = await Promise.allSettled([eodhdPromise, tdPromise]);
    const eodhdVal =
      eodhdResult.status === 'fulfilled' && eodhdResult.value !== null ? eodhdResult.value : null;
    const tdVal =
      tdResult.status === 'fulfilled' && tdResult.value !== null ? tdResult.value : null;

    this.logger.log(
      JSON.stringify({
        event: 'intraday_router_dual_call',
        endpoint: 'quote',
        symbol: eodhdTicker,
        td_symbol: tdSymbol,
        td_attempted: tdEligible,
        td_skip_reason: tdSkipReason, // PR #354 — null si attempted, sinon raison
        td_success: tdVal !== null,
        eodhd_success: eodhdVal !== null,
        called_by: calledBy,
      }),
    );

    if (tdVal !== null) return { ...tdVal, provider: 'td' };
    if (eodhdVal !== null) return { ...eodhdVal, provider: 'eodhd' };
    return null;
  }

  /**
   * Candles intraday au format CandleSeries (compat caller scanner).
   *
   * Branches :
   *   - options.fromTs / options.toTs présents → EODHD only (TD wrapper ne
   *     supporte pas le time-range arbitraire)
   *   - Symbol mappable TD + flag ON + ratio positif → dual-call parallèle,
   *     préférer TD si non vide
   *   - Sinon → EODHD only
   *
   * EODHD est TOUJOURS appelé (contrainte user "ZERO offload").
   */
  async getCandles(
    eodhdTicker: string,
    interval: '1m' | '5m' | '1h' = '1m',
    count = 20,
    options: IntradayCandlesOptions = {},
  ): Promise<IntradayCandleSeries | null> {
    const calledBy = options.calledBy ?? 'intraday_router';
    this.logFirstCallOnce('time_series', eodhdTicker, calledBy);
    const hasTimeWindow = options.fromTs != null || options.toTs != null;
    const tdSkipReason = this.computeTdSkipReason(eodhdTicker, hasTimeWindow);
    const tdSymbol = tdSkipReason === null ? this.convertToTdSymbol(eodhdTicker) : null;
    const tdEligible = tdSymbol !== null && this.td !== null;

    const eodhdPromise = this.eodhd.getCandles(
      eodhdTicker,
      interval,
      count,
      hasTimeWindow
        ? {
            ...(options.fromTs != null ? { fromTs: options.fromTs } : {}),
            ...(options.toTs != null ? { toTs: options.toTs } : {}),
          }
        : undefined,
    );
    const tdPromise = tdEligible
      ? this.td!.getCandles(
          tdSymbol!,
          interval === '1m' ? '1min' : interval === '5m' ? '5min' : '1h',
          count,
          calledBy,
        )
      : Promise.resolve(null);

    const [eodhdResult, tdResult] = await Promise.allSettled([eodhdPromise, tdPromise]);
    const eodhdVal =
      eodhdResult.status === 'fulfilled' && eodhdResult.value !== null ? eodhdResult.value : null;
    const tdVal =
      tdResult.status === 'fulfilled' && tdResult.value !== null && tdResult.value.candles.length > 0
        ? tdResult.value
        : null;

    this.logger.log(
      JSON.stringify({
        event: 'intraday_router_dual_call',
        endpoint: 'time_series',
        symbol: eodhdTicker,
        td_symbol: tdSymbol,
        td_attempted: tdEligible,
        td_skip_reason: tdSkipReason, // PR #354 — null si attempted, sinon raison
        td_success: tdVal !== null,
        eodhd_success: eodhdVal !== null,
        interval,
        count,
        time_window: hasTimeWindow,
        called_by: calledBy,
      }),
    );

    // PR #366 — quand les 2 providers réussissent, logge la comparaison
    // close TD vs EODHD (fire-and-forget). Mesure la valeur ajoutée réelle
    // de TD (divergence en bps) vs simple redondance.
    if (tdVal !== null && eodhdVal !== null && eodhdVal.candles.length > 0) {
      void this.recordProviderCompare(
        eodhdTicker,
        tdSymbol,
        interval,
        tdVal,
        eodhdVal,
        calledBy,
      );
    }

    if (tdVal !== null) {
      return {
        ticker: eodhdTicker,
        interval,
        candles: tdVal.candles,
        asOf: tdVal.asOf,
        rawCount: tdVal.candles.length,
        provider: 'td',
      };
    }
    if (eodhdVal !== null) return { ...eodhdVal, provider: 'eodhd' };
    return null;
  }

  /**
   * PR #366 — Enregistre la comparaison close TD vs EODHD (fire-and-forget).
   * Calcule la divergence en bps sur la dernière bougie de chaque série.
   * Visible pour tests.
   */
  async recordProviderCompare(
    symbol: string,
    tdSymbol: string | null,
    interval: string,
    tdSeries: { candles: Array<{ timestamp: number; close: number }> },
    eodhdSeries: { candles: Array<{ timestamp: number; close: number }> },
    calledBy: string,
  ): Promise<void> {
    try {
      const tdLast = tdSeries.candles[tdSeries.candles.length - 1];
      const eodhdLast = eodhdSeries.candles[eodhdSeries.candles.length - 1];
      if (!tdLast || !eodhdLast) return;

      // Fix 21/05 — comparer la dernière bougie de TIMESTAMP COMMUN, pas la
      // dernière de chaque série. Quand un provider est stale (asia/rétention
      // EODHD) ou bucke différemment (5m), les deux "dernières" bougies sont de
      // moments différents → divergence artefacte (jusqu'à 3000 bps, 99% des
      // lignes désalignées dans l'audit). divergence_bps n'est calculé que sur
      // une bougie réellement comparable ; sinon null (ligne conservée pour
      // tracer le taux de désalignement via td_candle_ts ≠ eodhd_candle_ts).
      const eodhdByTs = new Map<number, number>();
      for (const c of eodhdSeries.candles) eodhdByTs.set(c.timestamp, c.close);
      let matchTs: number | null = null;
      let matchTd: number | null = null;
      let matchEodhd: number | null = null;
      for (let i = tdSeries.candles.length - 1; i >= 0; i--) {
        const c = tdSeries.candles[i];
        const e = eodhdByTs.get(c.timestamp);
        if (e !== undefined) {
          matchTs = c.timestamp;
          matchTd = c.close;
          matchEodhd = e;
          break;
        }
      }
      const aligned = matchTs != null;
      const tdClose = aligned ? matchTd! : tdLast.close;
      const eodhdClose = aligned ? matchEodhd! : eodhdLast.close;
      const divergenceBps =
        aligned && eodhdClose > 0 ? ((tdClose - eodhdClose) / eodhdClose) * 10000 : null;
      if (!this.supabase?.isReady?.()) return;
      const { error } = await this.supabase
        .getClient()
        .from('intraday_provider_compare')
        .insert({
          symbol,
          td_symbol: tdSymbol,
          interval,
          td_close: tdClose,
          eodhd_close: eodhdClose,
          divergence_bps: divergenceBps != null ? Number(divergenceBps.toFixed(2)) : null,
          td_candle_ts: aligned ? matchTs : tdLast.timestamp,
          eodhd_candle_ts: aligned ? matchTs : eodhdLast.timestamp,
          td_candle_count: tdSeries.candles.length,
          eodhd_candle_count: eodhdSeries.candles.length,
          called_by: calledBy,
        });
      if (error) {
        this.logger.debug(`[intraday-router] provider-compare insert failed: ${error.message}`);
      }
    } catch (err) {
      this.logger.debug(
        `[intraday-router] provider-compare exception: ${(err as Error).message}`,
      );
    }
  }

  /**
   * Convertit ticker EODHD → symbol TwelveData.
   *
   * Mapping :
   *   - Sans suffixe                  → ticker tel quel (US)
   *   - .US                           → ticker nu (AAPL.US → AAPL)
   *   - .L / .LSE                     → :LSE (London)
   *   - .PA / .AS / .AMS              → :Euronext (Paris / Amsterdam)
   *   - .XETRA / .DE                  → :XETR (Frankfurt)
   *   - .SW                           → :SIX (Swiss)
   *   - .MI                           → :MIL (Milan)
   *   - .TO                           → :TSX (Toronto)
   *
   * PR #353 — extension asia (76% du trafic intraday actuel) :
   *   - .KO  (KOSPI)                  → :KRX (Korea Exchange)
   *   - .KQ  (KOSDAQ)                 → :KRX
   *   - .SHG (Shanghai SSE)           → :SSE
   *   - .SHE (Shenzhen SZSE)          → :SZSE
   *   - .HK  (Hong Kong)              → :HKEX
   *   - .T   (Tokyo)                  → :XTKS
   *   - .AU  (ASX)                    → :XASX
   *
   * Suffixe inconnu → null → fallback EODHD direct (EODHD reste systématique
   * de toute façon en dual-call).
   *
   * Visible pour tests.
   */
  convertToTdSymbol(eodhdTicker: string): string | null {
    // PR #355 — délégué au helper pur `td-symbol-mapper` (centralisé,
    // partagé avec evaluateTwelveDataFilters Supertrend US).
    return eodhdToTdSymbol(eodhdTicker);
  }

  /**
   * Quote live TwelveData pour le déclenchement des stops (consommé par
   * `LisaService.getLivePrice`).
   *
   * Motivation : sur les marchés où EODHD ne couvre pas le live (Corée/Chine —
   * récurrence vérifiée : 163 tickers auto-blacklistés observés 22/05, Samsung
   * 005930.KO inclus), `getLivePrice` tomberait en `fallback_unknown` → le
   * garde-fou fallback skippe tout stop/TP → position ouverte non protégeable.
   * TD fournit une source live réelle pour ces suffixes.
   *
   * Indépendant du flag A/B scanner (`TWELVEDATA_INTRADAY_SCANNER_ENABLED`) :
   * les stops doivent disposer d'une source fiable même si l'A/B intraday est off.
   *
   * Renvoie null si : suffixe hors périmètre, TD non mappable, ou TD échoue →
   * le caller retombe sur sa cascade EODHD/fallback existante. Jamais de prix
   * inventé : null = « pas de source TD », pas « prix 0 ».
   *
   * Périmètre configurable via `LIVE_PRICE_TD_SUFFIXES` (CSV). Default couvre
   * Asie (KO,KQ,SHG,SHE) + EU (LSE,L,PA,AS,AMS,DE,XETRA,SW,MI,TO) + US :
   * l'intraday EODHD est différé ~15min sur tous ces marchés sur le plan
   * All-In-One (mesure 22/05 : divergence prix réelle EU 1.76%, jusqu'à 5.6%
   * sur small-caps ; 26/05 : US tous taggués stale_eodhd age=940s+).
   * TD fournit le vrai real-time (NYSE/Nasdaq inclus plan PRO $229/mo).
   * Suffixe non mappable → null → fallback.
   */
  async getLiveQuote(eodhdTicker: string): Promise<{ price: number; source: 'twelvedata' | 'eodhd'; quoteTsMs: number } | null> {
    if (!eodhdTicker) return null;
    const suffix = eodhdTicker.includes('.') ? eodhdTicker.split('.').pop()!.toUpperCase() : '';
    // PR #468 — US ajouté au default (TD plan PRO inclut NYSE/Nasdaq real-time).
    // L'override env permet de retirer US si on bascule un jour sur EODHD US-PRO.
    const allowed = (this.config.get<string>('LIVE_PRICE_TD_SUFFIXES') ?? 'KO,KQ,SHG,SHE,LSE,L,PA,AS,AMS,DE,XETRA,SW,MI,TO,US')
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter((s) => s.length > 0);
    if (!allowed.includes(suffix)) return null;

    // PR #468 — TD US `/quote` en PRIORITÉ pour suffixe .US (true real-time).
    //
    // Plan TD PRO $229/mo inclut NYSE/Nasdaq real-time (free non-pro
    // self-cert). EODHD All-In-One ne couvre US qu'en délayé 15min côté
    // `/api/real-time` → 940s+ age → stale_eodhd → tous opens US skip.
    //
    // Comportement gracieux : si TD US fail (timeout, quota, symbol non
    // listed), retourne null et on tombe sur la cascade BCXE-puis-dual-source
    // existante ci-dessous (qui pour US tentera `getCandlesTdDirect 5m` = ~5min
    // lag au pire, beaucoup mieux qu'EODHD 15min).
    //
    // Kill-switch : `TWELVEDATA_US_LIVE_ENABLED=false` (default true) — utile
    // si on bascule sur EODHD US-PRO ou si on découvre une regression.
    const enableUsLive = (this.config.get<string>('TWELVEDATA_US_LIVE_ENABLED') ?? 'true').toLowerCase() !== 'false';
    if (enableUsLive && suffix === 'US' && this.td) {
      const tdSymUs = this.convertToTdSymbol(eodhdTicker);
      if (tdSymUs) {
        const tdUs = await this.td.getQuote(tdSymUs, 'live_price_us').catch(() => null);
        if (tdUs && Number.isFinite(tdUs.price) && tdUs.price > 0 && tdUs.timestamp > 0) {
          return { price: tdUs.price, source: 'twelvedata', quoteTsMs: tdUs.timestamp };
        }
      }
    }

    // P19-staleness-v5 — TD Cboe Europe (BCXE) en PRIORITÉ pour EU.
    //
    // BCXE = MTF pan-européen agrégeant LSE/Euronext/XETRA/SIX/BME en TRUE
    // real-time (<1 sec). Activable via add-on TD "Cboe Europe Equities",
    // gratuit en self-cert non-professional. Couvre 3065 stocks EU.
    //
    // Comportement gracieux : tant que l'add-on n'est pas activé, TD répond
    // 404 "You are not authorized to access BCXE data" → td.getQuote()
    // retourne null → on tombe sur le path EODHD existant ci-dessous. Dès que
    // l'add-on est activé côté account TD, ce path commence à renvoyer du
    // real-time sans deploy code.
    //
    // Kill-switch : `TWELVEDATA_BCXE_ENABLED=false` (default true) — utile
    // si TD facture un jour ou si on découvre une regression silencieuse.
    const enableBcxe = (this.config.get<string>('TWELVEDATA_BCXE_ENABLED') ?? 'true').toLowerCase() !== 'false';
    if (enableBcxe && this.td) {
      const bcxe = eodhdToCboeEuropeSymbol(eodhdTicker);
      if (bcxe) {
        const tdBcxe = await this.td
          .getQuote(bcxe.symbol, 'live_price_bcxe', bcxe.mic_code)
          .catch(() => null);
        if (tdBcxe && Number.isFinite(tdBcxe.price) && tdBcxe.price > 0 && tdBcxe.timestamp > 0) {
          return { price: tdBcxe.price, source: 'twelvedata', quoteTsMs: tdBcxe.timestamp };
        }
      }
    }

    // P19-staleness-v4 — dual-source EODHD real-time + TD candle, freshness-wins.
    //
    // Découverte live 26/05/2026 :
    //   - TD `/quote` et `/time_series` LSE/EU sont GELÉS sur Friday 15:29 UTC
    //     malgré plan Pro $229/mo qui inclut "Real-time EU market data".
    //     Toutes les variations symbol (VOD:LSE, VOD avec mic_code=XLON) → idem.
    //   - EODHD `/api/intraday/` aussi stale Friday pour LSE.
    //   - EODHD `/api/real-time/VOD.LSE` retourne timestamp temps réel (12 min
    //     ago, fresh) + change_p du jour. C'EST la vraie source live EU.
    //
    // Fix : on appelle EODHD real-time + TD candle en parallèle. EODHD live
    // gagne presque toujours pour EU/Asia. Le caller (tagStaleness) fait son
    // boulot si les deux sont stale.
    const tdSymbol = this.convertToTdSymbol(eodhdTicker);
    const tdEligible = this.td !== null && tdSymbol !== null;

    const [eodhdRes, tdRes] = await Promise.allSettled([
      this.eodhd.getQuote(eodhdTicker), // /api/real-time — fresh pour EU
      tdEligible ? this.getCandlesTdDirect(eodhdTicker, '5m', 2, 'live_price_dual') : Promise.resolve(null),
    ]);
    const eodhdQuote = eodhdRes.status === 'fulfilled' ? eodhdRes.value : null;
    const tdCandles = tdRes.status === 'fulfilled' ? tdRes.value : null;

    const eodhdTsMs = eodhdQuote ? eodhdQuote.timestamp * 1000 : 0;
    const tdLast = tdCandles?.candles?.length ? tdCandles.candles[tdCandles.candles.length - 1] : null;
    const tdTsMs = tdLast ? tdLast.timestamp * 1000 : 0;

    // Préférer la source au timestamp le plus récent (= la moins stale).
    if (eodhdQuote && eodhdTsMs >= tdTsMs) {
      return { price: eodhdQuote.price, source: 'eodhd', quoteTsMs: eodhdTsMs };
    }
    if (tdLast) {
      return { price: tdLast.close, source: 'twelvedata', quoteTsMs: tdTsMs };
    }
    if (eodhdQuote) {
      return { price: eodhdQuote.price, source: 'eodhd', quoteTsMs: eodhdTsMs };
    }

    // Dernier fallback : TD /quote (souvent stale aussi mais on tente).
    if (this.td && tdSymbol) {
      const q = await this.td.getQuote(tdSymbol, 'live_price').catch(() => null);
      if (q && Number.isFinite(q.price) && q.price > 0) {
        return { price: q.price, source: 'twelvedata', quoteTsMs: q.timestamp };
      }
    }
    return null;
  }

  /**
   * Candles DIRECTEMENT via TwelveData, en contournant la blacklist
   * (EODHD-driven), l'A/B et le flag scanner. Réservé au BACKFILL SHADOW asie :
   * EODHD n'a pas l'intraday coréen/chinois (→ NO_DATA) alors que TD l'a, mais
   * le routeur normal skippe TD sur ces tickers blacklistés (PR #355). Recent-N
   * (pas de range) : le caller filtre la fenêtre côté client. N'affecte PAS le
   * chemin live `getCandles` (méthode séparée). Null si TD indispo / symbole non
   * mappable / échec → le caller retombe sur sa cascade EODHD/Yahoo existante.
   */
  async getCandlesTdDirect(
    eodhdTicker: string,
    interval: '1m' | '5m',
    count: number,
    calledBy = 'shadow_td_direct',
  ): Promise<{ candles: Array<{ timestamp: number; open: number; high: number; low: number; close: number; volume: number }> } | null> {
    if (!this.td || !eodhdTicker) return null;
    const tdSymbol = this.convertToTdSymbol(eodhdTicker);
    if (!tdSymbol) return null;
    const tdInterval = interval === '1m' ? '1min' : '5min';
    const res = await this.td.getCandles(tdSymbol, tdInterval, count, calledBy).catch(() => null);
    if (!res || !res.candles || res.candles.length === 0) return null;
    return { candles: res.candles };
  }
}
