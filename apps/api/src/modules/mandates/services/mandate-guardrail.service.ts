import { Injectable, BadRequestException } from '@nestjs/common';
import { CreateMandateSchema, UpdateMandateSchema } from '../dto/mandate.dto';
import type { CreateMandateDto, UpdateMandateDto } from '../dto/mandate.dto';

@Injectable()
export class MandateGuardrailService {
  validateCreate(body: unknown): CreateMandateDto {
    const parsed = CreateMandateSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues.map((i) => i.message).join('; '));
    }
    return this.applyBusinessRules(parsed.data);
  }

  validateUpdate(body: unknown): UpdateMandateDto {
    const parsed = UpdateMandateSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues.map((i) => i.message).join('; '));
    }
    const data = parsed.data;
    // Cross-field guard: if both fields provided, singleTrade must not exceed positionSize
    if (
      data.maxSingleTradePct !== undefined &&
      data.maxPositionSizePct !== undefined &&
      data.maxSingleTradePct > data.maxPositionSizePct
    ) {
      throw new BadRequestException('maxSingleTradePct ne peut pas dépasser maxPositionSizePct');
    }
    return data;
  }

  private applyBusinessRules(data: CreateMandateDto): CreateMandateDto {
    const errors: string[] = [];

    if (data.maxPositionSizePct > 50) {
      errors.push('maxPositionSizePct ne peut pas dépasser 50% (garde-fou anti-concentration)');
    }
    if (data.maxSingleTradePct > data.maxPositionSizePct) {
      errors.push('maxSingleTradePct ne peut pas dépasser maxPositionSizePct');
    }
    if (data.maxDailyTradePct > 30) {
      errors.push('maxDailyTradePct ne peut pas dépasser 30% (garde-fou journalier)');
    }
    if (data.stopLossTriggerPct > 25) {
      errors.push('stopLossTriggerPct ne peut pas dépasser 25%');
    }

    const now = new Date();
    const expires = new Date(data.expiresAt);
    if (expires <= now) {
      errors.push('expiresAt doit être dans le futur');
    }
    const maxExpiry = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000);
    if (expires > maxExpiry) {
      errors.push('expiresAt ne peut pas dépasser 1 an dans le futur');
    }

    if (errors.length > 0) {
      throw new BadRequestException(errors.join('; '));
    }
    return data;
  }
}
