import React, { useEffect, useId, useMemo, useState } from 'react';
import {
  ChevronLeft,
  Copy,
  CopyCheck,
  Download,
  FileText,
  Folder,
  FolderPlus,
  HardDrive,
  Image as ImageIcon,
  Layers,
  Lock,
  Minimize2,
  Moon,
  Shield,
  Sparkles,
  Sun,
  Trash2,
  Upload,
  Wifi,
} from 'lucide-react';
import {
  AppPreferences,
  BatchAutoPace,
  DeviceIndexSummary,
  IndexProgress,
  IndexStats,
  OcrLanguage,
  PdfCompressPreset,
  PdfPageSizePreset,
  PdfQualityPreset,
  PhotoCompressPreset,
  ScanDocument,
  ScanFilterId,
} from '../types/filelens';
import { NAMING_TEMPLATES, SCAN_FILTERS } from '../data/seedData';
import { createEncryptedBackupBlob, decryptBackupBuffer } from '../utils/backupManager';
import { formatBytes, triggerFileDownload } from '../utils/formatters';
import { findSemanticDuplicates } from '../utils/smartTaxonomy';
import {
  analyzeVaultStorage,
  findExactDuplicates,
  findSimilarBurstPhotos,
  VisualBurstCluster,
} from '../utils/storageAnalyzer';
import { getBrowserStorageUsageBytes } from '../utils/vaultStorage';
import {
  AndroidNativeFileMeta,
  materializeAndroidNativeFile,
} from '../utils/deviceRoots';
import {
  AI_PROVIDER_PRESETS,
  AiConfig,
  loadAiConfig,
  saveAiConfig,
} from '../utils/aiService';
import { SmartIndexingBar } from './SmartIndexingBar';

