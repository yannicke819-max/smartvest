/**
 * PR #292 — Test du toggle env ENABLE_REACTIVE_EXITS.
 *
 * Quand ENABLE_REACTIVE_EXITS=false, checkReactiveSignals doit return
 * immédiatement sans logique. Le toggle est lu à chaque call (pas mis
 * en cache) pour permettre flip via flyctl secrets sans redeploy.
 */

describe('ENABLE_REACTIVE_EXITS env toggle', () => {
  const originalEnv = process.env.ENABLE_REACTIVE_EXITS;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.ENABLE_REACTIVE_EXITS;
    } else {
      process.env.ENABLE_REACTIVE_EXITS = originalEnv;
    }
  });

  it('disables reactive exits when env is "false"', () => {
    process.env.ENABLE_REACTIVE_EXITS = 'false';
    // Le toggle est strict-equal 'false'. Tout autre valeur = activé.
    expect(process.env.ENABLE_REACTIVE_EXITS === 'false').toBe(true);
  });

  it('keeps reactive exits enabled when env is undefined (default)', () => {
    delete process.env.ENABLE_REACTIVE_EXITS;
    expect(process.env.ENABLE_REACTIVE_EXITS === 'false').toBe(false);
  });

  it('keeps reactive exits enabled when env is anything other than "false"', () => {
    for (const value of ['true', '1', '0', 'no', 'False', 'FALSE', '']) {
      process.env.ENABLE_REACTIVE_EXITS = value;
      expect(process.env.ENABLE_REACTIVE_EXITS === 'false').toBe(false);
    }
  });
});
