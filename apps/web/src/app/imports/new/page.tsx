'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowLeft, UploadCloud, Loader2, CheckCircle2, AlertCircle } from 'lucide-react';
import { usePortfolios } from '@/hooks/use-portfolio';
import { useImportFormats, useImportPreview, useImportCommit, type ImportPreview } from '@/hooks/use-imports';
import { Button } from '@/components/ui/button';

export default function NewImportPage() {
  const router = useRouter();
  const portfoliosQuery = usePortfolios();
  const formatsQuery = useImportFormats();
  const preview = useImportPreview();
  const commit = useImportCommit();

  const [file, setFile] = useState<File | null>(null);
  const [csvContent, setCsvContent] = useState('');
  const [brokerFormat, setBrokerFormat] = useState<string>('');
  const [previewResult, setPreviewResult] = useState<ImportPreview | null>(null);
  const [skippedRows, setSkippedRows] = useState<Set<number>>(new Set());
  const [committed, setCommitted] = useState<{ rowsCommitted: number; transactionsCreated: number } | null>(null);

  const portfolio = portfoliosQuery.data?.[0] ?? null;

  async function onFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    setFile(f);
    const content = await f.text();
    setCsvContent(content);
  }

  async function runPreview() {
    if (!portfolio || !csvContent) return;
    try {
      const data = await preview.mutateAsync({
        portfolioId: portfolio.id,
        csvContent,
        filename: file?.name,
        brokerFormat: brokerFormat || undefined,
      });
      setPreviewResult(data);
    } catch (err) {
      console.error(err);
    }
  }

  async function runCommit() {
    if (!previewResult) return;
    try {
      const data = await commit.mutateAsync({
        jobId: previewResult.jobId,
        rowsToSkip: Array.from(skippedRows),
      });
      setCommitted({ rowsCommitted: data.rowsCommitted, transactionsCreated: data.transactionsCreated });
      setTimeout(() => router.push('/imports'), 2000);
    } catch (err) {
      console.error(err);
    }
  }

  function toggleSkip(rowNumber: number) {
    setSkippedRows((prev) => {
      const next = new Set(prev);
      if (next.has(rowNumber)) next.delete(rowNumber);
      else next.add(rowNumber);
      return next;
    });
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      <div className="flex items-center gap-3">
        <Link href="/imports">
          <Button variant="ghost" size="sm">
            <ArrowLeft className="mr-1.5 h-4 w-4" />
            Retour
          </Button>
        </Link>
        <div>
          <h1 className="text-xl font-semibold">Nouvel import CSV</h1>
          <p className="text-sm text-muted-foreground">
            Importer vos transactions broker. Preview obligatoire avant commit.
          </p>
        </div>
      </div>

      {committed && (
        <div className="rounded-lg border border-emerald-300 bg-emerald-50 p-4 text-sm dark:bg-emerald-950/30 dark:border-emerald-800">
          <CheckCircle2 className="mr-2 inline h-4 w-4" />
          <strong>{committed.rowsCommitted} ligne(s) importée(s)</strong> — {committed.transactionsCreated} transaction(s) créée(s). Redirection…
        </div>
      )}

      {!previewResult && !committed && (
        <div className="space-y-4 rounded-lg border p-6">
          <div>
            <label className="mb-1 block text-sm font-medium">Format broker</label>
            <select
              value={brokerFormat}
              onChange={(e) => setBrokerFormat(e.target.value)}
              className="w-full rounded-md border bg-background px-3 py-2 text-sm"
            >
              <option value="">Détection automatique</option>
              {(formatsQuery.data ?? []).map((f) => (
                <option key={f.format} value={f.format}>{f.label}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium">Fichier CSV</label>
            <input
              type="file"
              accept=".csv,text/csv"
              onChange={onFileChange}
              className="w-full rounded-md border bg-background px-3 py-2 text-sm"
            />
            {file && (
              <p className="mt-1 text-xs text-muted-foreground">
                {file.name} — {(file.size / 1024).toFixed(1)} KB
              </p>
            )}
          </div>

          <Button
            onClick={runPreview}
            disabled={!csvContent || !portfolio || preview.isPending}
          >
            {preview.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <UploadCloud className="mr-2 h-4 w-4" />}
            Prévisualiser
          </Button>

          {preview.error && (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
              {preview.error.message}
            </div>
          )}
        </div>
      )}

      {previewResult && !committed && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div className="rounded-lg border p-3">
              <div className="text-xs text-muted-foreground">Détectées</div>
              <div className="text-lg font-semibold">{previewResult.rowsDetected}</div>
            </div>
            <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 dark:bg-emerald-950/20 dark:border-emerald-900">
              <div className="text-xs text-muted-foreground">Valides</div>
              <div className="text-lg font-semibold text-emerald-700 dark:text-emerald-400">{previewResult.rowsValid}</div>
            </div>
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 dark:bg-amber-950/20 dark:border-amber-900">
              <div className="text-xs text-muted-foreground">Doublons</div>
              <div className="text-lg font-semibold text-amber-700 dark:text-amber-400">{previewResult.rowsDuplicate}</div>
            </div>
            <div className="rounded-lg border border-red-200 bg-red-50 p-3 dark:bg-red-950/20 dark:border-red-900">
              <div className="text-xs text-muted-foreground">Invalides</div>
              <div className="text-lg font-semibold text-red-700 dark:text-red-400">{previewResult.rowsInvalid}</div>
            </div>
          </div>

          <div className="rounded-lg border overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="border-b bg-muted/40">
                <tr>
                  <th className="px-2 py-2 text-left">#</th>
                  <th className="px-2 py-2 text-left">Date</th>
                  <th className="px-2 py-2 text-left">Action</th>
                  <th className="px-2 py-2 text-left">Ticker</th>
                  <th className="px-2 py-2 text-right">Qté</th>
                  <th className="px-2 py-2 text-right">Prix</th>
                  <th className="px-2 py-2 text-left">Devise</th>
                  <th className="px-2 py-2 text-left">Statut</th>
                  <th className="px-2 py-2 text-left">Skip</th>
                </tr>
              </thead>
              <tbody>
                {previewResult.rows.map((row) => {
                  const isValid = row.status === 'valid';
                  const isInvalid = row.status === 'invalid';
                  const isDup = row.status === 'duplicate';
                  return (
                    <tr key={row.rowNumber} className="border-b last:border-0">
                      <td className="px-2 py-1.5 font-mono">{row.rowNumber}</td>
                      <td className="px-2 py-1.5">{row.tradeDate ?? '—'}</td>
                      <td className="px-2 py-1.5">{row.action ?? '—'}</td>
                      <td className="px-2 py-1.5 font-mono">{row.ticker ?? row.isin ?? '—'}</td>
                      <td className="px-2 py-1.5 text-right">{row.quantity ?? '—'}</td>
                      <td className="px-2 py-1.5 text-right">{row.unitPrice ?? '—'}</td>
                      <td className="px-2 py-1.5">{row.currency ?? '—'}</td>
                      <td className="px-2 py-1.5">
                        <span
                          className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
                            isValid ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400'
                              : isDup ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400'
                                : 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400'
                          }`}
                        >
                          {row.status}
                        </span>
                        {isInvalid && row.validationErrors.length > 0 && (
                          <div className="mt-0.5 flex items-start gap-1 text-[10px] text-red-700 dark:text-red-400">
                            <AlertCircle className="h-3 w-3 flex-shrink-0" />
                            <span>{row.validationErrors.join(', ')}</span>
                          </div>
                        )}
                      </td>
                      <td className="px-2 py-1.5">
                        {isValid && (
                          <input
                            type="checkbox"
                            checked={skippedRows.has(row.rowNumber)}
                            onChange={() => toggleSkip(row.rowNumber)}
                          />
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="flex gap-2">
            <Button onClick={runCommit} disabled={commit.isPending || previewResult.rowsValid === 0}>
              {commit.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <CheckCircle2 className="mr-2 h-4 w-4" />}
              Valider l'import ({previewResult.rowsValid - skippedRows.size} lignes)
            </Button>
            <Button variant="outline" onClick={() => setPreviewResult(null)}>
              Annuler
            </Button>
          </div>

          {commit.error && (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
              {commit.error.message}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
