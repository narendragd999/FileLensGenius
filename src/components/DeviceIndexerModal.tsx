import React, { useRef, useState } from 'react';
import {
  CheckCircle2,
  Download,
  FileText,
  FolderOpen,
  HardDrive,
  Image as ImageIcon,
  Laptop,
  Loader2,
  RefreshCw,
  ShieldCheck,
  Trash2,
  X,
} from 'lucide-react';
import {
  DeviceIndexFilters,
  DeviceIndexSummary,
  DeviceRootPreset,
  DeviceStorageRoot,
  IndexProgress,
} from '../types/filelens';
import { formatShortDate } from '../utils/formatters';
import { DEFAULT_DEVICE_INDEX_FILTERS } from '../utils/deviceRoots';

interface DeviceIndexerModalProps {
  deviceRoots: DeviceStorageRoot[];
  isIndexing: boolean;
  progress: IndexProgress | null;
  lastSummary: DeviceIndexSummary | null;
  onLinkAndIndexPreset: (
    preset: DeviceRootPreset,
    filters: DeviceIndexFilters
  ) => Promise<'linked' | 'cancelled' | 'fallback_needed'>;
  onIndexFallbackFolderFiles: (
    files: File[],
    sourceLabel: string,
    filters: DeviceIndexFilters
  ) => void;
  onSyncAllDeviceRoots: (filters: DeviceIndexFilters) => void;
  onSyncSingleRoot: (rootId: string, filters: DeviceIndexFilters) => void;
  onRemoveRoot: (rootId: string) => void;
  onCancelIndexing: () => void;
  onClose: () => void;
}

const STORAGE_PRESETS: {
  id: DeviceRootPreset;
  label: string;
  subtitle: string;
  icon: React.ReactNode;
}[] = [
  {
    id: 'documents',
    label: 'Documents',
    subtitle: 'PDFs, contracts, bills',
    icon: <FileText className="w-4 h-4 text-orange-600 dark:text-orange-400" />,
  },
  {
    id: 'downloads',
    label: 'Downloads',
    subtitle: 'Statements, invoices, forms',
    icon: <Download className="w-4 h-4 text-orange-600 dark:text-orange-400" />,
  },
  {
    id: 'pictures',
    label: 'Pictures / DCIM',
    subtitle: 'Camera scans, receipts, IDs',
    icon: <ImageIcon className="w-4 h-4 text-orange-600 dark:text-orange-400" />,
  },
  {
    id: 'desktop',
    label: 'Desktop',
    subtitle: 'Quick files & folders',
    icon: <Laptop className="w-4 h-4 text-orange-600 dark:text-orange-400" />,
  },
];

