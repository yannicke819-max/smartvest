/**
 * Admin endpoint pour relancer l'audit de la boucle d'auto-apprentissage.
 *
 * Invocable depuis l'UI (panel "Audit auto-apprentissage" dans /lisa) ou via curl.
 * Réutilise la même logique que le script CLI `scripts/verify-learning-loop.ts`,
 * mais exposée en JSON pour le frontend.
 *
 * Auth : x-admin-token (cf. ADMIN_TOKEN env). Pas de 403 strict (UI usage),
 * on log juste un warn si le token est absent.
 */
import { Controller, Get, Headers, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LearningLoopAuditService } from '../lisa/services/learning-loop-audit.service';

@Controller('admin/verify-learning-loop')
export class AdminLearningLoopAuditController {
  private readonly logger = new Logger(AdminLearningLoopAuditController.name);

  constructor(
    private readonly config: ConfigService,
    private readonly audit: LearningLoopAuditService,
  ) {}

  @Get()
  async run(@Headers('x-admin-token') providedToken?: string): Promise<unknown> {
    const adminToken = this.config.get<string>('ADMIN_TOKEN');
    if (adminToken && providedToken !== adminToken) {
      this.logger.warn('[verify-learning-loop] invalid admin token — running anyway (UI usage)');
    }
    const t0 = Date.now();
    const report = await this.audit.runAudit();
    const latencyMs = Date.now() - t0;
    this.logger.log(`[verify-learning-loop] audit done in ${latencyMs}ms, global=${report.global_status}`);
    return { ...report, latency_ms: latencyMs };
  }
}
