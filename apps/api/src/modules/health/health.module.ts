import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { ScannerPulseController } from './scanner-pulse.controller';
import { VitalsController } from './vitals.controller';

@Module({ controllers: [HealthController, ScannerPulseController, VitalsController] })
export class HealthModule {}
