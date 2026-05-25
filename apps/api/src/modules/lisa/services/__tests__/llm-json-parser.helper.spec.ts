/**
 * Tests parseLlmJson — robustesse Gemini fence backticks.
 */
import { parseLlmJson, stripCodeFence, extractFirstBalanced } from '../llm-json-parser.helper';

describe('llm-json-parser', () => {
  describe('stripCodeFence', () => {
    it('strippe ```json ... ```', () => {
      expect(stripCodeFence('```json\n{"a":1}\n```')).toBe('{"a":1}');
    });
    it('strippe ``` ... ``` sans langage', () => {
      expect(stripCodeFence('```\n{"a":1}\n```')).toBe('{"a":1}');
    });
    it('passe une chaîne sans fence telle quelle', () => {
      expect(stripCodeFence('{"a":1}')).toBe('{"a":1}');
    });
    it('tolère espaces et casse', () => {
      expect(stripCodeFence('   ```JSON\n{"a":1}\n```  ')).toBe('{"a":1}');
    });
  });

  describe('extractFirstBalanced', () => {
    it('extrait objet balanced ignorant prose autour', () => {
      expect(extractFirstBalanced('blabla {"a":1} fin')).toBe('{"a":1}');
    });
    it('extrait tableau balanced', () => {
      expect(extractFirstBalanced('voici: ["A","B"] OK')).toBe('["A","B"]');
    });
    it('respecte les strings contenant } [', () => {
      const input = '{"text":"hello { world }","n":1}';
      expect(extractFirstBalanced(input)).toBe(input);
    });
    it('null si rien trouvé', () => {
      expect(extractFirstBalanced('aucun json')).toBeNull();
    });
  });

  describe('parseLlmJson', () => {
    it('parse direct quand pas de fence', () => {
      expect(parseLlmJson<{ a: number }>('{"a":1}')).toEqual({ a: 1 });
    });

    it('parse JSON fence par Gemini (regression prod 25/05)', () => {
      const geminiResponse = '```json\n[\n  "BTCUSDT",\n  "AAPL"\n]\n```';
      expect(parseLlmJson<string[]>(geminiResponse)).toEqual(['BTCUSDT', 'AAPL']);
    });

    it('parse objet fence', () => {
      const r = '```json\n{"pass":true,"signal_quality":0.85,"reason":"strong"}\n```';
      expect(parseLlmJson(r)).toEqual({ pass: true, signal_quality: 0.85, reason: 'strong' });
    });

    it('parse prose + balanced fallback', () => {
      const r = 'Here is the answer: {"pass":false,"signal_quality":0.2,"reason":"weak"}';
      expect(parseLlmJson(r)).toEqual({ pass: false, signal_quality: 0.2, reason: 'weak' });
    });

    it('parse array prose + balanced', () => {
      expect(parseLlmJson<string[]>('Réponse: ["A","B","C"] voilà.')).toEqual(['A', 'B', 'C']);
    });

    it('null si vraiment pas parsable', () => {
      expect(parseLlmJson('aucun JSON ici')).toBeNull();
    });

    it('null pour input vide', () => {
      expect(parseLlmJson('')).toBeNull();
    });

    it('idempotent : objet JSON déjà propre', () => {
      const obj = { a: 1, b: 'x' };
      expect(parseLlmJson(JSON.stringify(obj))).toEqual(obj);
    });
  });
});
