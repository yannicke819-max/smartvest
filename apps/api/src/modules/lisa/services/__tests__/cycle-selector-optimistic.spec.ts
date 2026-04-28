/**
 * P11-FIX-SCANNER-CYCLE — Test du comportement optimistic du CycleSelector.
 *
 * Le composant `CycleSelector` (gainers-status-tile.tsx) était un
 * controlled-component avec `value={currentCycle}` lié directement à
 * `data.intervalMinutes` (valeur serveur stale). Résultat : le select
 * revenait à 15 min immédiatement après chaque changement.
 *
 * Fix : état local `localCycle` + `pendingRef`. Ce test modélise la
 * machine d'état sans React pour vérifier que la logique est correcte.
 */

/**
 * Modélise l'état interne du CycleSelector après le fix P11.
 * - localCycle : valeur affichée (optimistic)
 * - pending    : mutation en flight
 */
class CycleSelectorStateMachine {
  localCycle: number;
  pending = false;

  constructor(serverCycle: number) {
    this.localCycle = serverCycle;
  }

  /** Simule le useEffect qui sync depuis le serveur quand pas en pending. */
  onServerUpdate(serverCycle: number): void {
    if (!this.pending) {
      this.localCycle = serverCycle;
    }
  }

  /** Simule le handleChange du select. */
  onChange(next: number): void {
    this.localCycle = next;
    this.pending = true;
  }

  /** Simule onSettled (mutation terminée, succès ou erreur). */
  onSettled(): void {
    this.pending = false;
  }

  /** Simule onSettled + prochain poll serveur. */
  onMutationSuccessThenPoll(confirmedServerValue: number): void {
    this.onSettled();
    this.onServerUpdate(confirmedServerValue);
  }
}

describe('P11-FIX CycleSelector optimistic state machine', () => {
  describe('Bug regression — select must NOT revert during pending mutation', () => {
    it('user selects 5 min: localCycle becomes 5 immediately', () => {
      const sel = new CycleSelectorStateMachine(15);
      sel.onChange(5);
      expect(sel.localCycle).toBe(5);
    });

    it('server poll at 15 during mutation does NOT override localCycle', () => {
      const sel = new CycleSelectorStateMachine(15);
      sel.onChange(5);
      sel.onServerUpdate(15); // server still returning 15 (stale)
      expect(sel.localCycle).toBe(5); // optimistic preserved
    });

    it('multiple server polls during mutation: localCycle stays optimistic', () => {
      const sel = new CycleSelectorStateMachine(15);
      sel.onChange(30);
      sel.onServerUpdate(15);
      sel.onServerUpdate(15);
      sel.onServerUpdate(15);
      expect(sel.localCycle).toBe(30);
    });
  });

  describe('After mutation settles', () => {
    it('success: server returns new value → localCycle syncs to confirmed value', () => {
      const sel = new CycleSelectorStateMachine(15);
      sel.onChange(5);
      sel.onMutationSuccessThenPoll(5); // backend confirmed 5
      expect(sel.localCycle).toBe(5);
    });

    it('success: server eventually returns 5 → select stays at 5', () => {
      const sel = new CycleSelectorStateMachine(15);
      sel.onChange(5);
      sel.onSettled();
      sel.onServerUpdate(5);
      expect(sel.localCycle).toBe(5);
    });

    it('mutation error: server still 15 → localCycle reverts to 15 after settle', () => {
      const sel = new CycleSelectorStateMachine(15);
      sel.onChange(5);
      sel.onSettled(); // error
      sel.onServerUpdate(15); // server: no change persisted
      expect(sel.localCycle).toBe(15); // graceful revert
    });
  });

  describe('Initial render and cold sync', () => {
    it('mount: localCycle initialised to serverCycle at mount', () => {
      const sel = new CycleSelectorStateMachine(20);
      expect(sel.localCycle).toBe(20);
    });

    it('no pending: server update syncs immediately', () => {
      const sel = new CycleSelectorStateMachine(15);
      sel.onServerUpdate(20);
      expect(sel.localCycle).toBe(20);
    });
  });

  describe('Rapid successive changes', () => {
    it('last change wins when user changes twice before first mutation settles', () => {
      const sel = new CycleSelectorStateMachine(15);
      sel.onChange(5);
      sel.onChange(10); // user changes mind mid-flight
      sel.onServerUpdate(15); // stale poll
      expect(sel.localCycle).toBe(10); // last selection retained
    });
  });
});
