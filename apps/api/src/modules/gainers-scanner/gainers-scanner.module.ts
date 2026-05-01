import { Module } from '@nestjs/common';
import { GainersBloc1Service } from './bloc1/gainers-bloc1.service';

/**
 * ADR-005 Gainers Algo V1 — Module NestJS découplé (ADR-006).
 * BLOC 1 wired (PR2). BLOC 2-4 ajoutés dans PR3-PR5.
 */
@Module({
  imports: [],
  providers: [GainersBloc1Service],
  exports: [GainersBloc1Service],
})
export class GainersModule {}
