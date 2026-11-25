import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Bookmark,
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  Droplets,
  FileText,
  Image as ImageIcon,
  Layers,
  PenTool,
  Search,
  ShieldCheck,
  Trash2,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import {
  PlacedSignature,
  SavedSignature,
  ScanDocument,
  WatermarkConfig,
} from '../types/filelens';
import { formatBytes, triggerFileDownload } from '../utils/formatters';
import {
  exportDocumentAsPdf,
  exportSinglePageAsJpeg,
  redactSensitiveInfoForSharing,
} from '../utils/pdfExport';
import { extractSmartData } from '../utils/temporalExtractor';
import { PageCanvasPreview } from './PageCanvasPreview';

interface PdfViewerModalProps {
  document: ScanDocument;
  initialPageIndex?: number;
  savedSignatures: SavedSignature[];
  onSaveSignature: (sig: SavedSignature) => void;
  onDeleteSavedSignature: (id: string) => void;
  onUpdateDocument: (updated: ScanDocument) => void;
  onOpenOrganizer: () => void;
  onClose: () => void;
  onToast: (message: string) => void;
}

export const PdfViewerModal: React.FC<PdfViewerModalProps> = ({
  document: doc,
  initialPageIndex = 0,
  savedSignatures,
  onSaveSignature,
  onDeleteSavedSignature,
  onUpdateDocument,
  onOpenOrganizer,
  onClose,
  onToast,
}) => {
  const [currentIdx, setCurrentIdx] = useState<number>(
    Math.max(0, Math.min(initialPageIndex, doc.pages.length - 1))
  );
  const [zoom, setZoom] = useState<number>(1);
  const [showFindBar, setShowFindBar] = useState<boolean>(false);
  const [findQuery, setFindQuery] = useState<string>('');
  const [showOcrDrawer, setShowOcrDrawer] = useState<boolean>(false);
  const [drawerTab, setDrawerTab] = useState<'ocr' | 'smart_data'>('ocr');
  const [showWatermarkModal, setShowWatermarkModal] = useState<boolean>(false);
  const [showSignatureModal, setShowSignatureModal] = useState<boolean>(false);
  const [showExportSheet, setShowExportSheet] = useState<boolean>(false);
  const [pdfPasswordInput, setPdfPasswordInput] = useState<string>('');
  const [isExporting, setIsExporting] = useState<boolean>(false);

  // Watermark editor state
  const [wmText, setWmText] = useState<string>(doc.watermark?.text ?? 'CONFIDENTIAL');
  const [wmColor, setWmColor] = useState<string>(doc.watermark?.color ?? '#DC2626');
  const [wmOpacity, setWmOpacity] = useState<number>(doc.watermark?.opacity ?? 0.22);

  // Signature pad state
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const isDrawingRef = useRef<boolean>(false);
  const [sigColor, setSigColor] = useState<string>('#1D4ED8');
  const [sigDateStamp, setSigDateStamp] = useState<boolean>(true);
  const [sigPosX, setSigPosX] = useState<number>(0.55);
  const [sigPosY, setSigPosY] = useState<number>(0.76);
  const [sigWidth, setSigWidth] = useState<number>(0.3);
  const [hasDrawnInk, setHasDrawnInk] = useState<boolean>(false);

  const safeIdx = Math.max(0, Math.min(currentIdx, Math.max(0, doc.pages.length - 1)));
  const currentPage = doc.pages[safeIdx];
  const touchStartXRef = useRef<number | null>(null);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') setCurrentIdx((i) => Math.max(0, i - 1));
      else if (e.key === 'ArrowRight') setCurrentIdx((i) => Math.min(doc.pages.length - 1, i + 1));
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [doc.pages.length]);

  const matchingPageIndices = useMemo(() => {
    const q = findQuery.trim().toLowerCase();
    if (!q) return [];
    return doc.pages
      .map((p, idx) => (p.ocrText.toLowerCase().includes(q) ? idx : -1))
      .filter((i) => i !== -1);
  }, [doc.pages, findQuery]);

  const handleToggleBookmark = () => {
    onUpdateDocument({ ...doc, isBookmarked: !doc.isBookmarked });
    onToast(doc.isBookmarked ? 'Removed bookmark' : 'Bookmarked document');
  };

  const handleApplyWatermark = () => {
    const cleaned = wmText.trim();
    const watermark: WatermarkConfig | null = cleaned
      ? { text: cleaned, color: wmColor, opacity: wmOpacity }
      : null;
    onUpdateDocument({ ...doc, watermark, updatedAt: new Date().toISOString() });
    setShowWatermarkModal(false);
    onToast(watermark ? `Applied "${cleaned}" watermark` : 'Removed watermark');
  };

  const handleClearWatermark = () => {
    onUpdateDocument({ ...doc, watermark: null, updatedAt: new Date().toISOString() });
    setShowWatermarkModal(false);
    onToast('Removed document watermark');
  };

  // Signature canvas pointer handlers
  const getCanvasCoords = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * canvas.width,
      y: ((e.clientY - rect.top) / rect.height) * canvas.height,
    };
  };

  const handleSigPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.setPointerCapture(e.pointerId);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const { x, y } = getCanvasCoords(e);
    ctx.strokeStyle = sigColor;
    ctx.lineWidth = 3.2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(x, y);
    isDrawingRef.current = true;
    setHasDrawnInk(true);
  };

  const handleSigPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!isDrawingRef.current || !canvasRef.current) return;
    const ctx = canvasRef.current.getContext('2d');
    if (!ctx) return;
    const { x, y } = getCanvasCoords(e);
    ctx.lineTo(x, y);
    ctx.stroke();
  };

  const handleSigPointerUp = () => {
    isDrawingRef.current = false;
  };

  const clearSignatureCanvas = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
    setHasDrawnInk(false);
  };

  const placeSignatureOnPage = (dataUrl: string, saveToLibrary: boolean) => {
    if (!currentPage) return;
    const newPlacement: PlacedSignature = {
      id: `sig-${Date.now()}`,
      dataUrl,
      posX: sigPosX,
      posY: sigPosY,
      widthFraction: sigWidth,
      includeDateStamp: sigDateStamp,
      dateLabel: new Date().toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      }),
    };

    if (saveToLibrary) {
      onSaveSignature({
        id: `saved-sig-${Date.now()}`,
        name: `Signature ${savedSignatures.length + 1}`,
        dataUrl,
        createdAt: new Date().toISOString(),
      });
    }

    const updatedPages = doc.pages.map((p, idx) =>
      idx === safeIdx ? { ...p, signatures: [...p.signatures, newPlacement] } : p
    );
    onUpdateDocument({ ...doc, pages: updatedPages, updatedAt: new Date().toISOString() });
    setShowSignatureModal(false);
    setHasDrawnInk(false);
    onToast(`Placed e-signature on Page ${safeIdx + 1}`);
  };

  const handleClearPageSignatures = () => {
    if (!currentPage || currentPage.signatures.length === 0) return;
    const updatedPages = doc.pages.map((p, idx) =>
      idx === safeIdx ? { ...p, signatures: [] } : p
    );
    onUpdateDocument({ ...doc, pages: updatedPages, updatedAt: new Date().toISOString() });
    onToast(`Cleared signatures on Page ${safeIdx + 1}`);
  };

  const smartData = useMemo(
    () => extractSmartData(doc.pages.map((p) => p.ocrText).join('\n')),
    [doc.pages]
  );

  const handleExportPdf = async () => {
    setIsExporting(true);
    try {
      await exportDocumentAsPdf(doc, doc.passwordProtected ? pdfPasswordInput : undefined);
      onToast(
        doc.passwordProtected && pdfPasswordInput.trim()
          ? `Downloaded encrypted "${doc.title}.pdf"`
          : `Downloaded "${doc.title}.pdf"`
      );
      setShowExportSheet(false);
    } catch {
      onToast('Export failed');
    } finally {
      setIsExporting(false);
    }
  };

  const handleMaskAndShare = async () => {
    if (!currentPage) return;
    setIsExporting(true);
    try {
      const { redactedDataUrl, redactedCount } = await redactSensitiveInfoForSharing(
        currentPage.imageUrl
      );
      const res = await fetch(redactedDataUrl);
      const blob = await res.blob();
      const safeName = doc.title.replace(/[^a-zA-Z0-9._ -]/g, '').trim() || 'Scan';
      triggerFileDownload(blob, `${safeName}_Page${safeIdx + 1}_Masked.jpg`);
      onToast(
        redactedCount > 0
          ? `Masked ${redactedCount} sensitive field(s) & exported safely`
          : 'Exported with privacy footer (no Aadhaar/PAN/phone detected)'
      );
      setShowExportSheet(false);
    } catch {
      onToast('Privacy redaction failed');
    } finally {
      setIsExporting(false);
    }
  };

  const handleExportJpeg = async () => {
    setIsExporting(true);
    try {
      await exportSinglePageAsJpeg(doc, safeIdx);
      onToast(`Exported Page ${safeIdx + 1} as JPEG`);
      setShowExportSheet(false);
    } catch {
      onToast('JPEG export failed');
    } finally {
      setIsExporting(false);
    }
  };

  const copyOcrText = async () => {
    const text = currentPage?.ocrText || '';
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      onToast('Copied page OCR text to clipboard');
    } catch {
      onToast('Clipboard unavailable');
    }
  };

  return (
    <div
      className="fixed inset-0 h-[100dvh] max-h-[100dvh] w-full overflow-hidden z-40 flex flex-col bg-[#F2F2F7] dark:bg-[#000000] text-slate-900 dark:text-slate-100"
      role="dialog"
      aria-modal="true"
      aria-label={doc.title}
    >
      {/* Top iOS Reader Toolbar */}
      <header className="shrink-0 z-20 pt-safe bg-white/95 dark:bg-[#1C1C1E]/95 backdrop-blur-md border-b border-slate-200 dark:border-white/10 px-3 sm:px-5 min-h-[52px] py-1.5 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <button
            onClick={onClose}
            className="min-h-[44px] px-2 -ml-2 flex items-center gap-1 text-orange-600 dark:text-orange-400 font-semibold text-sm shrink-0"
          >
            <ChevronLeft className="w-5 h-5" />
            <span>Back</span>
          </button>
          <div className="min-w-0">
            <h1 className="text-sm font-bold truncate">{doc.title}</h1>
            <p className="text-[11px] text-slate-500 dark:text-slate-400 font-mono tabular-nums">
              Page {safeIdx + 1} of {doc.pages.length} · {formatBytes(doc.sizeBytes)}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-1 shrink-0">
          <button
            onClick={() => setShowFindBar((v) => !v)}
            title="Search OCR inside PDF"
            className={`min-h-[40px] min-w-[40px] rounded-xl flex items-center justify-center transition-colors ${
              showFindBar
                ? 'bg-orange-100 dark:bg-orange-950/50 text-orange-600 dark:text-orange-400'
                : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-white/10'
            }`}
          >
            <Search className="w-4 h-4" />
          </button>
          <button
            onClick={() => setShowOcrDrawer((v) => !v)}
            title="Inspect OCR text"
            className={`min-h-[40px] min-w-[40px] rounded-xl flex items-center justify-center transition-colors ${
              showOcrDrawer
                ? 'bg-orange-100 dark:bg-orange-950/50 text-orange-600 dark:text-orange-400'
                : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-white/10'
            }`}
          >
            <FileText className="w-4 h-4" />
          </button>
          <button
            onClick={() => setShowWatermarkModal(true)}
            title="Diagonal Watermark"
            className="min-h-[40px] min-w-[40px] rounded-xl flex items-center justify-center text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-white/10 transition-colors"
          >
            <Droplets className="w-4 h-4" />
          </button>
          <button
            onClick={() => setShowSignatureModal(true)}
            title="Sign PDF Page"
            className="min-h-[40px] min-w-[40px] rounded-xl flex items-center justify-center text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-white/10 transition-colors"
          >
            <PenTool className="w-4 h-4" />
          </button>
          <button
            onClick={handleToggleBookmark}
            title={doc.isBookmarked ? 'Remove bookmark' : 'Bookmark document'}
            className="min-h-[40px] min-w-[40px] rounded-xl flex items-center justify-center text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-white/10 transition-colors"
          >
            <Bookmark
              className={`w-4 h-4 ${doc.isBookmarked ? 'fill-orange-500 text-orange-500' : ''}`}
            />
          </button>
          <button
            onClick={onOpenOrganizer}
            className="min-h-[38px] px-3 rounded-xl bg-orange-50 dark:bg-orange-950/40 text-orange-700 dark:text-orange-300 hover:bg-orange-100 dark:hover:bg-orange-950/60 text-xs font-semibold flex items-center gap-1.5 transition-colors whitespace-nowrap"
          >
            <Layers className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Organize</span>
          </button>
          <button
            onClick={() => setShowExportSheet(true)}
            className="min-h-[38px] px-3 rounded-xl bg-orange-600 hover:bg-orange-700 text-white text-xs font-semibold flex items-center gap-1.5 transition-colors whitespace-nowrap"
          >
            <Download className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Export</span>
          </button>
        </div>
      </header>

      {/* In-PDF OCR Find Bar */}
      {showFindBar && (
        <div className="bg-white dark:bg-[#1C1C1E] border-b border-slate-200 dark:border-white/10 px-4 py-2.5 flex flex-wrap items-center gap-3 shrink-0">
          <div className="relative flex-1 min-w-[200px] max-w-md">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={findQuery}
              onChange={(e) => setFindQuery(e.target.value)}
              placeholder="Search inside indexed OCR text…"
              className="w-full h-9 pl-9 pr-8 rounded-xl bg-slate-100 dark:bg-[#2C2C2E] text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
              autoFocus
            />
            {findQuery && (
              <button
                onClick={() => setFindQuery('')}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
          {findQuery.trim() && (
            <div className="flex items-center gap-1.5 flex-wrap text-xs">
              {matchingPageIndices.length === 0 ? (
                <span className="text-slate-500">No matches in OCR text</span>
              ) : (
                <>
                  <span className="text-slate-500">Matches on:</span>
                  {matchingPageIndices.map((pIdx) => (
                    <button
                      key={pIdx}
                      onClick={() => setCurrentIdx(pIdx)}
                      className={`px-2.5 py-1 rounded-lg font-mono font-semibold transition-colors ${
                        pIdx === safeIdx
                          ? 'bg-orange-600 text-white'
                          : 'bg-slate-100 dark:bg-[#2C2C2E] text-slate-700 dark:text-slate-200 hover:bg-orange-100'
                      }`}
                    >
                      P{pIdx + 1}
                    </button>
                  ))}
                </>
              )}
            </div>
          )}
        </div>
      )}

      {/* Main Viewer Canvas + Optional Side OCR Drawer */}
      <div className="flex-1 flex overflow-hidden relative">
        <div
          className="flex-1 overflow-auto flex items-center justify-center p-4 sm:p-8 bg-[#E5E5EA] dark:bg-[#0D0D0F] relative"
          onTouchStart={(e) => {
            if (e.touches.length === 1) touchStartXRef.current = e.touches[0].clientX;
          }}
          onTouchEnd={(e) => {
            if (touchStartXRef.current === null || e.changedTouches.length === 0) return;
            const dx = e.changedTouches[0].clientX - touchStartXRef.current;
            touchStartXRef.current = null;
            if (dx > 55) setCurrentIdx((i) => Math.max(0, i - 1));
            else if (dx < -55) setCurrentIdx((i) => Math.min(doc.pages.length - 1, i + 1));
          }}
        >
          {/* Floating Page Indicator Pill */}
          <div className="fixed top-16 left-1/2 -translate-x-1/2 z-10 px-3 py-1 rounded-full bg-black/70 text-white text-xs font-mono font-semibold backdrop-blur-md shadow flex items-center gap-2 pointer-events-auto">
            <button
              type="button"
              onClick={() => setCurrentIdx((i) => Math.max(0, i - 1))}
              disabled={safeIdx === 0}
              aria-label="Previous page"
              className="disabled:opacity-35 hover:text-orange-400"
            >
              <ChevronLeft className="w-3.5 h-3.5" />
            </button>
            <span>
              Page {safeIdx + 1} / {doc.pages.length}
            </span>
            <button
              type="button"
              onClick={() => setCurrentIdx((i) => Math.min(doc.pages.length - 1, i + 1))}
              disabled={safeIdx >= doc.pages.length - 1}
              aria-label="Next page"
              className="disabled:opacity-35 hover:text-orange-400"
            >
              <ChevronRight className="w-3.5 h-3.5" />
            </button>
          </div>
          {currentPage ? (
            <div
              className="transition-transform duration-150 origin-center"
              style={{ transform: `scale(${zoom})` }}
            >
              <div className="w-[min(86vw,540px)] aspect-[3/4] rounded-md shadow-xl overflow-hidden bg-white border border-slate-300/60 dark:border-white/10">
                <PageCanvasPreview
                  page={currentPage}
                  watermark={doc.watermark}
                  className="w-full h-full"
                />
              </div>
            </div>
          ) : (
            <p className="text-sm text-slate-500">No pages in this document.</p>
          )}

          {/* Floating Zoom & Signature Clear Controls */}
          <div className="fixed bottom-24 right-5 flex flex-col gap-2 z-10">
            <button
              onClick={() => setZoom((z) => Math.min(2.2, Number((z + 0.25).toFixed(2))))}
              aria-label="Zoom in"
              className="w-10 h-10 rounded-full bg-white/95 dark:bg-[#2C2C2E]/95 shadow-md border border-slate-200 dark:border-white/10 flex items-center justify-center hover:text-orange-600"
            >
              <ZoomIn className="w-4 h-4" />
            </button>
            <button
              onClick={() => setZoom((z) => Math.max(0.75, Number((z - 0.25).toFixed(2))))}
              aria-label="Zoom out"
              className="w-10 h-10 rounded-full bg-white/95 dark:bg-[#2C2C2E]/95 shadow-md border border-slate-200 dark:border-white/10 flex items-center justify-center hover:text-orange-600"
            >
              <ZoomOut className="w-4 h-4" />
            </button>
            {currentPage && currentPage.signatures.length > 0 && (
              <button
                onClick={handleClearPageSignatures}
                title="Clear signatures on this page"
                className="w-10 h-10 rounded-full bg-red-50 dark:bg-red-950/80 text-red-600 dark:text-red-400 shadow-md border border-red-200 dark:border-red-900 flex items-center justify-center"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            )}
          </div>
        </div>

        {/* OCR & Smart Data Side Inspector */}
        {showOcrDrawer && currentPage && (
          <aside className="w-full sm:w-80 bg-white dark:bg-[#1C1C1E] border-l border-slate-200 dark:border-white/10 p-4 flex flex-col gap-3 shrink-0 absolute inset-y-0 right-0 sm:static z-20 shadow-xl sm:shadow-none">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-bold">Inspector · Page {safeIdx + 1}</h3>
              <div className="flex items-center gap-1">
                <button
                  onClick={copyOcrText}
                  className="px-2.5 py-1.5 rounded-lg text-xs font-semibold bg-slate-100 dark:bg-[#2C2C2E] hover:bg-orange-50 text-slate-700 dark:text-slate-200 flex items-center gap-1"
                >
                  <Copy className="w-3.5 h-3.5" />
                  <span>Copy</span>
                </button>
                <button
                  onClick={() => setShowOcrDrawer(false)}
                  className="w-8 h-8 rounded-lg flex items-center justify-center hover:bg-slate-100 dark:hover:bg-white/10"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-1 p-1 rounded-xl bg-slate-100 dark:bg-[#2C2C2E]">
              <button
                type="button"
                onClick={() => setDrawerTab('ocr')}
                className={`py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                  drawerTab === 'ocr'
                    ? 'bg-white dark:bg-[#1C1C1E] text-orange-600 shadow-sm'
                    : 'text-slate-600 dark:text-slate-300'
                }`}
              >
                OCR Text
              </button>
              <button
                type="button"
                onClick={() => setDrawerTab('smart_data')}
                className={`py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                  drawerTab === 'smart_data'
                    ? 'bg-white dark:bg-[#1C1C1E] text-orange-600 shadow-sm'
                    : 'text-slate-600 dark:text-slate-300'
                }`}
              >
                Smart Data
              </button>
            </div>

            {drawerTab === 'ocr' ? (
              <div className="flex-1 overflow-y-auto rounded-xl bg-slate-50 dark:bg-[#2C2C2E] p-3.5 text-sm leading-relaxed text-slate-700 dark:text-slate-200 whitespace-pre-wrap">
                {currentPage.ocrText || 'No OCR text indexed for this page.'}
              </div>
            ) : (
              <div className="flex-1 overflow-y-auto space-y-3 pr-1">
                {(
                  [
                    { label: 'IDs (PAN / Aadhaar)', items: smartData.ids },
                    { label: 'Amounts', items: smartData.amounts },
                    { label: 'Dates', items: smartData.dates },
                    { label: 'Phones', items: smartData.phones },
                    { label: 'Emails', items: smartData.emails },
                  ] as const
                ).map((group) =>
                  group.items.length > 0 ? (
                    <div key={group.label} className="space-y-1.5">
                      <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                        {group.label}
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {group.items.map((val) => (
                          <button
                            key={val}
                            type="button"
                            onClick={() => {
                              navigator.clipboard?.writeText(val).catch(() => undefined);
                              onToast(`Copied "${val}"`);
                            }}
                            className="px-2.5 py-1 rounded-lg bg-slate-100 dark:bg-[#2C2C2E] hover:bg-orange-50 dark:hover:bg-orange-950/40 border border-slate-200 dark:border-white/10 text-xs font-mono text-slate-800 dark:text-slate-200 flex items-center gap-1"
                          >
                            <span>{val}</span>
                            <Copy className="w-3 h-3 text-slate-400" />
                          </button>
                        ))}
                      </div>
                    </div>
                  ) : null
                )}
                {smartData.ids.length === 0 &&
                  smartData.amounts.length === 0 &&
                  smartData.dates.length === 0 &&
                  smartData.phones.length === 0 &&
                  smartData.emails.length === 0 && (
                    <p className="text-xs text-slate-500 text-center py-8">
                      No structured dates, amounts, phones, emails, or IDs detected yet.
                    </p>
                  )}
              </div>
            )}
          </aside>
        )}
      </div>

      {/* Bottom Filmstrip Page Scrubber (Genius Scan iOS style) */}
      <footer className="bg-white/95 dark:bg-[#1C1C1E]/95 backdrop-blur-md border-t border-slate-200 dark:border-white/10 px-4 py-2.5 pb-safe flex items-center justify-between gap-4 shrink-0">
        <button
          onClick={() => setCurrentIdx((i) => Math.max(0, i - 1))}
          disabled={safeIdx === 0}
          aria-label="Previous page"
          className="min-h-[40px] min-w-[40px] rounded-xl flex items-center justify-center bg-slate-100 dark:bg-[#2C2C2E] disabled:opacity-35"
        >
          <ChevronLeft className="w-5 h-5" />
        </button>

        <div className="flex items-center gap-2 overflow-x-auto py-0.5">
          {doc.pages.map((pg, idx) => (
            <button
              key={pg.id}
              onClick={() => setCurrentIdx(idx)}
              className={`relative w-10 h-13 rounded-md overflow-hidden border-2 transition-all shrink-0 ${
                idx === safeIdx
                  ? 'border-orange-600 scale-105 shadow-sm'
                  : 'border-transparent opacity-65 hover:opacity-100'
              }`}
            >
              <PageCanvasPreview page={pg} className="w-full h-full" showWatermark={false} />
              <span className="absolute bottom-0 inset-x-0 bg-black/60 text-white text-[9px] font-mono text-center">
                {idx + 1}
              </span>
            </button>
          ))}
        </div>

        <button
          onClick={() => setCurrentIdx((i) => Math.min(doc.pages.length - 1, i + 1))}
          disabled={safeIdx >= doc.pages.length - 1}
          aria-label="Next page"
          className="min-h-[40px] min-w-[40px] rounded-xl flex items-center justify-center bg-slate-100 dark:bg-[#2C2C2E] disabled:opacity-35"
        >
          <ChevronRight className="w-5 h-5" />
        </button>
      </footer>

      {/* Watermark Studio Modal */}
      {showWatermarkModal && (
        <div
          className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm flex items-end sm:items-center justify-center p-0 sm:p-4"
          onClick={() => setShowWatermarkModal(false)}
        >
          <div
            className="w-full sm:max-w-md bg-white dark:bg-[#1C1C1E] rounded-t-3xl sm:rounded-3xl p-5 pb-safe space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <h3 className="text-base font-bold">Diagonal PDF Watermark</h3>
              <button
                onClick={() => setShowWatermarkModal(false)}
                className="w-9 h-9 rounded-full flex items-center justify-center hover:bg-slate-100 dark:hover:bg-white/10"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="space-y-3">
              <div>
                <label className="block text-xs font-semibold text-slate-600 dark:text-slate-300 mb-1">
                  Watermark Text
                </label>
                <input
                  type="text"
                  value={wmText}
                  onChange={(e) => setWmText(e.target.value)}
                  placeholder="CONFIDENTIAL, DRAFT, COPY ONLY…"
                  className="w-full h-11 px-3.5 rounded-xl bg-slate-50 dark:bg-[#2C2C2E] border border-slate-200 dark:border-white/10 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
                />
                <div className="flex gap-1.5 mt-2 flex-wrap">
                  {['CONFIDENTIAL', 'PAID', 'DRAFT', 'DO NOT COPY'].map((preset) => (
                    <button
                      key={preset}
                      type="button"
                      onClick={() => setWmText(preset)}
                      className="px-2.5 py-1 rounded-lg text-[11px] font-semibold bg-slate-100 dark:bg-[#2C2C2E] hover:bg-orange-50 text-slate-600 dark:text-slate-300"
                    >
                      {preset}
                    </button>
                  ))}
                </div>
              </div>

              <div className="flex items-center justify-between gap-4">
                <div>
                  <span className="block text-xs font-semibold text-slate-600 dark:text-slate-300 mb-1.5">
                    Ink Color
                  </span>
                  <div className="flex items-center gap-2">
                    {['#DC2626', '#EA580C', '#1D4ED8', '#0F172A', '#059669'].map((col) => (
                      <button
                        key={col}
                        type="button"
                        onClick={() => setWmColor(col)}
                        style={{ backgroundColor: col }}
                        className={`w-7 h-7 rounded-full border-2 transition-transform ${
                          wmColor === col ? 'border-slate-900 dark:border-white scale-110' : 'border-transparent'
                        }`}
                      />
                    ))}
                  </div>
                </div>
                <label className="flex-1">
                  <div className="flex justify-between text-xs text-slate-600 dark:text-slate-300 mb-1">
                    <span>Opacity</span>
                    <span className="font-mono tabular-nums">{Math.round(wmOpacity * 100)}%</span>
                  </div>
                  <input
                    type="range"
                    min="0.08"
                    max="0.55"
                    step="0.02"
                    value={wmOpacity}
                    onChange={(e) => setWmOpacity(parseFloat(e.target.value))}
                    className="w-full accent-orange-600"
                  />
                </label>
              </div>
            </div>

            <div className="flex items-center gap-2 pt-2">
              {doc.watermark && (
                <button
                  type="button"
                  onClick={handleClearWatermark}
                  className="h-11 px-4 rounded-xl text-sm font-semibold text-red-600 bg-red-50 dark:bg-red-950/40 hover:bg-red-100"
                >
                  Remove
                </button>
              )}
              <button
                type="button"
                onClick={handleApplyWatermark}
                className="flex-1 h-11 rounded-xl bg-orange-600 hover:bg-orange-700 text-white text-sm font-semibold transition-colors"
              >
                Apply Watermark
              </button>
            </div>
          </div>
        </div>
      )}

      {/* E-Signature Pad & Placement Modal */}
      {showSignatureModal && (
        <div
          className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm flex items-end sm:items-center justify-center p-0 sm:p-4"
          onClick={() => setShowSignatureModal(false)}
        >
          <div
            className="w-full sm:max-w-lg bg-white dark:bg-[#1C1C1E] rounded-t-3xl sm:rounded-3xl p-5 pb-safe space-y-4 max-h-[90vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-base font-bold">Sign Page {safeIdx + 1}</h3>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  Draw a signature below or tap a saved signature to stamp
                </p>
              </div>
              <button
                onClick={() => setShowSignatureModal(false)}
                className="w-9 h-9 rounded-full flex items-center justify-center hover:bg-slate-100 dark:hover:bg-white/10"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Canvas Pad */}
            <div className="space-y-2">
              <div className="relative rounded-2xl border-2 border-dashed border-slate-300 dark:border-white/20 bg-white overflow-hidden">
                <canvas
                  ref={canvasRef}
                  width={520}
                  height={180}
                  onPointerDown={handleSigPointerDown}
                  onPointerMove={handleSigPointerMove}
                  onPointerUp={handleSigPointerUp}
                  onPointerLeave={handleSigPointerUp}
                  className="w-full h-40 touch-none cursor-crosshair block"
                />
                {!hasDrawnInk && (
                  <span className="pointer-events-none absolute inset-0 flex items-center justify-center text-xs text-slate-400">
                    Sign here with mouse or touch
                  </span>
                )}
              </div>

              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  {[
                    { hex: '#1D4ED8', label: 'Blue' },
                    { hex: '#0F172A', label: 'Black' },
                    { hex: '#B91C1C', label: 'Red' },
                  ].map((ink) => (
                    <button
                      key={ink.hex}
                      type="button"
                      onClick={() => setSigColor(ink.hex)}
                      style={{ backgroundColor: ink.hex }}
                      title={ink.label}
                      className={`w-6 h-6 rounded-full border-2 ${
                        sigColor === ink.hex ? 'border-orange-500 scale-110' : 'border-transparent'
                      }`}
                    />
                  ))}
                </div>
                <button
                  type="button"
                  onClick={clearSignatureCanvas}
                  className="text-xs font-semibold text-slate-500 hover:text-slate-800 dark:hover:text-white"
                >
                  Clear Pad
                </button>
              </div>
            </div>

            {/* Placement Position Sliders */}
            <div className="grid grid-cols-3 gap-3 bg-slate-50 dark:bg-[#2C2C2E] p-3 rounded-2xl">
              <label className="text-xs">
                <span className="text-slate-500 block mb-1">Horizontal</span>
                <input
                  type="range"
                  min="0.05"
                  max="0.7"
                  step="0.02"
                  value={sigPosX}
                  onChange={(e) => setSigPosX(parseFloat(e.target.value))}
                  className="w-full accent-orange-600"
                />
              </label>
              <label className="text-xs">
                <span className="text-slate-500 block mb-1">Vertical</span>
                <input
                  type="range"
                  min="0.08"
                  max="0.86"
                  step="0.02"
                  value={sigPosY}
                  onChange={(e) => setSigPosY(parseFloat(e.target.value))}
                  className="w-full accent-orange-600"
                />
              </label>
              <label className="text-xs">
                <span className="text-slate-500 block mb-1">Size</span>
                <input
                  type="range"
                  min="0.18"
                  max="0.5"
                  step="0.02"
                  value={sigWidth}
                  onChange={(e) => setSigWidth(parseFloat(e.target.value))}
                  className="w-full accent-orange-600"
                />
              </label>
            </div>

            <label className="flex items-center gap-2 text-xs font-medium cursor-pointer">
              <input
                type="checkbox"
                checked={sigDateStamp}
                onChange={(e) => setSigDateStamp(e.target.checked)}
                className="w-4 h-4 accent-orange-600 rounded"
              />
              <span>Include today&apos;s date stamp underneath signature</span>
            </label>

            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={!hasDrawnInk}
                onClick={() => {
                  if (!canvasRef.current) return;
                  placeSignatureOnPage(canvasRef.current.toDataURL('image/png'), true);
                }}
                className="flex-1 h-11 rounded-xl bg-orange-600 hover:bg-orange-700 disabled:opacity-40 text-white text-sm font-semibold transition-colors"
              >
                Stamp & Save Signature
              </button>
            </div>

            {/* Saved Signatures Library */}
            {savedSignatures.length > 0 && (
              <div className="pt-2 border-t border-slate-200 dark:border-white/10 space-y-2">
                <span className="text-xs font-semibold text-slate-500">Saved Signatures</span>
                <div className="grid grid-cols-2 gap-2">
                  {savedSignatures.map((sig) => (
                    <div
                      key={sig.id}
                      className="flex items-center gap-2 p-2 rounded-xl border border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-[#2C2C2E]"
                    >
                      <button
                        type="button"
                        onClick={() => placeSignatureOnPage(sig.dataUrl, false)}
                        className="flex-1 h-10 bg-white rounded-lg p-1 flex items-center justify-center"
                      >
                        <img src={sig.dataUrl} alt={sig.name} className="max-h-full object-contain" />
                      </button>
                      <button
                        type="button"
                        onClick={() => onDeleteSavedSignature(sig.id)}
                        className="p-1.5 text-slate-400 hover:text-red-600"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Export / Share Bottom Sheet */}
      {showExportSheet && (
        <div
          className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm flex items-end sm:items-center justify-center p-0 sm:p-4"
          onClick={() => setShowExportSheet(false)}
        >
          <div
            className="w-full sm:max-w-md bg-white dark:bg-[#1C1C1E] rounded-t-3xl sm:rounded-3xl p-5 pb-safe space-y-3"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="w-10 h-1.5 bg-slate-300 dark:bg-slate-700 rounded-full mx-auto sm:hidden" />
            <div className="flex items-center justify-between">
              <h3 className="text-base font-bold">Export Document</h3>
              <button
                onClick={() => setShowExportSheet(false)}
                className="w-9 h-9 rounded-full flex items-center justify-center hover:bg-slate-100 dark:hover:bg-white/10"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            {doc.passwordProtected && (
              <div className="p-3 rounded-xl bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900/50 space-y-1.5">
                <label className="text-xs font-semibold text-amber-800 dark:text-amber-200 block">
                  PDF Encryption Password (Optional)
                </label>
                <input
                  type="password"
                  value={pdfPasswordInput}
                  onChange={(e) => setPdfPasswordInput(e.target.value)}
                  placeholder="Enter password to encrypt PDF…"
                  className="w-full px-3 py-2 rounded-lg bg-white dark:bg-[#2C2C2E] border border-amber-200 dark:border-white/10 text-xs"
                />
              </div>
            )}
            <button
              type="button"
              disabled={isExporting}
              onClick={handleExportPdf}
              className="w-full p-4 rounded-2xl bg-orange-600 hover:bg-orange-700 text-white flex items-center justify-between transition-colors disabled:opacity-60"
            >
              <div className="flex items-center gap-3">
                <Download className="w-5 h-5" />
                <div className="text-left">
                  <div className="text-sm font-bold">
                    {isExporting ? 'Building PDF…' : 'Export Multi-Page PDF'}
                  </div>
                  <div className="text-xs text-orange-100">
                    {doc.pages.length} page(s) · {doc.pageSizePreset.toUpperCase()} · {doc.qualityPreset} quality
                  </div>
                </div>
              </div>
            </button>
            <button
              type="button"
              disabled={isExporting}
              onClick={handleMaskAndShare}
              className="w-full p-4 rounded-2xl bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-900/50 hover:bg-emerald-100 dark:hover:bg-emerald-950/60 flex items-center justify-between transition-colors"
            >
              <div className="flex items-center gap-3">
                <ShieldCheck className="w-5 h-5 text-emerald-600 dark:text-emerald-400" />
                <div className="text-left">
                  <div className="text-sm font-semibold text-emerald-900 dark:text-emerald-200">
                    Mask & Share Safely
                  </div>
                  <div className="text-xs text-emerald-700 dark:text-emerald-400">
                    Auto-redacts Aadhaar, PAN, phone & account numbers
                  </div>
                </div>
              </div>
            </button>
            <button
              type="button"
              disabled={isExporting}
              onClick={handleExportJpeg}
              className="w-full p-4 rounded-2xl bg-slate-100 dark:bg-[#2C2C2E] hover:bg-slate-200 dark:hover:bg-white/15 flex items-center justify-between transition-colors"
            >
              <div className="flex items-center gap-3">
                <ImageIcon className="w-5 h-5 text-orange-600 dark:text-orange-400" />
                <div className="text-left">
                  <div className="text-sm font-semibold">Export Current Page as JPEG</div>
                  <div className="text-xs text-slate-500 dark:text-slate-400">
                    Page {safeIdx + 1} with filters, watermark & signature
                  </div>
                </div>
              </div>
            </button>
            <button
              type="button"
              onClick={() => {
                copyOcrText();
                setShowExportSheet(false);
              }}
              className="w-full p-4 rounded-2xl bg-slate-100 dark:bg-[#2C2C2E] hover:bg-slate-200 dark:hover:bg-white/15 flex items-center justify-between transition-colors"
            >
              <div className="flex items-center gap-3">
                <Copy className="w-5 h-5 text-orange-600 dark:text-orange-400" />
                <div className="text-left">
                  <div className="text-sm font-semibold">Copy Extracted OCR Text</div>
                  <div className="text-xs text-slate-500 dark:text-slate-400">
                    Plain text from Page {safeIdx + 1}
                  </div>
                </div>
              </div>
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
