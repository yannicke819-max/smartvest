/**
 * P19r (29/04/2026) — Tests pour le bump 1m window 24h → 48h.
 *
 * Constat prod (UI Lisa Top 20) : 1m=1/20, seul KFRC US a tf1m≠null. Les 9 KO
 * (Korea) + 4 NSE (India) + 1 AU n'avaient PAS de candles 1m car la fenêtre
 * 24h ne couvrait pas leur dernière session :
 *   - KOSPI Mon 00:00–06:30 UTC ; à 19:30 UTC mardi, window 24h remonte au
 *     lundi 19:30 → manque toute la session lundi (terminée 13h avant le
 *     début du window).
 *   - NSE India 03:45–10:00 UTC : pareil sur certains créneaux.
 *
 * Fix : window 1m = 48h. Capture systématiquement les 2 dernières sessions
 * de tous les marchés. Le `.slice(-count)` côté client limite la payload.
 */

import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EodhdIntradayService } from '../eodhd-intraday.service';
import { SupabaseService } from '../../../supabase/supabase.service';

jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

function makeService(envMap: Record<string, string | undefined> = { EODHD_API_KEY: 'test-key', EODHD_WEEKEND_FILTER_ENABLED: 'false' }) {
  const config = { get: jest.fn((k: string) => envMap[k]) } as unknown as ConfigService;
  const supabase = {
    isReady: () => true,
    getClient: () => ({ from: () => ({ insert: jest.fn().mockResolvedValue({ error: null }) }) }),
  } as unknown as SupabaseService;
  return new EodhdIntradayService(config, supabase);
}

describe('EodhdIntradayService — P19r 1m window 48h', () => {
  it('windowForInterval(1m) returns 48h (was 24h pre-P19r)', () => {
    const svc = makeService();
    const fn = (svc as any).windowForInterval.bind(svc);
    expect(fn('1m')).toBe(48 * 3600);
  });

  it('5m window unchanged at 5 days, 1h at 30 days', () => {
    const svc = makeService();
    const fn = (svc as any).windowForInterval.bind(svc);
    expect(fn('5m')).toBe(5 * 24 * 3600);
    expect(fn('1h')).toBe(30 * 24 * 3600);
  });

  it('1m getCandles uses a 48h window (verify URL params from→to span)', async () => {
    const svc = makeService();
    let capturedUrl = '';
    (global as any).fetch = jest.fn().mockImplementation(async (url: string) => {
      capturedUrl = url;
      return { ok: true, status: 200, json: async () => [], text: async () => '[]' };
    });

    await svc.getCandles('006340.KO', '1m', 65);

    expect(capturedUrl).toContain('https://eodhd.com/api/intraday/006340.KO');
    const u = new URL(capturedUrl);
    expect(u.searchParams.get('interval')).toBe('1m');
    const from = Number(u.searchParams.get('from'));
    const to = Number(u.searchParams.get('to'));
    expect(to - from).toBeGreaterThanOrEqual(48 * 3600 - 1);
    expect(to - from).toBeLessThanOrEqual(48 * 3600 + 60);
  });

  it('Korea KOSPI .KO ticker reaches Mon session even when polled Tue 19:30 UTC', async () => {
    // Régression spécifique : à 19:30 UTC mardi, on doit capturer la session
    // KOSPI Mon 00:00-06:30 UTC (terminée 37h avant). 24h window manquait,
    // 48h window doit la capturer.
    const svc = makeService();
    let capturedUrl = '';
    (global as any).fetch = jest.fn().mockImplementation(async (url: string) => {
      capturedUrl = url;
      return { ok: true, status: 200, json: async () => [], text: async () => '[]' };
    });

    // Mock Date.now() = mardi 19:30 UTC
    const tueAt1930Utc = Date.parse('2026-04-29T19:30:00Z');
    const realDateNow = Date.now;
    Date.now = () => tueAt1930Utc;

    await svc.getCandles('006340.KO', '1m', 65);

    Date.now = realDateNow;

    const u = new URL(capturedUrl);
    const from = Number(u.searchParams.get('from'));
    const fromDate = new Date(from * 1000);
    // from = 2026-04-27 19:30 UTC (dimanche). Cela couvre :
    //   - KOSPI Lun 28 Apr 00:00-06:30 ✓ (était le bug)
    //   - KOSPI Mar 29 Apr 00:00-06:30 ✓
    expect(fromDate.toISOString()).toBe('2026-04-27T19:30:00.000Z');
  });

  it('NSE India .NSE ticker reaches Mon session at Tue 19:30 UTC', async () => {
    // NSE 03:45–10:00 UTC. Lun 28 Apr 03:45 → 19:30 mardi = 39h avant.
    // 48h window capture, 24h window manquait.
    const svc = makeService();
    let capturedUrl = '';
    (global as any).fetch = jest.fn().mockImplementation(async (url: string) => {
      capturedUrl = url;
      return { ok: true, status: 200, json: async () => [], text: async () => '[]' };
    });

    await svc.getCandles('DEVYANI.NSE', '1m', 65);

    const u = new URL(capturedUrl);
    const from = Number(u.searchParams.get('from'));
    const to = Number(u.searchParams.get('to'));
    expect(to - from).toBeGreaterThanOrEqual(48 * 3600 - 1);
    // URL contient le ticker NSE inchangé
    expect(capturedUrl).toContain('DEVYANI.NSE');
  });
});
