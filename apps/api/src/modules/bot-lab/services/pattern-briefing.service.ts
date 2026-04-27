import { Injectable } from '@nestjs/common';
import { PatternAdoptionService } from './pattern-adoption.service';

/**
 * PatternBriefingService — Phase 4.
 *
 * Génère un bloc texte des patterns adoptés à injecter dans le briefing
 * Lisa. Différencie SUGGEST (informatif, recommandation) vs ENFORCE
 * (contraignant, Lisa doit respecter).
 *
 * OBSERVE level : pas inclus dans le briefing — purement pour audit user.
 *
 * Le service est dans bot-lab pour respecter l'architecture (le seul
 * pont entre bot-lab et lisa est lisa_pattern_adoptions). Lisa importe
 * ce service via lisa.module.ts.
 */
@Injectable()
export class PatternBriefingService {
  constructor(private readonly adoption: PatternAdoptionService) {}

  /**
   * Retourne le bloc texte à injecter dans le briefing Lisa pour un
   * portfolio. Empty string si aucun pattern adopté en SUGGEST/ENFORCE.
   */
  async getBriefingBlock(portfolioId: string): Promise<string> {
    const patterns = await this.adoption.getActiveAdoptedPatterns(portfolioId);
    const enforces = patterns.filter((p) => p.level === 'enforce');
    const suggests = patterns.filter((p) => p.level === 'suggest');

    if (enforces.length === 0 && suggests.length === 0) return '';

    const lines: string[] = [];
    lines.push('## PATTERNS ADOPTÉS — discipline issue du Bot Lab');
    lines.push('');
    lines.push(
      'Ces patterns ont été extraits de tes bots externes par le Pattern Miner ' +
      '(scoring composite robustness × edge × sample × dd) puis adoptés par toi ' +
      'pour être pris en compte dans tes propositions.',
    );
    lines.push('');

    // ── ENFORCE patterns (contraignants) ──────────────────────────
    if (enforces.length > 0) {
      lines.push('### 🔒 Patterns ENFORCE — à respecter strictement');
      lines.push('');
      lines.push(
        'Ces patterns sont contraignants. Si une thèse contredit un de ces ' +
        'patterns ENFORCE, le système la refusera. Aligne tes propositions.',
      );
      lines.push('');
      for (const p of enforces) {
        lines.push(this.formatPattern(p, true));
      }
      lines.push('');
    }

    // ── SUGGEST patterns (informatifs) ────────────────────────────
    if (suggests.length > 0) {
      lines.push('### 💡 Patterns SUGGEST — recommandations à considérer');
      lines.push('');
      lines.push(
        'Ces patterns sont informatifs. Tu peux les suivre ou les ignorer, mais ' +
        'cite-les dans ta diagnostic si tu écris une thèse qui matche un de ces ' +
        'patterns (renforce ou contredis explicitement).',
      );
      lines.push('');
      for (const p of suggests) {
        lines.push(this.formatPattern(p, false));
      }
      lines.push('');
    }

    return lines.join('\n') + '\n';
  }

  /**
   * Formate une ligne de pattern pour le briefing.
   */
  private formatPattern(
    p: Awaited<ReturnType<PatternAdoptionService['getActiveAdoptedPatterns']>>[number],
    isEnforce: boolean,
  ): string {
    const cond = p.conditions;
    const condStr = Object.entries(cond)
      .map(([k, v]) => `${k}=${String(v)}`)
      .join(', ');

    const winRate = p.winRatePct != null ? `${p.winRatePct.toFixed(0)}% win` : 'win rate inconnu';
    const exp = p.expectancyUsd ? `+$${parseFloat(p.expectancyUsd).toFixed(2)}/trade` : '';
    const score = p.compositeScore != null ? `composite ${p.compositeScore.toFixed(0)}/100` : '';

    // Feedback observed (boucle Phase 4)
    let feedback = '';
    if (p.triggeredCount > 0) {
      const liveWinRate = (p.triggeredWinningCount / p.triggeredCount) * 100;
      feedback = ` · live: ${p.triggeredCount} matches Lisa, ${liveWinRate.toFixed(0)}% won`;
    }

    const action = p.actionSignal?.action
      ? ` → action: ${p.actionSignal.action}`
      : '';

    const prefix = isEnforce ? '🔒' : '💡';
    return `- ${prefix} **${p.name}** [${condStr}]${action}\n  ${winRate} · ${exp} · ${score}${feedback}`;
  }
}
