import React, { useMemo, useRef, useState } from 'react';
import {
  CopyCheck,
  Download,
  HardDrive,
  Minimize2,
  Moon,
  RotateCcw,
  Sun,
  Trash2,
  Upload,
} from 'lucide-react';
import {
  AppPreferences,
  BatchAutoPace,
  DeviceIndexSummary,
  IndexProgress,
  IndexStats,
  PdfCompressPreset,
  PdfPageSizePreset,
  ScanDocument,
  ScanFilterId,
} from '../types/filelens';
import { NAMING_TEMPLATES, SCAN_FILTERS } from '../data/seedData';
import { formatBytes, triggerFileDownload } from '../utils/formatters';
import { findSemanticDuplicates } from '../utils/smartTaxonomy';
import { SmartIndexingBar } from './SmartIndexingBar';

interface ToolsAndSettingsViewProps {
  documents: ScanDocument[];
  preferences: AppPreferences;
  indexStats: IndexStats;
  linkedDeviceRootsCount: number;
  isIndexing: boolean;
  indexProgress: IndexProgress | null;
  lastIndexSummary: DeviceIndexSummary | null;
  onOpenDeviceIndexer: () => void;
  onIndexFiles: (files: File[], sourceLabel: string) => void;
  onRunDeltaReindex: () => void;
  onCancelIndexing: () => void;
  onUpdatePreferences: (next: AppPreferences) => void;
  onBatchCompressPdfs: (preset: PdfCompressPreset) => { savedBytes: number; count: number };
  onDeleteDocument: (docId: string) => void;
  onExportWorkspaceBackup: () => string;
  onImportWorkspaceBackup: (json: string) => boolean;
  onResetDemoWorkspace: () => void;
  onToast: (message: string) => void;
}

const PDF_COMPRESS_OPTIONS: {
  id: PdfCompressPreset;
  label: string;
  subtitle: string;
  ratio: number;
}[] = [
  { id: 'email_small', label: 'Email Ready', subtitle: '1280px · 62% quality', ratio: 0.34 },
  { id: 'balanced', label: 'Balanced', subtitle: '1700px · 76% quality', ratio: 0.54 },
  { id: 'print_high', label: 'Print High', subtitle: '2200px · 86% quality', ratio: 0.78 },
];

