import { CryptoFundingFadeService } from '../crypto-funding-fade.service';

describe('CryptoFundingFadeService.classifyTrigger', () => {
  const threshold = 0.0005; // 0.05% per cycle

  it('funding > threshold → above_threshold (fade SHORT)', () => {
    expect(CryptoFundingFadeService.classifyTrigger(0.001, threshold)).toBe('above_threshold');
    expect(CryptoFundingFadeService.classifyTrigger(0.00051, threshold)).toBe('above_threshold');
  });

  it('funding < -threshold → below_threshold (fade LONG)', () => {
    expect(CryptoFundingFadeService.classifyTrigger(-0.001, threshold)).toBe('below_threshold');
    expect(CryptoFundingFadeService.classifyTrigger(-0.0006, threshold)).toBe('below_threshold');
  });

  it('funding entre bornes → neutral', () => {
    expect(CryptoFundingFadeService.classifyTrigger(0.0001, threshold)).toBe('neutral');
    expect(CryptoFundingFadeService.classifyTrigger(0, threshold)).toBe('neutral');
    expect(CryptoFundingFadeService.classifyTrigger(-0.0003, threshold)).toBe('neutral');
  });

  it('exactement à la borne → neutral (strict >)', () => {
    expect(CryptoFundingFadeService.classifyTrigger(threshold, threshold)).toBe('neutral');
    expect(CryptoFundingFadeService.classifyTrigger(-threshold, threshold)).toBe('neutral');
  });
});
