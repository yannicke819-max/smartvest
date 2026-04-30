/**
 * One-shot endpoint pour valider FRED_API_KEY en runtime Fly.
 *
 * **TEMPORAIRE** — à supprimer après validation. Ne renvoie aucune donnée
 * sensible (pas la clé, pas la réponse FRED) — uniquement le status code
 * HTTP retourné par FRED + la longueur de la clé pour confirmer propagation
 * Fly secret.
 *
 * Volontairement sans auth car ADMIN_TOKEN inaccessible depuis l'agent
 * sandbox cf. user instruction explicite "endpoint public temporaire pour
 * ce one-shot". Surface attaque limitée :
 *  - Aucune donnée sensible exposée
 *  - 1 outbound call FRED par hit (FRED limite 120 req/min/IP)
 *  - Endpoint à retirer immédiatement après validation
 */

import { Controller, Get, Logger } from '@nestjs/common';

@Controller('admin/fred-test')
export class AdminFredTestController {
  private readonly logger = new Logger(AdminFredTestController.name);

  @Get()
  async testFred(): Promise<{ status: number; ok: boolean; keyLen: number }> {
    const key = process.env.FRED_API_KEY ?? '';
    const keyLen = key.length;

    if (keyLen === 0) {
      this.logger.warn('[FRED-SMOKE] FRED_API_KEY missing in env');
      return { status: 0, ok: false, keyLen: 0 };
    }

    const url = `https://api.stlouisfed.org/fred/series?series_id=GDP&api_key=${encodeURIComponent(key)}&file_type=json`;
    try {
      const res = await fetch(url);
      this.logger.log(`[FRED-SMOKE] keyLen=${keyLen} → HTTP ${res.status} ok=${res.ok}`);
      return { status: res.status, ok: res.ok, keyLen };
    } catch (e) {
      this.logger.error(`[FRED-SMOKE] fetch threw: ${String(e).slice(0, 200)}`);
      return { status: -1, ok: false, keyLen };
    }
  }
}