interface ToolsAndSettingsViewProps {
  documents: ScanDocument[];
  preferences: AppPreferences;
  indexStats: IndexStats;
  linkedDeviceRootsCount: number;
  hasAllFilesPermission: boolean;
  isIndexing: boolean;
  indexProgress: IndexProgress | null;
  lastIndexSummary: DeviceIndexSummary | null;
  onOneTapIndexDevice: () => void;
  onIndexFiles: (files: File[], sourceLabel: string) => void;
  onRunDeltaReindex: () => void;
  onCancelIndexing: () => void;
  onUpdatePreferences: (next: AppPreferences) => void;
  onBatchCompressPdfs: (preset: PdfCompressPreset) => Promise<{ savedBytes: number; count: number }>;
  onBatchCompressPhotos: (preset: PhotoCompressPreset) => Promise<{ savedBytes: number; count: number }>;
  onDeleteDocument: (docId: string) => void;
  onExportWorkspaceBackup: () => string;
  onImportWorkspaceBackup: (json: string) => boolean;
  onClearWorkspace: () => void;
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

const PHOTO_COMPRESS_OPTIONS: {
  id: PhotoCompressPreset;
  label: string;
  subtitle: string;
}[] = [
  { id: 'ultra_compact', label: 'Max Space', subtitle: '1920px · 76% JPEG' },
  { id: 'lossless_look', label: 'Smart Lossless', subtitle: '2560px · 84% JPEG' },
  { id: 'max_quality', label: 'Studio Crisp', subtitle: '3840px · 90% JPEG' },
];

export const ToolsAndSettingsView: React.FC<ToolsAndSettingsViewProps> = ({
  documents,
  preferences,
  indexStats,
  linkedDeviceRootsCount,
  hasAllFilesPermission,
  isIndexing,
  indexProgress,
  lastIndexSummary,
  onOneTapIndexDevice,
  onIndexFiles,
  onRunDeltaReindex,
  onCancelIndexing,
  onUpdatePreferences,
  onBatchCompressPdfs,
  onBatchCompressPhotos,
  onDeleteDocument,
  onExportWorkspaceBackup,
  onImportWorkspaceBackup,
  onClearWorkspace,
  onToast,
}) => {
  const [compressPreset, setCompressPreset] = useState<PdfCompressPreset>('balanced');
  const [photoPreset, setPhotoPreset] = useState<PhotoCompressPreset>('lossless_look');
  const [isCompressing, setIsCompressing] = useState<boolean>(false);
  const [indexedDbBytes, setIndexedDbBytes] = useState<number>(0);
  const [cleanerTab, setCleanerTab] = useState<'exact' | 'burst' | 'semantic' | 'large'>('exact');
  const [burstClusters, setBurstClusters] = useState<VisualBurstCluster[]>([]);
  const [isScanningBursts, setIsScanningBursts] = useState<boolean>(false);
  const [backupPassword, setBackupPassword] = useState<string>('');
  const [lanUrl, setLanUrl] = useState<string>(() =>
    typeof window !== 'undefined' && window.FileLensAndroid?.getLanServerUrl
      ? window.FileLensAndroid.getLanServerUrl()
      : ''
  );
  const [ftpUrl, setFtpUrl] = useState<string>(() =>
    typeof window !== 'undefined' && window.FileLensAndroid?.getFtpServerUrl
      ? window.FileLensAndroid.getFtpServerUrl()
      : ''
  );
  const [aiConfig, setAiConfig] = useState<AiConfig>(() => loadAiConfig());
  const [fmPath, setFmPath] = useState<string>('');
  const [fmEntries, setFmEntries] = useState<
    { name: string; path: string; isDirectory: boolean; size: number; lastModified: number }[]
  >([]);
  const [showFileManager, setShowFileManager] = useState<boolean>(false);
  const [deviceVolumes, setDeviceVolumes] = useState<
    { name: string; path: string; totalBytes: number; freeBytes: number }[]
  >([]);
  const backupInputId = useId();
  const encryptedBackupInputId = useId();

  const hasAndroidBridge =
    typeof window !== 'undefined' && Boolean(window.FileLensAndroid?.listDirectory);

  const loadFmDirectory = (targetPath: string) => {
    if (!window.FileLensAndroid?.listDirectory) return;
    try {
      const raw = window.FileLensAndroid.listDirectory(targetPath);
      const parsed = JSON.parse(raw || '[]');
      setFmPath(targetPath);
      setFmEntries(Array.isArray(parsed) ? parsed : []);
    } catch {
      setFmEntries([]);
    }
  };

  useEffect(() => {
    if (window.FileLensAndroid?.getDeviceStorageStats) {
      try {
        const parsed = JSON.parse(window.FileLensAndroid.getDeviceStorageStats() || '{}');
        if (Array.isArray(parsed.volumes)) setDeviceVolumes(parsed.volumes);
      } catch {
        // Ignore
      }
    }
  }, []);

  useEffect(() => {
    void getBrowserStorageUsageBytes().then((bytes) => setIndexedDbBytes(bytes));
  }, [documents.length]);

  const storageAnalysis = useMemo(() => analyzeVaultStorage(documents), [documents]);
  const exactDuplicates = useMemo(() => findExactDuplicates(documents), [documents]);
  const semanticDuplicates = useMemo(() => findSemanticDuplicates(documents, 0.8), [documents]);

  const storageStats = useMemo(() => {
    const totalBytes = storageAnalysis.totalBytes;
    const totalPages = documents.reduce((acc, d) => acc + d.pages.length, 0);
    const selectedOpt = PDF_COMPRESS_OPTIONS.find((o) => o.id === compressPreset)!;
    const estSavings = Math.round(totalBytes * (1 - selectedOpt.ratio));
    return { totalBytes, totalPages, estSavings };
  }, [documents, storageAnalysis.totalBytes, compressPreset]);

  const handleCompressAll = async () => {
    setIsCompressing(true);
    try {
      const { savedBytes, count } = await onBatchCompressPdfs(compressPreset);
      onToast(
        count > 0
          ? `Compressed ${count} PDF(s) · Freed ${formatBytes(savedBytes)}`
          : 'All documents are already optimally compressed'
      );
    } finally {
      setIsCompressing(false);
    }
  };

  const handleShrinkPhotos = async () => {
    setIsCompressing(true);
    try {
      const { savedBytes, count } = await onBatchCompressPhotos(photoPreset);
      onToast(
        count > 0
          ? `Shrunk ${count} photo(s) · Freed ${formatBytes(savedBytes)}`
          : 'Photos are already optimally sized'
      );
    } finally {
      setIsCompressing(false);
    }
  };

  const handleScanBurstPhotos = async () => {
    setIsScanningBursts(true);
    try {
      const clusters = await findSimilarBurstPhotos(documents);
      setBurstClusters(clusters);
      onToast(
        clusters.length > 0
          ? `Found ${clusters.length} similar burst photo cluster(s)`
          : 'No similar burst photos detected'
      );
    } finally {
      setIsScanningBursts(false);
    }
  };

  const handleBackupDownload = () => {
    const json = onExportWorkspaceBackup();
    const blob = new Blob([json], { type: 'application/json' });
    triggerFileDownload(blob, `FileLens_Backup_${new Date().toISOString().slice(0, 10)}.json`);
    onToast('Exported full offline JSON workspace backup');
  };

  const handleEncryptedBackupDownload = async () => {
    if (!backupPassword.trim()) {
      onToast('Enter a backup password to encrypt .fspbackup');
      return;
    }
    try {
      const payload = JSON.parse(onExportWorkspaceBackup());
      const blob = await createEncryptedBackupBlob(payload, backupPassword.trim());
      triggerFileDownload(blob, `FileLens_Backup_${new Date().toISOString().slice(0, 10)}.fspbackup`);
      onToast('Exported AES-256-GCM encrypted .fspbackup');
    } catch {
      onToast('Could not create encrypted backup');
    }
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

  const handleEncryptedBackupFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!backupPassword.trim()) {
      onToast('Enter your backup password first to decrypt .fspbackup');
      e.target.value = '';
      return;
    }
    try {
      const buf = await file.arrayBuffer();
      const decoded = await decryptBackupBuffer(buf, backupPassword.trim());
      const ok = onImportWorkspaceBackup(JSON.stringify(decoded));
      onToast(ok ? 'Decrypted & restored .fspbackup workspace' : 'Backup payload invalid');
    } catch {
      onToast('Incorrect password or corrupted .fspbackup file');
    } finally {
      e.target.value = '';
    }
  };

