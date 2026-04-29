/**
 * P18h — `GET /version` exposes deploy metadata for external visibility
 * (no flyctl/admin required).
 *
 * Built from env vars injected at Docker build time + Fly runtime env :
 *   - GIT_SHA             : passed via `flyctl deploy --build-arg GIT_SHA=...`
 *   - BUILD_TIME          : passed at build (ISO-8601 UTC)
 *   - NODE_ENV            : runtime
 *   - FLY_RELEASE_VERSION : injected automatically by Fly at runtime (e.g. "v259")
 *
 * Designed to resolve the visibility blind spot observed during the v258
 * failed-deploy / v259 success episode (29/04/2026 ~10:03–10:12 UTC) :
 * `/health` returned 200 from both the old and new binary indistinguishably.
 */

import { Controller, Get } from '@nestjs/common';

interface VersionResponse {
  git_sha: string | null;
  build_time: string | null;
  node_env: string;
  fly_release_id: string | null;
  fly_app_name: string | null;
  fly_region: string | null;
  fly_machine_id: string | null;
}

@Controller('version')
export class VersionController {
  @Get()
  getVersion(): VersionResponse {
    const env = (key: string): string | null => {
      const v = process.env[key];
      return v && v.length > 0 ? v : null;
    };
    return {
      git_sha: env('GIT_SHA'),
      build_time: env('BUILD_TIME'),
      node_env: process.env['NODE_ENV'] ?? 'development',
      fly_release_id: env('FLY_RELEASE_VERSION'),
      fly_app_name: env('FLY_APP_NAME'),
      fly_region: env('FLY_REGION'),
      fly_machine_id: env('FLY_MACHINE_ID'),
    };
  }
}
