import { Injectable } from '@nestjs/common';
import { v4 as uuid } from 'uuid';
import type {
  SectorExposureLink,
  AssetExposureLink,
  ExposureDirection,
  SignalConfidence,
} from '@smartvest/domain';

// Static knowledge base: signal category → affected sectors and direction
const SECTOR_IMPACT_MAP: Record<string, { sector: string; direction: ExposureDirection; rationale: string }[]> = {
  central_bank_decision: [
    { sector: 'financials', direction: 'positive', rationale: 'Hausse des taux favorise les marges bancaires' },
    { sector: 'real_estate', direction: 'negative', rationale: 'Coût du crédit accru pèse sur la valorisation immobilière' },
    { sector: 'utilities', direction: 'negative', rationale: 'Secteurs défensifs à fort levier sensibles aux taux' },
    { sector: 'technology', direction: 'negative', rationale: 'Valorisation des titres de croissance comprimée par la hausse des taux' },
  ],
  inflation_data: [
    { sector: 'energy', direction: 'positive', rationale: 'Matières premières énergétiques bénéficient de l\'inflation' },
    { sector: 'materials', direction: 'positive', rationale: 'Les matières premières servent de couverture contre l\'inflation' },
    { sector: 'consumer_staples', direction: 'uncertain', rationale: 'La compression des marges peut compenser la hausse des prix' },
    { sector: 'consumer_discretionary', direction: 'negative', rationale: 'Pouvoir d\'achat des ménages affecté' },
  ],
  geopolitical_tension: [
    { sector: 'defense', direction: 'positive', rationale: 'Hausse des dépenses militaires en période de tension' },
    { sector: 'energy', direction: 'positive', rationale: 'Perturbation des approvisionnements en énergie' },
    { sector: 'technology', direction: 'negative', rationale: 'Disruption des chaînes d\'approvisionnement mondiales' },
    { sector: 'emerging_markets', direction: 'negative', rationale: 'Fuite vers la qualité défavorable aux marchés émergents' },
  ],
  fx_move: [
    { sector: 'exporters', direction: 'uncertain', rationale: 'Dépend du sens de la variation et de la devise concernée' },
    { sector: 'importers', direction: 'uncertain', rationale: 'Dépend du sens de la variation et de la devise concernée' },
    { sector: 'tourism', direction: 'uncertain', rationale: 'Compétitivité-prix dépend de la monnaie locale' },
  ],
  commodity_move: [
    { sector: 'energy', direction: 'uncertain', rationale: 'Dépend de la direction du mouvement des matières premières' },
    { sector: 'materials', direction: 'uncertain', rationale: 'Lié aux prix des matières premières industrielles' },
    { sector: 'airlines', direction: 'negative', rationale: 'Hausse du carburant réduit les marges' },
    { sector: 'chemicals', direction: 'negative', rationale: 'Coûts des intrants plus élevés' },
  ],
  market_stress: [
    { sector: 'financials', direction: 'negative', rationale: 'Risque de crédit et liquidité élevés en période de stress' },
    { sector: 'technology', direction: 'negative', rationale: 'Fuite vers des valeurs refuges' },
    { sector: 'gold_miners', direction: 'positive', rationale: 'L\'or comme valeur refuge bénéficie du stress marché' },
  ],
  election_event: [
    { sector: 'healthcare', direction: 'uncertain', rationale: 'Politique de santé dépend des orientations du nouveau gouvernement' },
    { sector: 'energy', direction: 'uncertain', rationale: 'Politique énergétique et climatique en jeu' },
    { sector: 'defense', direction: 'uncertain', rationale: 'Budgets militaires liés aux priorités politiques' },
  ],
  regulatory_change: [
    { sector: 'financials', direction: 'uncertain', rationale: 'Nouvelles contraintes réglementaires possibles' },
    { sector: 'technology', direction: 'uncertain', rationale: 'Anti-trust, privacy, IA — dépend du texte' },
    { sector: 'pharmaceuticals', direction: 'uncertain', rationale: 'Réglementation des prix ou AMM' },
  ],
  growth_data: [
    { sector: 'consumer_discretionary', direction: 'uncertain', rationale: 'Croissance soutient la consommation' },
    { sector: 'industrials', direction: 'uncertain', rationale: 'Lié au cycle économique' },
  ],
  employment_data: [
    { sector: 'consumer_discretionary', direction: 'uncertain', rationale: 'Emploi = revenu disponible = consommation' },
    { sector: 'real_estate', direction: 'uncertain', rationale: 'Emploi plein favorise la demande immobilière' },
  ],
  credit_event: [
    { sector: 'financials', direction: 'negative', rationale: 'Risque de contagion et pertes de crédit' },
    { sector: 'high_yield', direction: 'negative', rationale: 'Spreads s\'écartent en cas d\'événement de crédit' },
  ],
  earnings_surprise: [
    { sector: 'technology', direction: 'uncertain', rationale: 'Dépend du secteur de l\'entreprise concernée' },
  ],
};

