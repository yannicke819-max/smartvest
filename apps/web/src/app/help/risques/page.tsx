import Link from 'next/link';
import { type Route } from 'next';
import { AlertTriangle } from 'lucide-react';
import { BackButton } from '@/components/ui/back-button';

const SECTIONS = [
  {
    title: 'Le capital peut être perdu',
    body: "Tout investissement en actions, ETF, obligations ou crypto-actifs comporte un risque de perte partielle ou totale du capital investi. SmartVest ne garantit aucun rendement ni la préservation du capital.",
  },
  {
    title: 'Les performances passées ne préjugent pas des performances futures',
    body: "Les analyses et projections de SmartVest sont fondées sur des données historiques et des modèles statistiques. L'évolution future des marchés peut différer significativement des scénarios simulés.",
  },
  {
    title: "SmartVest n'est pas un conseiller financier agréé",
    body: "SmartVest est un outil d'aide à la décision, pas un service de conseil en investissement au sens de la directive MiFID II. Ses suggestions ne constituent pas des recommandations personnalisées tenant compte de votre situation patrimoniale, fiscale et de vos objectifs précis. Pour une recommandation adaptée à votre situation, consultez un conseiller financier agréé (CIF).",
  },
  {
    title: 'Risque de liquidité',
    body: "Certains actifs (petites capitalisations, crypto peu liquides) peuvent être difficiles à céder rapidement sans impact significatif sur le prix. SmartVest signale la classe d'actif concernée mais ne garantit pas la liquidité à l'exécution.",
  },
  {
    title: 'Risque de change',
    body: "Investir dans des actifs libellés en devise étrangère (USD, GBP, JPY…) expose à des fluctuations de change qui peuvent amplifier les gains ou les pertes en euros.",
  },
  {
    title: 'Risque de concentration',
    body: "Un portefeuille concentré sur un secteur, une zone géographique ou un actif unique amplifie l'impact d'un choc spécifique. La diversification réduit ce risque sans l'éliminer.",
  },
  {
    title: 'Risque lié aux crypto-actifs',
    body: "Les crypto-actifs sont des actifs hautement volatils et non régulés dans la plupart des juridictions. Leur valorisation peut varier de façon extrême sur de courtes périodes. SmartVest applique des seuils de gestion spécifiques à cette classe d'actif.",
  },
  {
    title: 'Données de marché',
    body: "SmartVest utilise des données de marché fournies par des tiers (EODHD, Binance…). Ces données peuvent être retardées, incomplètes ou temporairement indisponibles. Les décisions prises sur la base de données dégradées le sont sous la responsabilité de l'utilisateur.",
  },
];

export default function RisquesPage() {
  return (
    <div className="mx-auto max-w-2xl space-y-6 p-6">
      <BackButton />

      <div>
        <h1 className="text-xl font-semibold">Comprendre les risques</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Investir comporte des risques. Prenez connaissance des principaux avant de commencer.
        </p>
      </div>

      <div className="flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 p-4 dark:border-amber-800 dark:bg-amber-950/30">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />
        <p className="text-sm text-amber-800 dark:text-amber-300">
          <strong>Avertissement :</strong> Les performances passées ne préjugent pas
          des performances futures. Le capital investi est exposé à un risque de perte.
        </p>
      </div>

      <div className="space-y-4">
        {SECTIONS.map((s) => (
          <div key={s.title} className="rounded-lg border p-4">
            <p className="text-sm font-medium">{s.title}</p>
            <p className="mt-1.5 text-sm text-muted-foreground">{s.body}</p>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap gap-4 border-t pt-4 text-xs text-muted-foreground">
        <Link href={'/legal/mentions' as Route} className="hover:text-foreground hover:underline underline-offset-4">
          Mentions légales
        </Link>
        <Link href={'/legal/confidentialite' as Route} className="hover:text-foreground hover:underline underline-offset-4">
          Politique de confidentialité
        </Link>
        <Link href={'/legal/cgu' as Route} className="hover:text-foreground hover:underline underline-offset-4">
          CGU
        </Link>
      </div>
    </div>
  );
}
