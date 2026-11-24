import React, { useRef, useState } from 'react';
import {
  CheckCircle2,
  Database,
  FileUp,
  FolderSearch,
  HardDrive,
  Loader2,
  RefreshCw,
  X,
} from 'lucide-react';
import { DeviceIndexSummary, IndexProgress, IndexStats } from '../types/filelens';
import { formatShortDate } from '../utils/formatters';

interface SmartIndexingBarProps {
  stats: IndexStats;
  linkedDeviceRootsCount: number;
  isIndexing: boolean;
  progress: IndexProgress | null;
  lastSummary: DeviceIndexSummary | null;
  onOpenDeviceIndexer: () => void;
  onIndexFiles: (files: File[], sourceLabel: string) => void;
  onRunDeltaReindex: () => void;
  onCancelIndexing: () => void;
  compact?: boolean;
}

export const SmartIndexingBar: React.FC<SmartIndexingBarProps> = ({
  stats,
  linkedDeviceRootsCount,
  isIndexing,
  progress,
  lastSummary,
  onOpenDeviceIndexer,
  onIndexFiles,
  onRunDeltaReindex,
  onCancelIndexing,
  compact = false,
}) => {
  const folderInputRef = useRef<HTMLInputElement | null>(null);
  const filesInputRef = useRef<HTMLInputElement | null>(null);
  const [isDraggingOver, setIsDraggingOver] = useState(false);

  const handleFolderPick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const fileList = e.target.files;
    if (fileList && fileList.length > 0) {
      const firstRel = (fileList[0] as File & { webkitRelativePath?: string }).webkitRelativePath;
      const folderName = firstRel ? firstRel.split('/')[0] : 'Local Folder';
      onIndexFiles(Array.from(fileList), `Folder: ${folderName}`);
    }
    e.target.value = '';
  };

  const handleFilesPick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const fileList = e.target.files;
    if (fileList && fileList.length > 0) {
      onIndexFiles(Array.from(fileList), `${fileList.length} Selected File(s)`);
    }
    e.target.value = '';
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDraggingOver(false);
    const dropped = Array.from(e.dataTransfer.files);
    if (dropped.length > 0) {
      onIndexFiles(dropped, `Dropped (${dropped.length} files)`);
    }
  };

  const pct =
    progress && progress.total > 0
      ? Math.min(100, Math.round((progress.indexed / progress.total) * 100))
      : 0;

  return (
    <section
      onDragOver={(e) => {
        e.preventDefault();
        if (!isDraggingOver) setIsDraggingOver(true);
      }}
      onDragLeave={() => setIsDraggingOver(false)}
      onDrop={handleDrop}
      className={`bg-white dark:bg-[#1C1C1E] rounded-2xl border transition-colors ${
        isDraggingOver
          ? 'border-orange-500 ring-2 ring-orange-500/25 bg-orange-50/40 dark:bg-orange-950/20'
          : 'border-slate-200/80 dark:border-white/10'
      } ${compact ? 'p-3.5 sm:p-4' : 'p-4 sm:p-5'} space-y-3.5`}
    >
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Database className="w-4 h-4 text-orange-600 dark:text-orange-400 shrink-0" />
            <h2 className="text-sm font-bold text-slate-900 dark:text-white">
              Universal On-Device Smart Indexing
            </h2>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-slate-500 dark:text-slate-400 font-mono tabular-nums">
            <span>{stats.totalFiles} files indexed</span>
            <span aria-hidden="true">·</span>
            <span>{stats.ocrDone} OCR/text ready</span>
            {stats.ocrPending > 0 && (
              <>
                <span aria-hidden="true">·</span>
                <span className="text-orange-600 dark:text-orange-400 font-semibold">
                  {stats.ocrPending} pending OCR
                </span>
              </>
            )}
            <span aria-hidden="true">·</span>
            <span>{stats.totalChunks} semantic chunks</span>
          </div>
        </div>

        <div className="flex items-center gap-2 flex-wrap shrink-0">
          <button
            type="button"
            disabled={isIndexing}
            onClick={onOpenDeviceIndexer}
            className="min-h-[38px] px-3.5 rounded-xl bg-orange-600 hover:bg-orange-700 disabled:opacity-50 text-white text-xs font-semibold flex items-center gap-1.5 transition-colors whitespace-nowrap"
          >
            <HardDrive className="w-3.5 h-3.5" />
            <span>
              {linkedDeviceRootsCount > 0
                ? `Index Device (${linkedDeviceRootsCount})`
                : 'Index Entire Device'}
            </span>
          </button>
          <button
            type="button"
            disabled={isIndexing}
            onClick={() => folderInputRef.current?.click()}
            className="min-h-[38px] px-3 rounded-xl bg-slate-100 dark:bg-[#2C2C2E] hover:bg-slate-200 dark:hover:bg-white/15 disabled:opacity-50 text-slate-800 dark:text-slate-100 text-xs font-semibold flex items-center gap-1.5 transition-colors whitespace-nowrap"
          >
            <FolderSearch className="w-3.5 h-3.5 text-orange-600 dark:text-orange-400" />
            <span>Folder</span>
          </button>
          <button
            type="button"
            disabled={isIndexing}
            onClick={() => filesInputRef.current?.click()}
            className="min-h-[38px] px-3 rounded-xl bg-slate-100 dark:bg-[#2C2C2E] hover:bg-slate-200 dark:hover:bg-white/15 disabled:opacity-50 text-slate-800 dark:text-slate-100 text-xs font-semibold flex items-center gap-1.5 transition-colors whitespace-nowrap"
          >
            <FileUp className="w-3.5 h-3.5 text-orange-600 dark:text-orange-400" />
            <span>Any Files</span>
          </button>
          <button
            type="button"
            disabled={isIndexing}
            onClick={onRunDeltaReindex}
            title="Run delta re-index & OCR on pending documents"
            className="min-h-[38px] px-3 rounded-xl bg-slate-100 dark:bg-[#2C2C2E] hover:bg-slate-200 dark:hover:bg-white/15 disabled:opacity-50 text-slate-800 dark:text-slate-100 text-xs font-semibold flex items-center gap-1.5 transition-colors whitespace-nowrap"
          >
            <RefreshCw
              className={`w-3.5 h-3.5 text-orange-600 dark:text-orange-400 ${
                isIndexing ? 'animate-spin' : ''
              }`}
            />
            <span>Delta Sync</span>
          </button>
        </div>
      </div>

      {/* Hidden Directory & Universal All-File Pickers (no restrictive extension filter!) */}
      <input
        ref={folderInputRef}
        type="file"
        multiple
        // @ts-expect-error webkitdirectory is supported across Chromium/Safari/Firefox for local folder indexing
        webkitdirectory=""
        directory=""
        className="hidden"
        onChange={handleFolderPick}
      />
      <input
        ref={filesInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={handleFilesPick}
      />

      {/* Live Discovery & Indexing Progress Bar */}
      {isIndexing && progress && (
        <div className="rounded-xl bg-slate-50 dark:bg-[#2C2C2E] p-3 space-y-2 border border-orange-200/70 dark:border-orange-900/40">
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
                aria-label="Cancel indexing"
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

      {/* Last Delta Index Run Summary */}
      {!isIndexing && lastSummary && (
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500 dark:text-slate-400 pt-1 border-t border-slate-100 dark:border-white/8">
          <div className="flex items-center gap-1.5">
            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400 shrink-0" />
            <span>
              Last run ({lastSummary.sourceLabel}):{' '}
              <strong className="text-slate-700 dark:text-slate-200 font-mono tabular-nums">
                {lastSummary.newOrUpdated} indexed
              </strong>
              {' · '}
              <span className="font-mono tabular-nums">{lastSummary.skippedUnchanged} skipped</span>
              {' · '}
              <span className="font-mono tabular-nums">
                {(lastSummary.elapsedMs / 1000).toFixed(1)}s
              </span>
            </span>
          </div>
          <span className="font-mono tabular-nums text-[11px]">
            {formatShortDate(lastSummary.timestampIso)}
          </span>
        </div>
      )}

      {!isIndexing && !lastSummary && !compact && (
        <p className="text-xs text-slate-500 dark:text-slate-400">
          Index your entire device or drop any file type—PDFs, DOCX/XLSX/PPTX, photos (real OCR), code, CSV/JSON, ZIP/APK archives, audio/video, and more. Everything is vector-indexed locally on-device.
        </p>
      )}
    </section>
  );
};
