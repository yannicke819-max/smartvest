/**
 * BinanceAdapter — Spot trading via Binance REST API v3.
 *
 * Authentication: HMAC-SHA256 signed requests.
 * Scope: spot account only — no margin, no futures, no leverage.
 *
 * Guard chain (MUST all be true before placeOrder executes a real order):
 *   BROKER_EXECUTION_ENABLED=true
 *   BROKER_ADAPTER_BINANCE_ENABLED=true
 *   DELEGATION_AUTONOMOUS_GUARDED=true
 *   AutonomyMandate active
 *
 * This adapter receives `executionEnabled` at construction time — the caller
 * (LisaService / BrokerSyncService) is responsible for verifying the chain
 * before constructing with executionEnabled=true.
 */

import { createHmac } from 'node:crypto';
import type {
  BrokerCapabilities,
  BrokerCredentials,
  BrokerProvider,
  SyncedCashBalance,
  SyncedPosition,
  SyncedTransaction,
} from '@smartvest/domain';
import type {
  IBrokerAdapter,
  PlaceOrderDraft,
  PlaceOrderResult,
  TestConnectionResult,
} from './broker-adapter.interface';
import { NotSupportedError } from './broker-adapter.interface';

const BASE_URL = 'https://api.binance.com';

interface BinanceCreds {
  apiKey: string;
  secretKey: string;
}

interface BinanceBalance {
  asset: string;
  free: string;
  locked: string;
}

interface BinanceAccountInfo {
  balances: BinanceBalance[];
  accountType: string;
  canTrade: boolean;
  canWithdraw: boolean;
  canDeposit: boolean;
}

interface BinanceOrderResult {
  orderId?: number;
  clientOrderId?: string;
  status?: string;
  code?: number;
  msg?: string;
}

export class BinanceAdapter implements IBrokerAdapter {
  readonly provider: BrokerProvider = 'BINANCE';
  readonly capabilities: BrokerCapabilities = {
    supportsRead: true,
    supportsExecution: true,
    supportsStreaming: false,
    supportsOptions: false,
    supportsCrypto: true,
    supportsCsvImport: true,
  };

  private creds: BinanceCreds | null = null;

  constructor(private readonly executionEnabled: boolean) {}

  async connect(credentials: BrokerCredentials): Promise<void> {
    if (credentials.provider !== 'BINANCE') {
      throw new Error(`BinanceAdapter: wrong provider ${credentials.provider}`);
    }
    const c = credentials as Extract<BrokerCredentials, { provider: 'BINANCE' }>;
    if (!('apiKey' in c)) {
      throw new NotSupportedError('Binance: real API key required (not csv-import placeholder)');
    }
    this.creds = { apiKey: (c as { apiKey: string; secretKey: string }).apiKey, secretKey: (c as { apiKey: string; secretKey: string }).secretKey };
  }

  async disconnect(): Promise<void> {
    this.creds = null;
  }

  async testConnection(): Promise<TestConnectionResult> {
    const start = Date.now();
    try {
      const data = await this.signedGetJson<BinanceAccountInfo>('/api/v3/account', {});
      const latencyMs = Date.now() - start;
      return {
        ok: true,
        latencyMs,
        message: `Binance account OK — canTrade=${data.canTrade}, type=${data.accountType}`,
      };
    } catch (e) {
      return {
        ok: false,
        latencyMs: Date.now() - start,
        message: String(e),
      };
    }
  }

  async fetchPositions(): Promise<SyncedPosition[]> {
    const data = await this.signedGetJson<BinanceAccountInfo>('/api/v3/account', {});
    return data.balances
      .filter((b) => parseFloat(b.free) > 0 || parseFloat(b.locked) > 0)
      .map((b) => ({
        accountIdExternal: 'spot',
        instrumentRef: b.asset,
        quantity: String(parseFloat(b.free) + parseFloat(b.locked)),
        avgCost: null,
        currency: b.asset,
        meta: { free: b.free, locked: b.locked, source: 'binance_spot' },
      }));
  }

