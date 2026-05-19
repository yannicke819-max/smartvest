/**
 * PR #358 (19/05/2026) — /admin/qw-pipeline-toggle endpoint.
 *
 * Permet de toggle le master flag QUICK_WINS_PIPELINE_ENABLED en runtime sans
 * redéployer Fly. Override survit jusqu'au prochain restart de process (puis
 * revient au flag env). Pour persister, l'utilisateur doit mettre à jour le
 * secret Fly via UI.
 *
 * Usage :
 *   GET  /admin/qw-pipeline-toggle              → status courant
 *   POST /admin/qw-pipeline-toggle { enabled }  → flip à enabled (bool ou null)
 *
 * Auth : header `x-admin-token` (même secret que /admin/providers-status).
 *
 * Contexte 19 mai : QW pipeline était OFF par défaut (default 'false'), résultait
 * en table qw_decision_log vide et 295310.KQ traded 7× (cap asia 4× ignoré).
 * Cet endpoint permet d'activer immédiatement post-merge sans risque deploy.
 */

import { Body, Controller, Get, Headers, HttpException, HttpStatus, Logger, Post } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { QuickWinsPipelineService } from '../lisa/quick-wins/quick-wins-pipeline.service';

interface ToggleBody {
  enabled?: boolean | null;
}

@Controller('admin/qw-pipeline-toggle')
export class AdminQwPipelineToggleController {
  private readonly logger = new Logger(AdminQwPipelineToggleController.name);

  constructor(
    private readonly qwPipeline: QuickWinsPipelineService,
    private readonly config: ConfigService,
  ) {}

  @Get()
  async getStatus(@Headers('x-admin-token') providedToken: string | undefined) {
    this.assertAdmin(providedToken);
    return {
      status: this.qwPipeline.getStatus(),
      help: {
        runtime_override:
          'POST { "enabled": true|false } pour override runtime. POST { "enabled": null } pour relâcher l override et revenir au flag env. POST { "enabled": true } équivaut à activer QW pipeline sans redeploy.',
        persistence:
          'Override runtime survit jusqu au prochain restart de process. Pour persister, l utilisateur doit mettre à jour le secret Fly QUICK_WINS_PIPELINE_ENABLED via UI.',
      },
    };
  }

  @Post()
  async toggle(
    @Headers('x-admin-token') providedToken: string | undefined,
    @Body() body: ToggleBody,
  ) {
    this.assertAdmin(providedToken);

    if (!body || (body.enabled !== true && body.enabled !== false && body.enabled !== null)) {
      throw new HttpException(
        {
          message: 'Body must contain { enabled: true|false|null }',
          code: 'INVALID_BODY',
        },
        HttpStatus.BAD_REQUEST,
      );
    }

    const result = this.qwPipeline.setEnabledRuntime(body.enabled);
    this.logger.log(
      `[admin] qw-pipeline-toggle previous=${result.previous} current=${result.current} (override=${body.enabled})`,
    );

    return {
      ok: true,
      previous_effective: result.previous,
      current_effective: result.current,
      status: this.qwPipeline.getStatus(),
    };
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
