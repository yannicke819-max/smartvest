import { EventNarrativeInterpreterService } from '../event-narrative-interpreter.service';

describe('EventNarrativeInterpreterService.parseToneJson', () => {
  it('parse JSON valide tous tons', () => {
    for (const tone of ['hawkish', 'dovish', 'neutral', 'mixed']) {
      const r = EventNarrativeInterpreterService.parseToneJson(
        `{"tone":"${tone}","market_implication":"buy XYZ","confidence":0.8}`,
      );
      expect(r!.tone).toBe(tone);
    }
  });

  it('parse JSON embed dans prose', () => {
    const r = EventNarrativeInterpreterService.parseToneJson(
      'Analysis: {"tone":"hawkish","market_implication":"USD up","confidence":0.9} done.',
    );
    expect(r!.tone).toBe('hawkish');
    expect(r!.market_implication).toBe('USD up');
  });

  it('tone invalide → null', () => {
    expect(EventNarrativeInterpreterService.parseToneJson('{"tone":"bullish","market_implication":"x","confidence":0.5}')).toBeNull();
  });

  it('confidence clampé 0..1', () => {
    const r = EventNarrativeInterpreterService.parseToneJson('{"tone":"neutral","market_implication":"x","confidence":2.5}');
    expect(r!.confidence).toBe(1);
  });

  it('market_implication tronqué à 250 chars', () => {
    const long = 'y'.repeat(400);
    const r = EventNarrativeInterpreterService.parseToneJson(
      `{"tone":"dovish","market_implication":"${long}","confidence":0.6}`,
    );
    expect(r!.market_implication.length).toBe(250);
  });

  it('no JSON → null', () => {
    expect(EventNarrativeInterpreterService.parseToneJson('no json content here')).toBeNull();
  });
});
