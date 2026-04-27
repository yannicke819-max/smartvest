/**
 * Tests pour symbol-to-eodhd.helper — fix incident 27/04/2026.
 *
 * Vérifie que les symboles tenus en prod (BTC, RTX) produisent un
 * ProviderAsset EODHD valide pour débloquer le quote refresh stérile.
 */
import { symbolToProviderAsset } from '../symbol-to-eodhd.helper';

describe('symbolToProviderAsset', () => {
  describe('crypto', () => {
    it('maps BTC + crypto_bitcoin → BTC-USD.CC', () => {
      const a = symbolToProviderAsset('id-btc', 'BTC', 'crypto_bitcoin');
      expect(a).not.toBeNull();
      expect(a!.providerTicker).toBe('BTC-USD.CC');
      expect(a!.ticker).toBe('BTC');
      expect(a!.currency).toBe('USD');
    });

    it('maps ETH + crypto_ethereum → ETH-USD.CC', () => {
      const a = symbolToProviderAsset('id-eth', 'ETH', 'crypto_ethereum');
      expect(a!.providerTicker).toBe('ETH-USD.CC');
    });

    it('strips USDT suffix : BTCUSDT → BTC-USD.CC', () => {
      const a = symbolToProviderAsset('id-1', 'BTCUSDT', 'crypto_bitcoin');
      expect(a!.providerTicker).toBe('BTC-USD.CC');
      expect(a!.ticker).toBe('BTC');
    });

    it('strips -USD suffix : BTC-USD → BTC-USD.CC', () => {
      const a = symbolToProviderAsset('id-1', 'BTC-USD', null);
      expect(a!.providerTicker).toBe('BTC-USD.CC');
    });

    it('strips -SPOT suffix : BTC-SPOT → BTC-USD.CC', () => {
      const a = symbolToProviderAsset('id-1', 'BTC-SPOT', null);
      expect(a!.providerTicker).toBe('BTC-USD.CC');
    });

    it('detects crypto via symbol whitelist when assetClass is missing', () => {
      // Cas réel : asset_class undefined sur position legacy
      const a = symbolToProviderAsset('id-sol', 'SOL', undefined);
      expect(a!.providerTicker).toBe('SOL-USD.CC');
    });

    it('detects crypto via crypto_ prefix even with unknown symbol', () => {
      const a = symbolToProviderAsset('id-x', 'NEWCOIN', 'crypto_altcoins');
      expect(a!.providerTicker).toBe('NEWCOIN-USD.CC');
    });
  });

  describe('equity / ETF', () => {
    it('maps RTX + equity_us_large → RTX.US (cas réel 27/04)', () => {
      const a = symbolToProviderAsset('id-rtx', 'RTX', 'equity_us_large');
      expect(a!.providerTicker).toBe('RTX.US');
      expect(a!.ticker).toBe('RTX');
    });

    it('maps SPY + equity_us_large → SPY.US', () => {
      const a = symbolToProviderAsset('id-spy', 'SPY', 'equity_us_large');
      expect(a!.providerTicker).toBe('SPY.US');
    });

    it('maps GLD ETF (commodities_metals_precious) → GLD.US', () => {
      const a = symbolToProviderAsset('id-gld', 'GLD', 'commodities_metals_precious');
      expect(a!.providerTicker).toBe('GLD.US');
    });

    it('maps unknown symbol with no assetClass → .US fallback', () => {
      const a = symbolToProviderAsset('id-x', 'NVDA', null);
      expect(a!.providerTicker).toBe('NVDA.US');
    });
  });

  describe('FX', () => {
    it('maps EURUSD + fx_g10 → EURUSD.FOREX', () => {
      const a = symbolToProviderAsset('id-eurusd', 'EURUSD', 'fx_g10');
      expect(a!.providerTicker).toBe('EURUSD.FOREX');
    });

    it('detects FX via 6-letter pattern when assetClass missing', () => {
      const a = symbolToProviderAsset('id-1', 'USDJPY', null);
      expect(a!.providerTicker).toBe('USDJPY.FOREX');
    });
  });

  describe('respect format complet existant', () => {
    it('preserves AAPL.US when symbol already contains . (no double-suffix)', () => {
      const a = symbolToProviderAsset('id-aapl', 'AAPL.US', 'equity_us_large');
      expect(a!.providerTicker).toBe('AAPL.US');
    });

    it('preserves ASML.AS (EU equity)', () => {
      const a = symbolToProviderAsset('id-asml', 'ASML.AS', 'equity_eu');
      expect(a!.providerTicker).toBe('ASML.AS');
    });

    it('preserves XAUUSD.FOREX', () => {
      const a = symbolToProviderAsset('id-xau', 'XAUUSD.FOREX', null);
      expect(a!.providerTicker).toBe('XAUUSD.FOREX');
    });
  });

  describe('cas insuffisants', () => {
    it('returns null on empty symbol', () => {
      expect(symbolToProviderAsset('id-1', '', null)).toBeNull();
    });
  });

  describe('repro production 27/04', () => {
    it('BTC long position (entry 76875.69) maps correctly', () => {
      // Repro de la position BTC live 17:38 UTC
      const a = symbolToProviderAsset('btc-pos-uuid', 'BTC', 'crypto_bitcoin');
      expect(a).not.toBeNull();
      expect(a!.providerTicker).toBe('BTC-USD.CC');
      expect(a!.assetId).toBe('btc-pos-uuid');
    });

    it('RTX long position (entry 172.92) maps correctly', () => {
      const a = symbolToProviderAsset('rtx-pos-uuid', 'RTX', 'equity_us_large');
      expect(a).not.toBeNull();
      expect(a!.providerTicker).toBe('RTX.US');
    });
  });
});
