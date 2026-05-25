/**
 * P19-staleness-DIAGNOSTIC (25/05) — /admin/td-probe endpoint.
 *
 * Hit direct l'API TwelveData `/quote` pour les holdings ou symbols passés
 * en query, retourne le timestamp + datetime du quote. Permet de confirmer
 * si TwelveData renvoie un prix stale (vendredi figé) sur nos LSE/Euronext/SIX
 * holdings — autrement dit, si notre plan TD couvre vraiment ces exchanges
 * en intraday ou seulement EOD.
 *
 * Usage :
 *   curl -H "x-admin-token: $ADMIN_TOKEN" \
 *     "https://smartvest.fly.dev/admin/td-probe?symbols=RMV.LSE,EZJ.LSE,AJB.LSE,NANO.PA,AMS.SW,AAPL.US"
 *
 * Pour chaque symbol :
 *   - Map vers format TD (RMV.LSE → RMV:LSE)
 *   - Call /quote, log timestamp + datetime + age en secondes
 *   - Compare à now : si age > 300s pendant les heures d'ouverture du marché
 *     correspondant → confirme stale feed
 */

import { Controller, Get, Headers, HttpException, HttpStatus, Logger, Query } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Controller('admin/td-probe')
export class AdminTdProbeController {
  private readonly logger = new Logger(AdminTdProbeController.name);

  constructor(private readonly config: ConfigService) {}

  @Get()
  async probe(
    @Headers('x-admin-token') providedToken: string | undefined,
    @Query('symbols') symbols?: string,
  ): Promise<unknown> {
    this.assertAdmin(providedToken);
    const apiKey = this.config.get<string>('TWELVEDATA_API_KEY');
    if (!apiKey) {
      throw new HttpException({ message: 'TWELVEDATA_API_KEY not configured', code: 'NO_KEY' }, 500);
    }
    const list = (symbols ?? 'RMV.LSE,EZJ.LSE,AJB.LSE,BOY.LSE,NANO.PA,AMS.SW,AAPL.US')
      .split(',').map((s) => s.trim()).filter(Boolean);

    const results: Array<Record<string, unknown>> = [];
    const nowMs = Date.now();
    for (const sym of list) {
      const tdSym = toTdSymbol(sym);
      try {
        const url = `https://api.twelvedata.com/quote?symbol=${encodeURIComponent(tdSym)}&apikey=${apiKey}`;
        const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
        const d = (await res.json()) as Record<string, unknown>;
        const ts = typeof d.timestamp === 'string' || typeof d.timestamp === 'number' ? Number(d.timestamp) : null;
        const lastQuoteAt = typeof d.last_quote_at === 'string' || typeof d.last_quote_at === 'number' ? Number(d.last_quote_at) : null;
        const ageS = ts ? Math.floor(nowMs / 1000 - ts) : null;
        const lastQuoteAgeS = lastQuoteAt ? Math.floor(nowMs / 1000 - lastQuoteAt) : null;
        results.push({
          symbol: sym, td_symbol: tdSym,
          status: d.status ?? 'ok',
          message: d.message ?? null,
          close: d.close ?? null,
          datetime: d.datetime ?? null,
          timestamp: ts,
          age_sec: ageS,
          age_hours: ageS ? Math.round(ageS / 360) / 10 : null,
          last_quote_at: lastQuoteAt,
          last_quote_age_sec: lastQuoteAgeS,
          last_quote_age_hours: lastQuoteAgeS ? Math.round(lastQuoteAgeS / 360) / 10 : null,
          is_market_open: d.is_market_open ?? null,
          exchange: d.exchange ?? null,
          stale_verdict: ts && ageS && ageS > 600 ? `STALE (${Math.floor(ageS / 3600)}h${Math.floor((ageS % 3600) / 60)}min old)` : 'fresh-ish',
        });
      } catch (e) {
        results.push({ symbol: sym, td_symbol: tdSym, error: String(e).slice(0, 200) });
      }
    }
    return {
      now_iso: new Date(nowMs).toISOString(),
      probed: list.length,
      results,
    };
  }

  private assertAdmin(providedToken: string | undefined): void {
    const expected = this.config.get<string>('ADMIN_TOKEN');
    if (!expected || expected.length === 0) {
      throw new HttpException({ message: 'Endpoint disabled (ADMIN_TOKEN not configured)', code: 'ADMIN_DISABLED' }, HttpStatus.FORBIDDEN);
    }
    if (providedToken !== expected) {
      throw new HttpException({ message: 'Invalid admin token', code: 'ADMIN_FORBIDDEN' }, HttpStatus.FORBIDDEN);
    }
  }
}

/**
 * Mapping SmartVest ticker → TwelveData symbol.
 *  - .LSE  → :LSE
 *  - .PA   → :Euronext
 *  - .SW   → :SIX
 *  - .XETRA → :XETR
 *  - .US ou rien → unchanged
 */
function toTdSymbol(sym: string): string {
  const upper = sym.toUpperCase();
  if (upper.endsWith('.LSE')) return `${upper.slice(0, -4)}:LSE`;
  if (upper.endsWith('.PA')) return `${upper.slice(0, -3)}:Euronext`;
  if (upper.endsWith('.AS')) return `${upper.slice(0, -3)}:Euronext`;
  if (upper.endsWith('.SW')) return `${upper.slice(0, -3)}:SIX`;
  if (upper.endsWith('.XETRA')) return `${upper.slice(0, -6)}:XETR`;
  if (upper.endsWith('.US')) return upper.slice(0, -3);
  return upper;
}