export const DeviceIndexerModal: React.FC<DeviceIndexerModalProps> = ({
  deviceRoots,
  isIndexing,
  progress,
  lastSummary,
  onLinkAndIndexPreset,
  onIndexFallbackFolderFiles,
  onSyncAllDeviceRoots,
  onSyncSingleRoot,
  onRemoveRoot,
  onCancelIndexing,
  onClose,
}) => {
  const [filters, setFilters] = useState<DeviceIndexFilters>(DEFAULT_DEVICE_INDEX_FILTERS);
  const [pendingFallbackPreset, setPendingFallbackPreset] = useState<string>('Device Storage');
  const fallbackDirInputRef = useRef<HTMLInputElement | null>(null);

  const handlePresetClick = async (preset: DeviceRootPreset, label: string) => {
    if (isIndexing) return;
    const outcome = await onLinkAndIndexPreset(preset, filters);
    if (outcome === 'fallback_needed') {
      setPendingFallbackPreset(label);
      fallbackDirInputRef.current?.click();
    }
  };

  const handleFallbackFolderChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const list = e.target.files;
    if (list && list.length > 0) {
      const files = Array.from(list);
      const firstRel = (files[0] as File & { webkitRelativePath?: string }).webkitRelativePath;
      const rootName = firstRel ? firstRel.split('/')[0] : pendingFallbackPreset;
      onIndexFallbackFolderFiles(files, `Device: ${rootName}`, filters);
    }
    e.target.value = '';
  };

  const pct =
    progress && progress.total > 0
      ? Math.min(100, Math.round((progress.indexed / progress.total) * 100))
      : 0;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/55 backdrop-blur-xs p-0 sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Full Device Smart Indexing"
    >
      <div className="w-full sm:max-w-2xl max-h-[92vh] flex flex-col bg-[#F2F2F7] dark:bg-[#141416] text-slate-900 dark:text-slate-100 rounded-t-3xl sm:rounded-3xl border border-slate-200/80 dark:border-white/10 shadow-2xl overflow-hidden">
        {/* Top Sheet Header */}
        <header className="px-5 py-4 bg-white dark:bg-[#1C1C1E] border-b border-slate-200/80 dark:border-white/10 flex items-center justify-between gap-3 shrink-0">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-9 h-9 rounded-xl bg-orange-50 dark:bg-orange-950/50 text-orange-600 dark:text-orange-400 flex items-center justify-center shrink-0">
              <HardDrive className="w-5 h-5" />
            </div>
            <div className="min-w-0">
              <h2 className="text-base font-bold tracking-tight truncate">
                Index Entire Device (All File Types)
              </h2>
              <p className="text-xs text-slate-500 dark:text-slate-400 truncate">
                PDFs, Office, Photos (OCR), Code, Archives, Media &amp; any file on your device
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close device indexer"
            className="w-9 h-9 rounded-xl flex items-center justify-center text-slate-500 hover:bg-slate-100 dark:hover:bg-white/10 shrink-0"
          >
            <X className="w-5 h-5" />
          </button>
        </header>

        {/* Scrollable Body */}
        <div className="flex-1 overflow-y-auto p-4 sm:p-5 space-y-5">
          {/* Primary Full Device Scan Card */}
          <div className="bg-white dark:bg-[#1C1C1E] rounded-2xl p-4 sm:p-5 border border-slate-200/80 dark:border-white/10 space-y-3.5">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div>
                <h3 className="text-sm font-bold text-slate-900 dark:text-white">
                  {deviceRoots.length > 0
                    ? `Sync Entire Device (${deviceRoots.length} linked root${deviceRoots.length > 1 ? 's' : ''})`
                    : 'Index Everything on Your Device'}
                </h3>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                  Crawls every nested folder, runs real OCR on images &amp; scans, parses DOCX/XLSX/PPTX/PDF/ZIP/code, and indexes metadata for every other file type.
                </p>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2.5">
              {deviceRoots.length > 0 && (
                <button
                  type="button"
                  disabled={isIndexing}
                  onClick={() => onSyncAllDeviceRoots(filters)}
                  className="min-h-[42px] px-4 rounded-xl bg-orange-600 hover:bg-orange-700 disabled:opacity-50 text-white text-xs font-semibold flex items-center gap-2 transition-colors whitespace-nowrap"
                >
                  <RefreshCw className={`w-4 h-4 ${isIndexing ? 'animate-spin' : ''}`} />
                  <span>Sync All Linked Storage</span>
                </button>
              )}
              <button
                type="button"
                disabled={isIndexing}
                onClick={() => handlePresetClick('custom', 'Entire Device / Drive')}
                className={`min-h-[42px] px-4 rounded-xl text-xs font-semibold flex items-center gap-2 transition-colors whitespace-nowrap disabled:opacity-50 ${
                  deviceRoots.length === 0
                    ? 'bg-orange-600 hover:bg-orange-700 text-white'
                    : 'bg-slate-100 dark:bg-[#2C2C2E] hover:bg-slate-200 dark:hover:bg-white/15 text-slate-900 dark:text-white'
                }`}
              >
                <FolderOpen className="w-4 h-4" />
                <span>Select Drive / Home Folder</span>
              </button>
            </div>

            {/* Live Full-Device Crawl & Indexing Progress */}
            {isIndexing && progress && (
              <div className="rounded-xl bg-slate-50 dark:bg-[#2C2C2E] p-3.5 space-y-2 border border-orange-200/70 dark:border-orange-900/40">
                <div className="flex items-center justify-between gap-2 text-xs">
                  <div className="flex items-center gap-2 min-w-0">
                    <Loader2 className="w-3.5 h-3.5 text-orange-600 animate-spin shrink-0" />
                    <span className="font-semibold text-slate-800 dark:text-slate-100 shrink-0">
                      {progress.phase}
                    </span>
                    <span className="text-slate-500 dark:text-slate-400 truncate">
                      {progress.currentFile}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className="font-mono tabular-nums font-semibold text-orange-600 dark:text-orange-400">
                      {progress.phase === 'Discovering Device Folders'
                        ? `${progress.foldersScanned ?? 0} dirs · ${progress.total} files`
                        : `${progress.indexed}/${progress.total} (${pct}%)`}
                    </span>
                    <button
                      type="button"
                      onClick={onCancelIndexing}
                      aria-label="Cancel device indexing"
                      className="w-6 h-6 rounded-md bg-slate-200/80 dark:bg-white/10 hover:bg-red-100 hover:text-red-600 flex items-center justify-center"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
                <div className="h-2 rounded-full bg-slate-200 dark:bg-black/40 overflow-hidden">
                  <div
                    className={`h-full bg-orange-600 transition-all duration-200 ${
                      progress.phase === 'Discovering Device Folders' ? 'animate-pulse' : ''
                    }`}
                    style={{
                      width:
                        progress.phase === 'Discovering Device Folders'
                          ? '45%'
                          : `${Math.max(6, pct)}%`,
                    }}
                  />
                </div>
                <div className="flex items-center gap-3 text-[11px] text-slate-500 dark:text-slate-400 font-mono tabular-nums">
                  <span>New/Updated: {progress.newOrUpdated}</span>
                  <span aria-hidden="true">·</span>
                  <span>Skipped unchanged: {progress.skippedUnchanged}</span>
                </div>
              </div>
            )}

            {!isIndexing && lastSummary && (
              <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-slate-100 dark:border-white/8 text-xs text-slate-500 dark:text-slate-400">
                <span className="flex items-center gap-1.5">
                  <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
                  <span>
                    Last sync ({lastSummary.sourceLabel}):{' '}
                    <strong className="text-slate-800 dark:text-slate-200 font-mono tabular-nums">
                      {lastSummary.newOrUpdated} indexed
                    </strong>
                    {' · '}
                    <span className="font-mono tabular-nums">
                      {lastSummary.skippedUnchanged} unchanged
                    </span>
                    {' · '}
                    <span className="font-mono tabular-nums">
                      {(lastSummary.elapsedMs / 1000).toFixed(1)}s
                    </span>
                  </span>
                </span>
                <span className="font-mono tabular-nums text-[11px]">
                  {formatShortDate(lastSummary.timestampIso)}
                </span>
              </div>
            )}
          </div>

          {/* Quick-Link Standard Device Storage Locations */}
          <div className="space-y-2.5">
            <h3 className="text-xs font-semibold text-slate-500 dark:text-slate-400 px-1">
              Quick-Link Device Locations
            </h3>
            <div className="grid grid-cols-2 gap-2.5">
              {STORAGE_PRESETS.map((preset) => {
                const alreadyLinked = deviceRoots.some((r) => r.preset === preset.id);
                return (
                  <button
                    key={preset.id}
                    type="button"
                    disabled={isIndexing}
                    onClick={() => handlePresetClick(preset.id, preset.label)}
                    className="p-3.5 rounded-2xl bg-white dark:bg-[#1C1C1E] border border-slate-200/80 dark:border-white/10 hover:border-orange-500/70 text-left transition-colors disabled:opacity-50 flex items-start gap-3"
                  >
                    <div className="w-9 h-9 rounded-xl bg-orange-50 dark:bg-orange-950/40 flex items-center justify-center shrink-0">
                      {preset.icon}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-1">
                        <span className="text-xs font-bold text-slate-900 dark:text-white truncate">
                          {preset.label}
                        </span>
                        {alreadyLinked && (
                          <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400 shrink-0" />
                        )}
                      </div>
                      <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5 truncate">
                        {alreadyLinked ? 'Linked · Click to re-link' : preset.subtitle}
                      </p>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Persistent Linked Device Roots List */}
          {deviceRoots.length > 0 && (
            <div className="space-y-2.5">
              <h3 className="text-xs font-semibold text-slate-500 dark:text-slate-400 px-1">
                Linked Device Storage Roots ({deviceRoots.length})
              </h3>
              <div className="bg-white dark:bg-[#1C1C1E] rounded-2xl border border-slate-200/80 dark:border-white/10 divide-y divide-slate-100 dark:divide-white/8">
                {deviceRoots.map((root) => (
                  <div
                    key={root.id}
                    className="p-3.5 flex items-center justify-between gap-3"
                  >
                    <div className="min-w-0">
                      <div className="text-xs font-bold text-slate-900 dark:text-white truncate">
                        {root.name}
                      </div>
                      <div className="text-[11px] text-slate-500 dark:text-slate-400 font-mono tabular-nums mt-0.5">
                        {root.lastFileCount} files · {root.foldersScanned} folders
                        {root.lastSyncedIso ? ` · ${formatShortDate(root.lastSyncedIso)}` : ''}
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <button
                        type="button"
                        disabled={isIndexing}
                        onClick={() => onSyncSingleRoot(root.id, filters)}
                        className="min-h-[34px] px-3 rounded-lg bg-slate-100 dark:bg-[#2C2C2E] hover:bg-orange-50 dark:hover:bg-orange-950/40 hover:text-orange-600 text-xs font-semibold flex items-center gap-1.5 disabled:opacity-40"
                      >
                        <RefreshCw className="w-3.5 h-3.5" />
                        <span>Sync</span>
                      </button>
                      <button
                        type="button"
                        disabled={isIndexing}
                        onClick={() => onRemoveRoot(root.id)}
                        aria-label={`Unlink ${root.name}`}
                        className="w-8 h-8 rounded-lg flex items-center justify-center text-slate-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-950/30 disabled:opacity-40"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Universal Device File Scope */}
          <div className="bg-white dark:bg-[#1C1C1E] rounded-2xl p-4 border border-slate-200/80 dark:border-white/10 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-xs font-bold text-slate-800 dark:text-slate-100">
                File Types to Index (Everything Enabled)
              </h3>
              <select
                value={filters.maxFilesPerRun}
                onChange={(e) =>
                  setFilters((f) => ({ ...f, maxFilesPerRun: Number(e.target.value) }))
                }
                aria-label="Maximum files per indexing run"
                className="h-8 px-2.5 rounded-lg bg-slate-100 dark:bg-[#2C2C2E] text-[11px] font-mono font-semibold text-slate-700 dark:text-slate-200 focus:outline-none focus:ring-2 focus:ring-orange-500"
              >
                <option value={200}>Up to 200 files / run</option>
                <option value={500}>Up to 500 files / run</option>
                <option value={2000}>Up to 2,000 files / run</option>
              </select>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
              <label className="flex items-center gap-2.5 p-2 rounded-xl bg-slate-50 dark:bg-[#2C2C2E] cursor-pointer">
                <input
                  type="checkbox"
                  checked={filters.includePdf}
                  onChange={(e) => setFilters((f) => ({ ...f, includePdf: e.target.checked }))}
                  className="accent-orange-600 w-4 h-4 rounded"
                />
                <span className="font-medium">PDFs (Text + Scanned OCR)</span>
              </label>
              <label className="flex items-center gap-2.5 p-2 rounded-xl bg-slate-50 dark:bg-[#2C2C2E] cursor-pointer">
                <input
                  type="checkbox"
                  checked={filters.includeImages}
                  onChange={(e) => setFilters((f) => ({ ...f, includeImages: e.target.checked }))}
                  className="accent-orange-600 w-4 h-4 rounded"
                />
                <span className="font-medium">All Images &amp; Photos (OCR)</span>
              </label>
              <label className="flex items-center gap-2.5 p-2 rounded-xl bg-slate-50 dark:bg-[#2C2C2E] cursor-pointer">
                <input
                  type="checkbox"
                  checked={filters.includeOfficeDocs}
                  onChange={(e) =>
                    setFilters((f) => ({ ...f, includeOfficeDocs: e.target.checked }))
                  }
                  className="accent-orange-600 w-4 h-4 rounded"
                />
                <span className="font-medium">Office (DOCX, XLSX, PPTX, EPUB, RTF)</span>
              </label>
              <label className="flex items-center gap-2.5 p-2 rounded-xl bg-slate-50 dark:bg-[#2C2C2E] cursor-pointer">
                <input
                  type="checkbox"
                  checked={filters.includeTextDocs}
                  onChange={(e) =>
                    setFilters((f) => ({ ...f, includeTextDocs: e.target.checked }))
                  }
                  className="accent-orange-600 w-4 h-4 rounded"
                />
                <span className="font-medium">Text, Code, CSV, JSON, EML, ICS</span>
              </label>
              <label className="flex items-center gap-2.5 p-2 rounded-xl bg-slate-50 dark:bg-[#2C2C2E] cursor-pointer">
                <input
                  type="checkbox"
                  checked={filters.includeMediaAndArchives}
                  onChange={(e) =>
                    setFilters((f) => ({ ...f, includeMediaAndArchives: e.target.checked }))
                  }
                  className="accent-orange-600 w-4 h-4 rounded"
                />
                <span className="font-medium">Audio, Video &amp; ZIP/APK Archives</span>
              </label>
              <label className="flex items-center gap-2.5 p-2 rounded-xl bg-slate-50 dark:bg-[#2C2C2E] cursor-pointer">
                <input
                  type="checkbox"
                  checked={filters.includeAllOtherFiles}
                  onChange={(e) =>
                    setFilters((f) => ({ ...f, includeAllOtherFiles: e.target.checked }))
                  }
                  className="accent-orange-600 w-4 h-4 rounded"
                />
                <span className="font-medium">All Other Device Files (*.*)</span>
              </label>
            </div>

            <label className="flex items-center gap-2.5 pt-1 text-xs text-slate-600 dark:text-slate-300 cursor-pointer">
              <input
                type="checkbox"
                checked={filters.skipSystemFolders}
                onChange={(e) =>
                  setFilters((f) => ({ ...f, skipSystemFolders: e.target.checked }))
                }
                className="accent-orange-600 w-4 h-4 rounded"
              />
              <span>Skip hidden system &amp; build cache folders (.git, node_modules, caches)</span>
            </label>
          </div>

          {/* 100% On-Device Privacy Note */}
          <div className="flex items-start gap-2.5 px-1 text-[11px] text-slate-500 dark:text-slate-400">
            <ShieldCheck className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0 mt-0.5" />
            <p className="leading-relaxed">
              100% local on-device indexing. Files never leave your device. Browser privacy requires selecting your Home/Drive or standard folders once to grant read access across nested directories.
            </p>
          </div>
        </div>

        {/* Hidden OS Recursive Directory Fallback Input */}
        <input
          ref={fallbackDirInputRef}
          type="file"
          multiple
          // @ts-expect-error webkitdirectory enables recursive OS folder selection in browsers without File System Access
          webkitdirectory=""
          directory=""
          className="hidden"
          onChange={handleFallbackFolderChange}
        />
      </div>
    </div>
  );
};
