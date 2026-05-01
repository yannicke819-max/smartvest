'use client';

import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description: string;
  onConfirm: () => void;
  onCancel: () => void;
  confirmLabel?: string;
  cancelLabel?: string;
  dangerous?: boolean;
}

export function ConfirmDialog({
  open,
  title,
  description,
  onConfirm,
  onCancel,
  confirmLabel = 'Confirmer',
  cancelLabel = 'Annuler',
  dangerous = false,
}: ConfirmDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  // Move focus to cancel button when dialog opens (safer default than confirm)
  useEffect(() => {
    if (open) cancelRef.current?.focus();
  }, [open]);

  // ESC closes dialog
  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onCancel();
      }
      // Focus trap: Tab/Shift+Tab cycles between cancel and confirm only
      if (e.key === 'Tab') {
        const focusable = [cancelRef.current, confirmRef.current].filter(Boolean) as HTMLButtonElement[];
        if (focusable.length < 2) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey) {
          if (document.activeElement === first) {
            e.preventDefault();
            last.focus();
          }
        } else {
          if (document.activeElement === last) {
            e.preventDefault();
            first.focus();
          }
        }
      }
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [open, onCancel]);

  if (!open || typeof document === 'undefined') return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/50" aria-hidden="true" />

      {/* Dialog */}
      <div
        ref={dialogRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        aria-describedby="confirm-dialog-desc"
        className="relative z-10 w-full max-w-sm rounded-lg border bg-background p-6 shadow-lg"
      >
        <h2
          id="confirm-dialog-title"
          className="text-base font-semibold"
        >
          {title}
        </h2>
        <p
          id="confirm-dialog-desc"
          className="mt-2 whitespace-pre-wrap text-sm text-muted-foreground"
        >
          {description}
        </p>

        <div className="mt-6 flex justify-end gap-3">
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            className="inline-flex min-h-[44px] items-center rounded-md border px-4 py-2 text-sm font-medium transition-colors hover:bg-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {cancelLabel}
          </button>
          <button
            ref={confirmRef}
            type="button"
            onClick={onConfirm}
            className={`inline-flex min-h-[44px] items-center rounded-md px-4 py-2 text-sm font-medium text-white transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
              dangerous
                ? 'bg-destructive hover:bg-destructive/90 focus-visible:ring-destructive'
                : 'bg-primary hover:bg-primary/90 focus-visible:ring-primary'
            }`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
