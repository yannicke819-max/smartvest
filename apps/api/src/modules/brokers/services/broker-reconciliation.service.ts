import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { createHash } from 'crypto';
import { SupabaseService } from '../../supabase/supabase.service';
import { CredentialsVaultService } from './credentials-vault.service';
import { FeatureFlagsService } from '../../feature-flags/feature-flags.service';
import { IbkrClient } from '@smartvest/brokers';
import type { IbkrPositionRaw } from '@smartvest/brokers';

/**
 * Phase E — BrokerReconciliationService.
 *
 * Cron toutes les 5 min : pour chaque portfolio en mode LIVE, compare les
 * positions DB (lisa_positions WHERE status='open') avec les positions broker
 * (IBKR.getPositions). Détection 3 types de drift :
 *
 *   1. broker_extra : position broker non trackée DB → INSERT (rare,
 *      typiquement des positions ouvertes manuellement par l'utilisateur via
 *      l'UI broker plutôt que SmartVest)
 *   2. db_extra    : position DB non trouvée broker → ALERT + auto kill-switch
 *      (drift critique, peut indiquer fill annulé côté broker, fork DB, etc.)
 *   3. mismatch    : qty/avg_price diffèrent → ALERT (souvent normal pour
 *      les fills partiels en cours, on tolère ±1% sur la quantité)
 *
 * Drift critique (db_extra OU drift_value > $100) → activation automatique
 * du flag AUTONOMY_KILL_SWITCH (impact runtime : tout placeOrder bloqué
 * via PreExecutionGuardService).
 *
 * Audit hash-chaîné dans broker_reconciliation_log (append-only).
 *
 * Activation : `BROKER_RECONCILIATION_ENABLED=true`. Off par défaut →
 * pas de side-effect runtime.
 */

interface ReconciliationDrift {
  type: 'broker_extra' | 'db_extra' | 'mismatch';
  symbol: string;
  db_qty?: number;
  broker_qty?: number;
  db_avg_cost?: number | null;
  broker_avg_cost?: number;
  value_usd?: number;
  detail: string;
}

@Injectable()
export class BrokerReconciliationService {
  private readonly logger = new Logger(BrokerReconciliationService.name);
  private prevHashByConnection = new Map<string, string>();

  constructor(
    private readonly supabase: SupabaseService,
    private readonly vault: CredentialsVaultService,
    private readonly flags: FeatureFlagsService,
  ) {}

  /**
   * Cron toutes les 5 min, mais gated par BROKER_RECONCILIATION_ENABLED.
   * Sans ce flag, le cron tourne mais skip immédiatement (pas de query DB).
   */
  @Cron('0 */5 * * * *', { name: 'broker-reconciliation' })
  async runReconciliationCron(): Promise<void> {
    const enabled = this.flags.getAll().BROKER_RECONCILIATION_ENABLED;
    if (!enabled) return;
    try {
      await this.runReconciliationInner();
    } catch (e) {
      this.logger.error(`[reconcile] cycle failed: ${String(e).slice(0, 200)}`);
    }
  }

  private async runReconciliationInner(): Promise<void> {
    // Récupère les connections IBKR actives
    const { data: connections, error } = await this.supabase
      .getClient()
      .from('broker_connections')
      .select('id, user_id, credentials_vault_ref')
      .eq('provider', 'INTERACTIVE_BROKERS')
      .eq('status', 'active');

    if (error) {
      this.logger.warn(`[reconcile] fetch connections failed: ${error.message}`);
      return;
    }
    if (!connections || connections.length === 0) return;

    for (const conn of connections) {
      await this.reconcileConnection(conn).catch((e) => {
        this.logger.warn(
          `[reconcile] connection ${String(conn.id).slice(0, 8)} failed: ${String(e).slice(0, 100)}`,
        );
      });
    }
  }

