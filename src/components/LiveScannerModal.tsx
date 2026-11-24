import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Camera,
  Check,
  Crop,
  Grid3X3,
  Image as ImageIcon,
  Loader2,
  Lock,
  RefreshCw,
  RotateCw,
  Sliders,
  Sparkles,
  SwitchCamera,
  Trash2,
  X,
  Zap,
  ZapOff,
} from 'lucide-react';
import {
  AppPreferences,
  BatchAutoPace,
  DocFolder,
  DocumentPage,
  FULL_QUAD,
  NormalizedQuad,
  PdfPageSizePreset,
  PdfQualityPreset,
  ScanDocument,
  ScanFilterId,
  ScanMode,
  SmartCardCategory,
} from '../types/filelens';
import {
  NAMING_TEMPLATES,
  SCAN_FILTERS,
  SMART_CARD_CATEGORIES,
} from '../data/seedData';
import { resolveNamingTemplate } from '../utils/formatters';
import { composeTwoInOneA4IdCard } from '../utils/pdfExport';
import {
  analyzeCanvasFrame,
  computeFingerprintDelta,
  computeQuadDelta,
  detectQuadFromImageUrl,
} from '../utils/documentEdgeDetector';
import { runRealOcrOnImage } from '../utils/smartIndexer';
import {
  detectSmartTags,
  extractExpiryDateIso,
  getCardSmartCategory,
  suggestFolderId,
  suggestSmartDocumentTitle,
} from '../utils/smartTaxonomy';
import { PageCanvasPreview } from './PageCanvasPreview';
import { PerspectiveCropModal } from './PerspectiveCropModal';

interface LiveScannerModalProps {
  initialMode: ScanMode;
  appendTargetTitle?: string;
  folders: DocFolder[];
  preferences: AppPreferences;
  nextSequenceNumber: number;
  onCompleteNewDocument: (doc: ScanDocument) => void;
  onCompleteAppendPages: (pages: DocumentPage[]) => void;
  onClose: () => void;
  onToast: (message: string) => void;
}

