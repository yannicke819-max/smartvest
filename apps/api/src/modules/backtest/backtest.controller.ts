import { BadRequestException, Body, Controller, Post } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  BacktestConfigSchema,
  DEFAULT_UNIVERSE,
  loadUniverseHistory,
  runBacktest,
  type BacktestConfig,
  type BacktestResult,
} from '@smartvest/backtest';

/**
 * Endpoint backtest — synchrone, simple.
 *
 * Pour l'instant on bloque le request thread pendant le run (de l'ordre
 * de quelques secondes pour 90 jours, jusqu'à ~30s pour 1 an avec
 * l'univers par défaut). Si on monte en charge, on bascule sur job
 * queue (BullMQ ou similaire) avec polling de status.
 */
@Controller('backtest')
export class BacktestController {
  constructor(private readonly config: ConfigService) {}

  @Post('run')
  async run(@Body() body: unknown): Promise<BacktestResult> {
    const parsed = BacktestConfigSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(
        `Configuration backtest invalide : ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ')}`,
      );
    }
    const cfg: BacktestConfig = parsed.data;

    const apiKey = this.config.get<string>('EODHD_API_KEY');
    if (!apiKey || apiKey === 'demo') {
      throw new BadRequestException(
        'EODHD_API_KEY manquant ou en mode demo — backtest impossible (besoin de données historiques réelles).',
      );
    }

    // Univers : config.universe override le défaut si fourni
    const universe =
      cfg.universe.length > 0
        ? cfg.universe
            .map((sym) => DEFAULT_UNIVERSE.find((u) => u.symbol === sym))
            .filter((u): u is (typeof DEFAULT_UNIVERSE)[number] => u != null)
        : DEFAULT_UNIVERSE;

    if (universe.length === 0) {
      throw new BadRequestException(
        `Univers vide — aucun ticker reconnu parmi ${cfg.universe.join(', ')}.`,
      );
    }

    const { histories, warnings } = await loadUniverseHistory(
      { fromDate: cfg.fromDate, toDate: cfg.toDate, apiKey },
      universe,
    );

    if (histories.length === 0) {
      throw new BadRequestException(
        `Aucune donnée chargée depuis EODHD pour la période ${cfg.fromDate} → ${cfg.toDate}. Vérifie les dates et la clé API.`,
      );
    }

    return runBacktest({ config: cfg, histories, warnings });
  }
}
