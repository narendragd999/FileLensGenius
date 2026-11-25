import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  CheckCircle2,
  Download,
  FileText,
  FileUp,
  FolderOpen,
  HardDrive,
  Image as ImageIcon,
  Laptop,
  Loader2,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Smartphone,
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
import {
  AndroidAllFilesPermissionStatus,
  DEFAULT_DEVICE_INDEX_FILTERS,
  detectDeviceRuntime,
  getAndroidAllFilesPermissionStatus,
  requestAndroidAllFilesAccess,
  triggerAndroidNativeDeviceIndex,
} from '../utils/deviceRoots';

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
  onToast: (message: string) => void;
  onClose: () => void;
}

const STORAGE_PRESETS: {
  id: DeviceRootPreset;
  label: string;
  mobileLabel: string;
  subtitle: string;
  icon: React.ReactNode;
}[] = [
  {
    id: 'documents',
    label: 'Documents',
    mobileLabel: 'Documents',
    subtitle: 'PDFs, Office, contracts',
    icon: <FileText className="w-4 h-4 text-orange-600 dark:text-orange-400" />,
  },
  {
    id: 'downloads',
    label: 'Downloads',
    mobileLabel: 'Downloads',
    subtitle: 'Invoices, bills, ZIPs',
    icon: <Download className="w-4 h-4 text-orange-600 dark:text-orange-400" />,
  },
  {
    id: 'pictures',
    label: 'Pictures / DCIM',
    mobileLabel: 'DCIM / Photos',
    subtitle: 'Camera scans & OCR',
    icon: <ImageIcon className="w-4 h-4 text-orange-600 dark:text-orange-400" />,
  },
  {
    id: 'desktop',
    label: 'Desktop',
    mobileLabel: 'All Storage',
    subtitle: 'Internal & SD files',
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
  onToast,
  onClose,
}) => {
  const [filters, setFilters] = useState<DeviceIndexFilters>(DEFAULT_DEVICE_INDEX_FILTERS);
  const pendingSourceRef = useRef<string>('Device Storage');
  const fallbackDirInputRef = useRef<HTMLInputElement | null>(null);
  const allFilesInputRef = useRef<HTMLInputElement | null>(null);
  const dirInputId = useId();
  const filesInputId = useId();

  const runtime = useMemo(() => detectDeviceRuntime(), []);
  const [androidPermStatus, setAndroidPermStatus] =
    useState<AndroidAllFilesPermissionStatus>(() => getAndroidAllFilesPermissionStatus());

  // Re-check Android MANAGE_EXTERNAL_STORAGE status whenever user returns from Android Settings
  useEffect(() => {
    const refreshPermission = () => {
      setAndroidPermStatus(getAndroidAllFilesPermissionStatus());
    };
    window.addEventListener('focus', refreshPermission);
    document.addEventListener('visibilitychange', refreshPermission);
    return () => {
      window.removeEventListener('focus', refreshPermission);
      document.removeEventListener('visibilitychange', refreshPermission);
    };
  }, []);

  const handleRequestAndroidPermission = () => {
    const triggered = requestAndroidAllFilesAccess();
    if (triggered) {
      onToast('Opened Android All Files Access settings');
    } else {
      onToast('Select files from Android storage below');
      allFilesInputRef.current?.click();
    }
  };

  const handleStartNativeAndroidCrawl = () => {
    if (androidPermStatus !== 'granted') {
      handleRequestAndroidPermission();
      return;
    }
    const started = triggerAndroidNativeDeviceIndex(filters);
    if (started) {
      onToast('Started native Android full-storage indexing');
    } else {
      allFilesInputRef.current?.click();
    }
  };

  /**
   * Synchronous click handler — NEVER awaits before invoking a file/folder picker,
   * preserving browser transient user activation on Android, iOS, desktop, and iframes.
   */
  const handlePresetClick = (preset: DeviceRootPreset, label: string) => {
    if (isIndexing) return;
    pendingSourceRef.current = label;

    // 1. Desktop top-level with File System Access API -> persistent folder handle
    if (runtime.canUseDirectoryPickerDirect) {
      void onLinkAndIndexPreset(preset, filters).then((outcome) => {
        if (outcome === 'fallback_needed') {
          onToast('Use "Select Folder" or "Select Files" below to grant read access');
        }
      });
      return;
    }

    // 2. Mobile (Android Chrome / WebView / iOS Safari) -> native multi-file storage picker
    if (runtime.isMobile) {
      allFilesInputRef.current?.click();
      return;
    }

    // 3. Desktop inside iframe or Firefox/Safari -> synchronous webkitdirectory picker
    fallbackDirInputRef.current?.click();
  };

  const handleFolderInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const list = e.target.files;
    if (list && list.length > 0) {
      const files = Array.from(list);
      const firstRel = (files[0] as File & { webkitRelativePath?: string }).webkitRelativePath;
      const rootName = firstRel ? firstRel.split('/')[0] : pendingSourceRef.current;
      onIndexFallbackFolderFiles(files, `Device: ${rootName}`, filters);
    }
    e.target.value = '';
  };

  const handleAllFilesInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const list = e.target.files;
    if (list && list.length > 0) {
      const files = Array.from(list);
      onIndexFallbackFolderFiles(
        files,
        `${pendingSourceRef.current} (${files.length} files)`,
        filters
      );
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
      onClick={onClose}
    >
      <div
        className="w-full sm:max-w-2xl max-h-[92vh] flex flex-col bg-[#F2F2F7] dark:bg-[#141416] text-slate-900 dark:text-slate-100 rounded-t-3xl sm:rounded-3xl border border-slate-200/80 dark:border-white/10 shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Compact Top Sheet Header */}
        <header className="px-4 py-3 bg-white dark:bg-[#1C1C1E] border-b border-slate-200/80 dark:border-white/10 flex items-center justify-between gap-2.5 shrink-0">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-8 h-8 rounded-xl bg-orange-50 dark:bg-orange-950/50 text-orange-600 dark:text-orange-400 flex items-center justify-center shrink-0">
              {runtime.isAndroid ? (
                <Smartphone className="w-4 h-4" />
              ) : (
                <HardDrive className="w-4 h-4" />
              )}
            </div>
            <div className="min-w-0">
              <h2 className="text-sm sm:text-base font-bold tracking-tight truncate">
                Index Device Storage (All Files)
              </h2>
              <p className="text-[11px] text-slate-500 dark:text-slate-400 truncate">
                PDFs, Photos (OCR), DOCX/XLSX/PPTX, Code, ZIP/APK &amp; any file
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close device indexer"
            className="w-8 h-8 rounded-xl flex items-center justify-center text-slate-500 hover:bg-slate-100 dark:hover:bg-white/10 shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </header>

        {/* Scrollable Body */}
        <div className="flex-1 overflow-y-auto p-3.5 sm:p-5 space-y-3.5 sm:space-y-4">
          {/* Android All Files Permission Card (shown on Android devices or native Android WebView bridge) */}
          {(runtime.isAndroid || runtime.hasNativeAndroidBridge) && (
            <div className="bg-white dark:bg-[#1C1C1E] rounded-2xl p-3.5 border border-orange-200/80 dark:border-orange-900/50 space-y-2.5">
              <div className="flex items-start justify-between gap-2.5">
                <div className="flex items-start gap-2.5 min-w-0">
                  {androidPermStatus === 'granted' ? (
                    <ShieldCheck className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0 mt-0.5" />
                  ) : (
                    <ShieldAlert className="w-4 h-4 text-orange-600 dark:text-orange-400 shrink-0 mt-0.5" />
                  )}
                  <div className="min-w-0">
                    <h3 className="text-xs font-bold text-slate-900 dark:text-white">
                      {androidPermStatus === 'granted'
                        ? 'Android All Files Access Granted'
                        : androidPermStatus === 'required'
                        ? 'Android All Files Access Required'
                        : 'Android Storage Access'}
                    </h3>
                    <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5 leading-snug">
                      {androidPermStatus === 'granted'
                        ? 'MANAGE_EXTERNAL_STORAGE is active. Ready to crawl /storage/emulated/0.'
                        : androidPermStatus === 'required'
                        ? 'Allow "All files access" in Android Settings to automatically index every folder on your device.'
                        : 'Tap below to select files from Internal Storage, Downloads, Documents, DCIM, or WhatsApp. Native Android APK builds unlock automatic All Files Access.'}
                    </p>
                  </div>
                </div>
              </div>

              {runtime.hasNativeAndroidBridge && (
                <div className="flex flex-wrap gap-2">
                  {androidPermStatus !== 'granted' ? (
                    <button
                      type="button"
                      onClick={handleRequestAndroidPermission}
                      className="h-9 px-3.5 rounded-xl bg-orange-600 hover:bg-orange-700 text-white text-xs font-semibold flex items-center gap-1.5"
                    >
                      <ShieldCheck className="w-3.5 h-3.5" />
                      <span>Grant All Files Access</span>
                    </button>
                  ) : (
                    <button
                      type="button"
                      disabled={isIndexing}
                      onClick={handleStartNativeAndroidCrawl}
                      className="h-9 px-3.5 rounded-xl bg-orange-600 hover:bg-orange-700 disabled:opacity-50 text-white text-xs font-semibold flex items-center gap-1.5"
                    >
                      <HardDrive className="w-3.5 h-3.5" />
                      <span>Crawl Entire Android Storage</span>
                    </button>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Primary Action Card — Uses native <label> bindings for guaranteed synchronous OS picker launch */}
          <div className="bg-white dark:bg-[#1C1C1E] rounded-2xl p-3.5 sm:p-4 border border-slate-200/80 dark:border-white/10 space-y-3">
            <div>
              <h3 className="text-xs sm:text-sm font-bold text-slate-900 dark:text-white">
                {deviceRoots.length > 0
                  ? `Sync Linked Storage (${deviceRoots.length} root${deviceRoots.length > 1 ? 's' : ''})`
                  : 'Select Device Files or Folder to Index'}
              </h3>
              <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5 leading-snug">
                Runs on-device OCR on photos &amp; scanned PDFs, extracts text from Office/Code/ZIP, and indexes metadata for every other file type.
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {deviceRoots.length > 0 && (
                <button
                  type="button"
                  disabled={isIndexing}
                  onClick={() => onSyncAllDeviceRoots(filters)}
                  className="h-10 px-3.5 rounded-xl bg-orange-600 hover:bg-orange-700 disabled:opacity-50 text-white text-xs font-semibold flex items-center gap-1.5 transition-colors whitespace-nowrap"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${isIndexing ? 'animate-spin' : ''}`} />
                  <span>Sync Linked ({deviceRoots.length})</span>
                </button>
              )}

              {runtime.isMobile ? (
                /* On Android/iOS browsers, <label htmlFor> synchronously opens Android's native multi-file storage picker every time */
                <label
                  htmlFor={isIndexing ? undefined : filesInputId}
                  onPointerDown={() => {
                    pendingSourceRef.current = 'Android Storage';
                  }}
                  className={`h-10 px-4 rounded-xl bg-orange-600 hover:bg-orange-700 text-white text-xs font-semibold inline-flex items-center gap-1.5 transition-colors whitespace-nowrap cursor-pointer select-none ${
                    isIndexing ? 'opacity-50 pointer-events-none' : ''
                  }`}
                >
                  <FileUp className="w-4 h-4" />
                  <span>Select Files from Storage</span>
                </label>
              ) : runtime.canUseDirectoryPickerDirect ? (
                <>
                  <button
                    type="button"
                    disabled={isIndexing}
                    onClick={() => handlePresetClick('custom', 'Device Folder')}
                    className={`h-10 px-3.5 rounded-xl text-xs font-semibold flex items-center gap-1.5 transition-colors whitespace-nowrap disabled:opacity-50 ${
                      deviceRoots.length === 0
                        ? 'bg-orange-600 hover:bg-orange-700 text-white'
                        : 'bg-slate-100 dark:bg-[#2C2C2E] hover:bg-slate-200 dark:hover:bg-white/15 text-slate-900 dark:text-white'
                    }`}
                  >
                    <FolderOpen className="w-4 h-4" />
                    <span>Link Drive / Folder</span>
                  </button>
                  <label
                    htmlFor={isIndexing ? undefined : filesInputId}
                    onPointerDown={() => {
                      pendingSourceRef.current = 'Selected Files';
                    }}
                    className={`h-10 px-3.5 rounded-xl bg-slate-100 dark:bg-[#2C2C2E] hover:bg-slate-200 dark:hover:bg-white/15 text-slate-900 dark:text-white text-xs font-semibold inline-flex items-center gap-1.5 transition-colors whitespace-nowrap cursor-pointer select-none ${
                      isIndexing ? 'opacity-50 pointer-events-none' : ''
                    }`}
                  >
                    <FileUp className="w-4 h-4 text-orange-600 dark:text-orange-400" />
                    <span>Select Any Files</span>
                  </label>
                </>
              ) : (
                /* Desktop iframe or Safari/Firefox: native <label> to webkitdirectory + multi-file input */
                <>
                  <label
                    htmlFor={isIndexing ? undefined : dirInputId}
                    onPointerDown={() => {
                      pendingSourceRef.current = 'Device Folder';
                    }}
                    className={`h-10 px-3.5 rounded-xl bg-orange-600 hover:bg-orange-700 text-white text-xs font-semibold inline-flex items-center gap-1.5 transition-colors whitespace-nowrap cursor-pointer select-none ${
                      isIndexing ? 'opacity-50 pointer-events-none' : ''
                    }`}
                  >
                    <FolderOpen className="w-4 h-4" />
                    <span>Select Folder / Drive</span>
                  </label>
                  <label
                    htmlFor={isIndexing ? undefined : filesInputId}
                    onPointerDown={() => {
                      pendingSourceRef.current = 'Selected Files';
                    }}
                    className={`h-10 px-3.5 rounded-xl bg-slate-100 dark:bg-[#2C2C2E] hover:bg-slate-200 dark:hover:bg-white/15 text-slate-900 dark:text-white text-xs font-semibold inline-flex items-center gap-1.5 transition-colors whitespace-nowrap cursor-pointer select-none ${
                      isIndexing ? 'opacity-50 pointer-events-none' : ''
                    }`}
                  >
                    <FileUp className="w-4 h-4 text-orange-600 dark:text-orange-400" />
                    <span>Select Multiple Files</span>
                  </label>
                </>
              )}
            </div>

            {/* Live Full-Device Crawl & Indexing Progress */}
            {isIndexing && progress && (
              <div className="rounded-xl bg-slate-50 dark:bg-[#2C2C2E] p-3 space-y-2 border border-orange-200/70 dark:border-orange-900/40">
                <div className="flex items-center justify-between gap-2 text-xs">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <Loader2 className="w-3.5 h-3.5 text-orange-600 animate-spin shrink-0" />
                    <span className="font-semibold text-slate-800 dark:text-slate-100 shrink-0">
                      {progress.phase}
                    </span>
                    <span className="text-slate-500 dark:text-slate-400 truncate">
                      {progress.currentFile}
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
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
                <div className="h-1.5 rounded-full bg-slate-200 dark:bg-black/40 overflow-hidden">
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
                <div className="flex items-center gap-2.5 text-[11px] text-slate-500 dark:text-slate-400 font-mono tabular-nums">
                  <span>Indexed: {progress.newOrUpdated}</span>
                  <span aria-hidden="true">·</span>
                  <span>Skipped unchanged: {progress.skippedUnchanged}</span>
                </div>
              </div>
            )}

            {!isIndexing && lastSummary && (
              <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-slate-100 dark:border-white/8 text-[11px] text-slate-500 dark:text-slate-400">
                <span className="flex items-center gap-1.5">
                  <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400 shrink-0" />
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
                <span className="font-mono tabular-nums">
                  {formatShortDate(lastSummary.timestampIso)}
                </span>
              </div>
            )}
          </div>

          {/* Quick-Link Standard Device Storage Locations */}
          <div className="space-y-2">
            <h3 className="text-[11px] font-semibold text-slate-500 dark:text-slate-400 px-1 uppercase tracking-wide">
              Quick-Pick Storage Locations
            </h3>
            <div className="grid grid-cols-2 gap-2">
              {STORAGE_PRESETS.map((preset) => {
                const alreadyLinked = deviceRoots.some((r) => r.preset === preset.id);
                const labelText = runtime.isMobile ? preset.mobileLabel : preset.label;

                // Use native <label> on mobile & desktop-iframe for guaranteed synchronous picker open
                if (!runtime.canUseDirectoryPickerDirect) {
                  const targetInputId = runtime.isMobile ? filesInputId : dirInputId;
                  return (
                    <label
                      key={preset.id}
                      htmlFor={isIndexing ? undefined : targetInputId}
                      onPointerDown={() => {
                        pendingSourceRef.current = labelText;
                      }}
                      className={`p-3 rounded-2xl bg-white dark:bg-[#1C1C1E] border border-slate-200/80 dark:border-white/10 hover:border-orange-500/70 text-left transition-colors flex items-center gap-2.5 cursor-pointer select-none ${
                        isIndexing ? 'opacity-50 pointer-events-none' : ''
                      }`}
                    >
                      <div className="w-8 h-8 rounded-xl bg-orange-50 dark:bg-orange-950/40 flex items-center justify-center shrink-0">
                        {preset.icon}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="text-xs font-bold text-slate-900 dark:text-white truncate">
                          {labelText}
                        </div>
                        <p className="text-[11px] text-slate-500 dark:text-slate-400 truncate">
                          {preset.subtitle}
                        </p>
                      </div>
                    </label>
                  );
                }

                return (
                  <button
                    key={preset.id}
                    type="button"
                    disabled={isIndexing}
                    onClick={() => handlePresetClick(preset.id, labelText)}
                    className="p-3 rounded-2xl bg-white dark:bg-[#1C1C1E] border border-slate-200/80 dark:border-white/10 hover:border-orange-500/70 text-left transition-colors disabled:opacity-50 flex items-center gap-2.5"
                  >
                    <div className="w-8 h-8 rounded-xl bg-orange-50 dark:bg-orange-950/40 flex items-center justify-center shrink-0">
                      {preset.icon}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-1">
                        <span className="text-xs font-bold text-slate-900 dark:text-white truncate">
                          {labelText}
                        </span>
                        {alreadyLinked && (
                          <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400 shrink-0" />
                        )}
                      </div>
                      <p className="text-[11px] text-slate-500 dark:text-slate-400 truncate">
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
            <div className="space-y-2">
              <h3 className="text-[11px] font-semibold text-slate-500 dark:text-slate-400 px-1 uppercase tracking-wide">
                Linked Device Storage Roots ({deviceRoots.length})
              </h3>
              <div className="bg-white dark:bg-[#1C1C1E] rounded-2xl border border-slate-200/80 dark:border-white/10 divide-y divide-slate-100 dark:divide-white/8">
                {deviceRoots.map((root) => (
                  <div
                    key={root.id}
                    className="p-3 flex items-center justify-between gap-2.5"
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
                        className="h-8 px-2.5 rounded-lg bg-slate-100 dark:bg-[#2C2C2E] hover:bg-orange-50 dark:hover:bg-orange-950/40 hover:text-orange-600 text-xs font-semibold flex items-center gap-1 disabled:opacity-40"
                      >
                        <RefreshCw className="w-3 h-3" />
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
          <div className="bg-white dark:bg-[#1C1C1E] rounded-2xl p-3.5 border border-slate-200/80 dark:border-white/10 space-y-2.5">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-xs font-bold text-slate-800 dark:text-slate-100">
                File Types to Index
              </h3>
              <select
                value={filters.maxFilesPerRun}
                onChange={(e) =>
                  setFilters((f) => ({ ...f, maxFilesPerRun: Number(e.target.value) }))
                }
                aria-label="Maximum files per indexing run"
                className="h-7 px-2 rounded-lg bg-slate-100 dark:bg-[#2C2C2E] text-[11px] font-mono font-semibold text-slate-700 dark:text-slate-200 focus:outline-none focus:ring-2 focus:ring-orange-500"
              >
                <option value={200}>Up to 200 files</option>
                <option value={500}>Up to 500 files</option>
                <option value={2000}>Up to 2,000 files</option>
              </select>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5 text-xs">
              <label className="flex items-center gap-2 p-2 rounded-xl bg-slate-50 dark:bg-[#2C2C2E] cursor-pointer">
                <input
                  type="checkbox"
                  checked={filters.includePdf}
                  onChange={(e) => setFilters((f) => ({ ...f, includePdf: e.target.checked }))}
                  className="accent-orange-600 w-3.5 h-3.5 rounded"
                />
                <span className="font-medium">PDFs (Text + Scanned OCR)</span>
              </label>
              <label className="flex items-center gap-2 p-2 rounded-xl bg-slate-50 dark:bg-[#2C2C2E] cursor-pointer">
                <input
                  type="checkbox"
                  checked={filters.includeImages}
                  onChange={(e) => setFilters((f) => ({ ...f, includeImages: e.target.checked }))}
                  className="accent-orange-600 w-3.5 h-3.5 rounded"
                />
                <span className="font-medium">Images &amp; Photos (OCR)</span>
              </label>
              <label className="flex items-center gap-2 p-2 rounded-xl bg-slate-50 dark:bg-[#2C2C2E] cursor-pointer">
                <input
                  type="checkbox"
                  checked={filters.includeOfficeDocs}
                  onChange={(e) =>
                    setFilters((f) => ({ ...f, includeOfficeDocs: e.target.checked }))
                  }
                  className="accent-orange-600 w-3.5 h-3.5 rounded"
                />
                <span className="font-medium">Office (DOCX, XLSX, PPTX, RTF)</span>
              </label>
              <label className="flex items-center gap-2 p-2 rounded-xl bg-slate-50 dark:bg-[#2C2C2E] cursor-pointer">
                <input
                  type="checkbox"
                  checked={filters.includeTextDocs}
                  onChange={(e) =>
                    setFilters((f) => ({ ...f, includeTextDocs: e.target.checked }))
                  }
                  className="accent-orange-600 w-3.5 h-3.5 rounded"
                />
                <span className="font-medium">Text, Code, CSV, JSON, EML</span>
              </label>
              <label className="flex items-center gap-2 p-2 rounded-xl bg-slate-50 dark:bg-[#2C2C2E] cursor-pointer">
                <input
                  type="checkbox"
                  checked={filters.includeMediaAndArchives}
                  onChange={(e) =>
                    setFilters((f) => ({ ...f, includeMediaAndArchives: e.target.checked }))
                  }
                  className="accent-orange-600 w-3.5 h-3.5 rounded"
                />
                <span className="font-medium">Audio, Video &amp; ZIP/APK</span>
              </label>
              <label className="flex items-center gap-2 p-2 rounded-xl bg-slate-50 dark:bg-[#2C2C2E] cursor-pointer">
                <input
                  type="checkbox"
                  checked={filters.includeAllOtherFiles}
                  onChange={(e) =>
                    setFilters((f) => ({ ...f, includeAllOtherFiles: e.target.checked }))
                  }
                  className="accent-orange-600 w-3.5 h-3.5 rounded"
                />
                <span className="font-medium">All Other Device Files (*.*)</span>
              </label>
            </div>

            <label className="flex items-center gap-2 pt-0.5 text-[11px] text-slate-600 dark:text-slate-300 cursor-pointer">
              <input
                type="checkbox"
                checked={filters.skipSystemFolders}
                onChange={(e) =>
                  setFilters((f) => ({ ...f, skipSystemFolders: e.target.checked }))
                }
                className="accent-orange-600 w-3.5 h-3.5 rounded"
              />
              <span>Skip hidden system &amp; build cache folders (.git, node_modules, caches)</span>
            </label>
          </div>

          {/* 100% On-Device Privacy Note */}
          <div className="flex items-start gap-2 px-1 text-[11px] text-slate-500 dark:text-slate-400">
            <ShieldCheck className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400 shrink-0 mt-0.5" />
            <p className="leading-snug">
              100% private on-device indexing. All OCR, text parsing, and semantic vectors stay locally in your IndexedDB vault.
            </p>
          </div>
        </div>

        {/* Native OS Recursive Folder Input (for desktop/iframe) */}
        <input
          id={dirInputId}
          ref={fallbackDirInputRef}
          type="file"
          multiple
          // @ts-expect-error webkitdirectory enables recursive OS folder selection on desktop browsers
          webkitdirectory=""
          directory=""
          className="sr-only"
          onChange={handleFolderInputChange}
        />

        {/* Native Universal Multi-File Input (guaranteed to open Android / iOS / Desktop storage picker) */}
        <input
          id={filesInputId}
          ref={allFilesInputRef}
          type="file"
          multiple
          className="sr-only"
          onChange={handleAllFilesInputChange}
        />
      </div>
    </div>
  );
};