export const LiveScannerModal: React.FC<LiveScannerModalProps> = ({
  initialMode,
  appendTargetTitle,
  folders,
  preferences,
  nextSequenceNumber,
  onCompleteNewDocument,
  onCompleteAppendPages,
  onClose,
  onToast,
}) => {
  const isAppendMode = Boolean(appendTargetTitle);
  const [phase, setPhase] = useState<'camera' | 'review'>('camera');
  const [scanMode, setScanMode] = useState<ScanMode>(isAppendMode ? 'batch' : initialMode);
  const [autoCapture, setAutoCapture] = useState<boolean>(preferences.autoCapture);
  const [batchPace, setBatchPace] = useState<BatchAutoPace>(preferences.batchPace);
  const [flashOn, setFlashOn] = useState<boolean>(false);
  const [showGrid, setShowGrid] = useState<boolean>(true);

  // Real WebRTC camera states (zero dummy captures!)
  const [cameraStatus, setCameraStatus] = useState<'initializing' | 'live' | 'denied' | 'unavailable'>(
    'initializing'
  );
  const [cameraErrorMsg, setCameraErrorMsg] = useState<string>('');
  const [facingMode, setFacingMode] = useState<'environment' | 'user'>('environment');
  const [videoDevices, setVideoDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string | null>(null);
  const [cameraRetryKey, setCameraRetryKey] = useState<number>(0);

  // Real-time edge detection & Anti-Duplicate Smart Page-Change Gate state
  const [detectedQuad, setDetectedQuad] = useState<NormalizedQuad | null>(null);
  const [edgeConfidence, setEdgeConfidence] = useState<number>(0);
  const [stabilityProgress, setStabilityProgress] = useState<number>(0); // 0..1
  const [waitingPageSwap, setWaitingPageSwap] = useState<boolean>(false);
  const [shutterFlash, setShutterFlash] = useState<boolean>(false);
  const [capturedPages, setCapturedPages] = useState<DocumentPage[]>([]);
  const [ocrInFlightCount, setOcrInFlightCount] = useState<number>(0);

  // Review & Save state
  const [docTitle, setDocTitle] = useState<string>(() =>
    initialMode === 'idcard'
      ? resolveNamingTemplate('ID_Card_{YYYY}-{MM}-{DD}', nextSequenceNumber)
      : resolveNamingTemplate(preferences.namingTemplate, nextSequenceNumber)
  );
  const [isSmartNaming, setIsSmartNaming] = useState<boolean>(false);
  const [folderId, setFolderId] = useState<string>(initialMode === 'idcard' ? 'ids' : 'inbox');
  const [activeFilter, setActiveFilter] = useState<ScanFilterId>(preferences.defaultFilter);
  const [pageSizePreset, setPageSizePreset] = useState<PdfPageSizePreset>(preferences.defaultPageSize);
  const [qualityPreset, setQualityPreset] = useState<PdfQualityPreset>(preferences.defaultQuality);
  const [searchableOcr, setSearchableOcr] = useState<boolean>(preferences.searchablePdfOcrLayer);
  const [passwordProtect, setPasswordProtect] = useState<boolean>(false);
  const [saveAsSmartCard, setSaveAsSmartCard] = useState<boolean>(initialMode === 'idcard');
  const [cardCategory, setCardCategory] = useState<SmartCardCategory>('Govt IDs');
  const [tagInput, setTagInput] = useState<string>(initialMode === 'idcard' ? 'ID Card, 2-in-1 A4' : 'Scanned');
  const [editingPageIdx, setEditingPageIdx] = useState<number | null>(null);
  const [isSaving, setIsSaving] = useState<boolean>(false);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const analysisCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const galleryInputRef = useRef<HTMLInputElement | null>(null);
  const nativeCameraInputRef = useRef<HTMLInputElement | null>(null);

  // Refs for real-time edge stability & anti-duplicate fingerprint gate
  const lastQuadRef = useRef<NormalizedQuad | null>(null);
  const stableFramesRef = useRef<number>(0);
  const lastCapturedFpRef = useRef<Float32Array | null>(null);
  const latestFpRef = useRef<Float32Array | null>(null);
  const waitingPageSwapRef = useRef<boolean>(false);
  const lastAutoShotMsRef = useRef<number>(0);
  const captureLockRef = useRef<boolean>(false);

  // Stop any active camera tracks safely
  const stopCameraTracks = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
  }, []);

  // Initialize REAL live WebRTC camera (tries rear camera first, then falls back to any available webcam!)
  useEffect(() => {
    if (phase !== 'camera') {
      stopCameraTracks();
      return;
    }

    let cancelled = false;
    setCameraStatus('initializing');
    setCameraErrorMsg('');

    async function startLiveCamera() {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        if (!cancelled) {
          setCameraStatus('unavailable');
          setCameraErrorMsg('This browser context does not expose live camera streaming.');
        }
        return;
      }

      const constraintsToTry: MediaStreamConstraints[] = selectedDeviceId
        ? [{ video: { deviceId: { exact: selectedDeviceId }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false }]
        : [
            { video: { facingMode: { ideal: facingMode }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false },
            { video: { facingMode: { ideal: facingMode } }, audio: false },
            { video: true, audio: false },
          ];

      let stream: MediaStream | null = null;
      let lastError: unknown = null;

      for (const constraints of constraintsToTry) {
        try {
          stream = await navigator.mediaDevices.getUserMedia(constraints);
          if (stream) break;
        } catch (err) {
          lastError = err;
        }
      }

      if (cancelled) {
        stream?.getTracks().forEach((t) => t.stop());
        return;
      }

      if (!stream) {
        const errName = (lastError as { name?: string })?.name ?? '';
        if (errName === 'NotAllowedError' || errName === 'PermissionDeniedError') {
          setCameraStatus('denied');
          setCameraErrorMsg('Camera permission was blocked. Allow camera access in your browser bar or use System Camera / Photos.');
        } else {
          setCameraStatus('unavailable');
          setCameraErrorMsg('No active camera stream detected on this device. Connect a camera or use System Camera / Photos.');
        }
        return;
      }

      streamRef.current = stream;

      // Enumerate all video input devices so user can switch lenses
      try {
        const allDevices = await navigator.mediaDevices.enumerateDevices();
        const cams = allDevices.filter((d) => d.kind === 'videoinput');
        if (!cancelled) setVideoDevices(cams);
      } catch {
        // Ignore enumerate errors
      }

      const video = videoRef.current;
      if (video) {
        video.srcObject = stream;
        video.setAttribute('playsinline', 'true');
        video.muted = true;
        try {
          await video.play();
        } catch {
          // Wait for loadedmetadata fallback
        }
      }

      if (!cancelled) {
        setCameraStatus('live');
      }
    }

    startLiveCamera();
    return () => {
      cancelled = true;
      stopCameraTracks();
    };
  }, [phase, facingMode, selectedDeviceId, cameraRetryKey, stopCameraTracks]);

  // Apply Torch / Flash constraint if supported by mobile rear camera hardware
  useEffect(() => {
    const track = streamRef.current?.getVideoTracks?.()[0];
    if (!track) return;
    const caps = (track.getCapabilities?.() as { torch?: boolean } | undefined) ?? {};
    if (caps.torch) {
      track
        .applyConstraints({
          advanced: [{ torch: flashOn } as MediaTrackConstraintSet],
        })
        .catch(() => {});
    }
  }, [flashOn, cameraStatus]);

  // Background real OCR enrichment for a newly captured page
  const enrichPageWithRealOcr = useCallback(
    (pageId: string, imageUrl: string) => {
      if (!searchableOcr) return;
      setOcrInFlightCount((c) => c + 1);
      runRealOcrOnImage(imageUrl)
        .then((extractedText) => {
          if (!extractedText) return;
          setCapturedPages((prev) =>
            prev.map((p) => (p.id === pageId ? { ...p, ocrText: extractedText } : p))
          );
          const smartTags = detectSmartTags('', extractedText);
          if (smartTags.length > 0) {
            setTagInput((prev) => {
              const existing = prev
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean);
              return Array.from(new Set([...existing, ...smartTags])).join(', ');
            });
          }
          const inferredFolder = suggestFolderId('', extractedText);
          if (inferredFolder !== 'inbox') {
            setFolderId(inferredFolder);
          }
        })
        .finally(() => {
          setOcrInFlightCount((c) => Math.max(0, c - 1));
        });
    },
    [searchableOcr]
  );

  // REAL Live Frame Capture directly from <video> hardware stream!
  const captureLiveVideoFrame = useCallback(
    (quadOverride?: NormalizedQuad | null) => {
      const video = videoRef.current;
      if (!video || video.readyState < 2 || video.videoWidth === 0 || video.videoHeight === 0) {
        onToast('Camera feed is still starting — hold on a moment');
        return;
      }
      if (captureLockRef.current) return;
      captureLockRef.current = true;

      setShutterFlash(true);
      setTimeout(() => setShutterFlash(false), 140);

      // Capture full native video resolution (up to 2048px wide)
      const maxDim = 2048;
      const scale = Math.min(1, maxDim / Math.max(video.videoWidth, video.videoHeight));
      const outW = Math.round(video.videoWidth * scale);
      const outH = Math.round(video.videoHeight * scale);

      const canvas = document.createElement('canvas');
      canvas.width = outW;
      canvas.height = outH;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        captureLockRef.current = false;
        return;
      }

      ctx.drawImage(video, 0, 0, outW, outH);
      const capturedDataUrl = canvas.toDataURL('image/jpeg', 0.92);

      // Snapshot visual 8x8 luma fingerprint so Auto-Capture never duplicates the same page!
      lastCapturedFpRef.current = latestFpRef.current ? new Float32Array(latestFpRef.current) : null;
      lastAutoShotMsRef.current = Date.now();
      stableFramesRef.current = 0;
      setStabilityProgress(0);

      const shouldGateSwap =
        scanMode !== 'single' && (batchPace === 'wait_page' || scanMode === 'idcard');
      waitingPageSwapRef.current = shouldGateSwap;
      setWaitingPageSwap(shouldGateSwap);

      const pageId = `pg-live-${Date.now()}`;
      const effectiveQuad =
        quadOverride ??
        detectedQuad ??
        (scanMode === 'idcard'
          ? { tlX: 0.08, tlY: 0.25, trX: 0.92, trY: 0.25, brX: 0.92, brY: 0.75, blX: 0.08, blY: 0.75 }
          : FULL_QUAD);

      const newPage: DocumentPage = {
        id: pageId,
        imageUrl: capturedDataUrl,
        rotation: 0,
        filter: activeFilter,
        quad: effectiveQuad,
        brightness: 1,
        contrast: 1,
        ocrText: '',
        signatures: [],
      };

      setCapturedPages((prev) => {
        const next = scanMode === 'single' ? [newPage] : [...prev, newPage];
        if (scanMode === 'single') {
          setTimeout(() => setPhase('review'), 160);
        } else if (scanMode === 'idcard' && next.length >= 2) {
          onToast('Captured Front & Back · Ready for 2-in-1 A4 ID composite');
          setTimeout(() => setPhase('review'), 200);
        } else {
          onToast(`Captured live Page ${next.length} · Extracting OCR…`);
        }
        return next;
      });

      enrichPageWithRealOcr(pageId, capturedDataUrl);

      setTimeout(() => {
        captureLockRef.current = false;
      }, 450);
    },
    [activeFilter, batchPace, detectedQuad, enrichPageWithRealOcr, onToast, scanMode]
  );

  // Real-time Live Document Edge Tracking & Smart Anti-Duplicate Auto-Capture Loop (~160ms interval)
  useEffect(() => {
    if (phase !== 'camera' || cameraStatus !== 'live') {
      setDetectedQuad(null);
      setEdgeConfidence(0);
      setStabilityProgress(0);
      return;
    }

    if (!analysisCanvasRef.current) {
      analysisCanvasRef.current = document.createElement('canvas');
      analysisCanvasRef.current.width = 128;
      analysisCanvasRef.current.height = 170;
    }

    const timer = window.setInterval(() => {
      const video = videoRef.current;
      const canvas = analysisCanvasRef.current;
      if (!video || !canvas || video.readyState < 2 || video.videoWidth === 0) return;

      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) return;

      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const analysis = analyzeCanvasFrame(canvas);
      latestFpRef.current = analysis.fingerprint;

      // Anti-Duplicate Smart Page-Change Gate (ported from LiveDocumentCameraView.kt)
      if (waitingPageSwapRef.current && lastCapturedFpRef.current) {
        const visualDelta = computeFingerprintDelta(analysis.fingerprint, lastCapturedFpRef.current);
        if (visualDelta >= 0.085) {
          waitingPageSwapRef.current = false;
          setWaitingPageSwap(false);
          stableFramesRef.current = 0;
        }
      }

      if (analysis.quad && analysis.confidence >= 0.52) {
        const prev = lastQuadRef.current;
        const smoothed: NormalizedQuad = prev
          ? {
              tlX: prev.tlX * 0.55 + analysis.quad.tlX * 0.45,
              tlY: prev.tlY * 0.55 + analysis.quad.tlY * 0.45,
              trX: prev.trX * 0.55 + analysis.quad.trX * 0.45,
              trY: prev.trY * 0.55 + analysis.quad.trY * 0.45,
              brX: prev.brX * 0.55 + analysis.quad.brX * 0.45,
              brY: prev.brY * 0.55 + analysis.quad.brY * 0.45,
              blX: prev.blX * 0.55 + analysis.quad.blX * 0.45,
              blY: prev.blY * 0.55 + analysis.quad.blY * 0.45,
            }
          : analysis.quad;

        const delta = computeQuadDelta(prev, smoothed);
        lastQuadRef.current = smoothed;
        setDetectedQuad(smoothed);
        setEdgeConfidence(analysis.confidence);

        const cooldownMs =
          batchPace === 'delay_5s' ? 5000 : batchPace === 'delay_3s' ? 3000 : 1800;
        const cooldownElapsed = Date.now() - lastAutoShotMsRef.current >= cooldownMs;

        if (autoCapture && !waitingPageSwapRef.current && cooldownElapsed && delta < 0.032) {
          stableFramesRef.current += 1;
          const progress = Math.min(1, stableFramesRef.current / 7);
          setStabilityProgress(progress);
          if (stableFramesRef.current >= 7) {
            captureLiveVideoFrame(smoothed);
          }
        } else {
          stableFramesRef.current = Math.max(0, stableFramesRef.current - 1);
          setStabilityProgress(Math.min(1, stableFramesRef.current / 7));
        }
      } else {
        stableFramesRef.current = 0;
        setStabilityProgress(0);
        setDetectedQuad(null);
        setEdgeConfidence(0);
        lastQuadRef.current = null;
      }
    }, 160);

    return () => window.clearInterval(timer);
  }, [autoCapture, batchPace, cameraStatus, captureLiveVideoFrame, phase]);

  const handleSwitchCamera = () => {
    if (videoDevices.length > 1) {
      const currentIdx = videoDevices.findIndex((d) => d.deviceId === selectedDeviceId);
      const next = videoDevices[(currentIdx + 1) % videoDevices.length];
      setSelectedDeviceId(next.deviceId);
    } else {
      setSelectedDeviceId(null);
      setFacingMode((prev) => (prev === 'environment' ? 'user' : 'environment'));
    }
  };

  // Real Photo / Native Mobile Camera Capture Handler
  const handleFileCaptureOrImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    const loadedPages = await Promise.all(
      Array.from(files).map(
        (file, idx) =>
          new Promise<DocumentPage>((resolve) => {
            const reader = new FileReader();
            reader.onload = async () => {
              const dataUrl = String(reader.result);
              const detected = await detectQuadFromImageUrl(dataUrl);
              resolve({
                id: `pg-file-${Date.now()}-${idx}`,
                imageUrl: dataUrl,
                rotation: 0,
                filter: activeFilter,
                quad: detected,
                brightness: 1,
                contrast: 1,
                ocrText: '',
                signatures: [],
              });
            };
            reader.readAsDataURL(file);
          })
      )
    );

    const next = scanMode === 'single' ? [loadedPages[0]] : [...capturedPages, ...loadedPages];
    setCapturedPages(next);
    setPhase('review');
    onToast(`Added ${loadedPages.length} real photo${loadedPages.length > 1 ? 's' : ''} · Running OCR & edge detection…`);

    loadedPages.forEach((pg) => enrichPageWithRealOcr(pg.id, pg.imageUrl));
    e.target.value = '';
  };

  const handleSmartTitleSuggestion = async () => {
    if (capturedPages.length === 0) return;
    setIsSmartNaming(true);
    try {
      let text = capturedPages.map((p) => p.ocrText).join('\n').trim();
      if (text.length < 10) {
        text = await runRealOcrOnImage(capturedPages[0].imageUrl);
        if (text) {
          setCapturedPages((prev) =>
            prev.map((p, idx) => (idx === 0 ? { ...p, ocrText: text } : p))
          );
        }
      }
      const suggested = suggestSmartDocumentTitle(text, scanMode === 'idcard' ? 'ID_Card' : 'Scan');
      setDocTitle(suggested);
      const tags = detectSmartTags(suggested, text);
      if (tags.length > 0) setTagInput(tags.join(', '));
      onToast(`Smart title: ${suggested}`);
    } finally {
      setIsSmartNaming(false);
    }
  };

  const handleApplyGlobalFilter = (filterId: ScanFilterId) => {
    setActiveFilter(filterId);
    setCapturedPages((prev) => prev.map((p) => ({ ...p, filter: filterId })));
  };

  const handleSaveScan = async () => {
    if (capturedPages.length === 0) return;
    setIsSaving(true);
    try {
      let finalPages = capturedPages;

      // 2-in-1 A4 ID Card compositing when scanning ID cards with 2 sides
      if (scanMode === 'idcard' && capturedPages.length >= 2 && !isAppendMode) {
        const compositeUrl = await composeTwoInOneA4IdCard(
          capturedPages[0].imageUrl,
          capturedPages[1].imageUrl
        );
        finalPages = [
          {
            id: `pg-id-composite-${Date.now()}`,
            imageUrl: compositeUrl,
            rotation: 0,
            filter: activeFilter,
            quad: FULL_QUAD,
            brightness: 1,
            contrast: 1,
            ocrText: `${capturedPages[0].ocrText}\n${capturedPages[1].ocrText}`.trim(),
            signatures: [],
          },
        ];
      }

      if (isAppendMode) {
        onCompleteAppendPages(finalPages);
        return;
      }

      const combinedOcr = finalPages.map((p) => p.ocrText).join('\n').trim();
      const autoTags = detectSmartTags(docTitle, combinedOcr);
      const userTags = tagInput
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean);
      const tags = Array.from(new Set([...userTags, ...autoTags]));
      const expiryDate = extractExpiryDateIso(combinedOcr);
      const resolvedCardCategory = saveAsSmartCard
        ? cardCategory
        : getCardSmartCategory(docTitle, tags, combinedOcr);

      const newDoc: ScanDocument = {
        id: `doc-scan-${Date.now()}`,
        title: docTitle.trim() || `Scan_${new Date().toISOString().slice(0, 10)}`,
        folderId,
        tags,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        pages: finalPages,
        isBookmarked: false,
        isSmartCard: saveAsSmartCard,
        cardCategory: saveAsSmartCard ? resolvedCardCategory : undefined,
        expiryDate,
        passwordProtected: passwordProtect,
        pageSizePreset,
        qualityPreset,
        sizeBytes: Math.round(
          finalPages.length *
            (qualityPreset === 'high' ? 620_000 : qualityPreset === 'compact' ? 210_000 : 390_000)
        ),
        searchableOcr,
        ocrStatus: combinedOcr.length > 0 ? 'done' : 'pending',
        indexedAt: new Date().toISOString(),
        chunksCount: Math.max(1, finalPages.length),
      };
      onCompleteNewDocument(newDoc);
    } finally {
      setIsSaving(false);
    }
  };

  const cycleBatchPace = () => {
    setBatchPace((prev) =>
      prev === 'wait_page' ? 'delay_3s' : prev === 'delay_3s' ? 'delay_5s' : 'wait_page'
    );
  };

  const paceLabel =
    batchPace === 'wait_page' ? 'Wait Page' : batchPace === 'delay_3s' ? '3s Auto' : '5s Auto';

  if (phase === 'camera') {
    const q = detectedQuad;
    const quadPolyPoints = q
      ? `${q.tlX * 100},${q.tlY * 100} ${q.trX * 100},${q.trY * 100} ${q.brX * 100},${q.brY * 100} ${q.blX * 100},${q.blY * 100}`
      : null;

    return (
      <div
        className="fixed inset-0 z-50 flex flex-col bg-black text-white select-none"
        role="dialog"
        aria-modal="true"
        aria-label="Live Document Scanner"
      >
        {/* Top Genius Scan iOS Camera Toolbar */}
        <div className="flex items-center justify-between px-3 sm:px-4 h-14 bg-black/85 backdrop-blur-md border-b border-white/10 z-20 shrink-0">
          <button
            onClick={onClose}
            className="min-h-[44px] min-w-[44px] flex items-center justify-center text-white/90 hover:text-white"
            aria-label="Close scanner"
          >
            <X className="w-6 h-6" />
          </button>

          <div className="flex items-center gap-1.5 sm:gap-2">
            <button
              onClick={() => setFlashOn((f) => !f)}
              className={`min-h-[38px] px-2.5 sm:px-3 rounded-full text-xs font-semibold flex items-center gap-1.5 transition-colors ${
                flashOn ? 'bg-orange-600 text-white' : 'bg-white/12 text-white/85 hover:bg-white/20'
              }`}
            >
              {flashOn ? <Zap className="w-3.5 h-3.5" /> : <ZapOff className="w-3.5 h-3.5" />}
              <span className="hidden sm:inline">{flashOn ? 'Torch On' : 'Torch'}</span>
            </button>
            <button
              onClick={() => setAutoCapture((a) => !a)}
              className={`min-h-[38px] px-3 rounded-full text-xs font-semibold flex items-center gap-1.5 transition-colors ${
                autoCapture ? 'bg-orange-600 text-white' : 'bg-white/12 text-white/85 hover:bg-white/20'
              }`}
            >
              <Sparkles className="w-3.5 h-3.5" />
              <span>{autoCapture ? 'Auto' : 'Manual'}</span>
            </button>
            {scanMode === 'batch' && (
              <button
                onClick={cycleBatchPace}
                className="min-h-[38px] px-3 rounded-full text-xs font-semibold bg-white/12 text-white/85 hover:bg-white/20 transition-colors hidden sm:flex items-center"
              >
                {paceLabel}
              </button>
            )}
            <button
              onClick={handleSwitchCamera}
              aria-label="Switch camera lens"
              title="Switch camera"
              className="min-h-[38px] min-w-[38px] rounded-full bg-white/12 text-white/85 hover:bg-white/20 flex items-center justify-center transition-colors"
            >
              <SwitchCamera className="w-4 h-4" />
            </button>
            <button
              onClick={() => setShowGrid((g) => !g)}
              aria-label="Toggle composition grid"
              className={`min-h-[38px] min-w-[38px] rounded-full flex items-center justify-center transition-colors ${
                showGrid ? 'bg-white/20 text-white' : 'bg-white/10 text-white/60'
              }`}
            >
              <Grid3X3 className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* REAL Live Camera Viewfinder */}
        <div className="relative flex-1 overflow-hidden flex items-center justify-center bg-[#0C0C0E]">
          {/* Always mount <video> so srcObject attaches immediately when stream opens */}
          <video
            ref={videoRef}
            playsInline
            muted
            autoPlay
            className={`w-full h-full object-cover ${cameraStatus === 'live' ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
          />

          {/* Initializing Spinner */}
          {cameraStatus === 'initializing' && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center">
              <Loader2 className="w-8 h-8 text-orange-500 animate-spin" />
              <p className="text-sm font-semibold text-white">Starting live camera…</p>
              <p className="text-xs text-white/60 max-w-xs">
                Allow camera access when prompted to enable real-time edge detection and capture.
              </p>
            </div>
          )}

          {/* Denied or Unavailable Real Camera Recovery UI (Never silently fakes a dummy scan!) */}
          {(cameraStatus === 'denied' || cameraStatus === 'unavailable') && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 p-6 text-center bg-[#121215]">
              <div className="w-14 h-14 rounded-2xl bg-orange-600/20 text-orange-400 flex items-center justify-center">
                <Camera className="w-7 h-7" />
              </div>
              <div className="space-y-1.5 max-w-sm">
                <h3 className="text-base font-bold text-white">
                  {cameraStatus === 'denied' ? 'Camera Permission Needed' : 'Live Camera Stream Unavailable'}
                </h3>
                <p className="text-xs text-white/65 leading-relaxed">{cameraErrorMsg}</p>
              </div>
              <div className="flex flex-wrap items-center justify-center gap-2.5 pt-1">
                <button
                  type="button"
                  onClick={() => setCameraRetryKey((k) => k + 1)}
                  className="min-h-[42px] px-4 rounded-xl bg-orange-600 hover:bg-orange-500 text-white text-xs font-semibold flex items-center gap-2"
                >
                  <RefreshCw className="w-4 h-4" />
                  <span>Retry Live Camera</span>
                </button>
                <button
                  type="button"
                  onClick={() => nativeCameraInputRef.current?.click()}
                  className="min-h-[42px] px-4 rounded-xl bg-white/12 hover:bg-white/20 text-white text-xs font-semibold flex items-center gap-2"
                >
                  <Camera className="w-4 h-4 text-orange-400" />
                  <span>Use Device Camera</span>
                </button>
                <button
                  type="button"
                  onClick={() => galleryInputRef.current?.click()}
                  className="min-h-[42px] px-4 rounded-xl bg-white/12 hover:bg-white/20 text-white text-xs font-semibold flex items-center gap-2"
                >
                  <ImageIcon className="w-4 h-4" />
                  <span>Import Photos</span>
                </button>
              </div>
            </div>
          )}

          {/* Composition Rule-of-Thirds Grid */}
          {cameraStatus === 'live' && showGrid && (
            <div className="pointer-events-none absolute inset-0 grid grid-cols-3 grid-rows-3 opacity-25">
              <div className="border-r border-b border-white/40" />
              <div className="border-r border-b border-white/40" />
              <div className="border-b border-white/40" />
              <div className="border-r border-b border-white/40" />
              <div className="border-r border-b border-white/40" />
              <div className="border-b border-white/40" />
              <div className="border-r border-white/40" />
              <div className="border-r border-white/40" />
              <div />
            </div>
          )}

          {/* REAL-TIME Detected Document Orange Quad Overlay */}
          {cameraStatus === 'live' && (
            <div className="pointer-events-none absolute inset-0">
              {quadPolyPoints ? (
                <svg
                  viewBox="0 0 100 100"
                  preserveAspectRatio="none"
                  className="w-full h-full"
                >
                  <polygon
                    points={quadPolyPoints}
                    fill={waitingPageSwap ? 'rgba(148,163,184,0.12)' : 'rgba(234, 88, 12, 0.18)'}
                    stroke={waitingPageSwap ? '#94A3B8' : '#F97316'}
                    strokeWidth="0.65"
                  />
                </svg>
              ) : scanMode === 'idcard' ? (
                <div className="absolute inset-0 flex items-center justify-center p-8">
                  <div className="w-full max-w-md aspect-[1.586/1] border-2 border-dashed border-orange-400/90 bg-orange-500/8 rounded-xl" />
                </div>
              ) : null}

              {/* Live Scanner Guidance Pill */}
              <div className="absolute bottom-4 left-1/2 -translate-x-1/2 px-3.5 py-1.5 rounded-full bg-black/75 backdrop-blur-md text-xs font-medium text-white whitespace-nowrap flex items-center gap-2">
                {waitingPageSwap ? (
                  <span>Page captured · Swap or turn sheet for next scan</span>
                ) : scanMode === 'idcard' ? (
                  <span>
                    {capturedPages.length === 0
                      ? 'Align Front of ID Card inside frame'
                      : 'Flip & align Back of ID Card'}
                  </span>
                ) : detectedQuad && edgeConfidence >= 0.52 ? (
                  <span>
                    {autoCapture && stabilityProgress > 0.2
                      ? `Hold steady… Auto-capturing (${Math.round(stabilityProgress * 100)}%)`
                      : 'Document edges locked · Tap shutter'}
                  </span>
                ) : (
                  <span>Point camera at document on contrasting surface</span>
                )}
              </div>
            </div>
          )}

          {/* Shutter Flash Feedback */}
          {shutterFlash && <div className="pointer-events-none absolute inset-0 bg-white/85 z-30" />}
        </div>

        {/* Hidden Native Camera + Gallery File Inputs */}
        <input
          ref={nativeCameraInputRef}
          type="file"
          accept="image/*"
          capture="environment"
          className="hidden"
          onChange={handleFileCaptureOrImport}
        />
        <input
          ref={galleryInputRef}
          type="file"
          accept="image/*"
          multiple={scanMode !== 'single'}
          className="hidden"
          onChange={handleFileCaptureOrImport}
        />

        {/* Bottom Genius Scan Capture Dock */}
        <div className="bg-black/95 border-t border-white/10 px-4 pt-3 pb-safe space-y-4 shrink-0">
          {!isAppendMode && (
            <div className="flex items-center justify-center gap-6 text-xs font-semibold">
              {(
                [
                  { id: 'single', label: 'Single' },
                  { id: 'batch', label: 'Batch' },
                  { id: 'idcard', label: '2-in-1 ID' },
                ] as const
              ).map((m) => (
                <button
                  key={m.id}
                  onClick={() => setScanMode(m.id)}
                  className={`py-1 px-2 transition-colors ${
                    scanMode === m.id ? 'text-orange-400' : 'text-white/55 hover:text-white/80'
                  }`}
                >
                  {m.label}
                </button>
              ))}
            </div>
          )}

          {/* Shutter Row */}
          <div className="max-w-md mx-auto flex items-center justify-between px-4 pb-2">
            {/* Import Real Photos */}
            <button
              type="button"
              onClick={() => galleryInputRef.current?.click()}
              className="flex flex-col items-center gap-1 min-w-[60px] text-white/80 hover:text-white transition-colors"
            >
              <span className="w-11 h-11 rounded-2xl bg-white/12 flex items-center justify-center">
                <ImageIcon className="w-5 h-5" />
              </span>
              <span className="text-[11px] font-medium">Photos</span>
            </button>

            {/* Concentric Genius Scan Orange Shutter with Live Stability Progress Ring */}
            <button
              type="button"
              onClick={() => {
                if (cameraStatus === 'live') {
                  captureLiveVideoFrame();
                } else {
                  nativeCameraInputRef.current?.click();
                }
              }}
              aria-label="Capture live document photo"
              className="relative w-[78px] h-[78px] rounded-full flex items-center justify-center active:scale-95 transition-transform"
            >
              <svg className="absolute inset-0 w-full h-full -rotate-90" viewBox="0 0 80 80">
                <circle
                  cx="40"
                  cy="40"
                  r="36"
                  fill="none"
                  stroke="rgba(255,255,255,0.35)"
                  strokeWidth="4"
                />
                {stabilityProgress > 0 && (
                  <circle
                    cx="40"
                    cy="40"
                    r="36"
                    fill="none"
                    stroke="#F97316"
                    strokeWidth="4"
                    strokeDasharray={226.2}
                    strokeDashoffset={226.2 * (1 - stabilityProgress)}
                    strokeLinecap="round"
                  />
                )}
              </svg>
              <span className="w-[58px] h-[58px] rounded-full bg-orange-600 hover:bg-orange-500 transition-colors flex items-center justify-center">
                <Camera className="w-6 h-6 text-white" />
              </span>
            </button>

            {/* Captured Stack Preview & Next */}
            <button
              type="button"
              disabled={capturedPages.length === 0}
              onClick={() => setPhase('review')}
              className="flex flex-col items-center gap-1 min-w-[60px] disabled:opacity-35 transition-opacity"
            >
              <div className="relative w-11 h-11 rounded-xl overflow-hidden bg-white/15 border border-white/25 flex items-center justify-center">
                {capturedPages.length > 0 ? (
                  <>
                    <img
                      src={capturedPages[capturedPages.length - 1].imageUrl}
                      alt="Last scan"
                      className="w-full h-full object-cover"
                    />
                    <span className="absolute -top-1 -right-1 min-w-[20px] h-5 px-1 rounded-full bg-orange-600 text-white text-[11px] font-mono font-bold flex items-center justify-center">
                      {capturedPages.length}
                    </span>
                  </>
                ) : (
                  <Check className="w-5 h-5 text-white/50" />
                )}
              </div>
              <span className="text-[11px] font-semibold text-orange-400">
                {capturedPages.length > 0 ? `Next (${capturedPages.length})` : 'Review'}
              </span>
            </button>
          </div>
        </div>
      </div>
    );
  }

  /* PHASE 2: POST-CAPTURE REVIEW, REAL OCR SMART NAMING & SAVE SHEET */
  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-[#F2F2F7] dark:bg-[#000000] text-slate-900 dark:text-slate-100"
      role="dialog"
      aria-modal="true"
      aria-label="Review Scanned Document"
    >
      <header className="sticky top-0 z-20 bg-white/95 dark:bg-[#1C1C1E]/95 backdrop-blur-md border-b border-slate-200 dark:border-white/10 px-4 sm:px-6 h-14 flex items-center justify-between gap-3 shrink-0">
        <button
          onClick={() => setPhase('camera')}
          className="min-h-[44px] flex items-center gap-1.5 text-sm font-semibold text-orange-600 dark:text-orange-400"
        >
          <Camera className="w-4 h-4" />
          <span>Add Page</span>
        </button>
        <div className="text-center min-w-0">
          <h2 className="text-sm font-bold truncate">
            {isAppendMode ? `Append to ${appendTargetTitle}` : 'Review & Save Scan'}
          </h2>
          <p className="text-[11px] text-slate-500 dark:text-slate-400 font-mono tabular-nums">
            {capturedPages.length} {capturedPages.length === 1 ? 'page' : 'pages'}
            {ocrInFlightCount > 0 ? ` · OCR running (${ocrInFlightCount})…` : ''}
          </p>
        </div>
        <button
          onClick={handleSaveScan}
          disabled={isSaving || capturedPages.length === 0}
          className="min-h-[40px] px-4 rounded-xl bg-orange-600 hover:bg-orange-700 text-white text-sm font-semibold flex items-center gap-1.5 disabled:opacity-50 transition-colors whitespace-nowrap"
        >
          <Check className="w-4 h-4" />
          <span>{isSaving ? 'Saving…' : isAppendMode ? 'Append' : 'Save PDF'}</span>
        </button>
      </header>

      <div className="flex-1 overflow-y-auto px-4 sm:px-6 py-5">
        <div className="max-w-5xl mx-auto grid grid-cols-1 lg:grid-cols-12 gap-6">
          {/* Left: Captured Pages Grid */}
          <div className="lg:col-span-7 space-y-4">
            <div className="bg-white dark:bg-[#1C1C1E] rounded-2xl p-4 border border-slate-200/80 dark:border-white/10 space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-slate-700 dark:text-slate-200 flex items-center gap-1.5">
                  <Sliders className="w-3.5 h-3.5 text-orange-600" />
                  <span>Enhancement Filter</span>
                </span>
                <span className="text-xs text-slate-500 dark:text-slate-400">
                  Applies across batch
                </span>
              </div>
              <div className="flex items-center gap-2 overflow-x-auto pb-1">
                {SCAN_FILTERS.map((f) => (
                  <button
                    key={f.id}
                    type="button"
                    onClick={() => handleApplyGlobalFilter(f.id)}
                    className={`min-h-[38px] px-3.5 rounded-xl text-xs font-semibold transition-colors whitespace-nowrap shrink-0 ${
                      activeFilter === f.id
                        ? 'bg-orange-600 text-white'
                        : 'bg-slate-100 dark:bg-[#2C2C2E] text-slate-700 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-white/15'
                    }`}
                  >
                    {f.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3.5">
              {capturedPages.map((pg, idx) => (
                <div
                  key={pg.id}
                  className="bg-white dark:bg-[#1C1C1E] rounded-2xl p-2.5 border border-slate-200/80 dark:border-white/10 flex flex-col gap-2"
                >
                  <div className="aspect-[3/4] rounded-xl bg-slate-100 dark:bg-[#121214] p-1.5 overflow-hidden">
                    <PageCanvasPreview page={pg} className="w-full h-full rounded shadow-xs" />
                  </div>
                  <div className="flex items-center justify-between px-0.5">
                    <span className="text-xs font-mono font-semibold text-slate-600 dark:text-slate-300">
                      P{idx + 1} {pg.ocrText ? '· OCR' : ''}
                    </span>
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => setEditingPageIdx(idx)}
                        title="Crop & adjust"
                        className="w-8 h-8 rounded-lg flex items-center justify-center text-slate-500 hover:text-orange-600 hover:bg-slate-100 dark:hover:bg-white/10"
                      >
                        <Crop className="w-3.5 h-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          setCapturedPages((prev) =>
                            prev.map((item, i) =>
                              i === idx
                                ? { ...item, rotation: (((item.rotation + 90) % 360) as 0 | 90 | 180 | 270) }
                                : item
                            )
                          )
                        }
                        title="Rotate 90°"
                        className="w-8 h-8 rounded-lg flex items-center justify-center text-slate-500 hover:text-orange-600 hover:bg-slate-100 dark:hover:bg-white/10"
                      >
                        <RotateCw className="w-3.5 h-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          setCapturedPages((prev) => prev.filter((_, i) => i !== idx))
                        }
                        title="Remove page"
                        className="w-8 h-8 rounded-lg flex items-center justify-center text-slate-500 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-950/30"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Right: Smart Naming, Folder, PDF Settings */}
          {!isAppendMode && (
            <div className="lg:col-span-5 space-y-4">
              <div className="bg-white dark:bg-[#1C1C1E] rounded-2xl p-4 sm:p-5 border border-slate-200/80 dark:border-white/10 space-y-4">
                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <label className="text-xs font-semibold text-slate-600 dark:text-slate-300">
                      Document Title
                    </label>
                    <button
                      type="button"
                      disabled={isSmartNaming}
                      onClick={handleSmartTitleSuggestion}
                      className="text-xs font-semibold text-orange-600 dark:text-orange-400 hover:underline flex items-center gap-1 disabled:opacity-50"
                    >
                      <Sparkles className="w-3.5 h-3.5" />
                      <span>{isSmartNaming ? 'Reading OCR…' : 'Smart Name from OCR'}</span>
                    </button>
                  </div>
                  <input
                    type="text"
                    value={docTitle}
                    onChange={(e) => setDocTitle(e.target.value)}
                    placeholder="Enter document name"
                    className="w-full h-11 px-3.5 rounded-xl bg-slate-50 dark:bg-[#2C2C2E] border border-slate-200 dark:border-white/10 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
                  />
                  <div className="flex flex-wrap gap-1.5 mt-2">
                    {NAMING_TEMPLATES.map((tpl) => (
                      <button
                        key={tpl.id}
                        type="button"
                        onClick={() => setDocTitle(resolveNamingTemplate(tpl.pattern, nextSequenceNumber))}
                        className="px-2.5 py-1 rounded-lg text-[11px] font-medium bg-slate-100 dark:bg-[#2C2C2E] hover:bg-orange-50 dark:hover:bg-orange-950/30 text-slate-600 dark:text-slate-300 hover:text-orange-600 transition-colors"
                      >
                        {tpl.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-semibold text-slate-600 dark:text-slate-300 mb-1.5">
                      Folder
                    </label>
                    <select
                      value={folderId}
                      onChange={(e) => setFolderId(e.target.value)}
                      className="w-full h-10 px-3 rounded-xl bg-slate-50 dark:bg-[#2C2C2E] border border-slate-200 dark:border-white/10 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
                    >
                      {folders.map((f) => (
                        <option key={f.id} value={f.id}>
                          {f.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-600 dark:text-slate-300 mb-1.5">
                      Tags (auto-enriched by OCR)
                    </label>
                    <input
                      type="text"
                      value={tagInput}
                      onChange={(e) => setTagInput(e.target.value)}
                      placeholder="Receipt, Tax"
                      className="w-full h-10 px-3 rounded-xl bg-slate-50 dark:bg-[#2C2C2E] border border-slate-200 dark:border-white/10 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
                    />
                  </div>
                </div>

                <div className="space-y-3 pt-2 border-t border-slate-100 dark:border-white/8">
                  <div>
                    <span className="block text-xs font-semibold text-slate-600 dark:text-slate-300 mb-1.5">
                      PDF Page Size
                    </span>
                    <div className="grid grid-cols-3 gap-1 p-1 rounded-xl bg-slate-100 dark:bg-[#2C2C2E]">
                      {(
                        [
                          { id: 'auto', label: 'Auto Fit' },
                          { id: 'a4', label: 'A4' },
                          { id: 'letter', label: 'US Letter' },
                        ] as const
                      ).map((s) => (
                        <button
                          key={s.id}
                          type="button"
                          onClick={() => setPageSizePreset(s.id)}
                          className={`py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                            pageSizePreset === s.id
                              ? 'bg-white dark:bg-[#3A3A3C] text-slate-900 dark:text-white shadow-xs'
                              : 'text-slate-600 dark:text-slate-400'
                          }`}
                        >
                          {s.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div>
                    <span className="block text-xs font-semibold text-slate-600 dark:text-slate-300 mb-1.5">
                      Export Quality
                    </span>
                    <div className="grid grid-cols-3 gap-1 p-1 rounded-xl bg-slate-100 dark:bg-[#2C2C2E]">
                      {(
                        [
                          { id: 'high', label: 'High' },
                          { id: 'balanced', label: 'Balanced' },
                          { id: 'compact', label: 'Small PDF' },
                        ] as const
                      ).map((q) => (
                        <button
                          key={q.id}
                          type="button"
                          onClick={() => setQualityPreset(q.id)}
                          className={`py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                            qualityPreset === q.id
                              ? 'bg-white dark:bg-[#3A3A3C] text-slate-900 dark:text-white shadow-xs'
                              : 'text-slate-600 dark:text-slate-400'
                          }`}
                        >
                          {q.label}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                <div className="space-y-3 pt-2 border-t border-slate-100 dark:border-white/8">
                  <label className="flex items-center justify-between gap-3 cursor-pointer">
                    <div>
                      <div className="text-sm font-medium">Searchable OCR Text Layer</div>
                      <div className="text-xs text-slate-500 dark:text-slate-400">
                        Extract on-device OCR &amp; build 384-dim semantic index
                      </div>
                    </div>
                    <input
                      type="checkbox"
                      checked={searchableOcr}
                      onChange={(e) => setSearchableOcr(e.target.checked)}
                      className="w-5 h-5 accent-orange-600 rounded"
                    />
                  </label>

                  <label className="flex items-center justify-between gap-3 cursor-pointer">
                    <div className="flex items-center gap-2">
                      <Lock className="w-4 h-4 text-slate-400" />
                      <div>
                        <div className="text-sm font-medium">Password Protect PDF</div>
                        <div className="text-xs text-slate-500 dark:text-slate-400">
                          Mark document as encrypted vault item
                        </div>
                      </div>
                    </div>
                    <input
                      type="checkbox"
                      checked={passwordProtect}
                      onChange={(e) => setPasswordProtect(e.target.checked)}
                      className="w-5 h-5 accent-orange-600 rounded"
                    />
                  </label>

                  <label className="flex items-center justify-between gap-3 cursor-pointer">
                    <div>
                      <div className="text-sm font-medium">Save to Smart Cards Wallet</div>
                      <div className="text-xs text-slate-500 dark:text-slate-400">
                        Auto-file in IDs, Medical, Finance, or Vehicle
                      </div>
                    </div>
                    <input
                      type="checkbox"
                      checked={saveAsSmartCard}
                      onChange={(e) => setSaveAsSmartCard(e.target.checked)}
                      className="w-5 h-5 accent-orange-600 rounded"
                    />
                  </label>

                  {saveAsSmartCard && (
                    <div className="flex flex-wrap gap-1.5 pt-1">
                      {SMART_CARD_CATEGORIES.map((cat) => (
                        <button
                          key={cat}
                          type="button"
                          onClick={() => setCardCategory(cat)}
                          className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                            cardCategory === cat
                              ? 'bg-orange-600 text-white'
                              : 'bg-slate-100 dark:bg-[#2C2C2E] text-slate-600 dark:text-slate-300'
                          }`}
                        >
                          {cat}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {editingPageIdx !== null && capturedPages[editingPageIdx] && (
        <PerspectiveCropModal
          page={capturedPages[editingPageIdx]}
          pageNumber={editingPageIdx + 1}
          onClose={() => setEditingPageIdx(null)}
          onSave={(updated) => {
            setCapturedPages((prev) =>
              prev.map((item, idx) => (idx === editingPageIdx ? updated : item))
            );
            setEditingPageIdx(null);
          }}
        />
      )}
    </div>
  );
};
