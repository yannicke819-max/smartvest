import { GeminiRiskManagerService } from '../gemini-risk-manager.service';

describe('GeminiRiskManagerService.parseVerdict', () => {
  it('parse JSON pur valide', () => {
    const r = GeminiRiskManagerService.parseVerdict('{"verdict":"broken","confidence":0.85,"reason":"FDA rejection"}');
    expect(r).not.toBeNull();
    expect(r!.verdict).toBe('broken');
    expect(r!.confidence).toBeCloseTo(0.85);
    expect(r!.reason).toBe('FDA rejection');
  });

  it('parse JSON balanced même avec prose autour', () => {
    const content = 'Looking at the news... {"verdict":"valid","confidence":0.6,"reason":"no relevant news"} done.';
    const r = GeminiRiskManagerService.parseVerdict(content);
    expect(r).not.toBeNull();
    expect(r!.verdict).toBe('valid');
  });

  it('confidence clampé 0..1', () => {
    const r = GeminiRiskManagerService.parseVerdict('{"verdict":"broken","confidence":1.5,"reason":"x"}');
    expect(r!.confidence).toBe(1);
    const r2 = GeminiRiskManagerService.parseVerdict('{"verdict":"broken","confidence":-0.3,"reason":"x"}');
    expect(r2!.confidence).toBe(0);
  });

  it('verdict invalide → null', () => {
    expect(GeminiRiskManagerService.parseVerdict('{"verdict":"maybe","confidence":0.8,"reason":"x"}')).toBeNull();
  });

  it('JSON malformé → null', () => {
    expect(GeminiRiskManagerService.parseVerdict('not json at all')).toBeNull();
  });

  it('reason tronqué à 200 chars', () => {
    const longReason = 'x'.repeat(300);
    const r = GeminiRiskManagerService.parseVerdict(`{"verdict":"valid","confidence":0.5,"reason":"${longReason}"}`);
    expect(r!.reason.length).toBe(200);
  });
});
