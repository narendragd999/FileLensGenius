import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Camera,
  Check,
  ChevronLeft,
  ChevronRight,
  Crop,
  Grid3X3,
  Image as ImageIcon,
  Loader2,
  Lock,
  Plus,
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
import { launchNativeGoogleDocScanner } from '../utils/deviceRoots';
import { composeTwoInOneA4IdCard, rectifyPageToStraightImage } from '../utils/pdfExport';
import {
  analyzeCanvasFrame,
  computeFingerprintDelta,
  computeQuadDelta,
  detectNeuralQuadFromCanvas,
  detectQuadFromImageUrl,
  isFullQuad,
} from '../utils/documentEdgeDetector';
import { isLowEndDevice } from '../utils/deviceTier';
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
  const [autoCapture, setAutoCapture] = useState<boolean>(false);
  const [batchPace, setBatchPace] = useState<BatchAutoPace>(preferences.batchPace);
  const [flashMode, setFlashMode] = useState<'auto' | 'on' | 'off'>('auto');
  const [autoTorchActive, setAutoTorchActive] = useState<boolean>(true);
  const effectiveFlashOn = flashMode === 'on' || (flashMode === 'auto' && autoTorchActive);
  const [showGrid, setShowGrid] = useState<boolean>(true);
  const [cameraZoom, setCameraZoom] = useState<1 | 2>(1);
  const [focusPoint, setFocusPoint] = useState<{ x: number; y: number } | null>(null);

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
  const [activeReviewIdx, setActiveReviewIdx] = useState<number>(0);
  const [retakeTargetIdx, setRetakeTargetIdx] = useState<number | null>(null);
  const [isSaving, setIsSaving] = useState<boolean>(false);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const analysisCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const galleryInputRef = useRef<HTMLInputElement | null>(null);
  const nativeCameraInputRef = useRef<HTMLInputElement | null>(null);
  const touchStartXRef = useRef<number | null>(null);
  const cameraStripEndRef = useRef<HTMLDivElement | null>(null);
  const activeThumbRef = useRef<HTMLButtonElement | null>(null);

  // Refs for real-time edge stability & anti-duplicate fingerprint gate
  const lastQuadRef = useRef<NormalizedQuad | null>(null);
  const stableFramesRef = useRef<number>(0);
  const lastCapturedFpRef = useRef<Float32Array | null>(null);
  const latestFpRef = useRef<Float32Array | null>(null);
  const waitingPageSwapRef = useRef<boolean>(false);
  const shutterAudioCtxRef = useRef<AudioContext | null>(null);
  const lastAutoShotMsRef = useRef<number>(0);
  const captureLockRef = useRef<boolean>(false);

  // Keep activeReviewIdx clamped and return to camera if all pages were removed in review
  useEffect(() => {
    if (capturedPages.length === 0) {
      setActiveReviewIdx(0);
      if (phase === 'review') {
        setPhase('camera');
      }
      return;
    }
    if (activeReviewIdx >= capturedPages.length) {
      setActiveReviewIdx(capturedPages.length - 1);
    }
  }, [capturedPages.length, activeReviewIdx, phase]);

  // Auto-scroll camera filmstrip to the latest captured page
  useEffect(() => {
    if (phase === 'camera' && capturedPages.length > 0) {
      cameraStripEndRef.current?.scrollIntoView({ behavior: 'smooth', inline: 'end', block: 'nearest' });
    }
  }, [capturedPages.length, phase]);

  // Auto-scroll active page thumbnail into view in review mode
  useEffect(() => {
    if (phase === 'review') {
      activeThumbRef.current?.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
    }
  }, [activeReviewIdx, phase]);

  // Keyboard arrow navigation across scanned pages in review phase
  useEffect(() => {
    if (phase !== 'review' || editingPageIdx !== null) return;
    const onKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.key === 'ArrowLeft') {
        setActiveReviewIdx((i) => Math.max(0, i - 1));
      } else if (e.key === 'ArrowRight') {
        setActiveReviewIdx((i) => Math.min(capturedPages.length - 1, i + 1));
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [phase, editingPageIdx, capturedPages.length]);

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

      const lowEnd = isLowEndDevice();
      const targetW = lowEnd ? 1280 : 1920;
      const targetH = lowEnd ? 720 : 1080;
      const constraintsToTry: MediaStreamConstraints[] = selectedDeviceId
        ? [
            { video: { deviceId: { exact: selectedDeviceId }, width: { ideal: targetW }, height: { ideal: targetH } }, audio: false },
            { video: { deviceId: { exact: selectedDeviceId } }, audio: false },
          ]
        : [
            { video: { facingMode: { ideal: facingMode }, width: { ideal: targetW }, height: { ideal: targetH } }, audio: false },
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
        const track = stream.getVideoTracks?.()[0];
        if (track && typeof track.applyConstraints === 'function') {
          const caps = (track.getCapabilities?.() as {
            focusMode?: string[];
            exposureMode?: string[];
            whiteBalanceMode?: string[];
          } | undefined) ?? {};
          const adv: Record<string, unknown> = {};
          if (!caps.focusMode || caps.focusMode.includes('continuous')) {
            adv.focusMode = 'continuous';
          } else if (caps.focusMode.includes('single-shot')) {
            adv.focusMode = 'single-shot';
          }
          if (caps.exposureMode?.includes('continuous')) adv.exposureMode = 'continuous';
          if (caps.whiteBalanceMode?.includes('continuous')) adv.whiteBalanceMode = 'continuous';
          if (Object.keys(adv).length > 0) {
            void track
              .applyConstraints({ advanced: [adv as MediaTrackConstraintSet] })
              .catch(() => undefined);
          }
        }
      }

      if (!cancelled) {
        setCameraStatus('live');
        // Enumerate video devices asynchronously AFTER preview is already live
        void navigator.mediaDevices
          .enumerateDevices()
          .then((allDevices) => {
            if (!cancelled) {
              setVideoDevices(allDevices.filter((d) => d.kind === 'videoinput'));
            }
          })
          .catch(() => undefined);
      }
    }

    startLiveCamera();
    return () => {
      cancelled = true;
      stopCameraTracks();
    };
  }, [phase, facingMode, selectedDeviceId, cameraRetryKey, stopCameraTracks]);

  // Trigger real hardware camera lens focus (tap-to-focus or center autofocus)
  const triggerCameraFocus = useCallback((normX = 0.5, normY = 0.5, showReticle = true) => {
    if (showReticle) {
      setFocusPoint({ x: normX * 100, y: normY * 100 });
      window.setTimeout(() => setFocusPoint(null), 950);
    }
    const track = streamRef.current?.getVideoTracks?.()[0];
    if (!track || typeof track.applyConstraints !== 'function') return;
    const caps = (track.getCapabilities?.() as { focusMode?: string[] } | undefined) ?? {};
    const focusModes = caps.focusMode ?? [];
    const targetMode = focusModes.includes('single-shot') ? 'single-shot' : 'continuous';

    const withPoi: Record<string, unknown> = {
      pointsOfInterest: [{ x: Math.max(0.05, Math.min(0.95, normX)), y: Math.max(0.05, Math.min(0.95, normY)) }],
      focusMode: targetMode,
    };
    void track
      .applyConstraints({ advanced: [withPoi as MediaTrackConstraintSet] })
      .catch(() =>
        track
          .applyConstraints({ advanced: [{ focusMode: targetMode } as MediaTrackConstraintSet] })
          .catch(() => undefined)
      )
      .finally(() => {
        if (targetMode === 'single-shot' && (!focusModes.length || focusModes.includes('continuous'))) {
          window.setTimeout(() => {
            const activeTrack = streamRef.current?.getVideoTracks?.()[0];
            if (activeTrack && typeof activeTrack.applyConstraints === 'function') {
              void activeTrack
                .applyConstraints({ advanced: [{ focusMode: 'continuous' } as MediaTrackConstraintSet] })
                .catch(() => undefined);
            }
          }, 1600);
        }
      });
  }, []);

  // Apply Torch / Flash constraint (Auto in low light, On, or Off)
  useEffect(() => {
    const track = streamRef.current?.getVideoTracks?.()[0];
    if (!track) return;
    const caps = (track.getCapabilities?.() as { torch?: boolean } | undefined) ?? {};
    if (caps.torch) {
      track
        .applyConstraints({
          advanced: [{ torch: effectiveFlashOn } as MediaTrackConstraintSet],
        })
        .catch(() => {});
    }
  }, [effectiveFlashOn, cameraStatus]);

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

  const playShutterSound = useCallback(() => {
    try {
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioCtx) return;
      if (!shutterAudioCtxRef.current || shutterAudioCtxRef.current.state === 'closed') {
        shutterAudioCtxRef.current = new AudioCtx();
      }
      const audioCtx = shutterAudioCtxRef.current;
      if (audioCtx.state === 'suspended') {
        void audioCtx.resume();
      }
      const now = audioCtx.currentTime;

      // Crisp two-stage mechanical camera shutter click (noise burst + short click)
      const bufferSize = Math.floor(audioCtx.sampleRate * 0.045);
      const noiseBuffer = audioCtx.createBuffer(1, bufferSize, audioCtx.sampleRate);
      const output = noiseBuffer.getChannelData(0);
      for (let i = 0; i < bufferSize; i++) {
        const env = i < bufferSize * 0.28 ? 1 : Math.exp(-(i - bufferSize * 0.28) / (bufferSize * 0.22));
        output[i] = (Math.random() * 2 - 1) * env;
      }

      const noise = audioCtx.createBufferSource();
      noise.buffer = noiseBuffer;

      const bandpass = audioCtx.createBiquadFilter();
      bandpass.type = 'bandpass';
      bandpass.frequency.setValueAtTime(1850, now);
      bandpass.Q.setValueAtTime(1.4, now);

      const gain = audioCtx.createGain();
      gain.gain.setValueAtTime(0.32, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.045);

      noise.connect(bandpass);
      bandpass.connect(gain);
      gain.connect(audioCtx.destination);
      noise.start(now);
      noise.stop(now + 0.048);

      // Subtle second leaf-shutter click 28ms later
      const osc = audioCtx.createOscillator();
      const oscGain = audioCtx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(920, now + 0.028);
      osc.frequency.exponentialRampToValueAtTime(280, now + 0.055);
      oscGain.gain.setValueAtTime(0.14, now + 0.028);
      oscGain.gain.exponentialRampToValueAtTime(0.001, now + 0.058);
      osc.connect(oscGain);
      oscGain.connect(audioCtx.destination);
      osc.start(now + 0.028);
      osc.stop(now + 0.06);
    } catch {
      // Audio playback is optional and must never block scanning
    }
  }, []);

  // REAL Live Frame Capture directly from <video> hardware stream!
  const captureLiveVideoFrame = useCallback(
    async (quadOverride?: NormalizedQuad | null) => {
      const video = videoRef.current;
      if (!video || video.readyState < 2 || video.videoWidth === 0 || video.videoHeight === 0) {
        onToast('Camera feed is still starting — hold on a moment');
        return;
      }
      if (captureLockRef.current) return;
      captureLockRef.current = true;

      playShutterSound();
      setShutterFlash(true);
      setTimeout(() => setShutterFlash(false), 140);

      // Capture native video resolution (1600px on low-end devices, up to 2048px on standard)
      const maxDim = isLowEndDevice() ? 1600 : 2048;
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

      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.filter = 'contrast(1.06) brightness(1.02) saturate(1.04)';
      ctx.drawImage(video, 0, 0, outW, outH);
      ctx.filter = 'none';

      // Fast 3x3 unsharp-mask pass so distant text stays crisp and legible
      const imgData = ctx.getImageData(0, 0, outW, outH);
      const src = imgData.data;
      const copy = new Uint8ClampedArray(src);
      const amount = 0.35;
      for (let y = 1; y < outH - 1; y++) {
        const row = y * outW;
        for (let x = 1; x < outW - 1; x++) {
          const i = (row + x) * 4;
          const up = ((row - outW) + x) * 4;
          const dn = ((row + outW) + x) * 4;
          const lf = i - 4;
          const rt = i + 4;
          for (let c = 0; c < 3; c++) {
            const blur = (copy[up + c] + copy[dn + c] + copy[lf + c] + copy[rt + c]) * 0.25;
            const sharp = copy[i + c] + (copy[i + c] - blur) * amount;
            src[i + c] = sharp < 0 ? 0 : sharp > 255 ? 255 : sharp;
          }
        }
      }
      ctx.putImageData(imgData, 0, 0);

      const capturedDataUrl = canvas.toDataURL('image/jpeg', 0.95);
      navigator.vibrate?.(20);

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
        if (retakeTargetIdx !== null && retakeTargetIdx < prev.length) {
          const targetIdx = retakeTargetIdx;
          const replaced = prev.map((item, i) => (i === targetIdx ? newPage : item));
          setRetakeTargetIdx(null);
          setActiveReviewIdx(targetIdx);
          onToast(`Replaced Page ${targetIdx + 1} · Extracting OCR…`);
          setTimeout(() => setPhase('review'), 140);
          return replaced;
        }
        const next = scanMode === 'single' ? [newPage] : [...prev, newPage];
        const newIdx = next.length - 1;
        setActiveReviewIdx(newIdx);
        if (scanMode === 'single') {
          setTimeout(() => setPhase('review'), 160);
        } else if (scanMode === 'idcard' && next.length >= 2) {
          onToast('Captured Front & Back · Ready for 2-in-1 A4 ID composite');
          setTimeout(() => setPhase('review'), 200);
        } else {
          onToast(`Captured Page ${next.length} · Tap thumbnail to preview`);
        }
        return next;
      });

      enrichPageWithRealOcr(pageId, capturedDataUrl);

      // Auto-detect white A4 paper borders at high-res & straighten immediately on capture!
      void (async () => {
        let autoQuad = effectiveQuad;
        if (!quadOverride) {
          const hiResQuad = await detectQuadFromImageUrl(capturedDataUrl);
          if (!isFullQuad(hiResQuad)) {
            autoQuad = hiResQuad;
          }
        }
        if (!isFullQuad(autoQuad)) {
          const straightUrl = await rectifyPageToStraightImage(capturedDataUrl, autoQuad, 0, 2400);
          setCapturedPages((prev) =>
            prev.map((p) =>
              p.id === pageId
                ? {
                    ...p,
                    imageUrl: straightUrl,
                    originalImageUrl: capturedDataUrl,
                    originalQuad: autoQuad,
                    quad: FULL_QUAD,
                  }
                : p
            )
          );
        }
      })();

      setTimeout(() => {
        captureLockRef.current = false;
      }, 450);
    },
    [activeFilter, batchPace, detectedQuad, enrichPageWithRealOcr, onToast, retakeTargetIdx, scanMode]
  );

  // Real-time Live Document Edge Tracking & Smart Anti-Duplicate Auto-Capture Loop (~160ms interval)
  useEffect(() => {
    if (phase !== 'camera' || cameraStatus !== 'live') {
      setDetectedQuad(null);
      setEdgeConfidence(0);
      setStabilityProgress(0);
      return;
    }

    const lowEnd = isLowEndDevice();
    const analysisW = lowEnd ? 192 : 240;
    const analysisH = lowEnd ? 256 : 320;
    const loopIntervalMs = lowEnd ? 240 : 160;
    const neuralModulo = lowEnd ? 3 : 2;

    if (!analysisCanvasRef.current) {
      analysisCanvasRef.current = document.createElement('canvas');
      analysisCanvasRef.current.width = analysisW;
      analysisCanvasRef.current.height = analysisH;
    }

    let missedFrames = 0;
    let frameTick = 0;
    let pendingJumpQuad: NormalizedQuad | null = null;
    let jumpConfirmCount = 0;
    let lastNeuralResult: { quad: NormalizedQuad; confidence: number; ts: number } | null = null;

    const timer = window.setInterval(() => {
      const video = videoRef.current;
      const canvas = analysisCanvasRef.current;
      if (!video || !canvas || video.readyState < 2 || video.videoWidth === 0) return;

      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) return;

      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const analysis = analyzeCanvasFrame(canvas, true);
      latestFpRef.current = analysis.fingerprint;

      frameTick++;
      if (
        frameTick % neuralModulo === 1 &&
        typeof window.FileLensAndroid?.detectDocumentQuadNative === 'function'
      ) {
        const neural = detectNeuralQuadFromCanvas(canvas);
        if (neural && neural.confidence >= 0.38) {
          lastNeuralResult = { quad: neural.quad, confidence: neural.confidence, ts: Date.now() };
        }
      }
      const activeNeural =
        lastNeuralResult && Date.now() - lastNeuralResult.ts < 850 ? lastNeuralResult : null;
      const chosenQuad =
        activeNeural && activeNeural.confidence >= 0.42
          ? activeNeural.quad
          : (analysis.quad ?? activeNeural?.quad ?? null);
      const chosenConfidence =
        activeNeural && activeNeural.confidence >= 0.42
          ? Math.max(analysis.confidence, activeNeural.confidence)
          : Math.max(analysis.confidence, activeNeural?.confidence ?? 0);

      if (flashMode === 'auto' && analysis.fingerprint.length > 0) {
        let sumLuma = 0;
        for (let k = 0; k < analysis.fingerprint.length; k++) sumLuma += analysis.fingerprint[k];
        const meanLuma = sumLuma / analysis.fingerprint.length;
        if (meanLuma < 0.65) setAutoTorchActive(true);
        else if (meanLuma > 0.78) setAutoTorchActive(false);
      }

      // Anti-Duplicate Smart Page-Change Gate (ported from LiveDocumentCameraView.kt)
      if (waitingPageSwapRef.current && lastCapturedFpRef.current) {
        const visualDelta = computeFingerprintDelta(analysis.fingerprint, lastCapturedFpRef.current);
        if (visualDelta >= 0.085) {
          waitingPageSwapRef.current = false;
          setWaitingPageSwap(false);
          stableFramesRef.current = 0;
          triggerCameraFocus(0.5, 0.5, false);
        }
      }

      if (chosenQuad && chosenConfidence >= 0.42) {
        missedFrames = 0;
        const prev = lastQuadRef.current;

        // Outlier jump rejection: require 2 consecutive agreeing frames for sudden large jumps
        if (prev && computeQuadDelta(prev, chosenQuad) > 0.12) {
          if (pendingJumpQuad && computeQuadDelta(pendingJumpQuad, chosenQuad) < 0.08) {
            jumpConfirmCount += 1;
          } else {
            pendingJumpQuad = chosenQuad;
            jumpConfirmCount = 1;
          }
          if (jumpConfirmCount < 2) {
            return;
          }
        }
        pendingJumpQuad = null;
        jumpConfirmCount = 0;

        const rawDelta = computeQuadDelta(prev, chosenQuad);
        const alpha = prev ? (rawDelta < 0.025 ? 0.22 : 0.52) : 1;
        const smoothed: NormalizedQuad = prev
          ? {
              tlX: prev.tlX * (1 - alpha) + chosenQuad.tlX * alpha,
              tlY: prev.tlY * (1 - alpha) + chosenQuad.tlY * alpha,
              trX: prev.trX * (1 - alpha) + chosenQuad.trX * alpha,
              trY: prev.trY * (1 - alpha) + chosenQuad.trY * alpha,
              brX: prev.brX * (1 - alpha) + chosenQuad.brX * alpha,
              brY: prev.brY * (1 - alpha) + chosenQuad.brY * alpha,
              blX: prev.blX * (1 - alpha) + chosenQuad.blX * alpha,
              blY: prev.blY * (1 - alpha) + chosenQuad.blY * alpha,
            }
          : chosenQuad;

        const delta = computeQuadDelta(prev, smoothed);
        lastQuadRef.current = smoothed;
        setDetectedQuad(smoothed);
        setEdgeConfidence(chosenConfidence);

        const cooldownMs =
          batchPace === 'delay_5s' ? 5000 : batchPace === 'delay_3s' ? 3000 : 1800;
        const cooldownElapsed = Date.now() - lastAutoShotMsRef.current >= cooldownMs;

        if (
          autoCapture &&
          !waitingPageSwapRef.current &&
          cooldownElapsed &&
          analysis.confidence >= 0.62 &&
          delta < 0.020
        ) {
          stableFramesRef.current += 1;
          const progress = Math.min(1, stableFramesRef.current / 6);
          setStabilityProgress(progress);
          if (stableFramesRef.current >= 6) {
            captureLiveVideoFrame(smoothed);
          }
        } else {
          stableFramesRef.current = Math.max(0, stableFramesRef.current - 1);
          setStabilityProgress(Math.min(1, stableFramesRef.current / 6));
        }
      } else {
        missedFrames += 1;
        pendingJumpQuad = null;
        jumpConfirmCount = 0;
        // Hold locked overlay briefly across 1-3 transient frames to prevent flicker
        if (missedFrames <= 3 && lastQuadRef.current) {
          stableFramesRef.current = Math.max(0, stableFramesRef.current - 1);
          setStabilityProgress(Math.min(1, stableFramesRef.current / 6));
        } else {
          stableFramesRef.current = 0;
          setStabilityProgress(0);
          setDetectedQuad(null);
          setEdgeConfidence(0);
          lastQuadRef.current = null;
        }
      }
    }, loopIntervalMs);

    return () => window.clearInterval(timer);
  }, [autoCapture, batchPace, cameraStatus, captureLiveVideoFrame, flashMode, phase]);

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
              const straightUrl = !isFullQuad(detected)
                ? await rectifyPageToStraightImage(dataUrl, detected, 0)
                : dataUrl;
              resolve({
                id: `pg-file-${Date.now()}-${idx}`,
                imageUrl: straightUrl,
                originalImageUrl: dataUrl,
                originalQuad: detected,
                rotation: 0,
                filter: activeFilter,
                quad: FULL_QUAD,
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

    if (retakeTargetIdx !== null && retakeTargetIdx < capturedPages.length) {
      const targetIdx = retakeTargetIdx;
      const replacement = loadedPages[0];
      setCapturedPages((prev) => prev.map((item, i) => (i === targetIdx ? replacement : item)));
      setRetakeTargetIdx(null);
      setActiveReviewIdx(targetIdx);
      setPhase('review');
      onToast(`Replaced Page ${targetIdx + 1} · Running OCR & edge detection…`);
      enrichPageWithRealOcr(replacement.id, replacement.imageUrl);
      e.target.value = '';
      return;
    }

    const next = scanMode === 'single' ? [loadedPages[0]] : [...capturedPages, ...loadedPages];
    setCapturedPages(next);
    setActiveReviewIdx(scanMode === 'single' ? 0 : Math.max(0, next.length - loadedPages.length));
    setPhase('review');
    onToast(`Added ${loadedPages.length} photo${loadedPages.length > 1 ? 's' : ''} · Running OCR & edge detection…`);

    loadedPages.forEach((pg) => enrichPageWithRealOcr(pg.id, pg.imageUrl));
    e.target.value = '';
  };

  const hasGoogleScanner =
    typeof window !== 'undefined' && typeof window.FileLensAndroid?.launchGoogleDocScanner === 'function';

  const handleGoogleDocScanner = async () => {
    const modeArg = scanMode === 'idcard' ? 'id_2in1' : scanMode === 'single' ? 'single' : 'batch';
    const dataUrls = await launchNativeGoogleDocScanner(modeArg);
    if (dataUrls.length === 0) return;

    const newPages: DocumentPage[] = dataUrls.map((url, idx) => ({
      id: `gscan-${Date.now()}-${idx}`,
      imageUrl: url,
      originalImageUrl: url,
      originalQuad: FULL_QUAD,
      quad: FULL_QUAD,
      filter: activeFilter,
      rotation: 0,
      brightness: 1,
      contrast: 1,
      ocrText: '',
      signatures: [],
    }));

    setCapturedPages((prev) => [...prev, ...newPages]);
    newPages.forEach((p) => {
      void enrichPageWithRealOcr(p.id, p.imageUrl);
    });
    onToast(`Google ML Scanner imported ${newPages.length} page${newPages.length > 1 ? 's' : ''}`);
    if (scanMode === 'single' || (scanMode === 'idcard' && newPages.length >= 2)) {
      setPhase('review');
    }
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
        fileExtension: 'pdf',
        mimeType: 'application/pdf',
        fileCategory: 'pdf',
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

  const safeReviewIdx = Math.min(activeReviewIdx, Math.max(0, capturedPages.length - 1));
  const activeReviewPage = capturedPages[safeReviewIdx] ?? null;

  const handleRotatePage = (idx: number) => {
    setCapturedPages((prev) =>
      prev.map((item, i) =>
        i === idx
          ? { ...item, rotation: (((item.rotation + 90) % 360) as 0 | 90 | 180 | 270) }
          : item
      )
    );
  };

  const handleDeletePage = (idx: number) => {
    setCapturedPages((prev) => prev.filter((_, i) => i !== idx));
    setActiveReviewIdx((curr) => {
      if (idx < curr) return curr - 1;
      if (idx === curr) return Math.max(0, curr - 1);
      return curr;
    });
  };

  const handleMoveActivePage = (direction: -1 | 1) => {
    const target = safeReviewIdx + direction;
    if (target < 0 || target >= capturedPages.length) return;
    setCapturedPages((prev) => {
      const next = [...prev];
      const [moved] = next.splice(safeReviewIdx, 1);
      next.splice(target, 0, moved);
      return next;
    });
    setActiveReviewIdx(target);
  };

  const handleOpenPreviewAt = (idx: number) => {
    setRetakeTargetIdx(null);
    setActiveReviewIdx(idx);
    setPhase('review');
  };

  if (phase === 'camera') {
    const q = detectedQuad;
    const quadPolyPoints = q
      ? `${q.tlX * 100},${q.tlY * 100} ${q.trX * 100},${q.trY * 100} ${q.brX * 100},${q.brY * 100} ${q.blX * 100},${q.blY * 100}`
      : null;

    return (
      <div
        className="fixed inset-0 h-[100dvh] max-h-[100dvh] w-full overflow-hidden z-50 flex flex-col bg-black text-white select-none"
        role="dialog"
        aria-modal="true"
        aria-label="Live Document Scanner"
      >
        {/* Top Genius Scan iOS Camera Toolbar (safe-area top protected) */}
        <div className="shrink-0 pt-safe bg-black/85 backdrop-blur-md border-b border-white/10 z-20">
          <div className="flex items-center justify-between px-2.5 sm:px-4 h-12 gap-2">
            <button
              type="button"
              onClick={() => {
                if (retakeTargetIdx !== null) {
                  setRetakeTargetIdx(null);
                  setPhase('review');
                } else {
                  onClose();
                }
              }}
              className="min-h-[40px] min-w-[40px] flex items-center justify-center text-white/90 hover:text-white rounded-lg"
              aria-label={retakeTargetIdx !== null ? 'Cancel retake' : 'Close scanner'}
            >
              <X className="w-5 h-5" />
            </button>

            {retakeTargetIdx !== null && (
              <span className="px-2.5 py-1 rounded-full bg-orange-600/90 text-white text-[11px] font-semibold whitespace-nowrap">
                Retaking Page {retakeTargetIdx + 1}
              </span>
            )}

            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() =>
                  setFlashMode((m) => (m === 'auto' ? 'on' : m === 'on' ? 'off' : 'auto'))
                }
                className={`min-h-[34px] px-2.5 rounded-full text-[11px] font-semibold flex items-center gap-1 transition-colors ${
                  effectiveFlashOn
                    ? 'bg-orange-600 text-white'
                    : flashMode === 'auto'
                      ? 'bg-amber-500/25 text-amber-200 border border-amber-400/40'
                      : 'bg-white/12 text-white/85 hover:bg-white/20'
                }`}
                title="Flash: Auto / On / Off"
              >
                {flashMode === 'off' ? (
                  <ZapOff className="w-3.5 h-3.5" />
                ) : (
                  <Zap className="w-3.5 h-3.5" />
                )}
                <span>
                  {flashMode === 'auto' ? 'Auto' : flashMode === 'on' ? 'On' : 'Off'}
                </span>
              </button>
              <button
                type="button"
                onClick={() => setAutoCapture((a) => !a)}
                className={`min-h-[34px] px-2.5 rounded-full text-[11px] font-semibold flex items-center gap-1 transition-colors ${
                  autoCapture ? 'bg-orange-600 text-white' : 'bg-white/12 text-white/85 hover:bg-white/20'
                }`}
              >
                <Sparkles className="w-3.5 h-3.5" />
                <span>{autoCapture ? 'Auto' : 'Manual'}</span>
              </button>
              {scanMode === 'batch' && (
                <button
                  type="button"
                  onClick={cycleBatchPace}
                  className="min-h-[34px] px-2.5 rounded-full text-[11px] font-semibold bg-white/12 text-white/85 hover:bg-white/20 transition-colors hidden sm:flex items-center"
                >
                  {paceLabel}
                </button>
              )}
              {hasGoogleScanner && (
                <button
                  type="button"
                  onClick={() => void handleGoogleDocScanner()}
                  className="min-h-[34px] px-2.5 rounded-full bg-orange-600 hover:bg-orange-500 text-white text-[11px] font-bold flex items-center gap-1 transition-colors shadow-sm"
                  title="Launch Google ML Kit Pro Document Scanner"
                >
                  <Sparkles className="w-3 h-3" />
                  Pro AI
                </button>
              )}
              <button
                type="button"
                onClick={() => setCameraZoom((z) => (z === 1 ? 2 : 1))}
                className={`min-h-[34px] px-2 rounded-full text-[11px] font-mono font-bold transition-colors ${
                  cameraZoom === 2
                    ? 'bg-orange-600 text-white'
                    : 'bg-white/12 text-white/85 hover:bg-white/20'
                }`}
                title="Toggle 1x / 2x zoom"
              >
                {cameraZoom}x
              </button>
              <button
                type="button"
                onClick={handleSwitchCamera}
                aria-label="Switch camera lens"
                title="Switch camera"
                className="min-h-[34px] min-w-[34px] rounded-full bg-white/12 text-white/85 hover:bg-white/20 flex items-center justify-center transition-colors"
              >
                <SwitchCamera className="w-4 h-4" />
              </button>
              <button
                type="button"
                onClick={() => triggerCameraFocus(0.5, 0.5, true)}
                aria-label="Refocus camera"
                title="Refocus camera"
                className="min-h-[34px] px-2 rounded-full flex items-center justify-center text-[11px] font-bold bg-white/10 hover:bg-white/20 text-white transition-colors"
              >
                AF
              </button>
              <button
                type="button"
                onClick={() => setShowGrid((g) => !g)}
                aria-label="Toggle composition grid"
                className={`min-h-[34px] min-w-[34px] rounded-full flex items-center justify-center transition-colors ${
                  showGrid ? 'bg-white/20 text-white' : 'bg-white/10 text-white/60'
                }`}
              >
                <Grid3X3 className="w-4 h-4" />
              </button>
            </div>
          </div>
        </div>

        {/* REAL Live Camera Viewfinder */}
        <div
          className="relative flex-1 min-h-0 overflow-hidden flex items-center justify-center bg-[#0C0C0E]"
          onClick={(e) => {
            if (cameraStatus !== 'live') return;
            const rect = e.currentTarget.getBoundingClientRect();
            const nx = (e.clientX - rect.left) / rect.width;
            const ny = (e.clientY - rect.top) / rect.height;
            triggerCameraFocus(nx, ny, true);
          }}
        >
          {/* Always mount <video> so srcObject attaches immediately when stream opens */}
          <video
            ref={videoRef}
            playsInline
            muted
            autoPlay
            style={{ transform: `scale(${cameraZoom})` }}
            className={`w-full h-full object-cover transition-transform duration-200 ${cameraStatus === 'live' ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
          />

          {/* Tap-to-Focus Reticle */}
          {focusPoint && (
            <div
              className="pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 w-16 h-16 rounded-lg border-2 border-orange-400 shadow-lg animate-ping"
              style={{ left: `${focusPoint.x}%`, top: `${focusPoint.y}%` }}
            />
          )}

          {/* 2-in-1 ID Card Alignment Guide */}
          {cameraStatus === 'live' && scanMode === 'idcard' && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-8">
              <div className="w-[min(86%,380px)] aspect-[1.586/1] rounded-2xl border-2 border-dashed border-orange-400/90 bg-orange-500/5 flex items-end justify-center pb-3">
                <span className="px-3 py-1 rounded-full bg-black/70 text-[11px] font-bold tracking-wider text-orange-300 uppercase">
                  {capturedPages.length === 0 ? 'Align Front Side' : 'Align Back Side'}
                </span>
              </div>
            </div>
          )}

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

          {/* Denied or Unavailable Real Camera Recovery UI */}
          {(cameraStatus === 'denied' || cameraStatus === 'unavailable') && (
            <div className="absolute inset-0 overflow-y-auto flex flex-col items-center justify-center gap-3.5 p-5 text-center bg-[#121215]">
              <div className="w-12 h-12 rounded-2xl bg-orange-600/20 text-orange-400 flex items-center justify-center shrink-0">
                <Camera className="w-6 h-6" />
              </div>
              <div className="space-y-1 max-w-sm">
                <h3 className="text-sm font-bold text-white">
                  {cameraStatus === 'denied' ? 'Camera Permission Needed' : 'Live Camera Stream Unavailable'}
                </h3>
                <p className="text-xs text-white/65 leading-relaxed">{cameraErrorMsg}</p>
              </div>
              <div className="flex flex-wrap items-center justify-center gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => setCameraRetryKey((k) => k + 1)}
                  className="min-h-[40px] px-3.5 rounded-xl bg-orange-600 hover:bg-orange-500 text-white text-xs font-semibold flex items-center gap-1.5"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  <span>Retry Camera</span>
                </button>
                <label
                  htmlFor="scanner-native-cam-input"
                  className="min-h-[40px] px-3.5 rounded-xl bg-white/12 hover:bg-white/20 text-white text-xs font-semibold flex items-center gap-1.5 cursor-pointer"
                >
                  <Camera className="w-3.5 h-3.5 text-orange-400" />
                  <span>Device Camera</span>
                </label>
                <label
                  htmlFor="scanner-gallery-input"
                  className="min-h-[40px] px-3.5 rounded-xl bg-white/12 hover:bg-white/20 text-white text-xs font-semibold flex items-center gap-1.5 cursor-pointer"
                >
                  <ImageIcon className="w-3.5 h-3.5" />
                  <span>Import Photos</span>
                </label>
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
                <div className="absolute inset-0 flex items-center justify-center p-6">
                  <div className="w-full max-w-md aspect-[1.586/1] border-2 border-dashed border-orange-400/90 bg-orange-500/8 rounded-xl" />
                </div>
              ) : null}

              {/* Live Scanner Guidance Pill */}
              <div className="absolute bottom-3 left-1/2 -translate-x-1/2 px-3 py-1 rounded-full bg-black/75 backdrop-blur-md text-[11px] font-medium text-white whitespace-nowrap max-w-[92%] truncate">
                {waitingPageSwap ? (
                  <span>Page captured · Turn sheet for next scan</span>
                ) : retakeTargetIdx !== null ? (
                  <span>Align Page {retakeTargetIdx + 1} to replace</span>
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

        {/* Accessible Native Camera + Gallery File Inputs (sr-only so mobile WebViews always trigger) */}
        <input
          id="scanner-native-cam-input"
          ref={nativeCameraInputRef}
          type="file"
          accept="image/*"
          capture="environment"
          className="sr-only"
          onChange={handleFileCaptureOrImport}
        />
        <input
          id="scanner-gallery-input"
          ref={galleryInputRef}
          type="file"
          accept="image/*"
          multiple={scanMode !== 'single' && retakeTargetIdx === null}
          className="sr-only"
          onChange={handleFileCaptureOrImport}
        />

        {/* Live Captured Pages Filmstrip (FileLensMobile-style immediate preview & page jump) */}
        {capturedPages.length > 0 && retakeTargetIdx === null && (
          <div className="shrink-0 bg-[#0D0D10] border-t border-white/12 px-3 py-2">
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-[11px] font-semibold text-white/80">
                Scanned ({capturedPages.length}) · Tap any page to preview
              </span>
              <button
                type="button"
                onClick={() => handleOpenPreviewAt(capturedPages.length - 1)}
                className="text-[11px] font-semibold text-orange-400 hover:text-orange-300"
              >
                Preview &amp; Save →
              </button>
            </div>
            <div className="flex items-center gap-2 overflow-x-auto no-scrollbar pb-0.5">
              {capturedPages.map((pg, idx) => {
                const isLatest = idx === capturedPages.length - 1;
                return (
                  <div
                    key={pg.id}
                    className={`relative shrink-0 w-12 h-16 rounded-lg overflow-hidden border-2 bg-zinc-900 transition-all ${
                      isLatest ? 'border-orange-500 ring-1 ring-orange-500/40' : 'border-white/20'
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => handleOpenPreviewAt(idx)}
                      aria-label={`Preview scanned page ${idx + 1}`}
                      className="w-full h-full block"
                    >
                      <PageCanvasPreview page={pg} className="w-full h-full" />
                    </button>
                    <span className="pointer-events-none absolute bottom-0.5 left-0.5 px-1 rounded bg-black/75 text-[9px] font-mono font-bold text-white">
                      {idx + 1}
                    </span>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDeletePage(idx);
                      }}
                      aria-label={`Remove page ${idx + 1}`}
                      className="absolute top-0.5 right-0.5 w-4 h-4 rounded-full bg-black/75 text-white/90 hover:bg-red-600 flex items-center justify-center"
                    >
                      <X className="w-2.5 h-2.5" />
                    </button>
                  </div>
                );
              })}
              <div ref={cameraStripEndRef} className="w-1 shrink-0" />
            </div>
          </div>
        )}

        {/* Bottom Genius Scan Capture Dock (compact for small screens) */}
        <div className="bg-black/95 border-t border-white/10 px-3 pt-2 pb-safe space-y-2 shrink-0">
          {!isAppendMode && retakeTargetIdx === null && (
            <div className="flex items-center justify-center gap-5 text-xs font-semibold">
              {(
                [
                  { id: 'single', label: 'Single' },
                  { id: 'batch', label: 'Batch' },
                  { id: 'idcard', label: '2-in-1 ID' },
                ] as const
              ).map((m) => (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => setScanMode(m.id)}
                  className={`py-0.5 px-2 transition-colors ${
                    scanMode === m.id ? 'text-orange-400' : 'text-white/55 hover:text-white/80'
                  }`}
                >
                  {m.label}
                </button>
              ))}
            </div>
          )}

          {/* Shutter Row */}
          <div className="max-w-md mx-auto flex items-center justify-between px-3 pb-1.5">
            {/* Import Real Photos */}
            <label
              htmlFor="scanner-gallery-input"
              className="flex flex-col items-center gap-1 min-w-[58px] text-white/80 hover:text-white transition-colors cursor-pointer"
            >
              <span className="w-10 h-10 rounded-xl bg-white/12 flex items-center justify-center">
                <ImageIcon className="w-4 h-4" />
              </span>
              <span className="text-[10px] font-medium">Photos</span>
            </label>

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
              className="relative w-[70px] h-[70px] rounded-full flex items-center justify-center active:scale-95 transition-transform"
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
              <span className="w-[52px] h-[52px] rounded-full bg-orange-600 hover:bg-orange-500 transition-colors flex items-center justify-center">
                <Camera className="w-5 h-5 text-white" />
              </span>
            </button>

            {/* Captured Stack Preview & Review */}
            <button
              type="button"
              disabled={capturedPages.length === 0}
              onClick={() => handleOpenPreviewAt(capturedPages.length - 1)}
              className="flex flex-col items-center gap-1 min-w-[58px] disabled:opacity-35 transition-opacity"
            >
              <div className="relative w-10 h-10 rounded-xl overflow-hidden bg-white/15 border border-white/25 flex items-center justify-center">
                {capturedPages.length > 0 ? (
                  <>
                    <img
                      src={capturedPages[capturedPages.length - 1].imageUrl}
                      alt="Last scanned page"
                      className="w-full h-full object-cover"
                    />
                    <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 rounded-full bg-orange-600 text-white text-[10px] font-mono font-bold flex items-center justify-center">
                      {capturedPages.length}
                    </span>
                  </>
                ) : (
                  <Check className="w-4 h-4 text-white/50" />
                )}
              </div>
              <span className="text-[10px] font-semibold text-orange-400">
                {capturedPages.length > 0 ? `Preview (${capturedPages.length})` : 'Preview'}
              </span>
            </button>
          </div>
        </div>
      </div>
    );
  }

  /* PHASE 2: POST-CAPTURE LARGE PREVIEW, PAGE NAVIGATION, REAL OCR SMART NAMING & SAVE SHEET */
  return (
    <div
      className="fixed inset-0 h-[100dvh] max-h-[100dvh] w-full overflow-hidden z-50 flex flex-col bg-[#F2F2F7] dark:bg-[#000000] text-slate-900 dark:text-slate-100"
      role="dialog"
      aria-modal="true"
      aria-label="Review Scanned Document"
    >
      {/* Top Safe-Area Header */}
      <header className="shrink-0 z-20 pt-safe bg-white/95 dark:bg-[#1C1C1E]/95 backdrop-blur-md border-b border-slate-200 dark:border-white/10">
        <div className="px-3 sm:px-5 h-12 flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={() => {
              setRetakeTargetIdx(null);
              setPhase('camera');
            }}
            className="min-h-[38px] px-2 flex items-center gap-1 text-xs sm:text-sm font-semibold text-orange-600 dark:text-orange-400 whitespace-nowrap"
          >
            <Plus className="w-4 h-4" />
            <span>Add Page</span>
          </button>
          <div className="text-center min-w-0">
            <h2 className="text-xs sm:text-sm font-bold truncate">
              {isAppendMode ? `Append to ${appendTargetTitle}` : 'Preview & Save Scan'}
            </h2>
            <p className="text-[10px] sm:text-[11px] text-slate-500 dark:text-slate-400 font-mono tabular-nums">
              Page {safeReviewIdx + 1} of {capturedPages.length}
              {ocrInFlightCount > 0 ? ` · OCR (${ocrInFlightCount})…` : ''}
            </p>
          </div>
          <button
            type="button"
            onClick={handleSaveScan}
            disabled={isSaving || capturedPages.length === 0}
            className="min-h-[36px] px-3 sm:px-4 rounded-xl bg-orange-600 hover:bg-orange-700 text-white text-xs sm:text-sm font-semibold flex items-center gap-1 disabled:opacity-50 transition-colors whitespace-nowrap"
          >
            <Check className="w-4 h-4" />
            <span>{isSaving ? 'Saving…' : isAppendMode ? 'Append' : 'Save PDF'}</span>
          </button>
        </div>
      </header>

      <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain px-3 sm:px-6 py-3 pb-safe">
        <div className="max-w-5xl mx-auto grid grid-cols-1 lg:grid-cols-12 gap-4">
          {/* Left / Top: Large Captured-Page Preview + Multi-Page Navigation + Filter Strip */}
          <div className="lg:col-span-7 space-y-3">
            {/* Large Full-Page Preview Stage with Prev/Next & Swipe Navigation */}
            {activeReviewPage && (
              <div className="bg-[#121215] rounded-2xl border border-slate-200/80 dark:border-white/10 overflow-hidden shadow-sm">
                {/* Page Navigation Bar */}
                <div className="flex items-center justify-between px-2.5 py-1.5 bg-black/55 border-b border-white/10 text-white">
                  <button
                    type="button"
                    disabled={safeReviewIdx <= 0}
                    onClick={() => setActiveReviewIdx((i) => Math.max(0, i - 1))}
                    aria-label="Previous scanned page"
                    className="h-8 px-2 rounded-lg flex items-center gap-1 text-xs font-semibold bg-white/10 hover:bg-white/20 disabled:opacity-30 transition-colors"
                  >
                    <ChevronLeft className="w-4 h-4" />
                    <span className="hidden xs:inline">Prev</span>
                  </button>

                  <div className="flex items-center gap-2 text-xs font-mono font-semibold tabular-nums">
                    <span>
                      Page {safeReviewIdx + 1} / {capturedPages.length}
                    </span>
                    {activeReviewPage.ocrText ? (
                      <span className="px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300 text-[10px] font-sans font-semibold">
                        OCR ready
                      </span>
                    ) : ocrInFlightCount > 0 ? (
                      <span className="px-1.5 py-0.5 rounded bg-orange-500/20 text-orange-300 text-[10px] font-sans font-semibold">
                        OCR…
                      </span>
                    ) : null}
                  </div>

                  <button
                    type="button"
                    disabled={safeReviewIdx >= capturedPages.length - 1}
                    onClick={() =>
                      setActiveReviewIdx((i) => Math.min(capturedPages.length - 1, i + 1))
                    }
                    aria-label="Next scanned page"
                    className="h-8 px-2 rounded-lg flex items-center gap-1 text-xs font-semibold bg-white/10 hover:bg-white/20 disabled:opacity-30 transition-colors"
                  >
                    <span className="hidden xs:inline">Next</span>
                    <ChevronRight className="w-4 h-4" />
                  </button>
                </div>

                {/* Large Preview Canvas with Swipe Support */}
                <div
                  className="relative h-[38dvh] sm:h-[46dvh] min-h-[220px] max-h-[480px] w-full p-2.5 sm:p-4 flex items-center justify-center bg-[#0B0B0D] touch-pan-y select-none"
                  onTouchStart={(e) => {
                    touchStartXRef.current = e.touches[0]?.clientX ?? null;
                  }}
                  onTouchEnd={(e) => {
                    if (touchStartXRef.current === null) return;
                    const endX = e.changedTouches[0]?.clientX ?? touchStartXRef.current;
                    const dx = endX - touchStartXRef.current;
                    touchStartXRef.current = null;
                    if (Math.abs(dx) >= 42) {
                      if (dx < 0 && safeReviewIdx < capturedPages.length - 1) {
                        setActiveReviewIdx((i) => Math.min(capturedPages.length - 1, i + 1));
                      } else if (dx > 0 && safeReviewIdx > 0) {
                        setActiveReviewIdx((i) => Math.max(0, i - 1));
                      }
                    }
                  }}
                >
                  <PageCanvasPreview
                    key={`${activeReviewPage.id}-${activeReviewPage.rotation}-${activeReviewPage.filter}`}
                    page={activeReviewPage}
                    className="w-full h-full rounded-lg shadow-xl"
                  />

                  {/* Quick overlay side arrows when multiple pages exist */}
                  {capturedPages.length > 1 && safeReviewIdx > 0 && (
                    <button
                      type="button"
                      onClick={() => setActiveReviewIdx((i) => Math.max(0, i - 1))}
                      aria-label="Previous page"
                      className="absolute left-2 top-1/2 -translate-y-1/2 w-8 h-8 rounded-full bg-black/60 hover:bg-black/80 text-white flex items-center justify-center backdrop-blur-xs"
                    >
                      <ChevronLeft className="w-5 h-5" />
                    </button>
                  )}
                  {capturedPages.length > 1 && safeReviewIdx < capturedPages.length - 1 && (
                    <button
                      type="button"
                      onClick={() =>
                        setActiveReviewIdx((i) => Math.min(capturedPages.length - 1, i + 1))
                      }
                      aria-label="Next page"
                      className="absolute right-2 top-1/2 -translate-y-1/2 w-8 h-8 rounded-full bg-black/60 hover:bg-black/80 text-white flex items-center justify-center backdrop-blur-xs"
                    >
                      <ChevronRight className="w-5 h-5" />
                    </button>
                  )}
                </div>

                {/* Per-Page Action Toolbar */}
                <div className="bg-white dark:bg-[#1C1C1E] border-t border-slate-200/80 dark:border-white/10 px-1.5 py-1.5 flex items-center justify-around gap-1">
                  <button
                    type="button"
                    onClick={() => setEditingPageIdx(safeReviewIdx)}
                    className="flex-1 min-h-[38px] rounded-xl flex flex-col sm:flex-row items-center justify-center gap-0.5 sm:gap-1.5 text-[11px] font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-white/10"
                  >
                    <Crop className="w-4 h-4 text-orange-600" />
                    <span>Crop</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => handleRotatePage(safeReviewIdx)}
                    className="flex-1 min-h-[38px] rounded-xl flex flex-col sm:flex-row items-center justify-center gap-0.5 sm:gap-1.5 text-[11px] font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-white/10"
                  >
                    <RotateCw className="w-4 h-4 text-orange-600" />
                    <span>Rotate</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setRetakeTargetIdx(safeReviewIdx);
                      setPhase('camera');
                    }}
                    className="flex-1 min-h-[38px] rounded-xl flex flex-col sm:flex-row items-center justify-center gap-0.5 sm:gap-1.5 text-[11px] font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-white/10"
                  >
                    <Camera className="w-4 h-4 text-orange-600" />
                    <span>Retake</span>
                  </button>
                  {capturedPages.length > 1 && (
                    <div className="flex items-center gap-0.5 shrink-0">
                      <button
                        type="button"
                        disabled={safeReviewIdx === 0}
                        onClick={() => handleMoveActivePage(-1)}
                        title="Move page earlier"
                        aria-label="Move page earlier"
                        className="w-8 h-9 rounded-lg flex items-center justify-center text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-white/10 disabled:opacity-30"
                      >
                        <ArrowLeft className="w-4 h-4" />
                      </button>
                      <button
                        type="button"
                        disabled={safeReviewIdx >= capturedPages.length - 1}
                        onClick={() => handleMoveActivePage(1)}
                        title="Move page later"
                        aria-label="Move page later"
                        className="w-8 h-9 rounded-lg flex items-center justify-center text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-white/10 disabled:opacity-30"
                      >
                        <ArrowRight className="w-4 h-4" />
                      </button>
                    </div>
                  )}
                  <button
                    type="button"
                    onClick={() => handleDeletePage(safeReviewIdx)}
                    className="flex-1 min-h-[38px] rounded-xl flex flex-col sm:flex-row items-center justify-center gap-0.5 sm:gap-1.5 text-[11px] font-semibold text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30"
                  >
                    <Trash2 className="w-4 h-4" />
                    <span>Delete</span>
                  </button>
                </div>
              </div>
            )}

            {/* Scanned Pages Navigation Filmstrip (tap any page to switch preview, or + Scan) */}
            <div className="bg-white dark:bg-[#1C1C1E] rounded-2xl p-2.5 sm:p-3 border border-slate-200/80 dark:border-white/10 space-y-2">
              <div className="flex items-center justify-between px-0.5">
                <span className="text-xs font-semibold text-slate-700 dark:text-slate-200">
                  Scanned Pages ({capturedPages.length})
                </span>
                <span className="text-[11px] text-slate-500 dark:text-slate-400">
                  Swipe preview or tap page
                </span>
              </div>
              <div className="flex items-center gap-2 overflow-x-auto no-scrollbar pb-0.5">
                {capturedPages.map((pg, idx) => {
                  const isActive = idx === safeReviewIdx;
                  return (
                    <button
                      key={pg.id}
                      ref={isActive ? activeThumbRef : undefined}
                      type="button"
                      onClick={() => setActiveReviewIdx(idx)}
                      aria-label={`Select page ${idx + 1}`}
                      className={`relative shrink-0 w-14 h-[74px] rounded-xl overflow-hidden border-2 bg-slate-100 dark:bg-[#121214] p-0.5 transition-all ${
                        isActive
                          ? 'border-orange-600 ring-2 ring-orange-500/25 scale-[1.03]'
                          : 'border-slate-200 dark:border-white/15 opacity-80 hover:opacity-100'
                      }`}
                    >
                      <PageCanvasPreview page={pg} className="w-full h-full rounded-md" />
                      <span
                        className={`absolute bottom-1 left-1 px-1.5 py-0.2 rounded text-[10px] font-mono font-bold ${
                          isActive
                            ? 'bg-orange-600 text-white'
                            : 'bg-black/70 text-white'
                        }`}
                      >
                        P{idx + 1}
                      </span>
                    </button>
                  );
                })}
                <button
                  type="button"
                  onClick={() => {
                    setRetakeTargetIdx(null);
                    setPhase('camera');
                  }}
                  className="shrink-0 w-14 h-[74px] rounded-xl border-2 border-dashed border-slate-300 dark:border-white/20 flex flex-col items-center justify-center gap-1 text-slate-500 dark:text-slate-400 hover:border-orange-500 hover:text-orange-600 transition-colors"
                >
                  <Plus className="w-4 h-4" />
                  <span className="text-[10px] font-semibold">Scan</span>
                </button>
              </div>
            </div>

            {/* Enhancement Filter Strip */}
            <div className="bg-white dark:bg-[#1C1C1E] rounded-2xl p-3 border border-slate-200/80 dark:border-white/10 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-slate-700 dark:text-slate-200 flex items-center gap-1.5">
                  <Sliders className="w-3.5 h-3.5 text-orange-600" />
                  <span>Enhancement Filter</span>
                </span>
                <span className="text-[11px] text-slate-500 dark:text-slate-400">
                  Applies across all pages
                </span>
              </div>
              <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar pb-0.5">
                {SCAN_FILTERS.map((f) => (
                  <button
                    key={f.id}
                    type="button"
                    onClick={() => handleApplyGlobalFilter(f.id)}
                    className={`min-h-[34px] px-3 rounded-xl text-xs font-semibold transition-colors whitespace-nowrap shrink-0 ${
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
