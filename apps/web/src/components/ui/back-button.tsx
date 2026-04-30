'use client';

import { ArrowLeft } from 'lucide-react';
import { useRouter } from 'next/navigation';

interface BackButtonProps {
  label?: string;
  className?: string;
}

export function BackButton({ label = 'Retour', className = '' }: BackButtonProps) {
  const router = useRouter();
  return (
    <button
      type="button"
      onClick={() => router.back()}
      aria-label={label}
      className={`inline-flex items-center min-h-[44px] py-2 pr-2 text-sm text-muted-foreground hover:text-foreground transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded ${className}`}
    >
      <ArrowLeft className="mr-1.5 h-4 w-4" aria-hidden />
      {label}
    </button>
  );
}
