import { Injectable, Logger } from '@nestjs/common';
import Decimal from 'decimal.js';
import { SupabaseService } from '../supabase/supabase.service';
import { ValuationService } from '../valuation/valuation.service';

Decimal.set({ precision: 28, rounding: Decimal.ROUND_HALF_EVEN });

export type AlertRuleKind =
  | 'allocation_drift_persistent'
  | 'threshold_breach'
  | 'asset_large_move'
  | 'drawdown_exceeded'
  | 'concentration_excessive'
  | 'quote_stale'
  | 'import_anomaly';

export type AlertSeverity = 'info' | 'warning' | 'critical';

export interface AlertRule {
  id: string;
  portfolioId: string;
  ruleKind: AlertRuleKind;
  severity: AlertSeverity;
  enabled: boolean;
  params: Record<string, unknown>;
  cooldownSeconds: number;
}

export interface PersistedAlert {
  ruleId: string | null;
  ruleKind: AlertRuleKind;
  severity: AlertSeverity;
  title: string;
  description: string;
  affectedTicker: string | null;
  value: string | null;
  threshold: string | null;
  context: Record<string, unknown> | null;
}

const QUOTE_STALE_MS = 24 * 60 * 60 * 1000; // 24h
const DEFAULTS: Record<AlertRuleKind, { severity: AlertSeverity; params: Record<string, unknown> }> = {
  allocation_drift_persistent: { severity: 'info',     params: { driftThresholdPct: 15, daysPersistent: 7 } },
  threshold_breach:            { severity: 'warning',  params: { minValue: null, maxValue: null } },
  asset_large_move:            { severity: 'warning',  params: { moveThresholdPct: 5 } },
  drawdown_exceeded:           { severity: 'critical', params: { drawdownThresholdPct: 15 } },
  concentration_excessive:     { severity: 'warning',  params: { concentrationThresholdPct: 35 } },
  quote_stale:                 { severity: 'warning',  params: { staleHours: 24 } },
  import_anomaly:              { severity: 'warning',  params: {} },
};

@Injectable()
export class AlertRulesService {
  private readonly logger = new Logger(AlertRulesService.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly valuation: ValuationService,
  ) {}

  async listRules(portfolioId: string): Promise<AlertRule[]> {
    if (!this.supabase.isReady()) return [];
    const { data } = await this.supabase
      .getClient()
      .from('alert_rules')
      .select('*')
      .eq('portfolio_id', portfolioId);
    return (data ?? []).map((r) => this.toRule(r));
  }

  async upsertRule(rule: {
    id?: string;
    userId: string;
    portfolioId: string;
    ruleKind: AlertRuleKind;
    severity?: AlertSeverity;
    enabled?: boolean;
    params?: Record<string, unknown>;
    cooldownSeconds?: number;
  }): Promise<AlertRule | null> {
    if (!this.supabase.isReady()) return null;

    const defaults = DEFAULTS[rule.ruleKind];
    const payload: Record<string, unknown> = {
      portfolio_id: rule.portfolioId,
      user_id: rule.userId,
      rule_kind: rule.ruleKind,
      severity: rule.severity ?? defaults.severity,
      enabled: rule.enabled ?? true,
      params: rule.params ?? defaults.params,
      cooldown_seconds: rule.cooldownSeconds ?? 3600,
      updated_at: new Date().toISOString(),
    };
    if (rule.id) payload['id'] = rule.id;

    const { data } = await this.supabase
      .getClient()
      .from('alert_rules')
      .upsert(payload)
      .select()
      .single();
    return data ? this.toRule(data) : null;
  }

  async deleteRule(userId: string, ruleId: string): Promise<boolean> {
    if (!this.supabase.isReady()) return false;
    const { error } = await this.supabase
      .getClient()
      .from('alert_rules')
      .delete()
      .eq('id', ruleId)
      .eq('user_id', userId);
    return !error;
  }

  /** Evaluate all rules for a portfolio and persist any new firings. */
  async evaluate(portfolioId: string): Promise<PersistedAlert[]> {
    const rules = await this.listRules(portfolioId);
    const val = await this.valuation.getPortfolioValuation(portfolioId);
    const fired: PersistedAlert[] = [];

    for (const rule of rules) {
      if (!rule.enabled) continue;
      const alerts = this.evaluateRule(rule, val);
      fired.push(...alerts);
    }

    // Always-on built-in checks (no rule row needed)
    fired.push(...this.builtInQuoteStale(val));
    fired.push(...this.builtInConcentration(val));

    await this.persistAlerts(portfolioId, fired);
    return fired;
  }

