import { Module } from '@nestjs/common';
import { BacktestController } from './backtest.controller';

@Module({
  controllers: [BacktestController],
})
export class BacktestModule {}
