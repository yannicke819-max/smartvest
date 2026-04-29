/**
 * P18h — VersionController tests.
 *
 * Validates :
 *   1. Reads GIT_SHA / BUILD_TIME / NODE_ENV / FLY_* from process.env
 *   2. Returns null for missing / empty env vars (instead of empty string)
 *   3. node_env defaults to 'development' if NODE_ENV is unset
 *   4. Real-world Fly-injected env vars are picked up
 */

import { VersionController } from '../version.controller';

describe('VersionController', () => {
  const ORIGINAL_ENV = process.env;
  let controller: VersionController;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...ORIGINAL_ENV };
    // Wipe vars we control in each test — only set what the test cares about
    delete process.env.GIT_SHA;
    delete process.env.BUILD_TIME;
    delete process.env.FLY_RELEASE_VERSION;
    delete process.env.FLY_APP_NAME;
    delete process.env.FLY_REGION;
    delete process.env.FLY_MACHINE_ID;
    controller = new VersionController();
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  it('returns all env vars when fully populated (production-like Fly deploy)', () => {
    process.env.GIT_SHA = '7d1f13249d2cf1e1727160d9c7d839bd2c047065';
    process.env.BUILD_TIME = '2026-04-29T10:08:47Z';
    process.env.NODE_ENV = 'production';
    process.env.FLY_RELEASE_VERSION = '259';
    process.env.FLY_APP_NAME = 'smartvest';
    process.env.FLY_REGION = 'cdg';
    process.env.FLY_MACHINE_ID = 'd8d4070a719018';

    const result = controller.getVersion();

    expect(result).toEqual({
      git_sha: '7d1f13249d2cf1e1727160d9c7d839bd2c047065',
      build_time: '2026-04-29T10:08:47Z',
      node_env: 'production',
      fly_release_id: '259',
      fly_app_name: 'smartvest',
      fly_region: 'cdg',
      fly_machine_id: 'd8d4070a719018',
    });
  });

  it('returns null for missing build-time env vars (local dev without --build-arg)', () => {
    process.env.NODE_ENV = 'development';
    // GIT_SHA + BUILD_TIME absent (npm run api:dev case)
    const result = controller.getVersion();

    expect(result.git_sha).toBeNull();
    expect(result.build_time).toBeNull();
    expect(result.node_env).toBe('development');
  });

  it('returns null for empty-string env vars (safer than returning "")', () => {
    process.env.GIT_SHA = '';
    process.env.BUILD_TIME = '';
    const result = controller.getVersion();
    expect(result.git_sha).toBeNull();
    expect(result.build_time).toBeNull();
  });

  it('falls back to "development" when NODE_ENV is unset', () => {
    delete process.env.NODE_ENV;
    const result = controller.getVersion();
    expect(result.node_env).toBe('development');
  });

  it('returns null for Fly-only vars when running outside Fly (e.g. local CI)', () => {
    process.env.NODE_ENV = 'test';
    // No FLY_* vars
    const result = controller.getVersion();
    expect(result.fly_release_id).toBeNull();
    expect(result.fly_app_name).toBeNull();
    expect(result.fly_region).toBeNull();
    expect(result.fly_machine_id).toBeNull();
  });
});
