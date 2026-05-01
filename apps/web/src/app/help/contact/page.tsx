import Link from 'next/link';
import { type Route } from 'next';
import { Mail, Github, MessageCircleQuestion } from 'lucide-react';
import { BackButton } from '@/components/ui/back-button';

export default function ContactPage() {
  return (
    <div className="mx-auto max-w-xl space-y-6 p-6">
      <BackButton />

      <div>
        <h1 className="text-xl font-semibold">Nous contacter</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Une question, un bug, une suggestion ? Voici comment nous joindre.
        </p>
      </div>

      <div className="space-y-3">
        <a
          href="mailto:support@smartvest.app"
          className="flex items-start gap-4 rounded-lg border p-4 transition-colors hover:bg-muted/30"
        >
          <Mail className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" aria-hidden />
          <div>
            <p className="text-sm font-medium">Email</p>
            <p className="text-sm text-muted-foreground">support@smartvest.app</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Pour toute question sur votre compte, vos données ou un problème technique.
            </p>
          </div>
        </a>

        <a
          href="https://github.com/yannicke819-max/smartvest/issues"
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-start gap-4 rounded-lg border p-4 transition-colors hover:bg-muted/30"
        >
          <Github className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" aria-hidden />
          <div>
            <p className="text-sm font-medium">GitHub Issues</p>
            <p className="text-sm text-muted-foreground">github.com/yannicke819-max/smartvest</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Pour signaler un bug ou proposer une amélioration. Réponse généralement sous 48 h.
            </p>
          </div>
        </a>

        <Link
          href={'/help/faq' as Route}
          className="flex items-start gap-4 rounded-lg border p-4 transition-colors hover:bg-muted/30"
        >
          <MessageCircleQuestion className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" aria-hidden />
          <div>
            <p className="text-sm font-medium">Questions fréquentes</p>
            <p className="text-sm text-muted-foreground">
              Consultez notre FAQ avant d'écrire — votre réponse s'y trouve peut-être déjà.
            </p>
          </div>
        </Link>
      </div>

      <div className="rounded-lg border border-dashed p-4">
        <p className="text-xs text-muted-foreground">
          SmartVest est un projet en beta. Votre feedback est précieux et lu avec attention.
          Nous ne vendons pas vos données à des tiers — cf.{' '}
          <Link href={'/legal/confidentialite' as Route} className="text-primary hover:underline underline-offset-4">
            notre politique de confidentialité
          </Link>.
        </p>
      </div>
    </div>
  );
}
