/**
 * GainersExitPolicyService — façade dédiée à la boucle d'apprentissage GAINERS.
 *
 * Distille les closes des positions ouvertes par le scanner gainers
 * (`venue_fee_detail->>source = 'scanner_top_gainers'`) en politique de sortie
 * apprise (GOOD / EARLY / OK). Mince wrapper sur ExitPolicyContextService pour
 * que la séparation des deux boucles (gainers vs oversold) soit explicite côté
 * code et observabilité, demande user du 04/06/2026 ("(2) pour oversold mais
 * aussi pour gainers séparément").
 */
import { Injectable, Logger } from '@nestjs/common';
import { ExitPolicyContextService, type LearnedExitPolicy } from '../exit-policy-context.service';

const GAINERS_SOURCE = 'scanner_top_gainers';

@Injectable()
export class GainersExitPolicyService {
  private readonly logger = new Logger(GainersExitPolicyService.name);

  constructor(private readonly base: ExitPolicyContextService) {}

  /** Policy apprise sur les closes gainers du portfolio (HIGH/TRADER/MIDDLE/SMALL). */
  getLearnedPolicy(portfolioId: string): Promise<LearnedExitPolicy> {
    return this.base.getLearnedExitPolicyBySource(portfolioId, GAINERS_SOURCE);
  }
}
