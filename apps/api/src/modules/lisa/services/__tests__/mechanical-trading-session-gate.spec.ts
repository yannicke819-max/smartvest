/**
 * PR #349 — Gate isInExchangeSession dans mechanical-trading.
 *
 * Preuve empirique 14j : 10 entrées pré-marché .SHG/.SHE → 8 SL / 1 TP /
 * 1 inval = -$289.47 net. Le gate amont getMarketState() avait un trou
 * pour asia ; ce PR ajoute un 2e gate au plus près de l'INSERT
 * lisa_positions, contre la source de vérité EXCHANGE_SESSIONS.
 *
 * Ce spec teste le helper isInExchangeSession isolément — la garantie
 * que mechanical-trading.service.ts l'appelle juste avant l'INSERT
 * est couverte par le test d'intégration mécanique (autre spec).
 */

import { isInExchangeSession } from '../exchange-sessions.helper';

describe('Session gate before INSERT lisa_positions — PR #349', () => {
  describe('Shanghai pre-market (bug 14j)', () => {
    // 00:17 UTC = 08:17 Shanghai (1h13 avant l'ouverture officielle 09:30 SH).
    // Pattern observé sur 10 entrées : gap baissier au open → SL fake.
    const preMarketSH = new Date('2026-05-18T00:17:00Z');

    it('blocks .SHG before official open 09:30 Shanghai', () => {
      expect(isInExchangeSession('601100.SHG', preMarketSH)).toBe(false);
    });

    it('blocks .SHE before official open 09:30 Shanghai', () => {
      expect(isInExchangeSession('300024.SHE', preMarketSH)).toBe(false);
    });
  });

  describe('Shanghai during session', () => {
    // 02:00 UTC = 10:00 Shanghai = en pleine session 09:30-15:00.
    const duringSH = new Date('2026-05-18T02:00:00Z');

    it('allows .SHG during 09:30-15:00 Shanghai', () => {
      expect(isInExchangeSession('601100.SHG', duringSH)).toBe(true);
    });

    it('allows .SHE during 09:30-15:00 Shanghai', () => {
      expect(isInExchangeSession('300024.SHE', duringSH)).toBe(true);
    });
  });

  describe('Other exchanges pre-market protection', () => {
    // 23:30 UTC dimanche = 08:30 Tokyo / Seoul lundi (avant ouverture).
    const preMarketTokyoSeoul = new Date('2026-05-17T23:30:00Z');

    it('blocks .T before Tokyo open 09:00', () => {
      expect(isInExchangeSession('7203.T', preMarketTokyoSeoul)).toBe(false);
    });

    it('blocks .KO before Seoul open 09:00', () => {
      expect(isInExchangeSession('005930.KO', preMarketTokyoSeoul)).toBe(false);
    });
  });

  describe('Crypto always-on bypass', () => {
    // 03:00 UTC : équities asia/EU/US toutes fermées, crypto doit passer.
    const anyTime = new Date('2026-05-18T03:00:00Z');

    it('allows .CC anytime (always-on)', () => {
      expect(isInExchangeSession('BTCUSD.CC', anyTime)).toBe(true);
    });

    it('allows .FOREX anytime (always-on)', () => {
      expect(isInExchangeSession('EURUSD.FOREX', anyTime)).toBe(true);
    });
  });

  describe('US during session', () => {
    // 18:00 UTC = 14:00 New York = en pleine session 09:30-16:00.
    // Note : EODHD convention = ticker.US, ex AAPL.US (cf. ensureExchangeSuffix
    // dans top-gainers-scanner.service.ts ligne 1399). Un AAPL nu retournerait
    // false (helper conservateur), mais c'est un cas qui ne survient pas dans
    // le flow mécanique car le scanner appose toujours le suffixe.
    const duringUS = new Date('2026-05-18T18:00:00Z');

    it('allows .US during session', () => {
      expect(isInExchangeSession('AAPL.US', duringUS)).toBe(true);
    });
  });

  describe('Weekend protection', () => {
    // Samedi 17 mai 2026 14:00 UTC : aucune équity ouverte.
    const saturday = new Date('2026-05-16T14:00:00Z');

    it('blocks .US on Saturday even in normal hours window', () => {
      expect(isInExchangeSession('AAPL.US', saturday)).toBe(false);
    });

    it('blocks .SHG on Saturday', () => {
      expect(isInExchangeSession('601100.SHG', saturday)).toBe(false);
    });

    it('still allows .CC on Saturday (crypto 24/7)', () => {
      expect(isInExchangeSession('BTCUSD.CC', saturday)).toBe(true);
    });
  });
});
