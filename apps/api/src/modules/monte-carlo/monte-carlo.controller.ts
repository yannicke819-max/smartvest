import { BadRequestException, Body, Controller, Post } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  MonteCarloConfigSchema,
  runMonteCarlo,
  type MonteCarloResult,
} from '@smartvest/monte-carlo';
import { DEFAULT_UNIVERSE, loadUniverseHistory } from '@smartvest/backtest';

/**
 * Endpoint Monte Carlo simulation.
 *
 * Synchrone, ~1-10s selon numPaths. Pour 10000 paths × 17 tickers, autour
 * de 10s. Si on monte sérieusement en charge, basculer sur job queue.
 */
@Controller('monte-carlo')
export class MonteCarloController {
  constructor(private readonly config: ConfigService) {}

  @Post('run')
  async run(@Body() body: unknown): Promise<MonteCarloResult> {
    const parsed = MonteCarloConfigSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(
        `Configuration invalide : ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ')}`,
      );
    }
    const cfg = parsed.data;

    const apiKey = this.config.get<string>('EODHD_API_KEY');
    if (!apiKey || apiKey === 'demo') {
      throw new BadRequestException('EODHD_API_KEY manquant — Monte Carlo impossible sans données historiques.');
    }

    // Fenêtre historique pour bootstrap : lookbackDays jours avant asOfDate
    const lookbackStart = new Date(cfg.asOfDate);
    lookbackStart.setUTCDate(lookbackStart.getUTCDate() - cfg.lookbackDays - 5);
    const fromDate = lookbackStart.toISOString().slice(0, 10);

    const universe = cfg.universe.length > 0
      ? cfg.universe
          .map((sym) => DEFAULT_UNIVERSE.find((u) => u.symbol === sym))
          .filter((u): u is (typeof DEFAULT_UNIVERSE)[number] => u != null)
      : DEFAULT_UNIVERSE;

    const { histories, warnings } = await loadUniverseHistory(
      { fromDate, toDate: cfg.asOfDate, apiKey },
      universe,
    );
    if (histories.length === 0) {
      throw new BadRequestException(
        `Aucune donnée chargée depuis EODHD pour la fenêtre ${fromDate} → ${cfg.asOfDate}.`,
      );
    }

    return runMonteCarlo({ config: cfg, histories, warnings });
  }
}
