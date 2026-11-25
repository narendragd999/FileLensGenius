import React, { useMemo, useState } from 'react';
import {
  CheckCircle2,
  HardDrive,
  Loader2,
  RefreshCw,
  Smartphone,
  X,
} from 'lucide-react';
import { DeviceIndexSummary, IndexProgress, IndexStats } from '../types/filelens';
import { formatShortDate } from '../utils/formatters';
import { detectDeviceRuntime } from '../utils/deviceRoots';

export const DEVICE_DIR_INPUT_ID = 'filelens-global-dir-input';
export const DEVICE_FILES_INPUT_ID = 'filelens-global-files-input';

interface IndexDeviceTriggerProps {
  disabled?: boolean;
  onOneTapIndexDevice: () => void;
  className: string;
  ariaLabel?: string;
  children: React.ReactNode;
}

/**
 * Single universal 1-tap "Index Device" trigger:
 * - Native Android APK bridge -> triggers MANAGE_EXTERNAL_STORAGE / full storage crawl
 * - Desktop top-level Chrome/Edge -> directly syncs linked root or opens showDirectoryPicker synchronously
 * - Android / iOS mobile browser -> native <label> synchronously opens OS multi-file storage picker
 * - Desktop iframe / Firefox / Safari -> native <label> synchronously opens OS recursive folder picker
 */
export const IndexDeviceTrigger: React.FC<IndexDeviceTriggerProps> = ({
  disabled = false,
  onOneTapIndexDevice,
  className,
  ariaLabel,
  children,
}) => {
  const runtime = detectDeviceRuntime();

  if (runtime.hasNativeAndroidBridge || runtime.canUseDirectoryPickerDirect) {
    return (
      <button
        type="button"
        disabled={disabled}
        onClick={onOneTapIndexDevice}
        aria-label={ariaLabel}
        className={className}
      >
        {children}
      </button>
    );
  }

  const targetInputId = runtime.isMobile ? DEVICE_FILES_INPUT_ID : DEVICE_DIR_INPUT_ID;

  return (
    <label
      htmlFor={disabled ? undefined : targetInputId}
      aria-label={ariaLabel}
      className={`${className} cursor-pointer select-none ${
        disabled ? 'opacity-50 pointer-events-none' : ''
      }`}
    >
      {children}
    </label>
  );
};

interface SmartIndexingBarProps {
  stats: IndexStats;
  linkedDeviceRootsCount: number;
  hasAllFilesPermission: boolean;
  isIndexing: boolean;
  progress: IndexProgress | null;
  lastSummary: DeviceIndexSummary | null;
  onOneTapIndexDevice: () => void;
  onIndexFiles: (files: File[], sourceLabel: string) => void;
  onRunDeltaReindex: () => void;
  onCancelIndexing: () => void;
  compact?: boolean;
}

/**
 * Modeled directly after FileLensMobile's CompactDeviceIndexBar:
 * One single clear button ("Index Device" / "Index All" / "Allow & Scan")
 * that immediately indexes & OCRs all files on the device with zero confusing dialogs.
 */
