import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TwelveDataService } from './twelve-data.service';
import { EodhdIntradayService, type CandleSeries } from './eodhd-intraday.service';
import { TickerBlacklistService } from './ticker-blacklist.service';
import { eodhdToTdSymbol } from './td-symbol-mapper';

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
    // PR #356 — @Optional() conservé sur blacklist pour back-compat tests
    // existants (23 .spec.ts qui n'injectent pas le 4e arg). Si null en prod,
    // simplement perte d'optim blacklist pre-TD, pas de bug critique sur TD.
    @Optional() private readonly blacklist: TickerBlacklistService | null = null,
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
      // Warning seulement : @Optional() conservé pour tests, perte d'optim
      // mais pas de bug fonctionnel TD.
      this.logger.warn(
        '[intraday-router] onModuleInit: TickerBlacklistService not injected (loss of pre-TD blacklist optim, non-critique).',
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
}
