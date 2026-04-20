import { Module } from '@nestjs/common';
import { PortfolioController } from './portfolio.controller';

@Module({ controllers: [PortfolioController] })
export class PortfolioModule {}