  return (
    <div className="space-y-3.5">
      <div className="flex items-baseline justify-between gap-2">
        <h1 className="text-lg sm:text-xl font-bold tracking-tight text-slate-900 dark:text-white">
          Tools, Cleaner &amp; Settings
        </h1>
        <span className="text-[11px] font-mono tabular-nums text-slate-500 dark:text-slate-400">
          {formatBytes(storageStats.totalBytes)}
        </span>
      </div>

      {/* Full Universal Smart Indexing Control Panel */}
      <SmartIndexingBar
        stats={indexStats}
        linkedDeviceRootsCount={linkedDeviceRootsCount}
        hasAllFilesPermission={hasAllFilesPermission}
        isIndexing={isIndexing}
        progress={indexProgress}
        lastSummary={lastIndexSummary}
        onOneTapIndexDevice={onOneTapIndexDevice}
        onIndexFiles={onIndexFiles}
        onRunDeltaReindex={onRunDeltaReindex}
        onCancelIndexing={onCancelIndexing}
      />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Left Column: Storage Analyser, Compressors & Space Cleaner */}
        <div className="space-y-5">
          {/* Multi-Segment Vault Storage Analyser */}
          <section className="bg-white dark:bg-[#1C1C1E] rounded-2xl border border-slate-200/80 dark:border-white/10 p-5 space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <HardDrive className="w-4 h-4 text-orange-600 dark:text-orange-400" />
                <h2 className="text-sm font-bold">Vault Storage Analyser</h2>
              </div>
              <span className="text-xs font-mono tabular-nums font-semibold text-slate-600 dark:text-slate-300">
                {formatBytes(Math.max(storageStats.totalBytes, indexedDbBytes))} used
              </span>
            </div>

            <div className="h-3 rounded-full bg-slate-100 dark:bg-[#2C2C2E] overflow-hidden flex">
              {storageAnalysis.categories.map((cat) => {
                const pct =
                  storageStats.totalBytes === 0
                    ? 0
                    : Math.round((cat.bytes / Math.max(1, storageStats.totalBytes)) * 100);
                if (pct <= 0) return null;
                return (
                  <div
                    key={cat.id}
                    className="h-full transition-all"
                    style={{ width: `${pct}%`, backgroundColor: cat.color }}
                    title={`${cat.label}: ${formatBytes(cat.bytes)}`}
                  />
                );
              })}
            </div>

