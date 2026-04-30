import type { Route } from 'next';
import Link from 'next/link';
import { BackButton } from '@/components/ui/back-button';

export default function ConfidentialitePage() {
  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <BackButton />

      <div>
        <h1 className="text-xl font-semibold">Politique de confidentialité</h1>
        <p className="mt-1 text-xs text-muted-foreground">Dernière mise à jour : 30 avril 2026</p>
      </div>

      <div className="space-y-6 text-sm">
        <section className="space-y-2">
          <h2 className="font-semibold">Données collectées</h2>
          <p className="text-muted-foreground">
            SmartVest collecte uniquement les données nécessaires au fonctionnement du service :
          </p>
          <ul className="ml-4 list-disc space-y-1 text-muted-foreground">
            <li>Adresse e-mail (authentification via Supabase Auth)</li>
            <li>Prénom (optionnel, personnalisation de l'interface)</li>
            <li>Réponses au questionnaire de profil (horizon, tolérance au risque, objectif)</li>
            <li>Données de portefeuille saisies ou importées par vous (positions, transactions)</li>
            <li>Logs de connexion (horodatage, adresse IP anonymisée après 30 jours)</li>
          </ul>
        </section>

        <section className="space-y-2">
          <h2 className="font-semibold">Utilisation des données</h2>
          <ul className="ml-4 list-disc space-y-1 text-muted-foreground">
            <li>Personnaliser votre expérience et paramétrer les simulations</li>
            <li>Générer des analyses via des modèles IA (données envoyées à Anthropic/Google)</li>
            <li>Afficher des données de marché pertinentes pour votre portefeuille</li>
          </ul>
          <p className="text-muted-foreground">
            Vos données ne sont <strong>pas vendues</strong> et ne sont <strong>pas partagées</strong>
            avec des partenaires commerciaux.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="font-semibold">Sous-traitants techniques</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b">
                  <th className="py-2 text-left font-medium">Service</th>
                  <th className="py-2 text-left font-medium">Usage</th>
                  <th className="py-2 text-left font-medium">Localisation</th>
                </tr>
              </thead>
              <tbody className="divide-y text-muted-foreground">
                <tr><td className="py-2">Supabase</td><td className="py-2">Base de données, authentification</td><td className="py-2">EU (AWS Frankfurt)</td></tr>
                <tr><td className="py-2">Vercel</td><td className="py-2">Hébergement frontend</td><td className="py-2">EU / US</td></tr>
                <tr><td className="py-2">Fly.io</td><td className="py-2">API backend</td><td className="py-2">EU (Amsterdam)</td></tr>
                <tr><td className="py-2">Anthropic (Claude)</td><td className="py-2">Modèle IA pour les analyses</td><td className="py-2">US</td></tr>
                <tr><td className="py-2">EODHD</td><td className="py-2">Données de marché</td><td className="py-2">US</td></tr>
              </tbody>
            </table>
          </div>
        </section>

        <section className="space-y-2">
          <h2 className="font-semibold">Vos droits (RGPD)</h2>
          <p className="text-muted-foreground">
            Conformément au Règlement Général sur la Protection des Données (RGPD), vous disposez de :
          </p>
          <ul className="ml-4 list-disc space-y-1 text-muted-foreground">
            <li><strong>Droit d'accès</strong> : obtenir une copie de vos données</li>
            <li><strong>Droit de rectification</strong> : corriger des données inexactes</li>
            <li><strong>Droit à l'effacement</strong> : supprimer votre compte et vos données</li>
            <li><strong>Droit à la portabilité</strong> : exporter vos données au format JSON/CSV</li>
            <li><strong>Droit d'opposition</strong> : vous opposer à certains traitements</li>
          </ul>
          <p className="text-muted-foreground">
            Pour exercer vos droits : supprimez votre compte depuis les paramètres ou
            contactez l'éditeur via le dépôt GitHub.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="font-semibold">Conservation</h2>
          <p className="text-muted-foreground">
            Les données sont conservées tant que votre compte est actif.
            En cas de suppression de compte, les données sont effacées sous 30 jours,
            sauf obligation légale de conservation.
          </p>
        </section>

        <div className="flex flex-wrap gap-4 text-muted-foreground">
          <Link href={'/legal/mentions' as Route} className="text-primary underline underline-offset-4">
            Mentions légales
          </Link>
          <Link href={'/legal/cgu' as Route} className="text-primary underline underline-offset-4">
            Conditions générales
          </Link>
        </div>
      </div>
    </div>
  );
}
