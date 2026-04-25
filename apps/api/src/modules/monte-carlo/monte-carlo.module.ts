import { Module } from '@nestjs/common';
import { MonteCarloController } from './monte-carlo.controller';

@Module({
  controllers: [MonteCarloController],
})
export class MonteCarloModule {}
