/**
 * GET /admin/config-dump
 *
 * Expose la même chose que ConfigDumpService au boot, mais à la demande HTTP.
 * Permet de voir la valeur courante de tous les secrets Fly sans dépendre
 * des boot logs (qui peuvent rouler hors fenêtre rétention Fly).
 *
 * Auth : header `x-admin-token` doit matcher `ADMIN_TOKEN`.
 *
 * Output JSON :
 *   {
 *     timestamp: "2026-06-03T...",
 *     git_sha: "...",
 *     totals: { set: 42, defaults: 87 },
 *     categories: {
 *       "GAINERS — OVERPUMP": [
 *         { key: "GAINERS_OVERPUMP_THRESHOLD_PCT_ASIA", value: "<not set>", default: "30" },
 *         ...
 *       ],
 *       ...
 *     }
 *   }
 */
import { Controller, Get, Headers, HttpException, HttpStatus } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

interface KnownSecret {
  key: string;
  defaultValue: string | null;
  sensitive?: boolean;
}

// Liste alignée sur ConfigDumpService (single source of truth serait mieux,
// mais à ce stade on garde duplication pour éviter dépendance croisée entre
// admin et lisa modules. Tests garantissent la même curation).
const KNOWN: Record<string, KnownSecret[]> = {
  STRATEGY: [
    { key: 'STRATEGY_MODE', defaultValue: null },
    { key: 'SCAN_INTERVAL_MINUTES', defaultValue: '15' },
    { key: 'NO_CACHE', defaultValue: 'false' },
  ],
  'GAINERS — risque/sizing': [
    { key: 'GAINERS_SL_ATR_MULTIPLIER', defaultValue: null },
    { key: 'GAINERS_SL_ATR_MAX_PCT', defaultValue: null },
    { key: 'GAINERS_MAX_ATR_RATIO_PCT', defaultValue: null },
    { key: 'GAINERS_OPEN_BUFFER_MIN', defaultValue: '0' },
    { key: 'GAINERS_MAX_SIGNAL_AGE_SEC', defaultValue: null },
    { key: 'GAINERS_PREFERRED_TICKERS_SIZE_MULT', defaultValue: null },
  ],
  'GAINERS — caps changePct': [
    { key: 'GAINERS_MAX_CHANGE_PCT_LONG', defaultValue: '0' },
    { key: 'GAINERS_MAX_CHANGE_PCT_LONG_ASIA', defaultValue: null },
    { key: 'GAINERS_MAX_CHANGE_PCT_LONG_EU', defaultValue: null },
    { key: 'GAINERS_MAX_CHANGE_PCT_LONG_US_LARGE', defaultValue: null },
    { key: 'GAINERS_MAX_CHANGE_PCT_LONG_US_SMALL_MID', defaultValue: null },
    { key: 'GAINERS_MAX_CHANGE_PCT_LONG_CRYPTO', defaultValue: null },
  ],
  'GAINERS — OVERPUMP (fix 03/06)': [
    { key: 'GAINERS_OVERPUMP_THRESHOLD_PCT', defaultValue: '0 (kill switch)' },
    { key: 'GAINERS_OVERPUMP_THRESHOLD_PCT_ASIA', defaultValue: '30' },
    { key: 'GAINERS_OVERPUMP_THRESHOLD_PCT_EU', defaultValue: '15' },
    { key: 'GAINERS_OVERPUMP_THRESHOLD_PCT_US_LARGE', defaultValue: '15' },
    { key: 'GAINERS_OVERPUMP_THRESHOLD_PCT_US_SMALL_MID', defaultValue: '15' },
    { key: 'GAINERS_OVERPUMP_THRESHOLD_PCT_CRYPTO', defaultValue: '30' },
  ],
  'GAINERS — dead zones': [
    { key: 'GAINERS_DEAD_ZONES_PCT', defaultValue: '15-20' },
    { key: 'GAINERS_DEAD_ZONES_PCT_ASIA_EQUITY', defaultValue: null },
    { key: 'GAINERS_DEAD_ZONES_PCT_EU_EQUITY', defaultValue: null },
    { key: 'GAINERS_DEAD_ZONES_PCT_US_EQUITY_LARGE', defaultValue: null },
    { key: 'GAINERS_DEAD_ZONES_PCT_US_EQUITY_SMALL_MID', defaultValue: null },
    { key: 'GAINERS_DEAD_ZONES_PCT_CRYPTO_MAJOR', defaultValue: null },
  ],
  'GAINERS — path efficiency': [
    { key: 'GAINERS_MIN_PATH_EFFICIENCY_US', defaultValue: null },
    { key: 'GAINERS_MIN_PATH_EFFICIENCY_EU', defaultValue: null },
    { key: 'GAINERS_MIN_PATH_EFFICIENCY_CRYPTO', defaultValue: null },
  ],
  'GAINERS — hour blacklists': [
    { key: 'GAINERS_HOUR_BLACKLIST_US_UTC', defaultValue: null },
    { key: 'GAINERS_HOUR_BLACKLIST_EU_UTC', defaultValue: null },
    { key: 'GAINERS_HOUR_BLACKLIST_ASIA_UTC', defaultValue: null },
    { key: 'GAINERS_HOUR_BLACKLIST_CRYPTO_UTC', defaultValue: null },
    { key: 'GAINERS_LONG_HOUR_BLACKLIST_UTC', defaultValue: null },
    { key: 'GAINERS_HOUR_GATE_PER_CLASS_OVERRIDES_GLOBAL', defaultValue: 'false' },
  ],
  'GAINERS — news & catalyseur': [
    { key: 'GAINERS_NEWS_AGE_FILTER_HOURS', defaultValue: null },
    { key: 'GAINERS_NEWS_AGE_FILTER_MIN_SENTIMENT', defaultValue: null },
    { key: 'GAINERS_CONSUME_DAILY_BRIEF', defaultValue: 'false' },
    { key: 'GAINERS_EARNINGS_FILTER_DAYS', defaultValue: null },
  ],
  'GAINERS — features & flags': [
    { key: 'GAINERS_HIGH_GRADING_ENABLED', defaultValue: 'false' },
    { key: 'GAINERS_CAPITAL_ROTATION_ENABLED', defaultValue: 'false' },
    { key: 'GAINERS_LEVERAGED_PROXIES_ENABLED', defaultValue: 'false' },
    { key: 'GAINERS_MACRO_VETO_ENABLED', defaultValue: 'false' },
    { key: 'GAINERS_TRAILING_TP_ENABLED', defaultValue: 'false' },
    { key: 'GAINERS_TRAILING_STOP_BREAKEVEN_ENABLED', defaultValue: 'false' },
    { key: 'GAINERS_TRAILING_STOP_ACTIVATION_PCT', defaultValue: null },
    { key: 'GAINERS_TRAILING_STOP_LOCK_PCT', defaultValue: null },
    { key: 'GAINERS_V1_SHADOW', defaultValue: 'false' },
    { key: 'GAINERS_VENUE_BLACKLIST', defaultValue: null },
    { key: 'GAINERS_LIQUIDITY_FAIL_CLOSED', defaultValue: 'false' },
    { key: 'GAINERS_CROSS_PORTFOLIO_SL_COOLDOWN_MIN', defaultValue: null },
  ],
  SCANNER: [
    { key: 'SCANNER_AB_SHADOW_ENABLED', defaultValue: 'false' },
    { key: 'SCANNER_COMPOSITE_RANKING_ENABLED', defaultValue: 'false' },
    { key: 'SCANNER_LLM_ROUTER_ENABLED', defaultValue: 'false' },
    { key: 'SCANNER_MISTRAL_FALLBACK_USE_FAST', defaultValue: 'false' },
    { key: 'SCANNER_MOMENTUM_ANALYSIS_ENABLED', defaultValue: 'false' },
    { key: 'SCANNER_MOMENTUM_TOP_N', defaultValue: null },
    { key: 'SCANNER_SCREENER_PAGE_SIZE', defaultValue: null },
    { key: 'SCANNER_SESSION_AWARE', defaultValue: 'false' },
    { key: 'SCANNER_UNIVERSE_MAX_TICKERS', defaultValue: null },
  ],
  TRADER: [
    { key: 'TRADER_ARBITRATION_ENABLED', defaultValue: 'false' },
    { key: 'TRADER_OVERPUMP_THRESHOLD_PCT', defaultValue: null },
    { key: 'TRADER_US_OPENING_BLOCK_ENABLED', defaultValue: 'false' },
    { key: 'LIVE_TRADER_AGENT_ENABLED', defaultValue: 'false' },
  ],
  'RISK MONITOR': [
    { key: 'RISK_MONITOR_ENABLED', defaultValue: 'false' },
    { key: 'RISK_MONITOR_ENABLED_US', defaultValue: 'false' },
    { key: 'RISK_MONITOR_ENABLED_EU', defaultValue: 'false' },
    { key: 'RISK_MONITOR_ENABLED_ASIA', defaultValue: 'false' },
    { key: 'RISK_MONITOR_ENABLED_CRYPTO', defaultValue: 'false' },
    { key: 'RISK_MONITOR_GEMINI_ENABLED', defaultValue: 'false' },
    { key: 'RISK_MONITOR_MODE', defaultValue: null },
    { key: 'GEMINI_RISK_MANAGER_ENABLED', defaultValue: 'false' },
    { key: 'GEMINI_RISK_MANAGER_USE_GROUNDING', defaultValue: 'false' },
    { key: 'GEMINI_RISK_MANAGER_USE_MACRO_NEWS', defaultValue: 'false' },
  ],
  LLM: [
    { key: 'LLM_PRIMARY_PROVIDER', defaultValue: null },
    { key: 'LLM_ROUTER_ENABLED', defaultValue: 'false' },
    { key: 'LLM_ROUTER_DAILY_BUDGET_USD', defaultValue: null },
    { key: 'LLM_ROUTER_FALLBACK_ON_BUDGET', defaultValue: 'false' },
    { key: 'CLAUDE_MODEL_OPUS', defaultValue: null },
  ],
  MISTRAL: [
    { key: 'MISTRAL_SHADOW_ENABLED', defaultValue: 'false' },
    { key: 'MISTRAL_LARGE_SHADOW_ENABLED', defaultValue: 'false' },
    { key: 'MISTRAL_SHADOW_MODEL', defaultValue: null },
    { key: 'MISTRAL_FREE_TIER', defaultValue: 'true' },
    { key: 'MISTRAL_MIN_INTERVAL_MS', defaultValue: '2500' },
    { key: 'MISTRAL_MAX_QUEUE_WAIT_MS', defaultValue: '15000' },
  ],
  'SIZING A/B': [
    { key: 'SIZING_AB_TEST_ENABLED', defaultValue: 'false' },
    { key: 'SIZING_AB_BUCKET_A_NOTIONAL', defaultValue: null },
    { key: 'SIZING_AB_BUCKET_A_MAX_POS', defaultValue: null },
    { key: 'SIZING_AB_BUCKET_B_NOTIONAL', defaultValue: null },
    { key: 'SIZING_AB_BUCKET_B_MAX_POS', defaultValue: null },
  ],
  'FEATURES — Tier 1+2': [
    { key: 'EARLY_EXIT_GUARD_ENABLED', defaultValue: 'false' },
    { key: 'MICRO_MOMENTUM_ENABLED', defaultValue: 'false' },
    { key: 'MICRO_MOMENTUM_GATE_ENABLED', defaultValue: 'false' },
    { key: 'REVERSE_MOMENTUM_MODE', defaultValue: 'false' },
    { key: 'ADAPTIVE_COOLDOWN_ENABLED', defaultValue: 'false' },
    { key: 'CORRELATION_GUARD_ENABLED', defaultValue: 'false' },
    { key: 'CONVICTION_SIZING_ENABLED', defaultValue: 'false' },
    { key: 'CONVICTION_SIZING_MULT_HIGH', defaultValue: null },
    { key: 'CONVICTION_SIZING_MULT_LOW', defaultValue: null },
    { key: 'CONVICTION_SIZING_SKIP_IF_NEGATIVE', defaultValue: 'false' },
    { key: 'CONTINUOUS_SCORING_ENABLED', defaultValue: 'false' },
    { key: 'STAGFLATION_HEDGE_GUARD_ENABLED', defaultValue: 'false' },
    { key: 'CRYPTO_FUNDING_FADE_ENABLED', defaultValue: 'false' },
    { key: 'FEATURE_AB_TUNING_ENABLED', defaultValue: 'false' },
    { key: 'DEBATE_GATE_ENABLED', defaultValue: 'false' },
    { key: 'DAILY_RETROSPECTIVE_ENABLED', defaultValue: 'false' },
    { key: 'HOURLY_EDGE_ANALYZER_ENABLED', defaultValue: 'false' },
    { key: 'EVENT_ENGINE_ENABLED', defaultValue: 'false' },
    { key: 'EVENT_NARRATIVE_INTERPRETER_ENABLED', defaultValue: 'false' },
    { key: 'SYMBOL_ATR_CACHE_REFRESH_ENABLED', defaultValue: 'false' },
    { key: 'SHADOW_SIZING_GEMINI_ENABLED', defaultValue: 'false' },
    { key: 'SHADOW_SIZING_ORCHESTRATOR_ENABLED', defaultValue: 'false' },
    { key: 'MAIN_SCANNER_POSTMORTEM_ENABLED', defaultValue: 'false' },
    { key: 'MARKET_CLOSE_REPORTS_ENABLED', defaultValue: 'false' },
    { key: 'MARKET_CLOSE_REPORTS_NARRATIVE', defaultValue: 'false' },
  ],
  'QUICK WINS': [
    { key: 'QUICK_WINS_PIPELINE_ENABLED', defaultValue: 'false' },
    { key: 'QUICK_WINS_TWELVEDATA_RSI_CRYPTO', defaultValue: 'false' },
    { key: 'QUICK_WINS_TWELVEDATA_SUPERTREND_US_LARGE', defaultValue: 'false' },
    { key: 'QW_7_COOLDOWN_MIN', defaultValue: null },
    { key: 'QW_8_MULTIPLIER', defaultValue: null },
  ],
  TWELVEDATA: [
    { key: 'TWELVEDATA_PRO_ENABLED', defaultValue: 'false' },
    { key: 'TWELVEDATA_AB_TEST_ENABLED', defaultValue: 'false' },
    { key: 'TWELVEDATA_SCANNER_ENABLED', defaultValue: 'false' },
    { key: 'TWELVEDATA_INTRADAY_SCANNER_ENABLED', defaultValue: 'false' },
    { key: 'TWELVEDATA_INTRADAY_AB_RATIO', defaultValue: null },
    { key: 'TWELVEDATA_INTRADAY_AB_TEST_RATIO', defaultValue: null },
    { key: 'TWELVEDATA_FILTER_CRYPTO_RSI_ENABLED', defaultValue: 'false' },
    { key: 'TWELVEDATA_FILTER_US_SUPERTREND_ENABLED', defaultValue: 'false' },
    { key: 'TWELVEDATA_FILTER_US_SUPERTREND_SHADOW', defaultValue: 'false' },
    { key: 'TWELVEDATA_FILTER_EU_SUPERTREND_ENABLED', defaultValue: 'false' },
    { key: 'TWELVEDATA_FILTER_EU_SUPERTREND_SHADOW', defaultValue: 'false' },
    { key: 'TWELVEDATA_FILTER_ASIA_SUPERTREND_ENABLED', defaultValue: 'false' },
    { key: 'TWELVEDATA_GAINERS_HK_ENABLED', defaultValue: 'false' },
    { key: 'TWELVEDATA_GAINERS_TOKYO_ENABLED', defaultValue: 'false' },
  ],
  EODHD: [
    { key: 'EODHD_AUTO_THROTTLE_DISABLED', defaultValue: 'false' },
    { key: 'EODHD_ECONOMIC_EVENTS_ENABLED', defaultValue: 'false' },
    { key: 'EODHD_NEWS_PERSIST_ENABLED', defaultValue: 'false' },
    { key: 'GEMINI_DAILY_BRIEF_ENABLED', defaultValue: 'false' },
  ],
  MISC: [
    { key: 'BINANCE_EXECUTION_ENABLED', defaultValue: 'false' },
    { key: 'BINANCE_WS_HEALTH_LOG_ENABLED', defaultValue: 'false' },
    { key: 'CRYPTO_SIMULATOR_ENABLED', defaultValue: 'false' },
    { key: 'MARKET_SNAPSHOT_CRYPTO_VIA_LIVE_PRICE', defaultValue: 'false' },
    { key: 'MARKET_SNAPSHOT_WEEKEND_SKIP_ENABLED', defaultValue: 'false' },
    { key: 'ENABLE_REACTIVE_EXITS', defaultValue: 'false' },
    { key: 'RUN_BACKFILL_POST_SL_ON_BOOT', defaultValue: 'false' },
  ],
};

