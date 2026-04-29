/**
 * P18h — `GET /version` exposes deploy metadata for external visibility
 * (no flyctl/admin required).
 *
 * Built from env vars injected at Docker build time + Fly runtime env :
 *   - GIT_SHA       : passed via `flyctl deploy --build-arg GIT_SHA=...`
 *   - BUILD_TIME    : passed at build (ISO-8601 UTC)
 *   - NODE_ENV      : runtime
 *   - FLY_IMAGE_REF : injected automatically by Fly at runtime, e.g.
 *                     "registry.fly.io/smartvest:deployment-08c46fc7b789...".
 *                     P18h.1 — replaces FLY_RELEASE_VERSION (which is NOT
 *                     auto-injected by Fly Machines, contrary to my earlier
 *                     assumption — P18h shipped with that field always null).
 *
 * P19w (29/04/2026 19:50 UTC) — Fallback file read pour resilience au layer
 * caching Docker. Observation prod : workflow run #204 succeeded mais
 * `/version` retournait `git_sha=null` car les ENV layers étaient cachés
 * malgré --build-arg passé. Le Dockerfile écrit maintenant les valeurs dans
 * `/build_meta/git_sha.txt` + `/build_meta/build_time.txt` baked au build.
 * On lit ces fichiers en priorité, ENV en fallback. Boot log pour traçabilité.
 *
 * Designed to resolve the visibility blind spot observed during the v258
 * failed-deploy / v259 success episode (29/04/2026 ~10:03–10:12 UTC) :
 * `/health` returned 200 from both the old and new binary indistinguishably.
 */

import { Controller, Get, Logger, OnModuleInit } from '@nestjs/common';
import { readFileSync } from 'node:fs';

interface VersionResponse {
  git_sha: string | null;
  build_time: string | null;
  node_env: string;
  fly_image_ref: string | null;
  fly_app_name: string | null;
  fly_region: string | null;
  fly_machine_id: string | null;
}

/**
 * P19w — Lecture sûre de /build_meta/{key}.txt baked au build.
 * Retourne null si fichier absent / vide / trim vide.
 */
function readBuildMetaFile(filename: string): string | null {
  try {
    const content = readFileSync(`/build_meta/${filename}`, 'utf-8').trim();
    return content.length > 0 ? content : null;
  } catch {
    return null;
  }
}

@Controller('version')
export class VersionController implements OnModuleInit {
  private readonly logger = new Logger(VersionController.name);

  /** P19w — Boot log pour traçabilité Fly logs. Permet de grep au démarrage
   *  si le binary tournant en prod a bien capté GIT_SHA / BUILD_TIME. */
  onModuleInit(): void {
    const meta = this.resolveMeta();
    this.logger.log(
      `[version] git_sha=${meta.git_sha ?? 'null'} build_time=${meta.build_time ?? 'null'} ` +
      `node_env=${meta.node_env} fly_image=${(meta.fly_image_ref ?? 'null').slice(-50)}`,
    );
  }

  @Get()
  getVersion(): VersionResponse {
    return this.resolveMeta();
  }

  /** P19w — Résolution avec priorité : ENV → fichier baked. */
  private resolveMeta(): VersionResponse {
    const envOrFile = (envKey: string, fileBasename: string): string | null => {
      const envVal = process.env[envKey];
      if (envVal && envVal.length > 0) return envVal;
      return readBuildMetaFile(fileBasename);
    };
    const env = (key: string): string | null => {
      const v = process.env[key];
      return v && v.length > 0 ? v : null;
    };
    return {
      git_sha: envOrFile('GIT_SHA', 'git_sha.txt'),
      build_time: envOrFile('BUILD_TIME', 'build_time.txt'),
      node_env: process.env['NODE_ENV'] ?? 'development',
      fly_image_ref: env('FLY_IMAGE_REF'),
      fly_app_name: env('FLY_APP_NAME'),
      fly_region: env('FLY_REGION'),
      fly_machine_id: env('FLY_MACHINE_ID'),
    };
  }
}
