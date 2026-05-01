import type { Metadata, Viewport } from 'next';
import './globals.css';
import { Providers } from './providers';
import { AppShell } from '@/components/layout/app-shell';
import { CookieBanner } from '@/components/cookie-banner';

export const metadata: Metadata = {
  title: 'SmartVest — Assistant personnel d\'investissement',
  description:
    'Outil personnel de simulation et de suivi d\'investissement. Aide à la décision uniquement — ne constitue pas un conseil financier.',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f5f8fc' },
    { media: '(prefers-color-scheme: dark)', color: '#0e1422' },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="fr" suppressHydrationWarning>
      <body className="min-h-screen antialiased">
        <Providers>
          <AppShell>{children}</AppShell>
          <CookieBanner />
        </Providers>
      </body>
    </html>
  );
}