export const SmartIndexingBar: React.FC<SmartIndexingBarProps> = ({
  stats,
  linkedDeviceRootsCount,
  hasAllFilesPermission,
  isIndexing,
  progress,
  lastSummary,
  onOneTapIndexDevice,
  onIndexFiles,
  onRunDeltaReindex,
  onCancelIndexing,
  compact = false,
}) => {
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  const runtime = detectDeviceRuntime();

  const isConnected =
    hasAllFilesPermission || linkedDeviceRootsCount > 0 || stats.totalFiles > 0;

  const buttonLabel = runtime.hasNativeAndroidBridge
    ? hasAllFilesPermission
      ? 'Index All'
      : 'Allow & Scan'
    : runtime.canUseDirectoryPickerDirect && linkedDeviceRootsCount > 0
    ? 'Index All'
    : 'Index Device';

  const subtitle = isIndexing && progress
    ? `${progress.phase} · ${progress.currentFile}`
    : stats.totalFiles > 0
    ? `${stats.totalFiles} files · ${stats.ocrDone} OCR ready`
    : runtime.hasNativeAndroidBridge && !hasAllFilesPermission
    ? 'Allow All Files Access for 1-tap full scan'
    : '1-tap scan & OCR all files on your device';

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
      className={`border transition-colors ${
        isDraggingOver
          ? 'border-orange-500 ring-2 ring-orange-500/25 bg-orange-50/70 dark:bg-orange-950/30'
          : 'border-orange-500/25 bg-orange-600/[0.06] dark:bg-orange-500/[0.10]'
      } ${compact ? 'rounded-xl px-2.5 py-2 space-y-2' : 'rounded-2xl p-3.5 sm:p-4 space-y-2.5'}`}
    >
      <div className="flex items-center gap-2.5">
        {/* Left status icon */}
        <div className="w-8 h-8 rounded-lg bg-orange-600/15 dark:bg-orange-500/20 flex items-center justify-center shrink-0">
          {isIndexing ? (
            <Loader2 className="w-4 h-4 text-orange-600 dark:text-orange-400 animate-spin" />
          ) : isConnected ? (
            <CheckCircle2 className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
          ) : runtime.isAndroid ? (
            <Smartphone className="w-4 h-4 text-orange-600 dark:text-orange-400" />
          ) : (
            <HardDrive className="w-4 h-4 text-orange-600 dark:text-orange-400" />
          )}
        </div>

        {/* Title & live status */}
        <div className="min-w-0 flex-1">
          <div className="text-xs sm:text-[13px] font-bold text-slate-900 dark:text-white leading-tight truncate">
            Entire Device Index
          </div>
          <div className="text-[11px] text-slate-600 dark:text-slate-300 font-mono tabular-nums truncate mt-0.5">
            {subtitle}
          </div>
        </div>

        {/* Right single primary action (+ subtle refresh icon when files exist) */}
        <div className="flex items-center gap-1.5 shrink-0">
          {stats.totalFiles > 0 && !isIndexing && (
            <button
              type="button"
              onClick={onRunDeltaReindex}
              title="Re-sync & OCR pending files"
              aria-label="Re-sync & OCR pending files"
              className="w-8 h-8 rounded-lg bg-white/80 dark:bg-[#1C1C1E] border border-orange-500/20 hover:border-orange-500 text-orange-600 dark:text-orange-400 flex items-center justify-center transition-colors shrink-0"
            >
              <RefreshCw className="w-3.5 h-3.5" />
            </button>
          )}

          {isIndexing ? (
            <button
              type="button"
              onClick={onCancelIndexing}
              className="h-8 px-3 rounded-lg bg-slate-900 dark:bg-white text-white dark:text-slate-900 text-xs font-semibold inline-flex items-center gap-1 whitespace-nowrap"
            >
              <X className="w-3.5 h-3.5" />
              <span>Stop</span>
            </button>
          ) : (
            <IndexDeviceTrigger
              onOneTapIndexDevice={onOneTapIndexDevice}
              className="h-8 px-3 rounded-lg bg-orange-600 hover:bg-orange-700 active:scale-[0.98] text-white text-xs font-bold inline-flex items-center gap-1.5 transition-all whitespace-nowrap shadow-xs"
            >
              <HardDrive className="w-3.5 h-3.5" />
              <span>{buttonLabel}</span>
            </IndexDeviceTrigger>
          )}
        </div>
      </div>

      {/* Live Inline Progress Bar */}
      {isIndexing && progress && (
        <div className="space-y-1">
          <div className="h-1.5 rounded-full bg-white/80 dark:bg-black/40 overflow-hidden">
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
          <div className="flex items-center justify-between text-[10px] font-mono tabular-nums text-slate-600 dark:text-slate-300">
            <span>
              {progress.phase === 'Discovering Device Folders'
                ? `${progress.foldersScanned ?? 0} folders · ${progress.total} files found`
                : `${progress.indexed}/${progress.total} (${pct}%) · +${progress.newOrUpdated} new`}
            </span>
            {progress.skippedUnchanged > 0 && (
              <span>{progress.skippedUnchanged} unchanged skipped</span>
            )}
          </div>
        </div>
      )}

      {/* Concise last sync summary in Tools view */}
      {!compact && !isIndexing && lastSummary && (
        <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-600 dark:text-slate-300 pt-1 border-t border-orange-500/15 font-mono tabular-nums">
          <span>
            Last sync: +{lastSummary.newOrUpdated} indexed · {lastSummary.skippedUnchanged} skipped ·{' '}
            {(lastSummary.elapsedMs / 1000).toFixed(1)}s
          </span>
          <span>{formatShortDate(lastSummary.timestampIso)}</span>
        </div>
      )}
    </section>
  );
};