  private evaluateRule(rule: AlertRule, val: Awaited<ReturnType<ValuationService['getPortfolioValuation']>>): PersistedAlert[] {
    const out: PersistedAlert[] = [];
    const totalValue = new Decimal(val.totalMarketValue);

    switch (rule.ruleKind) {
      case 'drawdown_exceeded': {
        const threshold = Number(rule.params['drawdownThresholdPct'] ?? 15);
        const pnl = new Decimal(val.pnlPercent);
        if (pnl.lt(-threshold)) {
          out.push({
            ruleId: rule.id,
            ruleKind: 'drawdown_exceeded',
            severity: rule.severity,
            title: `Drawdown portefeuille ${pnl.toFixed(2)}%`,
            description: `Le portefeuille est en baisse de ${pnl.abs().toFixed(2)}%, au-dessus du seuil ${threshold}%.`,
            affectedTicker: null,
            value: pnl.toFixed(2),
            threshold: String(threshold),
            context: null,
          });
        }
        break;
      }
      case 'asset_large_move': {
        const threshold = Number(rule.params['moveThresholdPct'] ?? 5);
        for (const pos of val.positions) {
          if (!pos.changePercent) continue;
          const change = new Decimal(pos.changePercent);
          if (change.abs().gt(threshold)) {
            out.push({
              ruleId: rule.id,
              ruleKind: 'asset_large_move',
              severity: rule.severity,
              title: `Mouvement ${pos.ticker} ${change.toFixed(2)}%`,
              description: `${pos.ticker} a varié de ${change.toFixed(2)}% aujourd'hui.`,
              affectedTicker: pos.ticker,
              value: change.toFixed(2),
              threshold: String(threshold),
              context: null,
            });
          }
        }
        break;
      }
      case 'concentration_excessive': {
        const threshold = Number(rule.params['concentrationThresholdPct'] ?? 35);
        for (const pos of val.positions) {
          if (totalValue.isZero()) continue;
          const weight = new Decimal(pos.marketValue).div(totalValue).mul(100);
          if (weight.gt(threshold)) {
            out.push({
              ruleId: rule.id,
              ruleKind: 'concentration_excessive',
              severity: rule.severity,
              title: `Concentration ${pos.ticker} ${weight.toFixed(1)}%`,
              description: `${pos.ticker} représente ${weight.toFixed(1)}% du portefeuille (seuil ${threshold}%).`,
              affectedTicker: pos.ticker,
              value: weight.toFixed(2),
              threshold: String(threshold),
              context: null,
            });
          }
        }
        break;
      }
      case 'threshold_breach': {
        const minV = rule.params['minValue'];
        const maxV = rule.params['maxValue'];
        const portfolioValue = totalValue.toNumber();
        if (typeof minV === 'number' && portfolioValue < minV) {
          out.push({
            ruleId: rule.id,
            ruleKind: 'threshold_breach',
            severity: rule.severity,
            title: `Valeur portefeuille sous seuil`,
            description: `Valeur actuelle ${portfolioValue.toFixed(2)} ${val.currency} sous le seuil minimum ${minV}.`,
            affectedTicker: null,
            value: portfolioValue.toFixed(2),
            threshold: String(minV),
            context: null,
          });
        }
        if (typeof maxV === 'number' && portfolioValue > maxV) {
          out.push({
            ruleId: rule.id,
            ruleKind: 'threshold_breach',
            severity: rule.severity,
            title: `Valeur portefeuille au-dessus du seuil`,
            description: `Valeur actuelle ${portfolioValue.toFixed(2)} ${val.currency} au-dessus du seuil maximum ${maxV}.`,
            affectedTicker: null,
            value: portfolioValue.toFixed(2),
            threshold: String(maxV),
            context: null,
          });
        }
        break;
      }
      default:
        break;
    }
    return out;
  }