            <div className="grid grid-cols-2 gap-2 text-xs">
              {storageAnalysis.categories.map((cat) => (
                <div key={cat.id} className="flex items-center justify-between gap-2 bg-slate-50 dark:bg-[#2C2C2E] px-2.5 py-1.5 rounded-lg">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: cat.color }} />
                    <span className="truncate text-slate-700 dark:text-slate-200">{cat.label}</span>
                  </div>
                  <span className="font-mono text-[11px] text-slate-500 shrink-0">
                    {cat.count} · {formatBytes(cat.bytes)}
                  </span>
                </div>
              ))}
            </div>
          </section>

          {/* Real Batch PDF & Photo Compressor */}
          <section className="bg-white dark:bg-[#1C1C1E] rounded-2xl border border-slate-200/80 dark:border-white/10 p-5 space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Minimize2 className="w-4 h-4 text-orange-600 dark:text-orange-400" />
                <h2 className="text-sm font-bold">Real PDF &amp; Photo Shrinker</h2>
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
                  className={`p-2.5 rounded-xl border text-left transition-colors ${
                    compressPreset === opt.id
                      ? 'border-orange-600 bg-orange-50/80 dark:bg-orange-950/35'
                      : 'border-slate-200/80 dark:border-white/10 bg-slate-50 dark:bg-[#2C2C2E]'
                  }`}
                >
                  <div className="text-xs font-bold">{opt.label}</div>
                  <div className="text-[10px] text-slate-500 dark:text-slate-400 mt-0.5">
                    {opt.subtitle}
                  </div>
                </button>
              ))}
            </div>

            <button
              type="button"
              onClick={handleCompressAll}
              disabled={documents.length === 0 || isCompressing}
              className="w-full h-10 rounded-xl bg-orange-600 hover:bg-orange-700 disabled:opacity-40 text-white text-xs font-semibold transition-colors"
            >
              {isCompressing ? 'Compressing…' : `Shrink All ${documents.length} PDF(s)`}
            </button>

            <div className="pt-3 border-t border-slate-100 dark:border-white/8 space-y-2.5">
              <div className="flex items-center gap-1.5 text-xs font-bold">
                <ImageIcon className="w-3.5 h-3.5 text-sky-500" />
                <span>Shrink Photos (Smart Lossless / Studio Crisp)</span>
              </div>
              <div className="grid grid-cols-3 gap-2">
                {PHOTO_COMPRESS_OPTIONS.map((opt) => (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => setPhotoPreset(opt.id)}
                    className={`p-2 rounded-xl border text-left transition-colors ${
                      photoPreset === opt.id
                        ? 'border-sky-600 bg-sky-50/80 dark:bg-sky-950/35'
                        : 'border-slate-200/80 dark:border-white/10 bg-slate-50 dark:bg-[#2C2C2E]'
                    }`}
                  >
                    <div className="text-[11px] font-bold">{opt.label}</div>
                    <div className="text-[10px] text-slate-500 dark:text-slate-400">{opt.subtitle}</div>
                  </button>
                ))}
              </div>
              <button
                type="button"
                onClick={handleShrinkPhotos}
                disabled={documents.length === 0 || isCompressing}
                className="w-full h-9 rounded-xl bg-sky-600 hover:bg-sky-700 disabled:opacity-40 text-white text-xs font-semibold transition-colors"
              >
                Shrink Indexed Photos
              </button>
            </div>
          </section>

          {/* Space Cleaner Suite (Exact SHA-256, dHash Burst, Semantic Clones, Large Files) */}
          <section className="bg-white dark:bg-[#1C1C1E] rounded-2xl border border-slate-200/80 dark:border-white/10 p-5 space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <CopyCheck className="w-4 h-4 text-orange-600 dark:text-orange-400" />
                <h2 className="text-sm font-bold">Space Cleaner &amp; Duplicate Analyzer</h2>
              </div>
            </div>

            <div className="grid grid-cols-4 gap-1 p-1 rounded-xl bg-slate-100 dark:bg-[#2C2C2E] text-[11px]">
              {(
                [
                  { id: 'exact', label: `Exact (${exactDuplicates.length})` },
                  { id: 'burst', label: `Burst (${burstClusters.length})` },
                  { id: 'semantic', label: `Clones (${semanticDuplicates.length})` },
                  { id: 'large', label: `Large (${storageAnalysis.largeFiles.length})` },
                ] as const
              ).map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setCleanerTab(t.id)}
                  className={`py-1.5 rounded-lg font-semibold transition-colors ${
                    cleanerTab === t.id
                      ? 'bg-white dark:bg-[#1C1C1E] text-orange-600 shadow-xs'
                      : 'text-slate-600 dark:text-slate-300'
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>

            {cleanerTab === 'exact' && (
              <div className="space-y-2.5">
                {exactDuplicates.length === 0 ? (
                  <p className="text-xs text-slate-500">No exact duplicate files found.</p>
                ) : (
                  exactDuplicates.map((g) => (
                    <div key={g.hash} className="rounded-xl bg-slate-50 dark:bg-[#2C2C2E] p-3 space-y-2">
                      <div className="text-[11px] font-mono text-orange-600 font-semibold">
                        Reclaimable: {formatBytes(g.totalDuplicateBytes)}
                      </div>
                      {g.documents.map((d, idx) => (
                        <div key={d.id} className="flex items-center justify-between gap-2 text-xs">
                          <span className="truncate font-medium">
                            {idx === 0 ? '★ ' : ''}{d.title} ({formatBytes(d.sizeBytes)})
                          </span>
                          {idx > 0 && (
                            <button
                              type="button"
                              onClick={() => onDeleteDocument(d.id)}
                              className="px-2 py-1 rounded-lg bg-red-50 dark:bg-red-950/40 text-red-600 text-[11px] font-semibold shrink-0"
                            >
                              Remove
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                  ))
                )}
              </div>
            )}

            {cleanerTab === 'burst' && (
              <div className="space-y-2.5">
                <button
                  type="button"
                  onClick={handleScanBurstPhotos}
                  disabled={isScanningBursts}
                  className="w-full h-9 rounded-xl bg-slate-900 dark:bg-white text-white dark:text-slate-900 text-xs font-semibold flex items-center justify-center gap-1.5"
                >
                  <Sparkles className="w-3.5 h-3.5" />
                  <span>{isScanningBursts ? 'Scanning similar & blurry photos…' : 'Scan Similar / Burst Photos'}</span>
                </button>
                {burstClusters.map((cluster) => (
                  <div key={cluster.clusterId} className="rounded-xl bg-slate-50 dark:bg-[#2C2C2E] p-3 space-y-2">
                    <div className="text-[11px] font-mono text-sky-600 dark:text-sky-400 font-semibold">
                      Burst Cluster · Reclaim {formatBytes(cluster.reclaimableBytes)}
                    </div>
                    {cluster.items.map((it) => (
                      <div key={it.doc.id} className="flex items-center justify-between gap-2 text-xs">
                        <div className="min-w-0">
                          <div className="truncate font-medium">
                            {it.isBestShot ? '★ Best Shot: ' : ''}{it.doc.title}
                          </div>
                          <div className="text-[10px] text-slate-500 font-mono">
                            Sharpness {Math.round(it.sharpness)} · {formatBytes(it.doc.sizeBytes)}
                          </div>
                        </div>
                        {!it.isBestShot && (
                          <button
                            type="button"
                            onClick={() => onDeleteDocument(it.doc.id)}
                            className="px-2 py-1 rounded-lg bg-red-50 dark:bg-red-950/40 text-red-600 text-[11px] font-semibold shrink-0"
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

            {cleanerTab === 'semantic' && (
              <div className="space-y-2.5">
                {semanticDuplicates.length === 0 ? (
                  <p className="text-xs text-slate-500">No near-duplicate documents detected (cosine ≥ 80%).</p>
                ) : (
                  semanticDuplicates.map((group) => (
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
                  ))
                )}
              </div>
            )}

            {cleanerTab === 'large' && (
              <div className="space-y-2">
                {storageAnalysis.largeFiles.length === 0 ? (
                  <p className="text-xs text-slate-500">No files ≥ 1 MB in your vault.</p>
                ) : (
                  storageAnalysis.largeFiles.map((d) => (
                    <div key={d.id} className="flex items-center justify-between gap-2 text-xs bg-slate-50 dark:bg-[#2C2C2E] p-2.5 rounded-xl">
                      <div className="min-w-0">
                        <div className="font-semibold truncate">{d.title}</div>
                        <div className="text-[11px] font-mono text-slate-500">
                          {formatBytes(d.sizeBytes)} · {d.pages.length} page(s)
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => onDeleteDocument(d.id)}
                        className="px-2 py-1 rounded-lg bg-red-50 dark:bg-red-950/40 text-red-600 text-[11px] font-semibold shrink-0"
                      >
                        Delete
                      </button>
                    </div>
                  ))
                )}
              </div>
            )}
          </section>
        </div>

        {/* Right Column: Scanner Defaults, OCR Language, Security & Encrypted Backup */}
        <div className="space-y-5">
          <section className="bg-white dark:bg-[#1C1C1E] rounded-2xl border border-slate-200/80 dark:border-white/10 p-5 space-y-4">
            <h2 className="text-sm font-bold">Scanner, OCR &amp; Appearance</h2>

            <div className="flex items-center justify-between gap-4">
              <div>
                <div className="text-sm font-medium">Appearance</div>
                <div className="text-xs text-slate-500 dark:text-slate-400">
                  Alabaster Light or Titanium Dark surfaces
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
                  OCR Recognition Script
                </label>
                <select
                  value={preferences.ocrLanguage ?? 'eng+hin'}
                  onChange={(e) =>
                    onUpdatePreferences({
                      ...preferences,
                      ocrLanguage: e.target.value as OcrLanguage,
                    })
                  }
                  className="w-full h-10 px-3 rounded-xl bg-slate-50 dark:bg-[#2C2C2E] border border-slate-200 dark:border-white/10 text-xs font-semibold"
                >
                  <option value="eng+hin">English + Hindi (Devanagari)</option>
                  <option value="eng">English Only</option>
                  <option value="hin">Hindi (Devanagari) Only</option>
                </select>
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-600 dark:text-slate-300 mb-1">
                  Default PDF Quality
                </label>
                <select
                  value={preferences.defaultQuality}
                  onChange={(e) =>
                    onUpdatePreferences({
                      ...preferences,
                      defaultQuality: e.target.value as PdfQualityPreset,
                    })
                  }
                  className="w-full h-10 px-3 rounded-xl bg-slate-50 dark:bg-[#2C2C2E] border border-slate-200 dark:border-white/10 text-xs font-semibold"
                >
                  <option value="high">High (2200px)</option>
                  <option value="balanced">Balanced (1700px)</option>
                  <option value="compact">Compact (1300px)</option>
                </select>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
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

            {typeof window !== 'undefined' &&
              typeof window.FileLensAndroid?.isBatteryOptimizationIgnored === 'function' && (
                <div className="flex items-center justify-between gap-3 p-3 rounded-xl bg-slate-50 dark:bg-[#2C2C2E] border border-slate-200 dark:border-white/10">
                  <div>
                    <div className="text-xs font-semibold">Unrestricted Background Indexing</div>
                    <div className="text-[11px] text-slate-500 dark:text-slate-400">
                      {window.FileLensAndroid.isBatteryOptimizationIgnored()
                        ? 'Battery optimization disabled — indexing runs smoothly'
                        : 'Allow unrestricted battery so large OCR batches finish'}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      window.FileLensAndroid?.requestIgnoreBatteryOptimizations?.();
                      onToast('Opening battery optimization setting…');
                    }}
                    disabled={window.FileLensAndroid.isBatteryOptimizationIgnored()}
                    className="px-3 py-1.5 rounded-lg bg-orange-600 hover:bg-orange-700 disabled:bg-emerald-600 disabled:opacity-90 text-white text-[11px] font-semibold shrink-0"
                  >
                    {window.FileLensAndroid.isBatteryOptimizationIgnored() ? 'Enabled' : 'Allow'}
                  </button>
                </div>
              )}

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
                <div className="text-sm font-medium">Auto-Capture on Steady Edges</div>
                <div className="text-xs text-slate-500 dark:text-slate-400">
                  Automatically snap photo when camera holds steady on document
                </div>
              </div>
              <input
                type="checkbox"
                checked={preferences.autoCapture}
                onChange={(e) =>
                  onUpdatePreferences({
                    ...preferences,
                    autoCapture: e.target.checked,
                  })
                }
                className="w-5 h-5 accent-orange-600 rounded"
              />
            </label>

            <label className="flex items-center justify-between gap-3 pt-2 border-t border-slate-100 dark:border-white/8 cursor-pointer">
              <div>
                <div className="text-sm font-medium">Searchable OCR Text Layer</div>
                <div className="text-xs text-slate-500 dark:text-slate-400">
                  Embed invisible selectable OCR layer inside exported PDFs
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

            <div className="pt-2 border-t border-slate-100 dark:border-white/8 space-y-2">
              <label className="flex items-center justify-between gap-3 cursor-pointer">
                <div className="flex items-center gap-2">
                  <Lock className="w-4 h-4 text-orange-600" />
                  <div>
                    <div className="text-sm font-medium">Smart Cards Vault Lock</div>
                    <div className="text-xs text-slate-500 dark:text-slate-400">
                      Require PIN/unlock before viewing Govt IDs &amp; Finance cards
                    </div>
                  </div>
                </div>
                <input
                  type="checkbox"
                  checked={Boolean(preferences.biometricCardsLock)}
                  onChange={(e) =>
                    onUpdatePreferences({
                      ...preferences,
                      biometricCardsLock: e.target.checked,
                    })
                  }
                  className="w-5 h-5 accent-orange-600 rounded"
                />
              </label>
              {preferences.biometricCardsLock && (
                <input
                  type="password"
                  value={preferences.cardsPinCode ?? ''}
                  onChange={(e) =>
                    onUpdatePreferences({ ...preferences, cardsPinCode: e.target.value })
                  }
                  placeholder="Optional 4-6 digit Vault PIN…"
                  className="w-full h-9 px-3 rounded-xl bg-slate-50 dark:bg-[#2C2C2E] border border-slate-200 dark:border-white/10 text-xs"
                />
              )}
            </div>
          </section>

          {/* Encrypted .fspbackup & JSON Offline Backup */}
          <section className="bg-white dark:bg-[#1C1C1E] rounded-2xl border border-slate-200/80 dark:border-white/10 p-5 space-y-3">
            <div className="flex items-center gap-2">
              <Shield className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
              <h2 className="text-sm font-bold">Encrypted (.fspbackup) &amp; JSON Backup</h2>
            </div>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              AES-256-GCM encrypted backup compatible with FileLensMobile, or portable JSON export.
            </p>

            <input
              type="password"
              value={backupPassword}
              onChange={(e) => setBackupPassword(e.target.value)}
              placeholder="Encryption password for .fspbackup…"
              className="w-full h-10 px-3 rounded-xl bg-slate-50 dark:bg-[#2C2C2E] border border-slate-200 dark:border-white/10 text-xs"
            />

            <div className="flex flex-wrap items-center gap-2 pt-1">
              <button
                type="button"
                onClick={handleEncryptedBackupDownload}
                className="min-h-[38px] px-3.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-semibold flex items-center gap-1.5"
              >
                <Lock className="w-3.5 h-3.5" />
                <span>Export .fspbackup</span>
              </button>
              <label
                htmlFor={encryptedBackupInputId}
                className="min-h-[38px] px-3.5 rounded-xl bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 text-xs font-semibold inline-flex items-center gap-1.5 cursor-pointer select-none"
              >
                <Upload className="w-3.5 h-3.5" />
                <span>Restore .fspbackup</span>
              </label>
              {typeof window !== 'undefined' &&
                typeof window.FileLensAndroid?.clearNativeAppCache === 'function' && (
                  <button
                    type="button"
                    onClick={() => {
                      const freed = window.FileLensAndroid?.clearNativeAppCache?.() ?? 0;
                      onToast(`Cleared app cache · Freed ${formatBytes(freed)}`);
                    }}
                    className="min-h-[38px] px-3.5 rounded-xl bg-slate-100 dark:bg-[#2C2C2E] hover:bg-slate-200 dark:hover:bg-white/15 text-xs font-semibold flex items-center gap-1.5"
                  >
                    <Trash2 className="w-3.5 h-3.5 text-rose-500" />
                    <span>Clear App Cache</span>
                  </button>
                )}
              <button
                type="button"
                onClick={handleBackupDownload}
                className="min-h-[38px] px-3.5 rounded-xl bg-slate-900 dark:bg-white text-white dark:text-slate-900 text-xs font-semibold flex items-center gap-1.5"
              >
                <Download className="w-3.5 h-3.5" />
                <span>JSON</span>
              </button>
              <label
                htmlFor={backupInputId}
                className="min-h-[38px] px-3.5 rounded-xl bg-slate-100 dark:bg-[#2C2C2E] text-xs font-semibold inline-flex items-center gap-1.5 cursor-pointer select-none"
              >
                <Upload className="w-3.5 h-3.5" />
                <span>Restore JSON</span>
              </label>
              <button
                type="button"
                onClick={() => {
                  if (window.confirm('Clear all indexed documents, voice notes, and local vault data? This cannot be undone.')) {
                    onClearWorkspace();
                  }
                }}
                className="min-h-[38px] px-3 rounded-xl text-xs font-semibold text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30 flex items-center gap-1.5 ml-auto"
              >
                <Trash2 className="w-3.5 h-3.5" />
                <span>Clear Vault</span>
              </button>
              <input
                id={backupInputId}
                type="file"
                accept="application/json"
                className="sr-only"
                onChange={handleBackupFile}
              />
              <input
                id={encryptedBackupInputId}
                type="file"
                accept=".fspbackup,application/octet-stream"
                className="sr-only"
                onChange={handleEncryptedBackupFile}
              />
            </div>
          </section>

          {/* AI Structuring & Extraction Settings */}
          <section className="bg-white dark:bg-[#1C1C1E] rounded-2xl border border-slate-200/80 dark:border-white/10 p-5 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Sparkles className="w-4 h-4 text-violet-500" />
                <h2 className="text-sm font-bold">AI Structuring (CSV / Tables / Summary)</h2>
              </div>
              <button
                type="button"
                onClick={() => {
                  saveAiConfig(aiConfig);
                  onToast('Saved AI provider settings');
                }}
                className="px-3 py-1.5 rounded-xl bg-violet-600 hover:bg-violet-700 text-white text-xs font-semibold"
              >
                Save AI
              </button>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
              <select
                value={aiConfig.providerId}
                onChange={(e) => {
                  const preset =
                    AI_PROVIDER_PRESETS.find((p) => p.id === e.target.value) ?? AI_PROVIDER_PRESETS[0];
                  const next: AiConfig = {
                    ...aiConfig,
                    providerId: preset.id,
                    endpoint: preset.endpoint,
                    model: preset.defaultModel,
                  };
                  setAiConfig(next);
                  saveAiConfig(next);
                }}
                className="h-9 px-3 rounded-xl bg-slate-50 dark:bg-[#2C2C2E] border border-slate-200 dark:border-white/10 text-xs font-semibold"
              >
                {AI_PROVIDER_PRESETS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
              <input
                type="text"
                value={aiConfig.model}
                onChange={(e) => setAiConfig({ ...aiConfig, model: e.target.value })}
                placeholder="Model name"
                className="h-9 px-3 rounded-xl bg-slate-50 dark:bg-[#2C2C2E] border border-slate-200 dark:border-white/10 text-xs font-mono"
              />
            </div>
            <input
              type="url"
              value={aiConfig.endpoint}
              onChange={(e) => setAiConfig({ ...aiConfig, endpoint: e.target.value })}
              placeholder="OpenAI-compatible /v1/chat/completions endpoint"
              className="w-full h-9 px-3 rounded-xl bg-slate-50 dark:bg-[#2C2C2E] border border-slate-200 dark:border-white/10 text-xs font-mono"
            />
            <input
              type="password"
              value={aiConfig.apiKey}
              onChange={(e) => setAiConfig({ ...aiConfig, apiKey: e.target.value })}
              placeholder="API Key (stored locally on device)"
              className="w-full h-9 px-3 rounded-xl bg-slate-50 dark:bg-[#2C2C2E] border border-slate-200 dark:border-white/10 text-xs"
            />
          </section>

          {/* Native Android File Manager, StatFs Storage & LAN Wi-Fi PC Explorer */}
          {hasAndroidBridge && (
            <section className="bg-white dark:bg-[#1C1C1E] rounded-2xl border border-slate-200/80 dark:border-white/10 p-5 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <Wifi className="w-4 h-4 text-sky-500" />
                  <h2 className="text-sm font-bold">LAN PC Explorer, FTP &amp; File Manager</h2>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      if (lanUrl) {
                        window.FileLensAndroid?.stopLanServer?.();
                        setLanUrl('');
                        onToast('Stopped LAN Wi-Fi Explorer');
                      } else {
                        const url = window.FileLensAndroid?.startLanServer?.() || '';
                        setLanUrl(url);
                        if (url) onToast(`LAN Explorer live at ${url}`);
                      }
                    }}
                    className={`px-3 py-1.5 rounded-xl text-xs font-semibold ${
                      lanUrl
                        ? 'bg-emerald-600 text-white'
                        : 'bg-sky-600 hover:bg-sky-700 text-white'
                    }`}
                  >
                    {lanUrl ? 'Stop HTTP' : 'Start HTTP'}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      if (ftpUrl) {
                        window.FileLensAndroid?.stopFtpServer?.();
                        setFtpUrl('');
                        onToast('Stopped FTP Server');
                      } else {
                        const url = window.FileLensAndroid?.startFtpServer?.() || '';
                        setFtpUrl(url);
                        if (url) onToast(`FTP Server live at ${url}`);
                      }
                    }}
                    className={`px-3 py-1.5 rounded-xl text-xs font-semibold ${
                      ftpUrl
                        ? 'bg-emerald-600 text-white'
                        : 'bg-indigo-600 hover:bg-indigo-700 text-white'
                    }`}
                  >
                    {ftpUrl ? 'Stop FTP' : 'Start FTP'}
                  </button>
                </div>
              </div>

              {ftpUrl && (
                <div className="p-3 rounded-xl bg-indigo-50 dark:bg-indigo-950/30 border border-indigo-200 dark:border-indigo-900/50 flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-[11px] text-indigo-700 dark:text-indigo-300 font-semibold">
                      FTP Server (FileZilla / Windows Explorer · Anonymous):
                    </div>
                    <div className="text-xs font-mono font-bold text-slate-900 dark:text-white truncate">
                      {ftpUrl}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      navigator.clipboard?.writeText(ftpUrl).catch(() => undefined);
                      onToast('Copied FTP URL');
                    }}
                    className="px-2.5 py-1.5 rounded-lg bg-white dark:bg-[#2C2C2E] text-xs font-semibold flex items-center gap-1 shrink-0"
                  >
                    <Copy className="w-3.5 h-3.5" />
                    Copy
                  </button>
                </div>
              )}

              {lanUrl && (
                <div className="p-3 rounded-xl bg-sky-50 dark:bg-sky-950/30 border border-sky-200 dark:border-sky-900/50 flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-[11px] text-sky-700 dark:text-sky-300 font-semibold">
                      Open on any PC browser (same Wi-Fi):
                    </div>
                    <div className="text-xs font-mono font-bold text-slate-900 dark:text-white truncate">
                      {lanUrl}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      navigator.clipboard?.writeText(lanUrl).catch(() => undefined);
                      onToast('Copied LAN Explorer URL');
                    }}
                    className="px-2.5 py-1.5 rounded-lg bg-white dark:bg-[#2C2C2E] text-xs font-semibold flex items-center gap-1 shrink-0"
                  >
                    <Copy className="w-3.5 h-3.5" />
                    <span>Copy</span>
                  </button>
                </div>
              )}

              {deviceVolumes.length > 0 && (
                <div className="space-y-2">
                  {deviceVolumes.map((v) => {
                    const used = Math.max(0, v.totalBytes - v.freeBytes);
                    const pct = v.totalBytes > 0 ? Math.round((used / v.totalBytes) * 100) : 0;
                    return (
                      <div key={v.path} className="space-y-1 text-xs">
                        <div className="flex justify-between font-medium">
                          <span>{v.name}</span>
                          <span className="font-mono text-[11px] text-slate-500">
                            {formatBytes(used)} / {formatBytes(v.totalBytes)} ({pct}%)
                          </span>
                        </div>
                        <div className="h-2 rounded-full bg-slate-100 dark:bg-[#2C2C2E] overflow-hidden">
                          <div className="h-full bg-sky-500" style={{ width: `${pct}%` }} />
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              <button
                type="button"
                onClick={() => {
                  const next = !showFileManager;
                  setShowFileManager(next);
                  if (next) loadFmDirectory(fmPath);
                }}
                className="w-full h-10 rounded-xl bg-slate-100 dark:bg-[#2C2C2E] hover:bg-slate-200 text-xs font-semibold flex items-center justify-center gap-1.5"
              >
                <Folder className="w-4 h-4 text-orange-600" />
                <span>{showFileManager ? 'Hide Device File Browser' : 'Browse Internal & SD Card Files'}</span>
              </button>

              {showFileManager && (
                <div className="rounded-xl border border-slate-200/80 dark:border-white/10 overflow-hidden">
                  <div className="px-3 py-2 bg-slate-50 dark:bg-[#2C2C2E] flex items-center justify-between gap-2 text-xs">
                    <div className="flex items-center gap-1.5 min-w-0">
                      {fmPath && (
                        <button
                          type="button"
                          onClick={() => {
                            const parent = fmPath.includes('/')
                              ? fmPath.slice(0, fmPath.lastIndexOf('/'))
                              : '';
                            loadFmDirectory(parent === '/storage' || parent === '/storage/emulated' ? '' : parent);
                          }}
                          className="p-1 rounded hover:bg-slate-200 dark:hover:bg-white/10"
                        >
                          <ChevronLeft className="w-4 h-4" />
                        </button>
                      )}
                      <span className="font-mono truncate text-[11px] text-slate-600 dark:text-slate-300">
                        {fmPath || 'Storage Volumes'}
                      </span>
                    </div>
                    {fmPath && (
                      <button
                        type="button"
                        onClick={() => {
                          const name = window.prompt('New folder name:');
                          if (name?.trim()) {
                            window.FileLensAndroid?.createFolder?.(`${fmPath}/${name.trim()}`);
                            loadFmDirectory(fmPath);
                          }
                        }}
                        className="p-1 rounded hover:bg-slate-200 dark:hover:bg-white/10 text-orange-600"
                        title="New Folder"
                      >
                        <FolderPlus className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                  <div className="max-h-64 overflow-y-auto divide-y divide-slate-100 dark:divide-white/8">
                    {fmEntries.map((entry) => (
                      <div
                        key={entry.path}
                        className="px-3 py-2 flex items-center justify-between gap-2 text-xs hover:bg-slate-50 dark:hover:bg-white/[0.03]"
                      >
                        <button
                          type="button"
                          onClick={() => {
                            if (entry.isDirectory) {
                              loadFmDirectory(entry.path);
                            } else {
                              const meta: AndroidNativeFileMeta = {
                                name: entry.name,
                                path: entry.path,
                                size: entry.size,
                                mime: '',
                                lastModified: entry.lastModified,
                              };
                              const f = materializeAndroidNativeFile(meta);
                              onIndexFiles([f], 'File Manager');
                              onToast(`Indexing "${entry.name}"…`);
                            }
                          }}
                          className="flex items-center gap-2 min-w-0 flex-1 text-left"
                        >
                          {entry.isDirectory ? (
                            <Folder className="w-4 h-4 text-orange-500 shrink-0" />
                          ) : (
                            <FileText className="w-4 h-4 text-sky-500 shrink-0" />
                          )}
                          <div className="min-w-0">
                            <div className="font-medium truncate">{entry.name}</div>
                            {!entry.isDirectory && (
                              <div className="text-[10px] font-mono text-slate-400">
                                {formatBytes(entry.size)} · Tap to index &amp; OCR
                              </div>
                            )}
                          </div>
                        </button>
                        {!entry.isDirectory && (
                          <button
                            type="button"
                            onClick={() => {
                              if (!window.confirm(`Permanently delete "${entry.name}" from device storage?`)) {
                                return;
                              }
                              if (window.FileLensAndroid?.deleteNativeFile?.(entry.path)) {
                                loadFmDirectory(fmPath);
                                onToast(`Deleted ${entry.name}`);
                              }
                            }}
                            className="p-1.5 text-slate-400 hover:text-red-600 shrink-0"
                            title="Delete file"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </section>
          )}
        </div>
      </div>
    </div>
  );
};
