import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { QuoteRefreshService } from '../services/quote-refresh.service';

@Injectable()
export class MarketDataScheduler {
  private readonly logger = new Logger(MarketDataScheduler.name);

  constructor(private readonly quoteRefresh: QuoteRefreshService) {}

  // Refresh quotes every 15 minutes on weekdays between 8am and 10pm UTC
  @Cron('0 */15 8-22 * * 1-5')
  async handleQuoteRefresh() {
    this.logger.log('Scheduled quote refresh started');
    const result = await this.quoteRefresh.runQuoteRefresh();
    this.logger.log(
      `Quote refresh done: ${result.assetsSucceeded}/${result.assetsRequested} succeeded`,
    );
  }

  // Refresh daily bars every night at 1am UTC
  @Cron(CronExpression.EVERY_DAY_AT_1AM)
  async handleBarRefresh() {
    this.logger.log('Scheduled bar refresh started');
    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const result = await this.quoteRefresh.runBarRefresh(yesterday, today);
    this.logger.log(
      `Bar refresh done: ${result.assetsSucceeded}/${result.assetsRequested} succeeded`,
    );
  }
}