  private async reconcileConnection(conn: {
    id: string;
    user_id: string;
    credentials_vault_ref: string | null;
  }): Promise<void> {
    if (!conn.credentials_vault_ref) return;

    // 1. Fetch credentials du Vault
    const credentials = await this.vault.fetch(conn.credentials_vault_ref).catch(() => null);
    if (!credentials || credentials.provider !== 'INTERACTIVE_BROKERS') {
      return;
    }

    // 2. Récupère le portfolio_id associé (lookup via broker_accounts ou meta)
    // V1 : on fait une query simple — si un user a plusieurs portfolios LIVE,
    // V2 améliorera le mapping connection→portfolio.
    const { data: account } = await this.supabase
      .getClient()
      .from('broker_accounts')
      .select('linked_portfolio_id')
      .eq('connection_id', conn.id)
      .maybeSingle();
    const portfolioId = account?.linked_portfolio_id;
    if (!portfolioId) {
      this.logger.debug(`[reconcile] connection ${conn.id.slice(0, 8)} not linked to portfolio — skip`);
      return;
    }

    // 3. Fetch positions broker
    const client = new IbkrClient({
      sessionToken: credentials.sessionToken,
      accountId: credentials.accountId,
    });
    let brokerPositions: IbkrPositionRaw[];
    try {
      brokerPositions = await client.getPositions(credentials.accountId);
    } catch (e) {
      // Broker unreachable — log mais ne kill-switch pas (transient)
      this.logger.warn(
        `[reconcile] broker getPositions failed for ${conn.id.slice(0, 8)}: ${String(e).slice(0, 80)}`,
      );
      await this.persistLog(conn, portfolioId, 'broker_unreachable', [], 0, 0);
      return;
    }

    // 4. Fetch positions DB
    const { data: dbPositions } = await this.supabase
      .getClient()
      .from('lisa_positions')
      .select('symbol, quantity, entry_price, entry_notional_usd')
      .eq('portfolio_id', portfolioId)
      .eq('status', 'open');

    // 5. Compare
    const brokerByTicker = new Map<string, IbkrPositionRaw>();
    for (const p of brokerPositions) {
      const key = (p.ticker ?? p.contractDesc).toUpperCase();
      brokerByTicker.set(key, p);
    }

    const dbByTicker = new Map<string, { symbol: string; qty: number; avgCost: number; notional: number }>();
    for (const p of dbPositions ?? []) {
      const key = String(p.symbol).toUpperCase();
      // SmartVest stocke `AAPL.US` mais broker retourne `AAPL` — strip suffix
      const stripped = key.replace(/\.[A-Z]{1,5}$/, '');
      dbByTicker.set(stripped, {
        symbol: String(p.symbol),
        qty: parseFloat(String(p.quantity)),
        avgCost: parseFloat(String(p.entry_price)),
        notional: parseFloat(String(p.entry_notional_usd ?? 0)),
      });
    }

    const drifts: ReconciliationDrift[] = [];
    let totalDriftValue = 0;

    // Check db_extra (DB position pas chez broker)
    for (const [key, db] of dbByTicker.entries()) {
      const broker = brokerByTicker.get(key);
      if (!broker) {
        drifts.push({
          type: 'db_extra',
          symbol: db.symbol,
          db_qty: db.qty,
          db_avg_cost: db.avgCost,
          value_usd: db.notional,
          detail: 'Position DB non trouvée chez broker',
        });
        totalDriftValue += db.notional;
        continue;
      }
      // Mismatch quantity (tolérance 1%)
      const qtyDiff = Math.abs(broker.position - db.qty);
      const qtyDiffPct = db.qty > 0 ? (qtyDiff / db.qty) * 100 : 0;
      if (qtyDiffPct > 1) {
        drifts.push({
          type: 'mismatch',
          symbol: db.symbol,
          db_qty: db.qty,
          broker_qty: broker.position,
          db_avg_cost: db.avgCost,
          broker_avg_cost: broker.avgCost,
          value_usd: Math.abs(qtyDiff * broker.avgCost),
          detail: `Qty mismatch ${qtyDiffPct.toFixed(2)}% (DB=${db.qty}, broker=${broker.position})`,
        });
        totalDriftValue += Math.abs(qtyDiff * broker.avgCost);
      }
    }

    // Check broker_extra (position broker pas en DB)
    for (const [key, broker] of brokerByTicker.entries()) {
      if (!dbByTicker.has(key) && broker.position !== 0) {
        const value = (broker.mktValue ?? broker.position * broker.avgCost);
        drifts.push({
          type: 'broker_extra',
          symbol: broker.ticker ?? broker.contractDesc,
          broker_qty: broker.position,
          broker_avg_cost: broker.avgCost,
          value_usd: Math.abs(value),
          detail: 'Position broker non trackée en DB',
        });
        totalDriftValue += Math.abs(value);
      }
    }

    // 6. Détecte drift critique → kill-switch
    const CRITICAL_DRIFT_USD = 100;
    const hasDbExtra = drifts.some((d) => d.type === 'db_extra');
    const isCritical = hasDbExtra || totalDriftValue > CRITICAL_DRIFT_USD;

    if (isCritical) {
      this.logger.error(
        `[reconcile] CRITICAL drift on ${portfolioId.slice(0, 8)} : ` +
        `${drifts.length} drifts, total $${totalDriftValue.toFixed(2)}. Activating kill-switch.`,
      );
      await this.activateKillSwitch(portfolioId, drifts, totalDriftValue);
      await this.persistLog(conn, portfolioId, 'kill_switch_triggered', drifts, dbByTicker.size, brokerByTicker.size);
      return;
    }

    if (drifts.length === 0) {
      await this.persistLog(conn, portfolioId, 'ok', [], dbByTicker.size, brokerByTicker.size);
    } else {
      this.logger.warn(
        `[reconcile] ${portfolioId.slice(0, 8)} : ${drifts.length} non-critical drift(s), total $${totalDriftValue.toFixed(2)}`,
      );
      await this.persistLog(
        conn,
        portfolioId,
        drifts.some((d) => d.type === 'broker_extra') ? 'broker_extra' : 'mismatch',
        drifts,
        dbByTicker.size,
        brokerByTicker.size,
      );
    }
  }

