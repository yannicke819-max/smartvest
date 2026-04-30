import type { Route } from 'next';
import Link from 'next/link';
import { BackButton } from '@/components/ui/back-button';

export default function MentionsLegalesPage() {
  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <BackButton />

      <div>
        <h1 className="text-xl font-semibold">Mentions légales</h1>
        <p className="mt-1 text-xs text-muted-foreground">Dernière mise à jour : 30 avril 2026</p>
      </div>

      <div className="space-y-6 text-sm">
        <section className="space-y-2">
          <h2 className="font-semibold">Éditeur</h2>
          <p className="text-muted-foreground">
            SmartVest est un outil personnel de suivi et de simulation d'investissement,
            édité à titre privé. Il n'est pas exploité par une personne morale enregistrée
            à des fins commerciales à ce stade.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="font-semibold">Hébergement</h2>
          <p className="text-muted-foreground">
            L'application est hébergée sur l'infrastructure <strong>Vercel</strong> (frontend)
            et <strong>Fly.io</strong> (API), avec une base de données <strong>Supabase</strong>.
            Ces services sont soumis à leurs propres conditions générales.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="font-semibold">Nature du service</h2>
          <p className="text-muted-foreground">
            SmartVest est un <strong>outil d'aide à la décision</strong> pour investisseurs
            particuliers. Il ne constitue pas :
          </p>
          <ul className="ml-4 list-disc space-y-1 text-muted-foreground">
            <li>un conseil en investissement au sens de la directive MiFID II ;</li>
            <li>une recommandation personnalisée fondée sur votre situation patrimoniale complète ;</li>
            <li>un service de gestion de portefeuille sous mandat réglementé ;</li>
            <li>un prestataire de services sur actifs numériques (PSAN) enregistré auprès de l'AMF.</li>
          </ul>
          <p className="text-muted-foreground">
            Les simulations et analyses produites sont à visée éducative et personnelle.
            <strong> Les performances passées ne préjugent pas des performances futures.</strong>
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="font-semibold">Propriété intellectuelle</h2>
          <p className="text-muted-foreground">
            Le code source de SmartVest est la propriété de son auteur. Les données de marché
            sont fournies par des tiers (EODHD, Binance, FRED) et soumises à leurs licences respectives.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="font-semibold">Liens</h2>
          <div className="flex flex-wrap gap-4 text-muted-foreground">
            <Link href={'/legal/confidentialite' as Route} className="text-primary underline underline-offset-4">
              Politique de confidentialité
            </Link>
            <Link href={'/legal/cgu' as Route} className="text-primary underline underline-offset-4">
              Conditions générales d'utilisation
            </Link>
          </div>
        </section>
      </div>
    </div>
  );
}