export const ToolsAndSettingsView: React.FC<ToolsAndSettingsViewProps> = ({
  documents,
  preferences,
  indexStats,
  linkedDeviceRootsCount,
  isIndexing,
  indexProgress,
  lastIndexSummary,
  onOpenDeviceIndexer,
  onIndexFiles,
  onRunDeltaReindex,
  onCancelIndexing,
  onUpdatePreferences,
  onBatchCompressPdfs,
  onDeleteDocument,
  onExportWorkspaceBackup,
  onImportWorkspaceBackup,
  onResetDemoWorkspace,
  onToast,
}) => {
  const [compressPreset, setCompressPreset] = useState<PdfCompressPreset>('balanced');
  const [cacheBytes, setCacheBytes] = useState<number>(4_820_000);
  const backupInputRef = useRef<HTMLInputElement | null>(null);

  const storageStats = useMemo(() => {
    const totalBytes = documents.reduce((acc, d) => acc + d.sizeBytes, 0);
    const totalPages = documents.reduce((acc, d) => acc + d.pages.length, 0);
    const selectedOpt = PDF_COMPRESS_OPTIONS.find((o) => o.id === compressPreset)!;
    const estSavings = Math.round(totalBytes * (1 - selectedOpt.ratio));
    return { totalBytes, totalPages, estSavings };
  }, [documents, compressPreset]);

  const semanticDuplicates = useMemo(() => findSemanticDuplicates(documents, 0.8), [documents]);

  const handleCompressAll = () => {
    const { savedBytes, count } = onBatchCompressPdfs(compressPreset);
    onToast(`Compressed ${count} PDF(s) · Freed ${formatBytes(savedBytes)}`);
  };

  const handleCleanCache = () => {
    const freed = cacheBytes;
    setCacheBytes(0);
    onToast(`Cleared ${formatBytes(freed)} of temporary crop & render cache`);
  };

  const handleBackupDownload = () => {
    const json = onExportWorkspaceBackup();
    const blob = new Blob([json], { type: 'application/json' });
    triggerFileDownload(blob, `FileLens_Backup_${new Date().toISOString().slice(0, 10)}.json`);
    onToast('Exported full offline JSON workspace backup');
  };

  const handleBackupFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const ok = onImportWorkspaceBackup(String(reader.result));
      onToast(ok ? 'Restored workspace backup' : 'Invalid backup JSON file');
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-slate-900 dark:text-white">
          Tools, Indexing &amp; Preferences
        </h1>
        <p className="text-xs sm:text-sm text-slate-500 dark:text-slate-400 mt-0.5">
          Smart Indexing engine, Semantic Duplicate Finder, Batch PDF Compressor &amp; Genius Scan defaults
        </p>
      </div>

      {/* Full Universal Smart Indexing Control Panel */}
      <SmartIndexingBar
        stats={indexStats}
        linkedDeviceRootsCount={linkedDeviceRootsCount}
        isIndexing={isIndexing}
        progress={indexProgress}
        lastSummary={lastIndexSummary}
        onOpenDeviceIndexer={onOpenDeviceIndexer}
        onIndexFiles={onIndexFiles}
        onRunDeltaReindex={onRunDeltaReindex}
        onCancelIndexing={onCancelIndexing}
      />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Left Column: Space Cleaner, Compressor & Semantic Clones */}
        <div className="space-y-5">
          <section className="bg-white dark:bg-[#1C1C1E] rounded-2xl border border-slate-200/80 dark:border-white/10 p-5 space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <HardDrive className="w-4 h-4 text-orange-600 dark:text-orange-400" />
                <h2 className="text-sm font-bold">Vault Storage Analyser</h2>
              </div>
              <span className="text-xs font-mono tabular-nums font-semibold text-slate-600 dark:text-slate-300">
                {formatBytes(storageStats.totalBytes + cacheBytes)} used
              </span>
            </div>

            <div className="h-3 rounded-full bg-slate-100 dark:bg-[#2C2C2E] overflow-hidden flex">
              <div
                className="bg-orange-600 h-full transition-all"
                style={{
                  width: `${Math.min(
                    100,
                    Math.round((storageStats.totalBytes / Math.max(1, storageStats.totalBytes + cacheBytes)) * 100)
                  )}%`,
                }}
              />
              {cacheBytes > 0 && (
                <div
                  className="bg-slate-400 dark:bg-slate-600 h-full transition-all"
                  style={{
                    width: `${Math.round(
                      (cacheBytes / Math.max(1, storageStats.totalBytes + cacheBytes)) * 100
                    )}%`,
                  }}
                />
              )}
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500 dark:text-slate-400 font-mono tabular-nums">
              <span>
                PDFs ({documents.length} files · {storageStats.totalPages} pages):{' '}
                <strong className="text-slate-800 dark:text-slate-200">
                  {formatBytes(storageStats.totalBytes)}
                </strong>
              </span>
              <span>
                Temp Cache:{' '}
                <strong className="text-slate-800 dark:text-slate-200">
                  {formatBytes(cacheBytes)}
                </strong>
              </span>
            </div>

            <div className="pt-2 border-t border-slate-100 dark:border-white/8 flex items-center justify-between gap-3">
              <div className="text-xs text-slate-500 dark:text-slate-400">
                Temporary crop thumbnails &amp; PDF render cache
              </div>
              <button
                type="button"
                disabled={cacheBytes === 0}
                onClick={handleCleanCache}
                className="min-h-[36px] px-3.5 rounded-xl bg-slate-100 dark:bg-[#2C2C2E] hover:bg-orange-50 dark:hover:bg-orange-950/30 disabled:opacity-40 text-xs font-semibold flex items-center gap-1.5 whitespace-nowrap"
              >
                <Trash2 className="w-3.5 h-3.5 text-orange-600" />
                <span>{cacheBytes === 0 ? 'Cache Clean' : 'Clean Cache'}</span>
              </button>
            </div>
          </section>

          {/* Smart PDF Compressor */}
          <section className="bg-white dark:bg-[#1C1C1E] rounded-2xl border border-slate-200/80 dark:border-white/10 p-5 space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Minimize2 className="w-4 h-4 text-orange-600 dark:text-orange-400" />
                <h2 className="text-sm font-bold">Smart Batch PDF Compressor</h2>
              </div>
              <span className="text-xs font-mono tabular-nums text-emerald-600 dark:text-emerald-400 font-semibold">
                Save ~{formatBytes(storageStats.estSavings)}
              </span>
            </div>

            <div className="grid grid-cols-3 gap-2">
              {PDF_COMPRESS_OPTIONS.map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => setCompressPreset(opt.id)}
                  className={`p-3 rounded-xl border text-left transition-colors ${
                    compressPreset === opt.id
                      ? 'border-orange-600 bg-orange-50/80 dark:bg-orange-950/35'
                      : 'border-slate-200/80 dark:border-white/10 bg-slate-50 dark:bg-[#2C2C2E]'
                  }`}
                >
                  <div className="text-xs font-bold">{opt.label}</div>
                  <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                    {opt.subtitle}
                  </div>
                </button>
              ))}
            </div>

            <button
              type="button"
              onClick={handleCompressAll}
              disabled={documents.length === 0}
              className="w-full h-11 rounded-xl bg-orange-600 hover:bg-orange-700 disabled:opacity-40 text-white text-sm font-semibold transition-colors"
            >
              Optimize All {documents.length} PDF(s)
            </button>
          </section>

          {/* Semantic Clones & Near-Duplicates Detector (384-dim Cosine Similarity) */}
          <section className="bg-white dark:bg-[#1C1C1E] rounded-2xl border border-slate-200/80 dark:border-white/10 p-5 space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <CopyCheck className="w-4 h-4 text-orange-600 dark:text-orange-400" />
                <h2 className="text-sm font-bold">
                  Semantic Duplicate Detector ({semanticDuplicates.length})
                </h2>
              </div>
              <span className="text-[11px] font-mono text-slate-500">384-dim cosine ≥ 80%</span>
            </div>

            {semanticDuplicates.length === 0 ? (
              <p className="text-xs text-slate-500 dark:text-slate-400">
                No near-duplicate documents detected across your indexed vault.
              </p>
            ) : (
              <div className="space-y-3">
                {semanticDuplicates.map((group) => (
                  <div
                    key={group.groupId}
                    className="rounded-xl bg-slate-50 dark:bg-[#2C2C2E] p-3 space-y-2 border border-slate-200/70 dark:border-white/8"
                  >
                    <div className="text-xs font-mono font-semibold text-orange-600 dark:text-orange-400">
                      {Math.round(group.similarity * 100)}% semantic overlap
                    </div>
                    {group.documents.map((doc, idx) => (
                      <div key={doc.id} className="flex items-center justify-between gap-2 text-xs">
                        <div className="min-w-0">
                          <div className="font-semibold text-slate-800 dark:text-slate-100 truncate">
                            {doc.title}
                          </div>
                          <div className="text-slate-500 font-mono tabular-nums">
                            {idx === 0 ? 'Primary copy' : 'Duplicate copy'} · {formatBytes(doc.sizeBytes)}
                          </div>
                        </div>
                        {idx > 0 && (
                          <button
                            type="button"
                            onClick={() => onDeleteDocument(doc.id)}
                            className="px-2.5 py-1.5 rounded-lg bg-red-50 dark:bg-red-950/40 text-red-600 dark:text-red-400 font-semibold shrink-0"
                          >
                            Remove
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>

        {/* Right Column: Scanner Defaults, Theme & Offline Backup */}
        <div className="space-y-5">
          <section className="bg-white dark:bg-[#1C1C1E] rounded-2xl border border-slate-200/80 dark:border-white/10 p-5 space-y-4">
            <h2 className="text-sm font-bold">Scanner &amp; Appearance</h2>

            <div className="flex items-center justify-between gap-4">
              <div>
                <div className="text-sm font-medium">Appearance</div>
                <div className="text-xs text-slate-500 dark:text-slate-400">
                  iOS Light Grouped or True Dark surfaces
                </div>
              </div>
              <div className="flex items-center gap-1 p-1 rounded-xl bg-slate-100 dark:bg-[#2C2C2E]">
                <button
                  type="button"
                  onClick={() => onUpdatePreferences({ ...preferences, theme: 'light' })}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 ${
                    preferences.theme === 'light'
                      ? 'bg-white text-slate-900 shadow-xs'
                      : 'text-slate-500'
                  }`}
                >
                  <Sun className="w-3.5 h-3.5" />
                  <span>Light</span>
                </button>
                <button
                  type="button"
                  onClick={() => onUpdatePreferences({ ...preferences, theme: 'dark' })}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 ${
                    preferences.theme === 'dark'
                      ? 'bg-[#3A3A3C] text-white shadow-xs'
                      : 'text-slate-500'
                  }`}
                >
                  <Moon className="w-3.5 h-3.5" />
                  <span>Dark</span>
                </button>
              </div>
            </div>

            <div className="pt-3 border-t border-slate-100 dark:border-white/8">
              <label className="block text-xs font-semibold text-slate-600 dark:text-slate-300 mb-1.5">
                Default Enhancement Filter
              </label>
              <div className="flex flex-wrap gap-1.5">
                {SCAN_FILTERS.map((f) => (
                  <button
                    key={f.id}
                    type="button"
                    onClick={() =>
                      onUpdatePreferences({ ...preferences, defaultFilter: f.id as ScanFilterId })
                    }
                    className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                      preferences.defaultFilter === f.id
                        ? 'bg-orange-600 text-white'
                        : 'bg-slate-100 dark:bg-[#2C2C2E] text-slate-700 dark:text-slate-300'
                    }`}
                  >
                    {f.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2">
              <div>
                <label className="block text-xs font-semibold text-slate-600 dark:text-slate-300 mb-1">
                  Default PDF Page Size
                </label>
                <select
                  value={preferences.defaultPageSize}
                  onChange={(e) =>
                    onUpdatePreferences({
                      ...preferences,
                      defaultPageSize: e.target.value as PdfPageSizePreset,
                    })
                  }
                  className="w-full h-10 px-3 rounded-xl bg-slate-50 dark:bg-[#2C2C2E] border border-slate-200 dark:border-white/10 text-xs font-semibold"
                >
                  <option value="auto">Auto Fit</option>
                  <option value="a4">A4 (210 × 297 mm)</option>
                  <option value="letter">US Letter</option>
                </select>
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-600 dark:text-slate-300 mb-1">
                  Batch Auto-Capture Pace
                </label>
                <select
                  value={preferences.batchPace}
                  onChange={(e) =>
                    onUpdatePreferences({
                      ...preferences,
                      batchPace: e.target.value as BatchAutoPace,
                    })
                  }
                  className="w-full h-10 px-3 rounded-xl bg-slate-50 dark:bg-[#2C2C2E] border border-slate-200 dark:border-white/10 text-xs font-semibold"
                >
                  <option value="wait_page">Smart Wait Page Swap</option>
                  <option value="delay_3s">Every 3 Seconds</option>
                  <option value="delay_5s">Every 5 Seconds</option>
                </select>
              </div>
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-600 dark:text-slate-300 mb-1">
                Automated Naming Template
              </label>
              <select
                value={preferences.namingTemplate}
                onChange={(e) =>
                  onUpdatePreferences({ ...preferences, namingTemplate: e.target.value })
                }
                className="w-full h-10 px-3 rounded-xl bg-slate-50 dark:bg-[#2C2C2E] border border-slate-200 dark:border-white/10 text-xs font-mono"
              >
                {NAMING_TEMPLATES.map((tpl) => (
                  <option key={tpl.id} value={tpl.pattern}>
                    {tpl.label} — {tpl.pattern}
                  </option>
                ))}
              </select>
            </div>

            <label className="flex items-center justify-between gap-3 pt-2 border-t border-slate-100 dark:border-white/8 cursor-pointer">
              <div>
                <div className="text-sm font-medium">Searchable OCR Text Layer</div>
                <div className="text-xs text-slate-500 dark:text-slate-400">
                  Run on-device Tesseract OCR on all newly scanned &amp; imported pages
                </div>
              </div>
              <input
                type="checkbox"
                checked={preferences.searchablePdfOcrLayer}
                onChange={(e) =>
                  onUpdatePreferences({
                    ...preferences,
                    searchablePdfOcrLayer: e.target.checked,
                  })
                }
                className="w-5 h-5 accent-orange-600 rounded"
              />
            </label>
          </section>

          <section className="bg-white dark:bg-[#1C1C1E] rounded-2xl border border-slate-200/80 dark:border-white/10 p-5 space-y-3">
            <h2 className="text-sm font-bold">Offline Workspace Backup</h2>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Export or restore all indexed documents, page edits, folders, voice checklists, and saved searches as portable JSON.
            </p>
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <button
                type="button"
                onClick={handleBackupDownload}
                className="min-h-[40px] px-4 rounded-xl bg-slate-900 dark:bg-white text-white dark:text-slate-900 text-xs font-semibold flex items-center gap-1.5"
              >
                <Download className="w-3.5 h-3.5" />
                <span>Export Backup</span>
              </button>
              <button
                type="button"
                onClick={() => backupInputRef.current?.click()}
                className="min-h-[40px] px-4 rounded-xl bg-slate-100 dark:bg-[#2C2C2E] text-xs font-semibold flex items-center gap-1.5"
              >
                <Upload className="w-3.5 h-3.5" />
                <span>Restore JSON</span>
              </button>
              <button
                type="button"
                onClick={onResetDemoWorkspace}
                className="min-h-[40px] px-3.5 rounded-xl text-xs font-semibold text-slate-500 hover:text-red-600 flex items-center gap-1.5 ml-auto"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                <span>Reset Samples</span>
              </button>
              <input
                ref={backupInputRef}
                type="file"
                accept="application/json"
                className="hidden"
                onChange={handleBackupFile}
              />
            </div>
          </section>
        </div>
      </div>
    </div>
  );
};