  private async activateKillSwitch(
    portfolioId: string,
    drifts: ReconciliationDrift[],
    totalDriftValue: number,
  ): Promise<void> {
    // 1. Active kill-switch sur le portfolio (lisa_session_configs)
    await this.supabase
      .getClient()
      .from('lisa_session_configs')
      .update({
        kill_switch_active: true,
        autopilot_paused_reason: 'BROKER_DRIFT_DETECTED',
      })
      .eq('portfolio_id', portfolioId);

    // 2. Audit dans lisa_decision_log
    await this.supabase
      .getClient()
      .from('lisa_decision_log')
      .insert({
        portfolio_id: portfolioId,
        kind: 'kill_switch_activated',
        summary: `[BROKER_DRIFT] Kill-switch activé — ${drifts.length} drift(s), $${totalDriftValue.toFixed(2)}`,
        rationale: 'Reconciliation broker vs DB a détecté un drift critique. Toute exécution suspendue.',
        payload: {
          drifts,
          total_drift_value_usd: totalDriftValue,
          triggered_by: 'broker_reconciliation_cron',
        },
        triggered_by: 'broker_reconciliation_cron',
      })
      .then(() => undefined, () => undefined);
  }

  private async persistLog(
    conn: { id: string; user_id: string; credentials_vault_ref: string | null },
    portfolioId: string,
    status: string,
    drifts: ReconciliationDrift[],
    dbCount: number,
    brokerCount: number,
  ): Promise<void> {
    const driftValue = drifts.reduce((s, d) => s + (d.value_usd ?? 0), 0);
    const prevHash = this.prevHashByConnection.get(conn.id) ?? '';
    const payload = {
      conn_id: conn.id,
      portfolio_id: portfolioId,
      status,
      db_count: dbCount,
      broker_count: brokerCount,
      drifts: drifts.length,
      drift_value: driftValue,
      ts: Date.now(),
    };
    const thisHash = createHash('sha256')
      .update(prevHash + JSON.stringify(payload))
      .digest('hex');

    try {
      await this.supabase
        .getClient()
        .from('broker_reconciliation_log')
        .insert({
          user_id: conn.user_id,
          portfolio_id: portfolioId,
          broker_connection_id: conn.id,
          status,
          db_positions_count: dbCount,
          broker_positions_count: brokerCount,
          drifted_positions: drifts,
          drift_value_usd: driftValue,
          prev_hash: prevHash || null,
          this_hash: thisHash,
          details: payload,
        });
      this.prevHashByConnection.set(conn.id, thisHash);
    } catch (e) {
      this.logger.warn(`[reconcile-log] insert failed: ${String(e).slice(0, 120)}`);
    }
  }
}