  async fetchCash(): Promise<SyncedCashBalance[]> {
    const data = await this.signedGetJson<BinanceAccountInfo>('/api/v3/account', {});
    // Report stablecoins + fiat-equivalent as "cash"
    const cashAssets = ['USDT', 'USDC', 'BUSD', 'TUSD', 'EUR', 'FDUSD'];
    return data.balances
      .filter(
        (b) =>
          cashAssets.includes(b.asset) &&
          (parseFloat(b.free) > 0 || parseFloat(b.locked) > 0),
      )
      .map((b) => ({
        accountIdExternal: 'spot',
        currency: b.asset === 'EUR' ? 'EUR' : 'USD',
        amount: String(parseFloat(b.free) + parseFloat(b.locked)),
      }));
  }

  /**
   * Binance has no single "all trades" endpoint without a symbol.
   * For MVP, return empty — full implementation requires iterating over symbols.
   */
  async fetchTransactions(_since?: Date): Promise<SyncedTransaction[]> {
    return [];
  }

  /**
   * Place a SPOT order on Binance.
   * Gated by executionEnabled (set at construction time by the caller after
   * verifying the full flag chain: BROKER_EXECUTION_ENABLED + adapter flag +
   * AUTONOMOUS_GUARDED + valid mandate + kill-switch off).
   */
  async placeOrder(draft: PlaceOrderDraft): Promise<PlaceOrderResult> {
    if (!this.executionEnabled) {
      return {
        externalOrderId: null,
        status: 'unsupported',
        message: 'Execution disabled — BROKER_EXECUTION_ENABLED=false or mandate inactive',
      };
    }

    if (!this.creds) {
      throw new Error('BinanceAdapter: call connect() before placeOrder()');
    }

    // Binance symbol format: BTCUSDT (no slash or dash)
    const symbol = draft.instrumentRef.replace(/[/\-]/g, '').toUpperCase();

    const params: Record<string, string> = {
      symbol,
      side: draft.side.toUpperCase(),
      type: draft.orderType === 'market' ? 'MARKET' : 'LIMIT',
      quantity: draft.quantity,
    };

    if (draft.orderType === 'limit') {
      params.timeInForce = (draft.timeInForce ?? 'GTC').toUpperCase();
      if (draft.limitPrice) params.price = draft.limitPrice;
    }

    try {
      const res = await this.signedPost('/api/v3/order', params);
      const data = (await res.json()) as BinanceOrderResult;

      if (!res.ok || data.code) {
        return {
          externalOrderId: null,
          status: 'rejected',
          message: data.msg ?? `Binance HTTP ${res.status}`,
        };
      }

      return {
        externalOrderId: String(data.orderId),
        status: 'accepted',
        message: data.status ?? 'ORDER_PLACED',
      };
    } catch (e) {
      return {
        externalOrderId: null,
        status: 'rejected',
        message: String(e),
      };
    }
  }

  // ── Internal signing helpers ────────────────────────────────────────────────

  private requireCreds(): BinanceCreds {
    if (!this.creds) throw new Error('BinanceAdapter not connected');
    return this.creds;
  }

  private sign(queryString: string): string {
    return createHmac('sha256', this.requireCreds().secretKey)
      .update(queryString)
      .digest('hex');
  }

  private buildSignedQuery(params: Record<string, string>): string {
    const all = { ...params, timestamp: Date.now().toString() };
    const qs = new URLSearchParams(all).toString();
    return `${qs}&signature=${this.sign(qs)}`;
  }

  private async signedGetJson<T>(path: string, params: Record<string, string>): Promise<T> {
    const qs = this.buildSignedQuery(params);
    const res = await fetch(`${BASE_URL}${path}?${qs}`, {
      headers: { 'X-MBX-APIKEY': this.requireCreds().apiKey },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Binance ${path} error ${res.status}: ${body}`);
    }
    return res.json() as Promise<T>;
  }

  private async signedPost(path: string, params: Record<string, string>): Promise<Response> {
    const body = this.buildSignedQuery(params);
    return fetch(`${BASE_URL}${path}`, {
      method: 'POST',
      headers: {
        'X-MBX-APIKEY': this.requireCreds().apiKey,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
    });
  }
}