const SENSITIVE_PATTERNS = [
  /_API_KEY$/i, /_SECRET_KEY$/i, /_SECRET$/i,
  /_TOKEN$/i, /TOKEN$/i, /_PASSWORD$/i, /PASSWORD$/i,
  /UNLOCK_CODE/i, /SERVICE_ROLE/i, /ANON_KEY/i,
];

function isSensitive(key: string): boolean {
  return SENSITIVE_PATTERNS.some((re) => re.test(key));
}

@Controller('admin/config-dump')
export class AdminConfigDumpController {
  constructor(private readonly config: ConfigService) {}

  @Get()
  getConfigDump(@Headers('x-admin-token') providedToken: string | undefined) {
    this.assertAdmin(providedToken);

    const categories: Record<string, Array<{ key: string; value: string; default: string | null; is_set: boolean }>> = {};
    let totalSet = 0;
    let totalDefault = 0;

    for (const [category, secrets] of Object.entries(KNOWN)) {
      categories[category] = [];
      for (const s of secrets) {
        const raw = this.config.get<string>(s.key);
        const isSet = raw != null && String(raw).trim() !== '';
        const sensitive = s.sensitive ?? isSensitive(s.key);
        let displayValue: string;
        if (isSet) {
          totalSet++;
          displayValue = sensitive ? '<set, REDACTED>' : String(raw);
        } else {
          totalDefault++;
          displayValue = '<not set>';
        }
        categories[category].push({
          key: s.key,
          value: displayValue,
          default: s.defaultValue,
          is_set: isSet,
        });
      }
    }

    return {
      timestamp: new Date().toISOString(),
      git_sha: process.env.GIT_SHA ?? null,
      totals: { set: totalSet, defaults: totalDefault },
      categories,
    };
  }

  private assertAdmin(providedToken: string | undefined): void {
    const expected = this.config.get<string>('ADMIN_TOKEN');
    if (!expected || expected.length === 0) {
      throw new HttpException(
        { message: 'Endpoint disabled (ADMIN_TOKEN not configured)', code: 'ADMIN_DISABLED' },
        HttpStatus.FORBIDDEN,
      );
    }
    if (providedToken !== expected) {
      throw new HttpException(
        { message: 'Invalid admin token', code: 'ADMIN_FORBIDDEN' },
        HttpStatus.FORBIDDEN,
      );
    }
  }
}
