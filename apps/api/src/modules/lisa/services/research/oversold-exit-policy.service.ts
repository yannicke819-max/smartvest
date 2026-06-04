/**
 * OversoldExitPolicyService — façade dédiée à la boucle d'apprentissage OVERSOLD.
 *
 * Distille les closes des positions ouvertes par l'OversoldScannerService
 * (`venue_fee_detail->>source = 'scanner_oversold'`) en politique de sortie
 * apprise spécifique au mean-reversion swing J+10. Séparée de gainers (scalp
 * 5-60min) parce que les patterns de give-back, RSI, momentum sont radicalement
 * différents entre les deux modes.
 *
 * Mince wrapper sur ExitPolicyContextService. Demande user du 04/06/2026
 * ("(2) pour oversold mais aussi pour gainers séparément"). Pas encore câblé
 * dans OversoldExitService — d'abord on collecte la data et on expose via
 * endpoint pour observation. Cabling = follow-up quand sample suffisant.
 */
import { Injectable, Logger } from '@nestjs/common';
import { ExitPolicyContextService, type LearnedExitPolicy } from '../exit-policy-context.service';

const OVERSOLD_SOURCE = 'scanner_oversold';

@Injectable()
export class OversoldExitPolicyService {
  private readonly logger = new Logger(OversoldExitPolicyService.name);

  constructor(private readonly base: ExitPolicyContextService) {}

  /** Policy apprise sur les closes oversold du portfolio (typiquement HIGH). */
  getLearnedPolicy(portfolioId: string): Promise<LearnedExitPolicy> {
    return this.base.getLearnedExitPolicyBySource(portfolioId, OVERSOLD_SOURCE);
  }
}
