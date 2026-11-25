import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Bookmark,
  Brain,
  Camera,
  CreditCard,
  FileText,
  Folder,
  HardDrive,
  Moon,
  Search,
  Settings,
  Sun,
} from 'lucide-react';
import {
  AppPreferences,
  AppTab,
  DeviceIndexFilters,
  DeviceIndexSummary,
  DeviceStorageRoot,
  DocFolder,
  DocumentPage,
  IndexProgress,
  IndexStats,
  PdfCompressPreset,
  PhotoCompressPreset,
  SavedSearch,
  SavedSignature,
  ScanDocument,
  ScanMode,
  SearchMode,
  SmartCardCategory,
  SmartToastItem,
  VoiceNote,
} from './types/filelens';
import {
  compressDocumentPagesReal,
  compressPhotoReal,
} from './utils/pdfExport';
import { classifyToastType, SmartToastHost } from './components/SmartToast';
import {
  DEFAULT_PREFERENCES,
  INITIAL_FOLDERS,
} from './data/seedData';
import {
  clearVaultState,
  createEmptyVaultState,
  loadVaultState,
  PersistedVaultState,
  saveVaultState,
} from './utils/vaultStorage';
import {
  runLibraryDeltaReindex,
  runSmartIndexingPipeline,
} from './utils/smartIndexer';
import {
  AndroidNativeFileMeta,
  cancelAndroidNativeDeviceIndex,
  clearAllStoredDeviceRoots,
  DEFAULT_DEVICE_INDEX_FILTERS,
  detectDeviceRuntime,
  ensureDirectoryReadPermission,
  getAndroidAllFilesPermissionStatus,
  getStoredDeviceRootHandle,
  listStoredDeviceRoots,
  materializeAndroidNativeFile,
  pickAndLinkDeviceRoot,
  requestAndroidAllFilesAccess,
  triggerAndroidNativeDeviceIndex,
  updateStoredDeviceRootStats,
  walkDeviceDirectoryHandle,
} from './utils/deviceRoots';
import { DocumentsView } from './components/DocumentsView';
import { SearchHubView } from './components/SearchHubView';
import { SecondBrainView } from './components/SecondBrainView';
import { SmartCardsView } from './components/SmartCardsView';
import { ToolsAndSettingsView } from './components/ToolsAndSettingsView';
import { LiveScannerModal } from './components/LiveScannerModal';
import { PageOrganizerModal } from './components/PageOrganizerModal';
import { PdfViewerModal } from './components/PdfViewerModal';
import {
  DEVICE_DIR_INPUT_ID,
  DEVICE_FILES_INPUT_ID,
  IndexDeviceTrigger,
} from './components/SmartIndexingBar';

