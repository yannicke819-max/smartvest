'use client';

import { useState } from 'react';
import Link from 'next/link';
import { type Route } from 'next';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { BackButton } from '@/components/ui/back-button';

const FAQ: Array<{ q: string; a: string }> = [
  {
    q: "Qu'est-ce que SmartVest ?",
    a: "SmartVest est une plateforme d'aide à la décision en investissement personnel. Elle analyse votre portefeuille, simule des scénarios et vous soumet des suggestions. Vous restez toujours décisionnaire.",
  },
  {
    q: 'SmartVest passe-t-il des ordres automatiquement ?',
    a: "Non. Par défaut, SmartVest est en mode \"analyse et suggestion\" uniquement. Aucune action n'est exécutée sans votre validation explicite. Si vous activez le mode autonome (Lisa), les paramètres sont définis par vous et peuvent être désactivés à tout moment via le bouton d'arrêt d'urgence.",
  },
  {
    q: 'Mes données sont-elles en sécurité ?',
    a: "Vos données sont stockées de manière chiffrée. SmartVest n'a pas accès à vos comptes broker sauf si vous les connectez explicitement, et uniquement en lecture seule. Vos identifiants broker ne sont jamais visibles côté application.",
  },
  {
    q: 'SmartVest est-il un conseiller financier agréé ?',
    a: "Non. SmartVest est un outil d'aide à la décision, pas un conseiller financier au sens réglementaire (MiFID). Ses analyses et suggestions sont des simulations et projections, pas des recommandations personnalisées. Pour une recommandation personnalisée, consultez un conseiller financier agréé.",
  },
  {
    q: "Les performances affichées sont-elles garanties ?",
    a: "Non. Toutes les projections sont des simulations basées sur des hypothèses. Les performances passées ne préjugent pas des performances futures. Le capital investi en bourse peut être partiellement ou totalement perdu.",
  },
  {
    q: "Comment fonctionne l'assistant Lisa ?",
    a: "Lisa est un assistant d'analyse propulsé par IA. Elle étudie votre portefeuille, les données de marché et vous propose des pistes d'optimisation ou d'action. Chaque suggestion inclut les hypothèses retenues et une estimation de l'impact.",
  },
  {
    q: "Puis-je utiliser SmartVest pour gérer un PEA ou une assurance vie ?",
    a: "SmartVest peut afficher et analyser le contenu de votre PEA ou assurance vie si vous saisissez vos positions. La gestion directe (ordres) dépend de la connexion broker disponible pour votre intermédiaire.",
  },
  {
    q: "Comment signaler un problème ou une idée ?",
    a: "Via la page Contact dans l'Aide, ou directement via les issues GitHub du projet. Nous lisons tous les retours.",
  },
];

function FaqItem({ q, a }: { q: string; a: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-b last:border-b-0">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center justify-between gap-4 py-4 text-left"
        aria-expanded={open}
      >
        <span className="text-sm font-medium">{q}</span>
        {open ? (
          <ChevronUp className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
        ) : (
          <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
        )}
      </button>
      {open && (
        <p className="pb-4 text-sm text-muted-foreground">{a}</p>
      )}
    </div>
  );
}

export default function FaqPage() {
  return (
    <div className="mx-auto max-w-2xl space-y-6 p-6">
      <BackButton />

      <div>
        <h1 className="text-xl font-semibold">Questions fréquentes</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Les réponses aux questions les plus courantes sur SmartVest.
        </p>
      </div>

      <div className="rounded-lg border px-4">
        {FAQ.map((item) => (
          <FaqItem key={item.q} q={item.q} a={item.a} />
        ))}
      </div>

      <div className="flex flex-wrap gap-3 border-t pt-4 text-sm">
        <span className="text-muted-foreground">Vous n'avez pas trouvé votre réponse ?</span>
        <Link
          href={'/help/contact' as Route}
          className="text-primary hover:underline underline-offset-4"
        >
          Contactez-nous →
        </Link>
      </div>
    </div>
  );
}
