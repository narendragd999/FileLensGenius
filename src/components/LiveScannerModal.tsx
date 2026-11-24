import React, { useEffect, useRef, useState } from 'react';
import {
  Camera,
  Check,
  Crop,
  Grid3X3,
  Image as ImageIcon,
  Lock,
  RotateCw,
  Sliders,
  Sparkles,
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
  PdfPageSizePreset,
  PdfQualityPreset,
  ScanDocument,
  ScanFilterId,
  ScanMode,
  SmartCardCategory,
} from '../types/filelens';
import {
  ASSET_IMAGES,
  NAMING_TEMPLATES,
  SCAN_FILTERS,
  SMART_CARD_CATEGORIES,
} from '../data/seedData';
import { resolveNamingTemplate } from '../utils/formatters';
import { composeTwoInOneA4IdCard } from '../utils/pdfExport';
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

const DEMO_CAPTURE_SAMPLES = [
  {
    url: ASSET_IMAGES.contract,
    label: 'Service Agreement',
    ocr: 'SERVICE AGREEMENT. Between Apex Solutions Inc. and Quantum Dynamics LLC. Fees & Payment $15,000. Signed Jonathan Chen.',
  },
  {
    url: ASSET_IMAGES.invoice,
    label: 'Studio Invoice',
    ocr: 'NOVA DESIGN STUDIO INVOICE #NDS-1089. Total Due $13,504.19 USD. PAID.',
  },
  {
    url: ASSET_IMAGES.medical,
    label: 'Clinic Lab Report',
    ocr: 'CITYWAY WELLNESS CLINIC PATIENT LAB REPORT. Complete Blood Count, Metabolic Panel, Lipid Panel.',
  },
  {
    url: ASSET_IMAGES.whiteboard,
    label: 'Architecture Whiteboard',
    ocr: 'PRODUCT ARCHITECTURE FLOW. API Gateway, Microservices, Q4 2024 Timeline.',
  },
  {
    url: ASSET_IMAGES.idCard,
    label: 'Identification Card',
    ocr: 'SPECIMEN IDENTIFICATION CARD. Member ID 123456789. Alexa R. Chen. Membership Pass.',
  },
];

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
  const [cameraActive, setCameraActive] = useState<boolean>(false);
  const [demoSampleIdx, setDemoSampleIdx] = useState<number>(initialMode === 'idcard' ? 4 : 0);
  const [shutterFlash, setShutterFlash] = useState<boolean>(false);
  const [quadConfidence, setQuadConfidence] = useState<'searching' | 'locked'>('locked');
  const [capturedPages, setCapturedPages] = useState<DocumentPage[]>([]);

  // Review & Save state
  const [docTitle, setDocTitle] = useState<string>(() =>
    initialMode === 'idcard'
      ? resolveNamingTemplate('ID_Card_{YYYY}-{MM}-{DD}', nextSequenceNumber)
      : resolveNamingTemplate(preferences.namingTemplate, nextSequenceNumber)
  );
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
  const galleryInputRef = useRef<HTMLInputElement | null>(null);

  // Attempt live camera access gracefully
  useEffect(() => {
    if (phase !== 'camera') return;
    let cancelled = false;

    async function initCamera() {
      if (!navigator.mediaDevices?.getUserMedia) {
        setCameraActive(false);
        return;
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
          audio: false,
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play().catch(() => {});
        }
        setCameraActive(true);
      } catch {
        setCameraActive(false);
      }
    }

    initCamera();
    return () => {
      cancelled = true;
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
      }
    };
  }, [phase]);

  // Subtle realistic document edge tracking pulse
  useEffect(() => {
    if (phase !== 'camera') return;
    const timer = window.setInterval(() => {
      setQuadConfidence((prev) => (prev === 'locked' ? 'locked' : 'locked'));
    }, 2400);
    return () => window.clearInterval(timer);
  }, [phase]);

  const triggerCapture = () => {
    setShutterFlash(true);
    setTimeout(() => setShutterFlash(false), 160);

    let capturedUrl = DEMO_CAPTURE_SAMPLES[demoSampleIdx].url;
    let capturedOcr = DEMO_CAPTURE_SAMPLES[demoSampleIdx].ocr;

    if (cameraActive && videoRef.current && videoRef.current.videoWidth > 0) {
      const canvas = document.createElement('canvas');
      canvas.width = videoRef.current.videoWidth;
      canvas.height = videoRef.current.videoHeight;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.drawImage(videoRef.current, 0, 0);
        capturedUrl = canvas.toDataURL('image/jpeg', 0.9);
        capturedOcr = `Captured live camera scan on ${new Date().toLocaleDateString()} via FileLens Scanner.`;
      }
    } else {
      // Advance demo desk page automatically so batch scans capture distinct sheets
      setDemoSampleIdx((i) => (i + 1) % DEMO_CAPTURE_SAMPLES.length);
    }

    const newPage: DocumentPage = {
      id: `pg-scan-${Date.now()}-${capturedPages.length}`,
      imageUrl: capturedUrl,
      rotation: 0,
      filter: activeFilter,
      quad: FULL_QUAD,
      brightness: 1,
      contrast: 1,
      ocrText: capturedOcr,
      signatures: [],
    };

    const nextPages = scanMode === 'single' ? [newPage] : [...capturedPages, newPage];
    setCapturedPages(nextPages);

    if (scanMode === 'single') {
      setPhase('review');
    } else if (scanMode === 'idcard' && nextPages.length >= 2) {
      onToast('Captured Front & Back · Ready for 2-in-1 A4 composite');
      setPhase('review');
    } else {
      onToast(`Captured Page ${nextPages.length}`);
    }
  };

  const handleGalleryUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    const promises = Array.from(files).map(
      (file, idx) =>
        new Promise<DocumentPage>((resolve) => {
          const reader = new FileReader();
          reader.onload = () => {
            resolve({
              id: `pg-upload-${Date.now()}-${idx}`,
              imageUrl: String(reader.result),
              rotation: 0,
              filter: activeFilter,
              quad: FULL_QUAD,
              brightness: 1,
              contrast: 1,
              ocrText: `Imported document image "${file.name}" scanned with FileLens.`,
              signatures: [],
            });
          };
          reader.readAsDataURL(file);
        })
    );

    Promise.all(promises).then((pages) => {
      const next = scanMode === 'single' ? [pages[0]] : [...capturedPages, ...pages];
      setCapturedPages(next);
      setPhase('review');
      onToast(`Imported ${pages.length} photo${pages.length > 1 ? 's' : ''}`);
    });
    e.target.value = '';
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
            ocrText: `${capturedPages[0].ocrText}\n${capturedPages[1].ocrText}`,
            signatures: [],
          },
        ];
      }

      if (isAppendMode) {
        onCompleteAppendPages(finalPages);
        return;
      }

      const tags = tagInput
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean);

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
        cardCategory: saveAsSmartCard ? cardCategory : undefined,
        passwordProtected: passwordProtect,
        pageSizePreset,
        qualityPreset,
        sizeBytes: Math.round(finalPages.length * (qualityPreset === 'high' ? 620_000 : qualityPreset === 'compact' ? 210_000 : 390_000)),
        searchableOcr,
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
    const activeDemo = DEMO_CAPTURE_SAMPLES[demoSampleIdx];

    return (
      <div
        className="fixed inset-0 z-50 flex flex-col bg-black text-white select-none"
        role="dialog"
        aria-modal="true"
        aria-label="Document Scanner"
      >
        {/* Top Genius Scan iOS Camera Toolbar */}
        <div className="flex items-center justify-between px-4 h-14 bg-black/80 backdrop-blur-md border-b border-white/10 z-20 shrink-0">
          <button
            onClick={onClose}
            className="min-h-[44px] min-w-[44px] flex items-center justify-center text-white/90 hover:text-white"
            aria-label="Close scanner"
          >
            <X className="w-6 h-6" />
          </button>

          <div className="flex items-center gap-2">
            <button
              onClick={() => setFlashOn((f) => !f)}
              className={`min-h-[38px] px-3 rounded-full text-xs font-semibold flex items-center gap-1.5 transition-colors ${
                flashOn ? 'bg-orange-600 text-white' : 'bg-white/12 text-white/85 hover:bg-white/20'
              }`}
            >
              {flashOn ? <Zap className="w-3.5 h-3.5" /> : <ZapOff className="w-3.5 h-3.5" />}
              <span>{flashOn ? 'Flash On' : 'Flash'}</span>
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

        {/* Live Viewfinder Area */}
        <div className="relative flex-1 overflow-hidden flex items-center justify-center bg-[#141416]">
          {cameraActive ? (
            <video
              ref={videoRef}
              playsInline
              muted
              className="w-full h-full object-cover"
            />
          ) : (
            /* Desk Preview Viewfinder when browser camera is unavailable */
            <div className="relative w-full h-full flex items-center justify-center bg-gradient-to-b from-[#1E1E22] to-[#121214] p-8 sm:p-12">
              <div className="relative h-full max-h-[560px] aspect-[3/4] rounded-md shadow-2xl overflow-hidden bg-white">
                <img
                  src={activeDemo.url}
                  alt={activeDemo.label}
                  referrerPolicy="no-referrer"
                  className="w-full h-full object-cover"
                />
              </div>
              <div className="absolute top-4 left-1/2 -translate-x-1/2 px-3.5 py-1.5 rounded-full bg-black/70 backdrop-blur-md text-xs text-white/90 flex items-center gap-2 whitespace-nowrap">
                <span>Desk Preview · {activeDemo.label}</span>
                <button
                  type="button"
                  onClick={() => setDemoSampleIdx((i) => (i + 1) % DEMO_CAPTURE_SAMPLES.length)}
                  className="text-orange-400 font-semibold hover:text-orange-300"
                >
                  Next Sheet
                </button>
              </div>
            </div>
          )}

          {/* Composition Rule-of-Thirds Grid */}
          {showGrid && (
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

          {/* Genius Scan Signature Translucent Orange Document Boundary Quad */}
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-10 sm:p-16">
            <div className="relative h-full max-h-[540px] aspect-[3/4] border-2 border-orange-500 bg-orange-500/10 rounded-sm transition-all duration-300">
              <span className="absolute -top-1.5 -left-1.5 w-4 h-4 border-t-3 border-l-3 border-orange-400" />
              <span className="absolute -top-1.5 -right-1.5 w-4 h-4 border-t-3 border-r-3 border-orange-400" />
              <span className="absolute -bottom-1.5 -left-1.5 w-4 h-4 border-b-3 border-l-3 border-orange-400" />
              <span className="absolute -bottom-1.5 -right-1.5 w-4 h-4 border-b-3 border-r-3 border-orange-400" />

              <div className="absolute bottom-3 left-1/2 -translate-x-1/2 px-3 py-1 rounded-full bg-black/75 text-[11px] font-medium text-white whitespace-nowrap">
                {scanMode === 'idcard'
                  ? capturedPages.length === 0
                    ? 'Align Front of ID Card'
                    : 'Flip & Align Back of ID Card'
                  : quadConfidence === 'locked'
                  ? 'Document detected · Tap shutter to scan'
                  : 'Align document inside frame'}
              </div>
            </div>
          </div>

          {/* Shutter Flash Feedback */}
          {shutterFlash && <div className="pointer-events-none absolute inset-0 bg-white/80 z-30" />}
        </div>

        {/* Bottom Genius Scan Capture Dock */}
        <div className="bg-black/95 border-t border-white/10 px-4 pt-3 pb-safe space-y-4 shrink-0">
          {/* Scan Mode Selector */}
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
            {/* Import From Photos */}
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
            <input
              ref={galleryInputRef}
              type="file"
              accept="image/*"
              multiple={scanMode !== 'single'}
              className="hidden"
              onChange={handleGalleryUpload}
            />

            {/* Signature iOS Concentric Orange Shutter Button */}
            <button
              type="button"
              onClick={triggerCapture}
              aria-label="Capture document page"
              className="w-[74px] h-[74px] rounded-full border-4 border-white flex items-center justify-center active:scale-95 transition-transform"
            >
              <span className="w-[58px] h-[58px] rounded-full bg-orange-600 hover:bg-orange-500 transition-colors flex items-center justify-center">
                <Camera className="w-6 h-6 text-white" />
              </span>
            </button>

            {/* Captured Stack Preview & Next Button */}
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

  /* PHASE 2: POST-CAPTURE REVIEW, FILTER & SAVE SHEET */
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
            {/* Global Filter Strip */}
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

            {/* Page Cards */}
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
                      P{idx + 1}
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

          {/* Right: Genius Scan Naming, Folder, PDF Settings */}
          {!isAppendMode && (
            <div className="lg:col-span-5 space-y-4">
              <div className="bg-white dark:bg-[#1C1C1E] rounded-2xl p-4 sm:p-5 border border-slate-200/80 dark:border-white/10 space-y-4">
                <div>
                  <label className="block text-xs font-semibold text-slate-600 dark:text-slate-300 mb-1.5">
                    Document Title
                  </label>
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
                      Tags (comma separated)
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

                {/* Page Size & Quality Segmented Controls */}
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

                {/* Smart Toggles */}
                <div className="space-y-3 pt-2 border-t border-slate-100 dark:border-white/8">
                  <label className="flex items-center justify-between gap-3 cursor-pointer">
                    <div>
                      <div className="text-sm font-medium">Searchable OCR Text Layer</div>
                      <div className="text-xs text-slate-500 dark:text-slate-400">
                        Index words for instant full-text search
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
