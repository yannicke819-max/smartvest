import type { Route } from 'next';
import Link from 'next/link';
import { BackButton } from '@/components/ui/back-button';

export default function CguPage() {
  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <BackButton />

      <div>
        <h1 className="text-xl font-semibold">Conditions générales d'utilisation</h1>
        <p className="mt-1 text-xs text-muted-foreground">Dernière mise à jour : 30 avril 2026</p>
      </div>

      <div className="space-y-6 text-sm">
        <section className="rounded-lg border border-amber-200 bg-amber-50 p-4 dark:border-amber-800 dark:bg-amber-900/20">
          <p className="text-xs text-amber-800 dark:text-amber-300">
            <strong>Document en cours de rédaction.</strong> Ces conditions sont provisoires
            et n'ont pas été validées par un expert juridique. Elles seront mises à jour
            avant tout déploiement public.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="font-semibold">1. Objet</h2>
          <p className="text-muted-foreground">
            SmartVest est un outil personnel de suivi et de simulation d'investissement.
            Son utilisation est soumise aux présentes conditions générales.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="font-semibold">2. Nature du service</h2>
          <p className="text-muted-foreground">
            SmartVest fournit des <strong>analyses, simulations et suggestions</strong>
            à titre informatif et éducatif uniquement. Il ne constitue pas :
          </p>
          <ul className="ml-4 list-disc space-y-1 text-muted-foreground">
            <li>un conseil en investissement réglementé au sens de MiFID II ;</li>
            <li>une recommandation personnalisée fondée sur votre situation complète ;</li>
            <li>une garantie de rendement ou de performance.</li>
          </ul>
        </section>

        <section className="space-y-2">
          <h2 className="font-semibold">3. Responsabilité utilisateur</h2>
          <p className="text-muted-foreground">
            L'utilisateur est seul responsable de ses décisions d'investissement.
            SmartVest, ses auteurs et contributeurs ne pourront être tenus responsables
            de pertes financières résultant de l'utilisation du service.
          </p>
          <p className="text-muted-foreground">
            <strong>Les performances passées ne préjugent pas des performances futures.</strong>
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="font-semibold">4. Simulations</h2>
          <p className="text-muted-foreground">
            Les portefeuilles en mode simulation sont entièrement virtuels. Aucun ordre
            réel n'est transmis à un broker. Les résultats simulés ne représentent pas
            des gains ou pertes réels.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="font-semibold">5. Données de marché</h2>
          <p className="text-muted-foreground">
            Les cours affichés sont fournis par des sources tierces (EODHD, Binance, FRED)
            et peuvent être en différé de 15 minutes. Ils ne constituent pas des données
            en temps réel et ne doivent pas être utilisés pour du trading en direct.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="font-semibold">6. Modifications</h2>
          <p className="text-muted-foreground">
            Ces conditions peuvent être modifiées à tout moment. Les utilisateurs seront
            notifiés des changements significatifs.
          </p>
        </section>

        <div className="flex flex-wrap gap-4 text-muted-foreground">
          <Link href={'/legal/mentions' as Route} className="text-primary underline underline-offset-4">
            Mentions légales
          </Link>
          <Link href={'/legal/confidentialite' as Route} className="text-primary underline underline-offset-4">
            Politique de confidentialité
          </Link>
        </div>
      </div>
    </div>
  );
}
