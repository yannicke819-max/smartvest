import Link from 'next/link';
import { type Route } from 'next';
import { BackButton } from '@/components/ui/back-button';

export default function CookiesPage() {
  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <BackButton />

      <div>
        <h1 className="text-xl font-semibold">Politique de cookies</h1>
        <p className="mt-1 text-xs text-muted-foreground">Dernière mise à jour : 1er mai 2026</p>
      </div>

      <div className="space-y-6 text-sm">
        <section className="space-y-2">
          <h2 className="font-semibold">1. Qu'est-ce qu'un cookie ?</h2>
          <p className="text-muted-foreground">
            Un cookie est un petit fichier texte déposé sur votre appareil lors de votre visite
            sur un site web. Il permet au site de mémoriser vos préférences ou de vous
            reconnaître lors de visites ultérieures.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="font-semibold">2. Cookies utilisés par SmartVest</h2>

          <div className="rounded-lg border overflow-hidden">
            <table className="w-full text-xs">
              <thead className="bg-muted/50">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">Cookie</th>
                  <th className="px-3 py-2 text-left font-medium">Finalité</th>
                  <th className="px-3 py-2 text-left font-medium">Durée</th>
                  <th className="px-3 py-2 text-left font-medium">Type</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                <tr>
                  <td className="px-3 py-2 font-mono">sb-*</td>
                  <td className="px-3 py-2 text-muted-foreground">Session utilisateur (Supabase Auth)</td>
                  <td className="px-3 py-2 text-muted-foreground">Session / 7 jours</td>
                  <td className="px-3 py-2">
                    <span className="rounded-full bg-blue-100 px-2 py-0.5 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300">
                      Essentiel
                    </span>
                  </td>
                </tr>
                <tr>
                  <td className="px-3 py-2 font-mono">smartvest_*</td>
                  <td className="px-3 py-2 text-muted-foreground">
                    Préférences UI (tour de bienvenue, glossaire, mode d'affichage)
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">Persistant (localStorage)</td>
                  <td className="px-3 py-2">
                    <span className="rounded-full bg-blue-100 px-2 py-0.5 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300">
                      Essentiel
                    </span>
                  </td>
                </tr>
                <tr>
                  <td className="px-3 py-2 font-mono">__vercel_*</td>
                  <td className="px-3 py-2 text-muted-foreground">Routage réseau (CDN Vercel)</td>
                  <td className="px-3 py-2 text-muted-foreground">Session</td>
                  <td className="px-3 py-2">
                    <span className="rounded-full bg-blue-100 px-2 py-0.5 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300">
                      Technique
                    </span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <p className="text-xs text-muted-foreground">
            SmartVest n'utilise <strong>pas</strong> de cookies publicitaires, de tracking
            tiers (Google Analytics, Meta Pixel, etc.) ou de profilage comportemental.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="font-semibold">3. Cookies essentiels</h2>
          <p className="text-muted-foreground">
            Les cookies essentiels sont indispensables au fonctionnement de SmartVest
            (authentification, sécurité de session, préférences d'interface). Ils ne peuvent
            pas être refusés sans rendre le service inaccessible. Ils ne nécessitent pas votre
            consentement au sens du RGPD (art. 5 §3 directive ePrivacy, exemption cookies
            strictement nécessaires).
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="font-semibold">4. Comment gérer vos cookies ?</h2>
          <p className="text-muted-foreground">
            Vous pouvez à tout moment supprimer les cookies déposés par SmartVest via les
            paramètres de votre navigateur (Paramètres → Confidentialité → Cookies). La
            suppression des cookies de session vous déconnectera.
          </p>
          <p className="text-muted-foreground">
            Les préférences UI (tour de bienvenue, etc.) sont stockées en <strong>localStorage</strong>,
            pas dans des cookies HTTP. Vous pouvez les effacer via les outils développeur de votre
            navigateur (Application → Local Storage).
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="font-semibold">5. Contact</h2>
          <p className="text-muted-foreground">
            Pour toute question relative aux cookies ou à la protection de vos données,
            contactez-nous via la{' '}
            <Link href={'/help/contact' as Route} className="text-primary hover:underline underline-offset-4">
              page Contact
            </Link>{' '}
            ou consultez notre{' '}
            <Link href={'/legal/confidentialite' as Route} className="text-primary hover:underline underline-offset-4">
              politique de confidentialité
            </Link>.
          </p>
        </section>
      </div>

      <div className="flex flex-wrap gap-4 border-t pt-4 text-xs text-muted-foreground">
        <Link href={'/legal/mentions' as Route} className="hover:text-foreground hover:underline underline-offset-4">
          Mentions légales
        </Link>
        <Link href={'/legal/cgu' as Route} className="hover:text-foreground hover:underline underline-offset-4">
          CGU
        </Link>
        <Link href={'/legal/confidentialite' as Route} className="hover:text-foreground hover:underline underline-offset-4">
          Confidentialité
        </Link>
      </div>
    </div>
  );
}
