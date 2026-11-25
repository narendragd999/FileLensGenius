import React, { useEffect, useRef, useState } from 'react';
import {
  Check,
  Eye,
  FileText,
  Maximize2,
  RotateCw,
  SlidersHorizontal,
  Sparkles,
  Square,
  Undo2,
  X,
} from 'lucide-react';
import { DocumentPage, FULL_QUAD, NormalizedQuad, ScanFilterId } from '../types/filelens';
import { SCAN_FILTERS } from '../data/seedData';
import {
  createA4CenteredQuad,
  detectQuadFromImageUrl,
  isFullQuad,
  squareUpQuadToRectangle,
} from '../utils/documentEdgeDetector';

interface PerspectiveCropModalProps {
  page: DocumentPage;
  pageNumber: number;
  onSave: (updated: DocumentPage) => void;
  onClose: () => void;
}

type CornerKey = 'tl' | 'tr' | 'br' | 'bl';
type EdgeKey = 'top' | 'right' | 'bottom' | 'left';
type DragTarget = { type: 'corner'; key: CornerKey } | { type: 'edge'; key: EdgeKey; startX: number; startY: number; startQuad: NormalizedQuad };

export const PerspectiveCropModal: React.FC<PerspectiveCropModalProps> = ({
  page,
  pageNumber,
  onSave,
  onClose,
}) => {
  const [quad, setQuad] = useState<NormalizedQuad>(page.quad);
  const [undoStack, setUndoStack] = useState<{ quad: NormalizedQuad; rotation: 0 | 90 | 180 | 270 }[]>([]);
  const [filter, setFilter] = useState<ScanFilterId>(page.filter);
  const [rotation, setRotation] = useState<0 | 90 | 180 | 270>(page.rotation);
  const [brightness, setBrightness] = useState<number>(page.brightness ?? 1);
  const [contrast, setContrast] = useState<number>(page.contrast ?? 1);
  const [activeTab, setActiveTab] = useState<'crop' | 'filter' | 'adjust'>('crop');
  const [dragTarget, setDragTarget] = useState<DragTarget | null>(null);
  const [isDetecting, setIsDetecting] = useState<boolean>(false);
  const [compareOriginal, setCompareOriginal] = useState<boolean>(false);
  const stageRef = useRef<HTMLDivElement | null>(null);

  // Auto-detect white A4 paper edges on open if page is currently uncropped
  useEffect(() => {
    if (!isFullQuad(page.quad)) return;
    let active = true;
    setIsDetecting(true);
    void detectQuadFromImageUrl(page.imageUrl)
      .then((detected) => {
        if (!active) return;
        if (!isFullQuad(detected)) {
          setQuad(detected);
        }
      })
      .finally(() => {
        if (active) setIsDetecting(false);
      });
    return () => {
      active = false;
    };
  }, [page.imageUrl, page.quad]);

  const pushUndo = (prevQuad = quad, prevRot = rotation) => {
    setUndoStack((s) => [...s.slice(-19), { quad: prevQuad, rotation: prevRot }]);
  };

  const handleUndo = () => {
    setUndoStack((s) => {
      if (s.length === 0) return s;
      const last = s[s.length - 1];
      setQuad(last.quad);
      setRotation(last.rotation);
      return s.slice(0, -1);
    });
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragTarget || !stageRef.current) return;
    const rect = stageRef.current.getBoundingClientRect();
    const nx = Math.max(0.01, Math.min(0.99, (e.clientX - rect.left) / rect.width));
    const ny = Math.max(0.01, Math.min(0.99, (e.clientY - rect.top) / rect.height));

    if (dragTarget.type === 'corner') {
      const k = dragTarget.key;
      setQuad((prev) => {
        if (k === 'tl') return { ...prev, tlX: Math.min(nx, prev.trX - 0.1), tlY: Math.min(ny, prev.blY - 0.1) };
        if (k === 'tr') return { ...prev, trX: Math.max(nx, prev.tlX + 0.1), trY: Math.min(ny, prev.brY - 0.1) };
        if (k === 'br') return { ...prev, brX: Math.max(nx, prev.blX + 0.1), brY: Math.max(ny, prev.trY + 0.1) };
        return { ...prev, blX: Math.min(nx, prev.brX - 0.1), blY: Math.max(ny, prev.tlY + 0.1) };
      });
    } else {
      const dx = nx - dragTarget.startX;
      const dy = ny - dragTarget.startY;
      const q0 = dragTarget.startQuad;
      const clamp = (v: number) => Math.max(0.01, Math.min(0.99, v));

      if (dragTarget.key === 'top') {
        const tlY = Math.min(clamp(q0.tlY + dy), q0.blY - 0.1);
        const trY = Math.min(clamp(q0.trY + dy), q0.brY - 0.1);
        setQuad({ ...q0, tlY, trY });
      } else if (dragTarget.key === 'bottom') {
        const blY = Math.max(clamp(q0.blY + dy), q0.tlY + 0.1);
        const brY = Math.max(clamp(q0.brY + dy), q0.trY + 0.1);
        setQuad({ ...q0, blY, brY });
      } else if (dragTarget.key === 'left') {
        const tlX = Math.min(clamp(q0.tlX + dx), q0.trX - 0.1);
        const blX = Math.min(clamp(q0.blX + dx), q0.brX - 0.1);
        setQuad({ ...q0, tlX, blX });
      } else {
        const trX = Math.max(clamp(q0.trX + dx), q0.tlX + 0.1);
        const brX = Math.max(clamp(q0.brX + dx), q0.blX + 0.1);
        setQuad({ ...q0, trX, brX });
      }
    }
  };

  const autoDetectEdges = async () => {
    setIsDetecting(true);
    pushUndo();
    try {
      const detected = await detectQuadFromImageUrl(page.imageUrl);
      const isFull =
        detected.tlX <= 0.01 &&
        detected.tlY <= 0.01 &&
        detected.trX >= 0.99 &&
        detected.brY >= 0.99;
      setQuad(
        isFull
          ? { tlX: 0.04, tlY: 0.04, trX: 0.96, trY: 0.04, brX: 0.96, brY: 0.96, blX: 0.04, blY: 0.96 }
          : detected
      );
    } finally {
      setIsDetecting(false);
    }
  };

  const resetFullFrame = () => {
    pushUndo();
    setQuad(FULL_QUAD);
  };

  const applyA4Frame = () => {
    pushUndo();
    setQuad(createA4CenteredQuad());
  };

  const squareUpQuad = () => {
    pushUndo();
    setQuad(squareUpQuadToRectangle(quad));
  };

  const rotateRight = () => {
    pushUndo();
    setRotation((r) => (((r + 90) % 360) as 0 | 90 | 180 | 270));
  };

  const handleSave = () => {
    onSave({
      ...page,
      quad,
      filter,
      rotation,
      brightness,
      contrast,
    });
  };

  const corners: { key: CornerKey; x: number; y: number }[] = [
    { key: 'tl', x: quad.tlX, y: quad.tlY },
    { key: 'tr', x: quad.trX, y: quad.trY },
    { key: 'br', x: quad.brX, y: quad.brY },
    { key: 'bl', x: quad.blX, y: quad.blY },
  ];

  const edges: { key: EdgeKey; x: number; y: number; vertical: boolean }[] = [
    { key: 'top', x: (quad.tlX + quad.trX) / 2, y: (quad.tlY + quad.trY) / 2, vertical: false },
    { key: 'right', x: (quad.trX + quad.brX) / 2, y: (quad.trY + quad.brY) / 2, vertical: true },
    { key: 'bottom', x: (quad.blX + quad.brX) / 2, y: (quad.blY + quad.brY) / 2, vertical: false },
    { key: 'left', x: (quad.tlX + quad.blX) / 2, y: (quad.tlY + quad.blY) / 2, vertical: true },
  ];

  const activeCorner =
    dragTarget?.type === 'corner'
      ? corners.find((c) => c.key === dragTarget.key) ?? null
      : null;

  const polygonPoints = `${quad.tlX * 100},${quad.tlY * 100} ${quad.trX * 100},${quad.trY * 100} ${quad.brX * 100},${quad.brY * 100} ${quad.blX * 100},${quad.blY * 100}`;

  return (
    <div
      className="fixed inset-0 h-[100dvh] max-h-[100dvh] w-full overflow-hidden z-50 flex flex-col bg-[#0C0C0E] text-white"
      role="dialog"
      aria-modal="true"
      aria-label={`Edit Page ${pageNumber}`}
    >
      {/* Top Studio Bar */}
      <div className="shrink-0 pt-safe flex items-center justify-between px-3 sm:px-4 min-h-[52px] py-1.5 border-b border-white/10">
        <button
          onClick={onClose}
          className="min-h-[44px] min-w-[44px] flex items-center gap-1.5 text-sm font-medium text-white/80 hover:text-white transition-colors"
        >
          <X className="w-5 h-5" />
          <span className="hidden sm:inline">Cancel</span>
        </button>

        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold tracking-tight">Page {pageNumber}</h2>
          <button
            type="button"
            onPointerDown={() => setCompareOriginal(true)}
            onPointerUp={() => setCompareOriginal(false)}
            onPointerLeave={() => setCompareOriginal(false)}
            className="px-2.5 py-1 rounded-lg bg-white/10 hover:bg-white/15 text-[11px] font-medium flex items-center gap-1 text-white/80"
            title="Hold to compare original"
          >
            <Eye className="w-3.5 h-3.5" />
            <span>{compareOriginal ? 'Original' : 'Compare'}</span>
          </button>
        </div>

        <div className="flex items-center gap-1.5">
          {undoStack.length > 0 && (
            <button
              type="button"
              onClick={handleUndo}
              className="min-h-[38px] px-2.5 rounded-xl bg-white/10 hover:bg-white/15 text-xs font-semibold flex items-center gap-1"
              title="Undo"
            >
              <Undo2 className="w-4 h-4" />
            </button>
          )}
          <button
            onClick={handleSave}
            className="min-h-[40px] px-4 rounded-xl bg-orange-600 hover:bg-orange-500 text-white text-sm font-semibold flex items-center gap-1.5 transition-colors whitespace-nowrap"
          >
            <Check className="w-4 h-4" />
            <span>Apply</span>
          </button>
        </div>
      </div>

      {/* Main Dark Stage */}
      <div
        className="relative flex-1 flex items-center justify-center p-6 overflow-hidden select-none touch-none"
        onPointerMove={handlePointerMove}
        onPointerUp={() => setDragTarget(null)}
        onPointerLeave={() => setDragTarget(null)}
      >
        {/* 3.5x Corner Magnifier Loupe when dragging */}
        {activeCorner && (
          <div className="pointer-events-none absolute top-4 right-4 z-20 w-24 h-24 rounded-full border-2 border-orange-500 overflow-hidden shadow-2xl bg-black">
            <img
              src={page.imageUrl}
              alt="Magnifier"
              className="w-full h-full object-contain"
              style={{
                transform: `scale(3.2) translate(${(0.5 - activeCorner.x) * 100}%, ${(0.5 - activeCorner.y) * 100}%)`,
                transformOrigin: 'center center',
              }}
            />
            <div className="absolute inset-0 flex items-center justify-center">
              <div className="w-3 h-3 rounded-full border border-orange-400 bg-orange-500/30" />
            </div>
          </div>
        )}

        <div
          ref={stageRef}
          className="relative max-w-full max-h-full aspect-[3/4] h-full flex items-center justify-center"
        >
          <div
            className="w-full h-full flex items-center justify-center transition-transform duration-200"
            style={{ transform: `rotate(${rotation}deg)` }}
          >
            <img
              src={page.imageUrl}
              alt={`Page ${pageNumber} edit preview`}
              referrerPolicy="no-referrer"
              className={`w-full h-full object-contain ${
                compareOriginal ? '' : `scan-filter-${filter}`
              } rounded-sm`}
              style={
                compareOriginal
                  ? undefined
                  : { filter: `brightness(${brightness}) contrast(${contrast})` }
              }
              draggable={false}
            />
          </div>

          {/* Perspective Quad Overlay */}
          {activeTab === 'crop' && !compareOriginal && (
            <>
              <svg
                viewBox="0 0 100 100"
                preserveAspectRatio="none"
                className="absolute inset-0 w-full h-full pointer-events-none"
              >
                <defs>
                  <mask id="crop-cutout-mask">
                    <rect width="100" height="100" fill="white" />
                    <polygon points={polygonPoints} fill="black" />
                  </mask>
                </defs>
                <rect
                  width="100"
                  height="100"
                  fill="rgba(0,0,0,0.45)"
                  mask="url(#crop-cutout-mask)"
                />
                <polygon
                  points={polygonPoints}
                  fill="rgba(234, 88, 12, 0.12)"
                  stroke="#F97316"
                  strokeWidth="0.7"
                />
              </svg>

              {/* 4 Mid-Edge Slide Bars */}
              {edges.map((edge) => (
                <button
                  key={edge.key}
                  type="button"
                  aria-label={`Slide ${edge.key} edge`}
                  onPointerDown={(e) => {
                    if (!stageRef.current) return;
                    e.currentTarget.setPointerCapture(e.pointerId);
                    pushUndo();
                    const rect = stageRef.current.getBoundingClientRect();
                    setDragTarget({
                      type: 'edge',
                      key: edge.key,
                      startX: (e.clientX - rect.left) / rect.width,
                      startY: (e.clientY - rect.top) / rect.height,
                      startQuad: quad,
                    });
                  }}
                  style={{ left: `${edge.x * 100}%`, top: `${edge.y * 100}%` }}
                  className="absolute -translate-x-1/2 -translate-y-1/2 p-2 cursor-grab active:cursor-grabbing"
                >
                  <span
                    className={`block rounded-full bg-orange-400 border border-white shadow ${
                      edge.vertical ? 'w-1.5 h-6' : 'w-6 h-1.5'
                    }`}
                  />
                </button>
              ))}

              {/* 4 Draggable Corner Handles */}
              {corners.map((corner) => (
                <button
                  key={corner.key}
                  type="button"
                  aria-label={`Drag ${corner.key} corner`}
                  onPointerDown={(e) => {
                    e.currentTarget.setPointerCapture(e.pointerId);
                    pushUndo();
                    setDragTarget({ type: 'corner', key: corner.key });
                  }}
                  style={{
                    left: `${corner.x * 100}%`,
                    top: `${corner.y * 100}%`,
                  }}
                  className={`absolute -translate-x-1/2 -translate-y-1/2 w-10 h-10 flex items-center justify-center cursor-grab active:cursor-grabbing ${
                    dragTarget?.type === 'corner' && dragTarget.key === corner.key ? 'scale-125' : ''
                  } transition-transform`}
                >
                  <span className="w-5 h-5 rounded-full bg-orange-500 border-2 border-white shadow-lg" />
                </button>
              ))}
            </>
          )}
        </div>
      </div>

      {/* Bottom Controls Dock */}
      <div className="bg-[#16161A] border-t border-white/10 px-4 pt-3 pb-safe space-y-3 shrink-0">
        {activeTab === 'crop' && (
          <div className="flex items-center justify-center gap-2 flex-wrap">
            <button
              onClick={autoDetectEdges}
              disabled={isDetecting}
              className="min-h-[38px] px-3.5 rounded-xl bg-white/10 hover:bg-white/15 text-xs font-semibold flex items-center gap-1.5 transition-colors disabled:opacity-50"
            >
              <Sparkles className="w-4 h-4 text-orange-400" />
              <span>{isDetecting ? 'Detecting…' : 'Auto Edges'}</span>
            </button>
            <button
              onClick={squareUpQuad}
              className="min-h-[38px] px-3.5 rounded-xl bg-white/10 hover:bg-white/15 text-xs font-semibold flex items-center gap-1.5 transition-colors"
            >
              <Square className="w-4 h-4 text-sky-400" />
              <span>Rect 90°</span>
            </button>
            <button
              onClick={applyA4Frame}
              className="min-h-[38px] px-3.5 rounded-xl bg-white/10 hover:bg-white/15 text-xs font-semibold flex items-center gap-1.5 transition-colors"
            >
              <FileText className="w-4 h-4 text-emerald-400" />
              <span>A4 Fit</span>
            </button>
            <button
              onClick={resetFullFrame}
              className="min-h-[38px] px-3.5 rounded-xl bg-white/10 hover:bg-white/15 text-xs font-semibold flex items-center gap-1.5 transition-colors"
            >
              <Maximize2 className="w-4 h-4" />
              <span>Full</span>
            </button>
            <button
              onClick={rotateRight}
              className="min-h-[38px] px-3.5 rounded-xl bg-white/10 hover:bg-white/15 text-xs font-semibold flex items-center gap-1.5 transition-colors"
            >
              <RotateCw className="w-4 h-4" />
              <span>90°</span>
            </button>
          </div>
        )}

        {activeTab === 'filter' && (
          <div className="flex items-center justify-start sm:justify-center gap-2 overflow-x-auto pb-1">
            {SCAN_FILTERS.map((f) => {
              const active = filter === f.id;
              return (
                <button
                  key={f.id}
                  onClick={() => setFilter(f.id)}
                  className={`flex flex-col items-center gap-1.5 px-3 py-2 rounded-xl border transition-colors shrink-0 min-w-[76px] ${
                    active
                      ? 'border-orange-500 bg-orange-500/15 text-orange-300'
                      : 'border-white/10 bg-white/5 text-white/75 hover:bg-white/10'
                  }`}
                >
                  <div className="w-10 h-12 rounded overflow-hidden bg-white">
                    <img
                      src={page.imageUrl}
                      alt={f.label}
                      referrerPolicy="no-referrer"
                      className={`w-full h-full object-cover scan-filter-${f.id}`}
                    />
                  </div>
                  <span className="text-[11px] font-medium whitespace-nowrap">{f.shortLabel}</span>
                </button>
              );
            })}
          </div>
        )}

        {activeTab === 'adjust' && (
          <div className="max-w-md mx-auto grid grid-cols-1 sm:grid-cols-2 gap-4 py-1">
            <label className="flex flex-col gap-1.5">
              <div className="flex justify-between text-xs text-white/80">
                <span>Brightness</span>
                <span className="font-mono tabular-nums">{Math.round(brightness * 100)}%</span>
              </div>
              <input
                type="range"
                min="0.7"
                max="1.35"
                step="0.02"
                value={brightness}
                onChange={(e) => setBrightness(parseFloat(e.target.value))}
                className="accent-orange-500"
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <div className="flex justify-between text-xs text-white/80">
                <span>Contrast</span>
                <span className="font-mono tabular-nums">{Math.round(contrast * 100)}%</span>
              </div>
              <input
                type="range"
                min="0.7"
                max="1.5"
                step="0.02"
                value={contrast}
                onChange={(e) => setContrast(parseFloat(e.target.value))}
                className="accent-orange-500"
              />
            </label>
          </div>
        )}

        {/* Segmented Mode Switcher */}
        <div className="max-w-sm mx-auto grid grid-cols-3 gap-1 p-1 rounded-xl bg-white/8">
          {(
            [
              { id: 'crop', label: 'Crop' },
              { id: 'filter', label: 'Filters' },
              { id: 'adjust', label: 'Adjust' },
            ] as const
          ).map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`min-h-[38px] rounded-lg text-xs font-semibold transition-colors flex items-center justify-center gap-1.5 ${
                activeTab === tab.id
                  ? 'bg-orange-600 text-white'
                  : 'text-white/70 hover:text-white'
              }`}
            >
              {tab.id === 'adjust' && <SlidersHorizontal className="w-3.5 h-3.5" />}
              <span>{tab.label}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
};