export default function App() {
  const emptyInitial = useMemo(() => createEmptyVaultState(), []);
  const runtime = detectDeviceRuntime();
  const [documents, setDocuments] = useState<ScanDocument[]>(emptyInitial.documents);
  const [folders, setFolders] = useState<DocFolder[]>(emptyInitial.folders);
  const [voiceNotes, setVoiceNotes] = useState<VoiceNote[]>(emptyInitial.voiceNotes);
  const [savedSearches, setSavedSearches] = useState<SavedSearch[]>(emptyInitial.savedSearches);
  const [savedSignatures, setSavedSignatures] = useState<SavedSignature[]>(emptyInitial.savedSignatures);
  const [preferences, setPreferences] = useState<AppPreferences>(emptyInitial.preferences);
  const [isVaultHydrated, setIsVaultHydrated] = useState<boolean>(false);

  // Smart Indexing & Full-Device Storage state
  const [isIndexing, setIsIndexing] = useState<boolean>(false);
  const [indexProgress, setIndexProgress] = useState<IndexProgress | null>(null);
  const [lastIndexSummary, setLastIndexSummary] = useState<DeviceIndexSummary | null>(null);
  const [deviceRoots, setDeviceRoots] = useState<DeviceStorageRoot[]>([]);
  const [hasAllFilesPermission, setHasAllFilesPermission] = useState<boolean>(
    () => getAndroidAllFilesPermissionStatus() === 'granted'
  );
  const pendingAutoIndexAfterGrantRef = useRef<boolean>(false);
  const indexAbortRef = useRef<AbortController | null>(null);

  const [activeTab, setActiveTab] = useState<AppTab>('documents');
  const [selectedFolderId, setSelectedFolderId] = useState<string>('all');

  // Full-screen Genius Scan studios
  const [scannerState, setScannerState] = useState<{
    open: boolean;
    mode: ScanMode;
    appendToDocId?: string;
  }>({ open: false, mode: 'batch' });
  const [viewerState, setViewerState] = useState<{ docId: string; pageIndex: number } | null>(null);
  const [organizerDocId, setOrganizerDocId] = useState<string | null>(null);
  const [smartToast, setSmartToast] = useState<SmartToastItem | null>(null);

  // Hydrate persistent vault from IndexedDB (supports large real indexed files)
  useEffect(() => {
    let active = true;
    void loadVaultState().then((loaded) => {
      if (!active) return;
      setDocuments(loaded.documents);
      setFolders(loaded.folders);
      setVoiceNotes(loaded.voiceNotes);
      setSavedSearches(loaded.savedSearches);
      setSavedSignatures(loaded.savedSignatures);
      setPreferences(loaded.preferences);
      setLastIndexSummary(loaded.lastIndexSummary);
      setIsVaultHydrated(true);
    });
    void listStoredDeviceRoots().then((roots) => {
      if (active) setDeviceRoots(roots);
    });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    if (preferences.theme === 'dark') {
      root.classList.add('dark');
    } else {
      root.classList.remove('dark');
    }
  }, [preferences.theme]);

  // Persist workspace to IndexedDB (longer debounce during active indexing to prevent UI/IDB hang)
  useEffect(() => {
    if (!isVaultHydrated) return;
    const delayMs = isIndexing ? 4000 : 1200;
    const timer = window.setTimeout(() => {
      const payload: PersistedVaultState = {
        documents,
        folders,
        voiceNotes,
        savedSearches,
        savedSignatures,
        preferences,
        lastIndexSummary,
      };
      void saveVaultState(payload);
    }, delayMs);
    return () => window.clearTimeout(timer);
  }, [
    isVaultHydrated,
    isIndexing,
    documents,
    folders,
    voiceNotes,
    savedSearches,
    savedSignatures,
    preferences,
    lastIndexSummary,
  ]);

  const showToast = (
    message: string,
    undo?: { label?: string; action: () => void }
  ) => {
    setSmartToast({
      id: `toast-${Date.now()}`,
      message,
      type: classifyToastType(message),
      undoLabel: undo?.label,
      onUndo: undo?.action,
      durationMs: undo ? 3200 : 1800,
    });
  };

  const indexStats: IndexStats = useMemo(() => {
    const ocrDone = documents.filter(
      (d) => d.ocrStatus === 'done' || d.pages.every((p) => p.ocrText && p.ocrText.trim().length > 0)
    ).length;
    const totalChunks = documents.reduce(
      (acc, d) => acc + (d.chunksCount ?? Math.max(1, d.pages.length)),
      0
    );
    return {
      totalFiles: documents.length,
      ocrDone,
      ocrPending: Math.max(0, documents.length - ocrDone),
      totalChunks,
      cardsCount: documents.filter((d) => d.isSmartCard).length,
    };
  }, [documents]);

  const documentsRef = useRef<ScanDocument[]>(documents);
  documentsRef.current = documents;
  const androidBatchQueueRef = useRef<
    { items?: AndroidNativeFileMeta[]; files?: File[]; sourceLabel: string; totalFound?: number; sentCount?: number }[]
  >([]);
  const isDrainingAndroidQueueRef = useRef<boolean>(false);
  const androidCrawlDoneRef = useRef<boolean>(true);
  const androidStatsRef = useRef({
    newOrUpdated: 0,
    skippedUnchanged: 0,
    totalScanned: 0,
    foldersScanned: 0,
    startMs: 0,
    sourceLabel: 'Device & SD Card',
  });

  const handleIndexFiles = async (
    files: File[],
    sourceLabel: string,
    filePathMap?: WeakMap<File, string>,
    filters?: DeviceIndexFilters
  ) => {
    if (isIndexing || files.length === 0) return;
    const controller = new AbortController();
    indexAbortRef.current = controller;
    setIsIndexing(true);
    setIndexProgress({
      indexed: 0,
      total: files.length,
      currentFile: files[0].name,
      phase: 'Scanning',
      skippedUnchanged: 0,
      newOrUpdated: 0,
    });

    try {
      const result = await runSmartIndexingPipeline({
        files,
        existingDocuments: documentsRef.current,
        defaultFilter: preferences.defaultFilter,
        ocrLanguage: preferences.ocrLanguage ?? 'eng+hin',
        sourceLabel,
        filePathMap,
        filters,
        signal: controller.signal,
        onProgress: (prog) => setIndexProgress(prog),
      });

      if (result.newDocuments.length > 0 || result.updatedDocuments.length > 0) {
        setDocuments((prev) => {
          const updatedMap = new Map(result.updatedDocuments.map((d) => [d.id, d]));
          const merged = prev.map((d) => updatedMap.get(d.id) ?? d);
          return [...result.newDocuments, ...merged];
        });
      }

      setLastIndexSummary(result.summary);
      if (result.summary.wasCancelled) {
        showToast(`Indexing cancelled · ${result.summary.newOrUpdated} file(s) indexed`);
      } else if (result.summary.totalScanned === 0) {
        showToast('No files matched your active device scope filters');
      } else {
        showToast(
          `Smart Indexed ${result.summary.newOrUpdated} file(s) · ${result.summary.skippedUnchanged} unchanged skipped`
        );
      }
    } catch {
      showToast('Smart Indexing encountered an error on one or more files');
    } finally {
      setIsIndexing(false);
      setIndexProgress(null);
      indexAbortRef.current = null;
    }
  };

  // Sequential queue for native Android APK full-device + SD card crawl batches
  useEffect(() => {
    const finishIfReady = () => {
      if (
        androidCrawlDoneRef.current &&
        !isDrainingAndroidQueueRef.current &&
        androidBatchQueueRef.current.length === 0
      ) {
        const st = androidStatsRef.current;
        try {
          localStorage.removeItem('fl_device_index_pending');
        } catch {
          // ignore storage errors
        }
        window.FileLensAndroid?.stopBackgroundService?.();
        setIsIndexing(false);
        setIndexProgress(null);
        indexAbortRef.current = null;
        if (st.totalScanned > 0 || st.newOrUpdated > 0) {
          setLastIndexSummary({
            newOrUpdated: st.newOrUpdated,
            skippedUnchanged: st.skippedUnchanged,
            totalScanned: st.totalScanned,
            elapsedMs: Math.round(performance.now() - st.startMs),
            timestampIso: new Date().toISOString(),
            sourceLabel: st.sourceLabel,
          });
          showToast(
            `Device & SD Card indexed: ${st.newOrUpdated} new/updated · ${st.skippedUnchanged} unchanged`
          );
        } else {
          showToast('Device & SD Card scan complete · 0 matching files found');
        }
      }
    };

    const drainQueue = async () => {
      if (isDrainingAndroidQueueRef.current) return;
      isDrainingAndroidQueueRef.current = true;
      setIsIndexing(true);
      window.FileLensAndroid?.startBackgroundService?.(
        'FileLens Genius Indexing',
        'Scanning & OCRing device files…',
        0,
        0
      );
      const controller = new AbortController();
      indexAbortRef.current = controller;

      try {
        while (androidBatchQueueRef.current.length > 0 && !controller.signal.aborted) {
          const item = androidBatchQueueRef.current.shift()!;
          const batchFiles = item.items
            ? item.items.map((m) => materializeAndroidNativeFile(m))
            : item.files || [];
          if (batchFiles.length === 0) continue;

          const result = await runSmartIndexingPipeline({
            files: batchFiles,
            existingDocuments: documentsRef.current,
            defaultFilter: preferences.defaultFilter,
            ocrLanguage: preferences.ocrLanguage ?? 'eng+hin',
            sourceLabel: item.sourceLabel,
            signal: controller.signal,
            onProgress: (prog) => {
              const st = androidStatsRef.current;
              const doneCount = st.totalScanned + prog.indexed;
              const totalCount = Math.max(item.totalFound ?? doneCount + prog.total, st.totalScanned + prog.total);
              setIndexProgress({
                ...prog,
                indexed: doneCount,
                total: totalCount,
                newOrUpdated: st.newOrUpdated + prog.newOrUpdated,
                skippedUnchanged: st.skippedUnchanged + prog.skippedUnchanged,
                foldersScanned: st.foldersScanned,
              });
              window.FileLensAndroid?.updateBackgroundService?.(
                'FileLens Genius Indexing',
                `${prog.phase}: ${prog.currentFile}`,
                doneCount,
                totalCount
              );
            },
          });

          if (result.newDocuments.length > 0 || result.updatedDocuments.length > 0) {
            setDocuments((prev) => {
              const updatedMap = new Map(result.updatedDocuments.map((d) => [d.id, d]));
              const merged = prev.map((d) => updatedMap.get(d.id) ?? d);
              const next = [...result.newDocuments, ...merged];
              documentsRef.current = next;
              return next;
            });
          }

          androidStatsRef.current.newOrUpdated += result.summary.newOrUpdated;
          androidStatsRef.current.skippedUnchanged += result.summary.skippedUnchanged;
          androidStatsRef.current.totalScanned += result.summary.totalScanned;
          androidStatsRef.current.sourceLabel = item.sourceLabel;
          // Yield to WebView UI thread between batches so scrolling & taps stay responsive
          await new Promise((resolve) => window.setTimeout(resolve, 30));
        }
      } finally {
        isDrainingAndroidQueueRef.current = false;
        finishIfReady();
      }
    };

    const onAndroidProgress = (ev: Event) => {
      const d = (ev as CustomEvent<{ found?: number; folders?: number; currentFolder?: string }>).detail;
      if (!d) return;
      androidStatsRef.current.foldersScanned = d.folders ?? androidStatsRef.current.foldersScanned;
      if (!isDrainingAndroidQueueRef.current) {
        setIsIndexing(true);
        setIndexProgress({
          indexed: 0,
          total: d.found ?? 0,
          currentFile: d.currentFolder || 'Scanning Device & SD Card…',
          phase: 'Discovering Device Folders',
          skippedUnchanged: 0,
          newOrUpdated: 0,
          foldersScanned: d.folders ?? 0,
        });
      }
    };

    const onAndroidFilesMeta = (ev: Event) => {
      const detail = (
        ev as CustomEvent<{
          items?: AndroidNativeFileMeta[];
          sourceLabel?: string;
          totalFound?: number;
          sentCount?: number;
        }>
      ).detail;
      if (detail?.items && detail.items.length > 0) {
        androidBatchQueueRef.current.push({
          items: detail.items,
          sourceLabel: detail.sourceLabel || 'Internal & SD Card Storage',
          totalFound: detail.totalFound,
          sentCount: detail.sentCount,
        });
        void drainQueue();
      }
    };

    const onAndroidFiles = (ev: Event) => {
      const detail = (
        ev as CustomEvent<{
          files?: File[];
          sourceLabel?: string;
          totalFound?: number;
          sentCount?: number;
        }>
      ).detail;
      if (detail?.files && detail.files.length > 0) {
        androidBatchQueueRef.current.push({
          files: detail.files,
          sourceLabel: detail.sourceLabel || 'Internal & SD Card Storage',
          totalFound: detail.totalFound,
          sentCount: detail.sentCount,
        });
        void drainQueue();
      }
    };

    const onAndroidReady = () => {
      setHasAllFilesPermission(getAndroidAllFilesPermissionStatus() === 'granted');
    };

    const onAndroidComplete = (ev: Event) => {
      const d = (
        ev as CustomEvent<{
          sourceLabel?: string;
          totalFound?: number;
          foldersScanned?: number;
          cancelled?: boolean;
        }>
      ).detail;
      androidCrawlDoneRef.current = true;
      if (d?.sourceLabel) androidStatsRef.current.sourceLabel = d.sourceLabel;
      if (d?.foldersScanned) androidStatsRef.current.foldersScanned = d.foldersScanned;
      finishIfReady();
    };

    window.addEventListener('filelens-android-ready', onAndroidReady);
    window.addEventListener('filelens-android-progress', onAndroidProgress);
    window.addEventListener('filelens-android-files-meta', onAndroidFilesMeta);
    window.addEventListener('filelens-android-files', onAndroidFiles);
    window.addEventListener('filelens-android-complete', onAndroidComplete);
    return () => {
      window.removeEventListener('filelens-android-ready', onAndroidReady);
      window.removeEventListener('filelens-android-progress', onAndroidProgress);
      window.removeEventListener('filelens-android-files-meta', onAndroidFilesMeta);
      window.removeEventListener('filelens-android-files', onAndroidFiles);
      window.removeEventListener('filelens-android-complete', onAndroidComplete);
    };
  }, [preferences.defaultFilter, preferences.ocrLanguage]);

  const runWalkAndIndexRoots = async (
    entries: { root: DeviceStorageRoot; handle: FileSystemDirectoryHandle }[],
    sourceLabel: string,
    filters: DeviceIndexFilters
  ) => {
    if (isIndexing || entries.length === 0) return;
    const controller = new AbortController();
    indexAbortRef.current = controller;
    setIsIndexing(true);

    try {
      const combinedFiles: File[] = [];
      const combinedPathMap = new WeakMap<File, string>();
      let totalFoldersScanned = 0;

      for (const { root, handle } of entries) {
        if (controller.signal.aborted) break;
        const remainingCap = Math.max(0, filters.maxFilesPerRun - combinedFiles.length);
        if (remainingCap === 0) break;

        const walked = await walkDeviceDirectoryHandle(
          handle,
          root.name,
          { ...filters, maxFilesPerRun: remainingCap },
          controller.signal,
          (disc) => {
            setIndexProgress({
              indexed: 0,
              total: combinedFiles.length + disc.filesFound,
              currentFile: disc.currentFolder,
              phase: 'Discovering Device Folders',
              skippedUnchanged: 0,
              newOrUpdated: 0,
              foldersScanned: totalFoldersScanned + disc.foldersScanned,
            });
          }
        );

        totalFoldersScanned += walked.foldersScanned;
        for (const f of walked.files) {
          combinedFiles.push(f);
          const p = walked.filePathMap.get(f);
          if (p) combinedPathMap.set(f, p);
        }

        await updateStoredDeviceRootStats(root.id, walked.files.length, walked.foldersScanned);
      }

      const refreshedRoots = await listStoredDeviceRoots();
      setDeviceRoots(refreshedRoots);

      if (combinedFiles.length === 0) {
        showToast(
          controller.signal.aborted
            ? 'Device discovery cancelled'
            : 'No matching files found in linked device storage'
        );
        return;
      }

      const result = await runSmartIndexingPipeline({
        files: combinedFiles,
        existingDocuments: documents,
        defaultFilter: preferences.defaultFilter,
        sourceLabel,
        filePathMap: combinedPathMap,
        filters,
        signal: controller.signal,
        onProgress: (prog) => setIndexProgress(prog),
      });

      if (result.newDocuments.length > 0 || result.updatedDocuments.length > 0) {
        setDocuments((prev) => {
          const updatedMap = new Map(result.updatedDocuments.map((d) => [d.id, d]));
          const merged = prev.map((d) => updatedMap.get(d.id) ?? d);
          return [...result.newDocuments, ...merged];
        });
      }

      setLastIndexSummary(result.summary);
      showToast(
        result.summary.wasCancelled
          ? `Device sync cancelled · ${result.summary.newOrUpdated} file(s) indexed`
          : `Device indexed ${result.summary.newOrUpdated} file(s) across ${totalFoldersScanned} folder(s) · ${result.summary.skippedUnchanged} unchanged`
      );
    } catch {
      showToast('Device indexing encountered an error on one or more folders');
    } finally {
      setIsIndexing(false);
      setIndexProgress(null);
      indexAbortRef.current = null;
    }
  };

  // Mirror FileLensMobile MainActivity.kt: auto-start full-device index right after user grants Android All Files Access
  useEffect(() => {
    if (!runtime.hasNativeAndroidBridge) return;
    const onResumeCheck = () => {
      const granted = getAndroidAllFilesPermissionStatus() === 'granted';
      setHasAllFilesPermission(granted);
      if (granted && pendingAutoIndexAfterGrantRef.current) {
        pendingAutoIndexAfterGrantRef.current = false;
        androidCrawlDoneRef.current = false;
        androidBatchQueueRef.current = [];
        androidStatsRef.current = {
          newOrUpdated: 0,
          skippedUnchanged: 0,
          totalScanned: 0,
          foldersScanned: 0,
          startMs: performance.now(),
          sourceLabel: 'Device & SD Card',
        };
        try {
          localStorage.setItem('fl_device_index_pending', '1');
        } catch {
          // ignore storage errors
        }
        setIsIndexing(true);
        triggerAndroidNativeDeviceIndex(DEFAULT_DEVICE_INDEX_FILTERS);
        showToast('All Files Access granted · Indexing & OCRing device & SD card…');
      }
    };
    window.addEventListener('focus', onResumeCheck);
    document.addEventListener('visibilitychange', onResumeCheck);
    return () => {
      window.removeEventListener('focus', onResumeCheck);
      document.removeEventListener('visibilitychange', onResumeCheck);
    };
  }, [runtime.hasNativeAndroidBridge]);

  // Auto-resume indexing on app launch from remaining checkpoint if not all files are indexed
  const launchAutoResumeCheckedRef = useRef(false);
  useEffect(() => {
    if (!isVaultHydrated || launchAutoResumeCheckedRef.current) return;
    launchAutoResumeCheckedRef.current = true;
    if (!runtime.hasNativeAndroidBridge) return;
    if (getAndroidAllFilesPermissionStatus() !== 'granted') return;

    let hasCheckpoint = false;
    try {
      hasCheckpoint = localStorage.getItem('fl_device_index_pending') === '1';
    } catch {
      hasCheckpoint = false;
    }
    const hasPendingOcr = documentsRef.current.some((d) => d.ocrStatus === 'pending');
    if (!hasCheckpoint && !hasPendingOcr) return;

    const timer = window.setTimeout(() => {
      if (isDrainingAndroidQueueRef.current) return;
      try {
        localStorage.setItem('fl_device_index_pending', '1');
      } catch {
        // ignore storage errors
      }
      androidCrawlDoneRef.current = false;
      androidBatchQueueRef.current = [];
      androidStatsRef.current = {
        newOrUpdated: 0,
        skippedUnchanged: 0,
        totalScanned: 0,
        foldersScanned: 0,
        startMs: performance.now(),
        sourceLabel: 'Device & SD Card',
      };
      setIsIndexing(true);
      setIndexProgress({
        indexed: 0,
        total: 0,
        currentFile: 'Resuming from remaining checkpoint…',
        phase: 'Discovering Device Folders',
        skippedUnchanged: 0,
        newOrUpdated: 0,
      });
      triggerAndroidNativeDeviceIndex(DEFAULT_DEVICE_INDEX_FILTERS);
    }, 800);
    return () => window.clearTimeout(timer);
  }, [isVaultHydrated, runtime.hasNativeAndroidBridge]);

  // Handle incoming Android ACTION_SEND / ACTION_SEND_MULTIPLE share intents (PDFs, images, WhatsApp text)
  useEffect(() => {
    if (!isVaultHydrated || !runtime.hasNativeAndroidBridge) return;
    const processSharePayload = (raw: unknown) => {
      if (!raw || typeof raw !== 'object') return;
      const payload = raw as {
        text?: string;
        files?: { name: string; mime: string; base64: string }[];
      };
      if (Array.isArray(payload.files) && payload.files.length > 0) {
        const files: File[] = [];
        for (const item of payload.files) {
          try {
            const bin = atob(item.base64);
            const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            files.push(new File([bytes], item.name || 'shared_file', { type: item.mime || 'application/octet-stream' }));
          } catch {
            // skip malformed attachment
          }
        }
        if (files.length > 0) {
          void handleIndexFiles(files, 'Shared Intent');
          setActiveTab('documents');
          showToast(`Imported ${files.length} shared file${files.length > 1 ? 's' : ''}`);
        }
      } else if (payload.text && payload.text.trim()) {
        const text = payload.text.trim();
        const note: VoiceNote = {
          id: `vn-share-${Date.now()}`,
          title: text.slice(0, 48) + (text.length > 48 ? '…' : ''),
          transcript: text,
          temporalClass: 'today',
          recurrence: 'none',
          languageCode: preferences.voiceLanguage || 'en-IN',
          createdAt: new Date().toISOString(),
          checklist: [{ id: `chk-${Date.now()}`, text, done: false }],
        };
        setVoiceNotes((prev) => [note, ...prev]);
        setActiveTab('brain');
        showToast('Saved shared text to Second Brain');
      }
    };

    try {
      const pendingRaw = window.FileLensAndroid?.consumePendingShareIntent?.();
      if (pendingRaw) processSharePayload(JSON.parse(pendingRaw));
    } catch {
      // ignore invalid pending share payload
    }

    const onShareEvent = (ev: Event) => {
      processSharePayload((ev as CustomEvent).detail);
    };
    window.addEventListener('filelens-share-intent', onShareEvent);
    return () => window.removeEventListener('filelens-share-intent', onShareEvent);
  }, [isVaultHydrated, runtime.hasNativeAndroidBridge]);

  const handleSyncAllDeviceRoots = async (filters: DeviceIndexFilters) => {
    const ready: { root: DeviceStorageRoot; handle: FileSystemDirectoryHandle }[] = [];
    for (const root of deviceRoots) {
      const handle = await getStoredDeviceRootHandle(root.id);
      if (!handle) continue;
      const granted = await ensureDirectoryReadPermission(handle);
      if (granted) ready.push({ root, handle });
    }
    if (ready.length === 0) {
      // If stored permission expired, prompt user cleanly to pick storage again
      const res = await pickAndLinkDeviceRoot('custom');
      if (res.status === 'linked') {
        const refreshed = await listStoredDeviceRoots();
        setDeviceRoots(refreshed);
        await runWalkAndIndexRoots(
          [{ root: res.root, handle: res.handle }],
          `Device: ${res.root.name}`,
          filters
        );
      }
      return;
    }
    await runWalkAndIndexRoots(ready, `Entire Device (${ready.length} root${ready.length > 1 ? 's' : ''})`, filters);
  };

  /**
   * Single 1-tap "Index Device" flow matching FileLensMobile:
   * - Native Android APK: checks MANAGE_EXTERNAL_STORAGE, opens permission settings if needed, or crawls full storage immediately.
   * - Desktop top-level Chrome/Edge: syncs linked roots immediately or opens showDirectoryPicker synchronously on first tap.
   */
  const handleOneTapIndexDevice = () => {
    if (isIndexing) return;

    if (runtime.hasNativeAndroidBridge) {
      const granted = getAndroidAllFilesPermissionStatus() === 'granted';
      setHasAllFilesPermission(granted);
      if (granted) {
        androidCrawlDoneRef.current = false;
        androidBatchQueueRef.current = [];
        androidStatsRef.current = {
          newOrUpdated: 0,
          skippedUnchanged: 0,
          totalScanned: 0,
          foldersScanned: 0,
          startMs: performance.now(),
          sourceLabel: 'Device & SD Card',
        };
        try {
          localStorage.setItem('fl_device_index_pending', '1');
        } catch {
          // ignore storage errors
        }
        setIsIndexing(true);
        setIndexProgress({
          indexed: 0,
          total: 0,
          currentFile: 'Scanning Internal Storage & SD Card…',
          phase: 'Discovering Device Folders',
          skippedUnchanged: 0,
          newOrUpdated: 0,
        });
        triggerAndroidNativeDeviceIndex(DEFAULT_DEVICE_INDEX_FILTERS);
        showToast('Scanning & OCRing entire device & SD card…');
      } else {
        pendingAutoIndexAfterGrantRef.current = true;
        requestAndroidAllFilesAccess();
        showToast('Enable All Files Access to scan your device');
      }
      return;
    }

    if (runtime.canUseDirectoryPickerDirect) {
      if (deviceRoots.length > 0) {
        void handleSyncAllDeviceRoots(DEFAULT_DEVICE_INDEX_FILTERS);
      } else {
        void pickAndLinkDeviceRoot('custom').then(async (res) => {
          if (res.status === 'linked') {
            const refreshed = await listStoredDeviceRoots();
            setDeviceRoots(refreshed);
            await runWalkAndIndexRoots(
              [{ root: res.root, handle: res.handle }],
              `Device: ${res.root.name}`,
              DEFAULT_DEVICE_INDEX_FILTERS
            );
          }
        });
      }
    }
  };

  const handleRunDeltaReindex = async () => {
    if (isIndexing || documents.length === 0) return;
    const controller = new AbortController();
    indexAbortRef.current = controller;
    setIsIndexing(true);

    try {
      const { updatedDocs, summary } = await runLibraryDeltaReindex(
        documents,
        controller.signal,
        (prog) => setIndexProgress(prog)
      );
      setDocuments(updatedDocs);
      setLastIndexSummary(summary);
      showToast(
        `Delta Sync complete · ${summary.newOrUpdated} enriched, ${summary.skippedUnchanged} up-to-date`
      );
    } finally {
      setIsIndexing(false);
      setIndexProgress(null);
      indexAbortRef.current = null;
    }
  };

  const handleCancelIndexing = () => {
    indexAbortRef.current?.abort();
    androidBatchQueueRef.current = [];
    androidCrawlDoneRef.current = true;
    cancelAndroidNativeDeviceIndex();
  };

  const activeViewerDoc = useMemo(
    () => (viewerState ? documents.find((d) => d.id === viewerState.docId) ?? null : null),
    [documents, viewerState]
  );

  const activeOrganizerDoc = useMemo(
    () => (organizerDocId ? documents.find((d) => d.id === organizerDocId) ?? null : null),
    [documents, organizerDocId]
  );

  const appendTargetDoc = useMemo(
    () =>
      scannerState.appendToDocId
        ? documents.find((d) => d.id === scannerState.appendToDocId) ?? null
        : null,
    [documents, scannerState.appendToDocId]
  );

  const updateDocument = (updated: ScanDocument) => {
    setDocuments((prev) => prev.map((d) => (d.id === updated.id ? updated : d)));
  };

  const handleMergeDocuments = (docIds: string[]) => {
    const targets = documents.filter((d) => docIds.includes(d.id));
    if (targets.length < 2) return;
    const mergedPages: DocumentPage[] = targets.flatMap((d, dIdx) =>
      d.pages.map((p, pIdx) => ({ ...p, id: `pg-m-${Date.now()}-${dIdx}-${pIdx}` }))
    );
    const merged: ScanDocument = {
      ...targets[0],
      id: `doc-merged-${Date.now()}`,
      title: `${targets[0].title} + ${targets.length - 1} merged`,
      pages: mergedPages,
      sizeBytes: targets.reduce((acc, d) => acc + d.sizeBytes, 0),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ocrStatus: 'done',
      chunksCount: mergedPages.length,
    };
    setDocuments((prev) => [merged, ...prev]);
    setOrganizerDocId(merged.id);
    showToast(`Merged ${targets.length} PDFs (${mergedPages.length} pages)`);
  };

  const handleBatchCompressPdfs = async (preset: PdfCompressPreset) => {
    let savedBytes = 0;
    let count = 0;
    const nextDocs: ScanDocument[] = [];
    for (const d of documents) {
      const res = await compressDocumentPagesReal(d, preset);
      nextDocs.push(res.updatedDoc);
      if (res.didCompress) {
        savedBytes += res.savedBytes;
        count++;
      }
    }
    setDocuments(nextDocs);
    return { savedBytes, count };
  };

  const handleBatchCompressPhotos = async (preset: PhotoCompressPreset) => {
    let savedBytes = 0;
    let count = 0;
    const nextDocs: ScanDocument[] = [];
    for (const d of documents) {
      if (d.pages.length === 1 && (d.fileCategory === 'image' || d.pages[0]?.imageUrl.startsWith('data:image/'))) {
        const res = await compressPhotoReal(d.pages[0].imageUrl, preset, d.sizeBytes);
        if (res.didCompress) {
          savedBytes += Math.max(0, d.sizeBytes - res.newBytes);
          count++;
          nextDocs.push({
            ...d,
            sizeBytes: res.newBytes,
            pages: [{ ...d.pages[0], imageUrl: res.dataUrl }],
            updatedAt: new Date().toISOString(),
          });
          continue;
        }
      }
      nextDocs.push(d);
    }
    setDocuments(nextDocs);
    return { savedBytes, count };
  };

  const navItems: { id: AppTab; label: string; icon: React.ReactNode }[] = [
    { id: 'documents', label: 'Documents', icon: <FileText className="w-5 h-5" /> },
    { id: 'search', label: 'Search & Index', icon: <Search className="w-5 h-5" /> },
    { id: 'brain', label: 'Brain', icon: <Brain className="w-5 h-5" /> },
    { id: 'cards', label: 'Cards', icon: <CreditCard className="w-5 h-5" /> },
    { id: 'settings', label: 'Tools', icon: <Settings className="w-5 h-5" /> },
  ];

  return (
    <div className="h-[100dvh] max-h-[100dvh] w-full overflow-hidden flex bg-[#F2F2F7] dark:bg-[#000000] text-slate-900 dark:text-[#F5F5F7]">
      {/* Desktop Left Sidebar Rail */}
      <aside className="hidden lg:flex lg:flex-col lg:w-68 xl:w-72 shrink-0 bg-white dark:bg-[#1C1C1E] border-r border-slate-200/80 dark:border-white/10 h-full overflow-hidden">
        <div className="p-5 flex items-center justify-between">
          <span className="text-lg font-bold tracking-tight text-slate-900 dark:text-white whitespace-nowrap">
            FileLens Scan
          </span>
          <button
            type="button"
            onClick={() =>
              setPreferences((p) => ({ ...p, theme: p.theme === 'dark' ? 'light' : 'dark' }))
            }
            aria-label="Toggle color theme"
            className="w-9 h-9 rounded-xl flex items-center justify-center text-slate-500 hover:bg-slate-100 dark:hover:bg-white/10 transition-colors"
          >
            {preferences.theme === 'dark' ? (
              <Sun className="w-4 h-4" />
            ) : (
              <Moon className="w-4 h-4" />
            )}
          </button>
        </div>

        {/* Primary Genius Scan Orange CTA + Quick Index Entire Device */}
        <div className="px-4 pb-4 space-y-2">
          <button
            type="button"
            onClick={() => setScannerState({ open: true, mode: 'batch' })}
            className="w-full h-11 rounded-xl bg-orange-600 hover:bg-orange-700 text-white text-sm font-semibold flex items-center justify-center gap-2 transition-colors shadow-sm shadow-orange-600/20"
          >
            <Camera className="w-4 h-4" />
            <span>Scan Document</span>
          </button>
          <IndexDeviceTrigger
            disabled={isIndexing}
            onOneTapIndexDevice={handleOneTapIndexDevice}
            className="w-full h-10 rounded-xl bg-slate-100 dark:bg-[#2C2C2E] hover:bg-orange-50 dark:hover:bg-orange-950/40 text-slate-800 dark:text-slate-100 hover:text-orange-600 text-xs font-semibold flex items-center justify-center gap-2 transition-colors"
          >
            <HardDrive className="w-3.5 h-3.5 text-orange-600 dark:text-orange-400" />
            <span>{deviceRoots.length > 0 || hasAllFilesPermission ? 'Index All' : 'Index Device'}</span>
          </IndexDeviceTrigger>
        </div>

        {/* Primary Navigation Links */}
        <nav className="px-3 space-y-1">
          {navItems.map((item) => {
            const active = activeTab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setActiveTab(item.id)}
                className={`w-full h-11 px-3 rounded-xl text-sm font-semibold flex items-center gap-3 transition-colors ${
                  active
                    ? 'bg-orange-50 dark:bg-orange-950/40 text-orange-700 dark:text-orange-400'
                    : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-white/8'
                }`}
              >
                {item.icon}
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>

        {/* Sidebar Folders List */}
        <div className="mt-6 px-3 flex-1 overflow-y-auto">
          <div className="px-3 pb-2 text-xs font-semibold text-slate-400 dark:text-slate-500">
            Folders
          </div>
          <div className="space-y-0.5">
            <button
              type="button"
              onClick={() => {
                setSelectedFolderId('all');
                setActiveTab('documents');
              }}
              className={`w-full h-9 px-3 rounded-lg text-xs font-medium flex items-center justify-between transition-colors ${
                activeTab === 'documents' && selectedFolderId === 'all'
                  ? 'bg-slate-100 dark:bg-[#2C2C2E] text-slate-900 dark:text-white font-semibold'
                  : 'text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-white/5'
              }`}
            >
              <span className="flex items-center gap-2 truncate">
                <Folder className="w-3.5 h-3.5 text-orange-600" />
                <span>All Scans</span>
              </span>
              <span className="font-mono tabular-nums text-slate-400">{documents.length}</span>
            </button>
            <button
              type="button"
              onClick={() => {
                setSelectedFolderId('bookmarked');
                setActiveTab('documents');
              }}
              className={`w-full h-9 px-3 rounded-lg text-xs font-medium flex items-center justify-between transition-colors ${
                activeTab === 'documents' && selectedFolderId === 'bookmarked'
                  ? 'bg-slate-100 dark:bg-[#2C2C2E] text-slate-900 dark:text-white font-semibold'
                  : 'text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-white/5'
              }`}
            >
              <span className="flex items-center gap-2 truncate">
                <Bookmark className="w-3.5 h-3.5 text-orange-600" />
                <span>Starred</span>
              </span>
              <span className="font-mono tabular-nums text-slate-400">
                {documents.filter((d) => d.isBookmarked).length}
              </span>
            </button>
            {folders.map((folder) => {
              const count = documents.filter((d) => d.folderId === folder.id).length;
              return (
                <button
                  key={folder.id}
                  type="button"
                  onClick={() => {
                    setSelectedFolderId(folder.id);
                    setActiveTab('documents');
                  }}
                  className={`w-full h-9 px-3 rounded-lg text-xs font-medium flex items-center justify-between transition-colors ${
                    activeTab === 'documents' && selectedFolderId === folder.id
                      ? 'bg-slate-100 dark:bg-[#2C2C2E] text-slate-900 dark:text-white font-semibold'
                      : 'text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-white/5'
                  }`}
                >
                  <span className="flex items-center gap-2 truncate">
                    <Folder className="w-3.5 h-3.5 opacity-60" />
                    <span className="truncate">{folder.name}</span>
                  </span>
                  <span className="font-mono tabular-nums text-slate-400">{count}</span>
                </button>
              );
            })}
          </div>
        </div>
      </aside>

      {/* Main Responsive Content Column — strictly fitted inside 100dvh */}
      <div className="flex-1 flex flex-col min-w-0 h-full overflow-hidden">
        {/* Locked Mobile Top Bar (< 1024px) with safe-area top inset */}
        <header className="lg:hidden shrink-0 z-30 pt-safe bg-white/95 dark:bg-[#1C1C1E]/95 backdrop-blur-md border-b border-slate-200/80 dark:border-white/10">
          <div className="h-11 px-3 flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-sm font-bold tracking-tight whitespace-nowrap">
                FileLens Scan
              </span>
              <span className="text-[11px] font-mono tabular-nums text-slate-400 dark:text-slate-500 truncate">
                {documents.length} files
              </span>
            </div>
            <div className="flex items-center gap-0.5 shrink-0">
              <IndexDeviceTrigger
                disabled={isIndexing}
                onOneTapIndexDevice={handleOneTapIndexDevice}
                ariaLabel="Index entire device"
                className="h-8 px-2.5 rounded-lg inline-flex items-center gap-1 text-[11px] font-semibold text-white bg-orange-600 hover:bg-orange-700"
              >
                <HardDrive className="w-3.5 h-3.5" />
                <span>Index</span>
              </IndexDeviceTrigger>
              <button
                type="button"
                onClick={() => setActiveTab('settings')}
                aria-label="Tools and Preferences"
                className={`w-8 h-8 rounded-lg flex items-center justify-center transition-colors ${
                  activeTab === 'settings'
                    ? 'text-orange-600 dark:text-orange-400 bg-orange-50 dark:bg-orange-950/40'
                    : 'text-slate-600 dark:text-slate-300'
                }`}
              >
                <Settings className="w-4 h-4" />
              </button>
              <button
                type="button"
                onClick={() =>
                  setPreferences((p) => ({ ...p, theme: p.theme === 'dark' ? 'light' : 'dark' }))
                }
                aria-label="Toggle light and dark theme"
                className="w-8 h-8 rounded-lg flex items-center justify-center text-slate-600 dark:text-slate-300"
              >
                {preferences.theme === 'dark' ? (
                  <Sun className="w-4 h-4" />
                ) : (
                  <Moon className="w-4 h-4" />
                )}
              </button>
            </div>
          </div>
        </header>

        {/* Scrollable Workspace Body — constrained cleanly between top bar and bottom bar */}
        <main className="flex-1 min-h-0 overflow-y-auto overscroll-contain px-2.5 sm:px-6 lg:px-8 py-2 sm:py-4 pb-6">
          <div className="max-w-6xl mx-auto">
            {activeTab === 'documents' && (
              <DocumentsView
                documents={documents}
                folders={folders}
                selectedFolderId={selectedFolderId}
                indexStats={indexStats}
                linkedDeviceRootsCount={deviceRoots.length}
                hasAllFilesPermission={hasAllFilesPermission}
                isIndexing={isIndexing}
                indexProgress={indexProgress}
                lastIndexSummary={lastIndexSummary}
                onOneTapIndexDevice={handleOneTapIndexDevice}
                onIndexFiles={handleIndexFiles}
                onRunDeltaReindex={handleRunDeltaReindex}
                onCancelIndexing={handleCancelIndexing}
                onSelectFolder={setSelectedFolderId}
                onCreateFolder={(name) => {
                  const id = `folder-${Date.now()}`;
                  setFolders((prev) => [...prev, { id, name, icon: 'folder' }]);
                  setSelectedFolderId(id);
                  showToast(`Created folder "${name}"`);
                }}
                onOpenScanner={(mode) => setScannerState({ open: true, mode })}
                onOpenViewer={(docId) => setViewerState({ docId, pageIndex: 0 })}
                onOpenOrganizer={(docId) => setOrganizerDocId(docId)}
                onToggleBookmark={(docId) => {
                  setDocuments((prev) =>
                    prev.map((d) =>
                      d.id === docId ? { ...d, isBookmarked: !d.isBookmarked } : d
                    )
                  );
                }}
                onRenameDocument={(docId, newTitle) => {
                  setDocuments((prev) =>
                    prev.map((d) =>
                      d.id === docId
                        ? { ...d, title: newTitle, updatedAt: new Date().toISOString() }
                        : d
                    )
                  );
                  showToast(`Renamed to "${newTitle}"`);
                }}
                onMoveDocumentsToFolder={(docIds, folderId) => {
                  const idSet = new Set(docIds);
                  setDocuments((prev) =>
                    prev.map((d) => (idSet.has(d.id) ? { ...d, folderId } : d))
                  );
                  const folderName = folders.find((f) => f.id === folderId)?.name ?? 'folder';
                  showToast(`Moved ${docIds.length} document(s) to ${folderName}`);
                }}
                onMergeDocuments={handleMergeDocuments}
                onDeleteDocuments={(docIds) => {
                  const idSet = new Set(docIds);
                  setDocuments((prev) => prev.filter((d) => !idSet.has(d.id)));
                  showToast(`Deleted ${docIds.length} document(s)`);
                }}
                onToast={showToast}
              />
            )}

            {activeTab === 'search' && (
              <SearchHubView
                documents={documents}
                savedSearches={savedSearches}
                indexStats={indexStats}
                linkedDeviceRootsCount={deviceRoots.length}
                hasAllFilesPermission={hasAllFilesPermission}
                isIndexing={isIndexing}
                indexProgress={indexProgress}
                lastIndexSummary={lastIndexSummary}
                onOneTapIndexDevice={handleOneTapIndexDevice}
                onIndexFiles={handleIndexFiles}
                onRunDeltaReindex={handleRunDeltaReindex}
                onCancelIndexing={handleCancelIndexing}
                onSaveSearch={(query, mode: SearchMode) => {
                  setSavedSearches((prev) => [
                    { id: `ss-${Date.now()}`, query, mode, createdAt: new Date().toISOString() },
                    ...prev,
                  ]);
                }}
                onDeleteSavedSearch={(id) =>
                  setSavedSearches((prev) => prev.filter((s) => s.id !== id))
                }
                onOpenDocumentAtPage={(docId, pageIndex) => setViewerState({ docId, pageIndex })}
                onOpenOrganizer={(docId) => setOrganizerDocId(docId)}
                onToast={showToast}
              />
            )}

            {activeTab === 'brain' && (
              <SecondBrainView
                notes={voiceNotes}
                documents={documents}
                voiceLanguage={preferences.voiceLanguage}
                awarenessBellEnabled={Boolean(preferences.awarenessBellEnabled)}
                morningDigestEnabled={Boolean(preferences.morningDigestEnabled)}
                onToggleAwarenessBell={(v) =>
                  setPreferences((p) => ({ ...p, awarenessBellEnabled: v }))
                }
                onToggleMorningDigest={(v) =>
                  setPreferences((p) => ({ ...p, morningDigestEnabled: v }))
                }
                onChangeVoiceLanguage={(code) =>
                  setPreferences((p) => ({ ...p, voiceLanguage: code }))
                }
                onAddNote={(note) => setVoiceNotes((prev) => [note, ...prev])}
                onUpdateNote={(updated) =>
                  setVoiceNotes((prev) => prev.map((n) => (n.id === updated.id ? updated : n)))
                }
                onDeleteNote={(id) => {
                  const deleted = voiceNotes.find((n) => n.id === id);
                  setVoiceNotes((prev) => prev.filter((n) => n.id !== id));
                  showToast(
                    'Deleted voice note',
                    deleted
                      ? {
                          label: 'Undo',
                          action: () => setVoiceNotes((prev) => [deleted, ...prev]),
                        }
                      : undefined
                  );
                }}
                onOpenDocument={(docId) => setViewerState({ docId, pageIndex: 0 })}
                onToast={showToast}
              />
            )}

            {activeTab === 'cards' && (
              <SmartCardsView
                documents={documents}
                privacyBlur={preferences.privacyBlurCards}
                biometricCardsLock={Boolean(preferences.biometricCardsLock)}
                cardsPinCode={preferences.cardsPinCode ?? ''}
                onTogglePrivacyBlur={() =>
                  setPreferences((p) => ({ ...p, privacyBlurCards: !p.privacyBlurCards }))
                }
                onLaunchIdScanner={() => setScannerState({ open: true, mode: 'idcard' })}
                onPromoteDocumentToCard={(docId, category: SmartCardCategory, expiryDate) => {
                  setDocuments((prev) =>
                    prev.map((d) =>
                      d.id === docId
                        ? { ...d, isSmartCard: true, cardCategory: category, expiryDate }
                        : d
                    )
                  );
                }}
                onUpdateCardExpiry={(docId, expiryDate) => {
                  setDocuments((prev) =>
                    prev.map((d) =>
                      d.id === docId ? { ...d, expiryDate: expiryDate || undefined } : d
                    )
                  );
                }}
                onScheduleExpiryReminder={(doc, expiryDate, daysBefore) => {
                  const exp = new Date(expiryDate);
                  if (daysBefore && !Number.isNaN(exp.getTime())) {
                    exp.setDate(exp.getDate() - daysBefore);
                  }
                  const scheduledIso = Number.isNaN(exp.getTime())
                    ? expiryDate
                    : exp.toISOString();
                  const label = daysBefore ? ` (${daysBefore}d before)` : '';
                  const reminder: VoiceNote = {
                    id: `vn-exp-${Date.now()}-${daysBefore ?? 0}`,
                    title: `Renew "${doc.title}"${label}`,
                    transcript: `Renewal radar alert for ${doc.title} expiring on ${expiryDate}.`,
                    temporalClass: 'upcoming',
                    scheduledDate: scheduledIso,
                    recurrence: 'none',
                    linkedDocId: doc.id,
                    languageCode: preferences.voiceLanguage,
                    createdAt: new Date().toISOString(),
                    checklist: [
                      { id: `c-exp-1-${Date.now()}`, text: 'Prepare renewal application', done: false },
                      { id: `c-exp-2-${Date.now()}`, text: 'Scan updated card in FileLens', done: false },
                    ],
                  };
                  setVoiceNotes((prev) => [reminder, ...prev]);
                  if (!daysBefore) showToast('Scheduled renewal alert in Second Brain');
                }}
                onOpenViewer={(docId) => setViewerState({ docId, pageIndex: 0 })}
                onOpenOrganizer={(docId) => setOrganizerDocId(docId)}
                onToast={showToast}
              />
            )}

            {activeTab === 'settings' && (
              <ToolsAndSettingsView
                documents={documents}
                preferences={preferences}
                indexStats={indexStats}
                linkedDeviceRootsCount={deviceRoots.length}
                hasAllFilesPermission={hasAllFilesPermission}
                isIndexing={isIndexing}
                indexProgress={indexProgress}
                lastIndexSummary={lastIndexSummary}
                onOneTapIndexDevice={handleOneTapIndexDevice}
                onIndexFiles={handleIndexFiles}
                onRunDeltaReindex={handleRunDeltaReindex}
                onCancelIndexing={handleCancelIndexing}
                onUpdatePreferences={setPreferences}
                onBatchCompressPdfs={handleBatchCompressPdfs}
                onBatchCompressPhotos={handleBatchCompressPhotos}
                onDeleteDocument={(docId) => {
                  setDocuments((prev) => prev.filter((d) => d.id !== docId));
                  showToast('Removed duplicate document');
                }}
                onExportWorkspaceBackup={() =>
                  JSON.stringify(
                    {
                      formatVersion: 2,
                      exportedAtIso: new Date().toISOString(),
                      documents,
                      folders,
                      voiceNotes,
                      savedSearches,
                      savedSignatures,
                      preferences,
                    },
                    null,
                    2
                  )
                }
                onImportWorkspaceBackup={(json) => {
                  try {
                    const parsed = JSON.parse(json) as Partial<PersistedVaultState>;
                    if (!Array.isArray(parsed.documents)) return false;
                    setDocuments(parsed.documents);
                    if (parsed.folders) setFolders(parsed.folders);
                    if (parsed.voiceNotes) setVoiceNotes(parsed.voiceNotes);
                    if (parsed.savedSearches) setSavedSearches(parsed.savedSearches);
                    if (parsed.savedSignatures) setSavedSignatures(parsed.savedSignatures);
                    if (parsed.preferences) {
                      setPreferences({ ...DEFAULT_PREFERENCES, ...parsed.preferences });
                    }
                    return true;
                  } catch {
                    return false;
                  }
                }}
                onClearWorkspace={() => {
                  setDocuments([]);
                  setFolders(INITIAL_FOLDERS);
                  setVoiceNotes([]);
                  setSavedSearches([]);
                  setSavedSignatures([]);
                  setLastIndexSummary(null);
                  setDeviceRoots([]);
                  void clearVaultState();
                  void clearAllStoredDeviceRoots();
                  showToast('Cleared local vault and device index');
                }}
                onToast={showToast}
              />
            )}
          </div>
        </main>

        {/* Compact Mobile Bottom Navigation Bar — seated inside 100dvh flex shell */}
        <nav
          aria-label="Primary navigation"
          className="lg:hidden shrink-0 relative z-30 bg-white/95 dark:bg-[#1C1C1E]/95 backdrop-blur-md border-t border-slate-200/80 dark:border-white/10 pb-safe overflow-visible"
        >
          <div className="grid grid-cols-5 items-center h-13 px-1">
            <MobileTabButton
              active={activeTab === 'documents'}
              label="Docs"
              icon={<FileText className="w-4 h-4" />}
              onClick={() => setActiveTab('documents')}
            />
            <MobileTabButton
              active={activeTab === 'search'}
              label="Search"
              icon={<Search className="w-4 h-4" />}
              onClick={() => setActiveTab('search')}
            />

            <div className="flex items-center justify-center">
              <button
                type="button"
                onClick={() => setScannerState({ open: true, mode: 'batch' })}
                aria-label="Scan document"
                className="-mt-4 w-12 h-12 rounded-full bg-orange-600 hover:bg-orange-700 active:scale-95 text-white shadow-lg shadow-orange-600/30 flex items-center justify-center border-[3px] border-[#F2F2F7] dark:border-[#000000] transition-transform"
              >
                <Camera className="w-5 h-5" />
              </button>
            </div>

            <MobileTabButton
              active={activeTab === 'brain'}
              label="Brain"
              icon={<Brain className="w-4 h-4" />}
              onClick={() => setActiveTab('brain')}
            />
            <MobileTabButton
              active={activeTab === 'cards'}
              label="Cards"
              icon={<CreditCard className="w-4 h-4" />}
              onClick={() => setActiveTab('cards')}
            />
          </div>
        </nav>
      </div>

      {/* Live Document Scanner Studio */}
      {scannerState.open && (
        <LiveScannerModal
          initialMode={scannerState.mode}
          appendTargetTitle={appendTargetDoc?.title}
          folders={folders}
          preferences={preferences}
          nextSequenceNumber={documents.length + 1}
          onClose={() => setScannerState({ open: false, mode: 'batch' })}
          onCompleteNewDocument={(newDoc) => {
            setDocuments((prev) => [newDoc, ...prev]);
            setScannerState({ open: false, mode: 'batch' });
            setActiveTab('documents');
            setOrganizerDocId(newDoc.id);
            showToast(
              `Saved & indexed "${newDoc.title}" (${newDoc.pages.length} page${newDoc.pages.length > 1 ? 's' : ''})`
            );
          }}
          onCompleteAppendPages={(newPages) => {
            if (appendTargetDoc) {
              updateDocument({
                ...appendTargetDoc,
                pages: [...appendTargetDoc.pages, ...newPages],
                sizeBytes: appendTargetDoc.sizeBytes + newPages.length * 360_000,
                updatedAt: new Date().toISOString(),
                chunksCount: (appendTargetDoc.chunksCount ?? appendTargetDoc.pages.length) + newPages.length,
              });
              showToast(`Appended ${newPages.length} page(s) to "${appendTargetDoc.title}"`);
            }
            setScannerState({ open: false, mode: 'batch' });
          }}
          onToast={showToast}
        />
      )}

      {/* Full-Screen PDF Reader & Annotator */}
      {activeViewerDoc && (
        <PdfViewerModal
          document={activeViewerDoc}
          initialPageIndex={viewerState?.pageIndex ?? 0}
          savedSignatures={savedSignatures}
          onSaveSignature={(sig) => setSavedSignatures((prev) => [sig, ...prev])}
          onDeleteSavedSignature={(id) =>
            setSavedSignatures((prev) => prev.filter((s) => s.id !== id))
          }
          onUpdateDocument={updateDocument}
          onOpenOrganizer={() => {
            const id = activeViewerDoc.id;
            setViewerState(null);
            setOrganizerDocId(id);
          }}
          onClose={() => setViewerState(null)}
          onToast={showToast}
        />
      )}

      {/* Dedicated Genius Scan + FileLens Page Organizer Studio */}
      {activeOrganizerDoc && (
        <PageOrganizerModal
          document={activeOrganizerDoc}
          allDocuments={documents}
          onUpdateDocument={updateDocument}
          onExtractNewDocument={(extracted) => {
            setDocuments((prev) => [extracted, ...prev]);
          }}
          onLaunchAppendScan={() =>
            setScannerState({ open: true, mode: 'batch', appendToDocId: activeOrganizerDoc.id })
          }
          onClose={() => setOrganizerDocId(null)}
          onToast={showToast}
        />
      )}

      {/* Global Single-Button Native Pickers (guaranteed synchronous launch on Android, iOS, desktop & iframes) */}
      {!runtime.isMobile && (
        <input
          id={DEVICE_DIR_INPUT_ID}
          type="file"
          multiple
          // @ts-expect-error webkitdirectory enables recursive OS folder selection on desktop browsers
          webkitdirectory=""
          directory=""
          className="sr-only"
          onChange={(e) => {
            const list = e.target.files;
            if (list && list.length > 0) {
              const files = Array.from(list);
              const firstRel = (files[0] as File & { webkitRelativePath?: string })
                .webkitRelativePath;
              const rootName = firstRel ? firstRel.split('/')[0] : 'Device';
              void handleIndexFiles(
                files,
                `Device: ${rootName}`,
                undefined,
                DEFAULT_DEVICE_INDEX_FILTERS
              );
            }
            e.target.value = '';
          }}
        />
      )}
      <input
        id={DEVICE_FILES_INPUT_ID}
        type="file"
        multiple
        className="sr-only"
        onChange={(e) => {
          const list = e.target.files;
          if (list && list.length > 0) {
            const files = Array.from(list);
            void handleIndexFiles(
              files,
              `Device (${files.length} files)`,
              undefined,
              DEFAULT_DEVICE_INDEX_FILTERS
            );
          }
          e.target.value = '';
        }}
      />

      {/* Top-Anchored Smart Toast Overlay */}
      <SmartToastHost toast={smartToast} onDismiss={() => setSmartToast(null)} />
    </div>
  );
}

interface MobileTabButtonProps {
  active: boolean;
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
}

const MobileTabButton: React.FC<MobileTabButtonProps> = ({ active, label, icon, onClick }) => (
  <button
    type="button"
    onClick={onClick}
    className={`min-h-[44px] flex flex-col items-center justify-center gap-0.5 transition-colors ${
      active
        ? 'text-orange-600 dark:text-orange-400'
        : 'text-slate-500 dark:text-slate-400'
    }`}
  >
    {icon}
    <span className="text-[10px] font-semibold tracking-tight">{label}</span>
  </button>
);