  private builtInQuoteStale(val: Awaited<ReturnType<ValuationService['getPortfolioValuation']>>): PersistedAlert[] {
    const out: PersistedAlert[] = [];
    const now = Date.now();
    for (const pos of val.positions) {
      if (!pos.currentPrice) {
        out.push({
          ruleId: null,
          ruleKind: 'quote_stale',
          severity: 'warning',
          title: `Cours manquant — ${pos.ticker}`,
          description: `Aucune cotation disponible pour ${pos.ticker}. Valorisation estimée au coût d'achat.`,
          affectedTicker: pos.ticker,
          value: null,
          threshold: null,
          context: null,
        });
      } else if (pos.priceAsOf && now - new Date(pos.priceAsOf).getTime() > QUOTE_STALE_MS) {
        out.push({
          ruleId: null,
          ruleKind: 'quote_stale',
          severity: 'info',
          title: `Cours ancien — ${pos.ticker}`,
          description: `Dernière cotation datée du ${new Date(pos.priceAsOf).toLocaleDateString('fr-FR')}.`,
          affectedTicker: pos.ticker,
          value: pos.priceAsOf,
          threshold: '24h',
          context: null,
        });
      }
    }
    return out;
  }

  private builtInConcentration(val: Awaited<ReturnType<ValuationService['getPortfolioValuation']>>): PersistedAlert[] {
    const out: PersistedAlert[] = [];
    const total = new Decimal(val.totalMarketValue);
    if (total.isZero()) return out;

    // Aggregate crypto exposure
    const cryptoValue = val.positions
      .filter((p) => p.assetClass === 'crypto')
      .reduce((s, p) => s.plus(new Decimal(p.marketValue)), new Decimal(0));
    if (cryptoValue.div(total).gt(0.2)) {
      out.push({
        ruleId: null,
        ruleKind: 'concentration_excessive',
        severity: 'warning',
        title: 'Surexposition crypto',
        description: `Crypto = ${cryptoValue.div(total).mul(100).toFixed(1)}% du portefeuille.`,
        affectedTicker: null,
        value: cryptoValue.div(total).mul(100).toFixed(1),
        threshold: '20',
        context: { class: 'crypto' },
      });
    }
    return out;
  }

  private async persistAlerts(portfolioId: string, alerts: PersistedAlert[]) {
    if (!this.supabase.isReady() || alerts.length === 0) return;
    const client = this.supabase.getClient();

    const { data: portfolio } = await client.from('portfolios').select('user_id').eq('id', portfolioId).single();
    if (!portfolio) return;

    // Cooldown: skip persisting if same (ruleKind, ticker) fired within last hour
    const cooldownSince = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const { data: recent } = await client
      .from('alerts')
      .select('rule_kind, affected_ticker')
      .eq('portfolio_id', portfolioId)
      .gte('created_at', cooldownSince);
    const recentKeys = new Set((recent ?? []).map((r) => `${r.rule_kind}|${r.affected_ticker ?? ''}`));

    const toInsert = alerts
      .filter((a) => !recentKeys.has(`${a.ruleKind}|${a.affectedTicker ?? ''}`))
      .map((a) => ({
        portfolio_id: portfolioId,
        user_id: portfolio.user_id,
        rule_id: a.ruleId,
        rule_kind: a.ruleKind,
        severity: a.severity,
        title: a.title,
        description: a.description,
        affected_ticker: a.affectedTicker,
        value: a.value,
        threshold: a.threshold,
        context: a.context,
      }));

    if (toInsert.length > 0) await client.from('alerts').insert(toInsert);
  }

  private toRule(row: Record<string, unknown>): AlertRule {
    return {
      id: row['id'] as string,
      portfolioId: row['portfolio_id'] as string,
      ruleKind: row['rule_kind'] as AlertRuleKind,
      severity: row['severity'] as AlertSeverity,
      enabled: row['enabled'] as boolean,
      params: (row['params'] as Record<string, unknown>) ?? {},
      cooldownSeconds: (row['cooldown_seconds'] as number) ?? 3600,
    };
  }

  async listAlerts(portfolioId: string, opts: { unreadOnly?: boolean } = {}) {
    if (!this.supabase.isReady()) return [];
    let q = this.supabase
      .getClient()
      .from('alerts')
      .select('*')
      .eq('portfolio_id', portfolioId)
      .is('dismissed_at', null)
      .order('created_at', { ascending: false })
      .limit(100);
    if (opts.unreadOnly) q = q.is('read_at', null);
    const { data } = await q;
    return data ?? [];
  }

  async markRead(alertId: string, userId: string) {
    if (!this.supabase.isReady()) return;
    await this.supabase
      .getClient()
      .from('alerts')
      .update({ read_at: new Date().toISOString() })
      .eq('id', alertId)
      .eq('user_id', userId);
  }

  async dismiss(alertId: string, userId: string) {
    if (!this.supabase.isReady()) return;
    await this.supabase
      .getClient()
      .from('alerts')
      .update({ dismissed_at: new Date().toISOString() })
      .eq('id', alertId)
      .eq('user_id', userId);
  }
}
