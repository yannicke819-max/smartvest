import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { ScannerPulseController } from './scanner-pulse.controller';

@Module({ controllers: [HealthController, ScannerPulseController] })
export class HealthModule {}
