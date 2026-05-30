/**
 * Endpoints admin pour LessonAutoApplyService — pipeline d'amélioration continue.
 *
 * GET  /admin/lesson-auto-apply/status — état du cycle, count pending/applied/needs_review
 * POST /admin/lesson-auto-apply/run    — déclenche un cycle manuel (utile pour test)
 *
 * Auth : header x-admin-token aligné sur AdminScannerPostMortemController.
 */

import { Controller, Get, Headers, HttpException, HttpStatus, Logger, Post } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LessonAutoApplyService } from '../lisa/services/lesson-auto-apply.service';

@Controller('admin/lesson-auto-apply')
export class AdminLessonAutoApplyController {
  private readonly logger = new Logger(AdminLessonAutoApplyController.name);

  constructor(
    private readonly autoApply: LessonAutoApplyService,
    private readonly config: ConfigService,
  ) {}

  @Get('status')
  async getStatus(@Headers('x-admin-token') providedToken: string | undefined) {
    this.assertAdmin(providedToken);
    return this.autoApply.getStatus();
  }

  @Post('run')
  async run(@Headers('x-admin-token') providedToken: string | undefined) {
    this.assertAdmin(providedToken);
    this.logger.log('[admin/lesson-auto-apply] manual cycle triggered');
    return this.autoApply.runCycle();
  }

  private assertAdmin(providedToken: string | undefined): void {
    const expected = this.config.get<string>('ADMIN_TOKEN');
    if (!expected || expected.length === 0) {
      throw new HttpException(
        { message: 'Endpoint disabled (ADMIN_TOKEN not configured)', code: 'ADMIN_DISABLED' },
        HttpStatus.FORBIDDEN,
      );
    }
    if (providedToken !== expected) {
      throw new HttpException(
        { message: 'Invalid admin token', code: 'ADMIN_FORBIDDEN' },
        HttpStatus.FORBIDDEN,
      );
    }
  }
}