// Asset class sensitivities by signal category
const ASSET_CLASS_IMPACT: Record<string, { assetClass: string; direction: ExposureDirection; magnitudePct: string }[]> = {
  central_bank_decision: [
    { assetClass: 'bonds', direction: 'negative', magnitudePct: '3.5' },
    { assetClass: 'equity', direction: 'negative', magnitudePct: '2.0' },
    { assetClass: 'cash', direction: 'positive', magnitudePct: '0.5' },
  ],
  inflation_data: [
    { assetClass: 'bonds', direction: 'negative', magnitudePct: '2.0' },
    { assetClass: 'commodities', direction: 'positive', magnitudePct: '3.0' },
    { assetClass: 'real_estate', direction: 'uncertain', magnitudePct: '1.5' },
  ],
  geopolitical_tension: [
    { assetClass: 'equity', direction: 'negative', magnitudePct: '4.0' },
    { assetClass: 'commodities', direction: 'positive', magnitudePct: '5.0' },
    { assetClass: 'gold', direction: 'positive', magnitudePct: '3.0' },
    { assetClass: 'bonds', direction: 'positive', magnitudePct: '1.0' },
  ],
  market_stress: [
    { assetClass: 'equity', direction: 'negative', magnitudePct: '8.0' },
    { assetClass: 'high_yield', direction: 'negative', magnitudePct: '5.0' },
    { assetClass: 'gold', direction: 'positive', magnitudePct: '4.0' },
    { assetClass: 'government_bonds', direction: 'positive', magnitudePct: '2.5' },
  ],
};

@Injectable()
export class ImpactMapperService {
  mapSectorExposures(
    category: string,
    severity: string,
    confidence: SignalConfidence,
  ): SectorExposureLink[] {
    const sectors = SECTOR_IMPACT_MAP[category] ?? [];
    return sectors.map((s) => ({
      ...s,
      magnitudePct: this.scaleByConfidence(this.estimateMagnitude(severity), confidence),
      affectedAssetClasses: this.inferAssetClassesForSector(s.sector),
    }));
  }

  mapAssetExposures(
    category: string,
    portfolioAssets: { assetId: string; ticker: string; isin: string | null; assetClass: string }[],
    severity: string,
    confidence: SignalConfidence,
  ): AssetExposureLink[] {
    const assetClassImpacts = ASSET_CLASS_IMPACT[category] ?? [];
    const result: AssetExposureLink[] = [];

    for (const asset of portfolioAssets) {
      const impact = assetClassImpacts.find((a) => a.assetClass === asset.assetClass);
      if (!impact) continue;

      result.push({
        assetId: asset.assetId,
        ticker: asset.ticker,
        isin: asset.isin,
        direction: impact.direction,
        magnitudePct: this.scaleByConfidence(impact.magnitudePct, confidence),
        rationale: `Impact classe d'actifs "${asset.assetClass}" sur signal "${category}"`,
        confidence,
      });
    }

    return result;
  }

  private estimateMagnitude(severity: string): string {
    const magnitudes: Record<string, string> = {
      info: '0.5',
      watch: '1.5',
      warning: '3.0',
      critical: '5.0',
      systemic: '10.0',
    };
    return magnitudes[severity] ?? '2.0';
  }

  private scaleByConfidence(baseMagnitude: string, confidence: SignalConfidence): string {
    const scales: Record<SignalConfidence, number> = { low: 0.4, medium: 0.7, high: 1.0 };
    const scaled = parseFloat(baseMagnitude) * scales[confidence];
    return scaled.toFixed(2);
  }

  private inferAssetClassesForSector(sector: string): string[] {
    const map: Record<string, string[]> = {
      financials: ['equity', 'bonds'],
      technology: ['equity'],
      energy: ['equity', 'commodities'],
      real_estate: ['real_estate', 'equity'],
      consumer_discretionary: ['equity'],
      consumer_staples: ['equity'],
      materials: ['equity', 'commodities'],
      utilities: ['equity', 'bonds'],
      healthcare: ['equity'],
      industrials: ['equity'],
      defense: ['equity'],
    };
    return map[sector] ?? ['equity'];
  }

  buildAssessmentId(): string {
    return uuid();
  }
}
