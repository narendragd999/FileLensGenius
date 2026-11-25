import React, { useRef, useState } from 'react';
import {
  Check,
  Maximize2,
  RotateCw,
  SlidersHorizontal,
  Sparkles,
  X,
} from 'lucide-react';
import { DocumentPage, FULL_QUAD, NormalizedQuad, ScanFilterId } from '../types/filelens';
import { SCAN_FILTERS } from '../data/seedData';
import { detectQuadFromImageUrl } from '../utils/documentEdgeDetector';

interface PerspectiveCropModalProps {
  page: DocumentPage;
  pageNumber: number;
  onSave: (updated: DocumentPage) => void;
  onClose: () => void;
}

type CornerKey = 'tl' | 'tr' | 'br' | 'bl';

export const PerspectiveCropModal: React.FC<PerspectiveCropModalProps> = ({
  page,
  pageNumber,
  onSave,
  onClose,
}) => {
  const [quad, setQuad] = useState<NormalizedQuad>(page.quad);
  const [filter, setFilter] = useState<ScanFilterId>(page.filter);
  const [rotation, setRotation] = useState<0 | 90 | 180 | 270>(page.rotation);
  const [brightness, setBrightness] = useState<number>(page.brightness ?? 1);
  const [contrast, setContrast] = useState<number>(page.contrast ?? 1);
  const [activeTab, setActiveTab] = useState<'crop' | 'filter' | 'adjust'>('crop');
  const [draggingCorner, setDraggingCorner] = useState<CornerKey | null>(null);
  const [isDetecting, setIsDetecting] = useState<boolean>(false);
  const stageRef = useRef<HTMLDivElement | null>(null);

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingCorner || !stageRef.current) return;
    const rect = stageRef.current.getBoundingClientRect();
    const nx = Math.max(0.01, Math.min(0.99, (e.clientX - rect.left) / rect.width));
    const ny = Math.max(0.01, Math.min(0.99, (e.clientY - rect.top) / rect.height));

    setQuad((prev) => {
      if (draggingCorner === 'tl') return { ...prev, tlX: Math.min(nx, prev.trX - 0.1), tlY: Math.min(ny, prev.blY - 0.1) };
      if (draggingCorner === 'tr') return { ...prev, trX: Math.max(nx, prev.tlX + 0.1), trY: Math.min(ny, prev.brY - 0.1) };
      if (draggingCorner === 'br') return { ...prev, brX: Math.max(nx, prev.blX + 0.1), brY: Math.max(ny, prev.trY + 0.1) };
      return { ...prev, blX: Math.min(nx, prev.brX - 0.1), blY: Math.max(ny, prev.tlY + 0.1) };
    });
  };

  const autoDetectEdges = async () => {
    setIsDetecting(true);
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

  const resetFullFrame = () => setQuad(FULL_QUAD);

  const rotateRight = () => {
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

  const polygonPoints = `${quad.tlX * 100},${quad.tlY * 100} ${quad.trX * 100},${quad.trY * 100} ${quad.brX * 100},${quad.brY * 100} ${quad.blX * 100},${quad.blY * 100}`;

  return (
    <div
      className="fixed inset-0 h-[100dvh] max-h-[100dvh] w-full overflow-hidden z-50 flex flex-col bg-[#0C0C0E] text-white"
      role="dialog"
      aria-modal="true"
      aria-label={`Edit Page ${pageNumber}`}
    >
      {/* Top iOS Studio Bar */}
      <div className="shrink-0 pt-safe flex items-center justify-between px-4 min-h-[52px] py-1.5 border-b border-white/10">
        <button
          onClick={onClose}
          className="min-h-[44px] min-w-[44px] flex items-center gap-1.5 text-sm font-medium text-white/80 hover:text-white transition-colors"
        >
          <X className="w-5 h-5" />
          <span>Cancel</span>
        </button>
        <div className="text-center">
          <h2 className="text-sm font-semibold tracking-tight">Edit Page {pageNumber}</h2>
        </div>
        <button
          onClick={handleSave}
          className="min-h-[40px] px-4 rounded-xl bg-orange-600 hover:bg-orange-500 text-white text-sm font-semibold flex items-center gap-1.5 transition-colors whitespace-nowrap"
        >
          <Check className="w-4 h-4" />
          <span>Apply</span>
        </button>
      </div>

      {/* Main Dark Stage */}
      <div
        className="flex-1 flex items-center justify-center p-6 overflow-hidden select-none touch-none"
        onPointerMove={handlePointerMove}
        onPointerUp={() => setDraggingCorner(null)}
        onPointerLeave={() => setDraggingCorner(null)}
      >
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
              className={`w-full h-full object-contain scan-filter-${filter} rounded-sm`}
              style={{ filter: `brightness(${brightness}) contrast(${contrast})` }}
              draggable={false}
            />
          </div>

          {/* Genius Scan Signature Orange Perspective Quad Overlay */}
          {activeTab === 'crop' && (
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

              {corners.map((corner) => (
                <button
                  key={corner.key}
                  type="button"
                  aria-label={`Drag ${corner.key} corner`}
                  onPointerDown={(e) => {
                    e.currentTarget.setPointerCapture(e.pointerId);
                    setDraggingCorner(corner.key);
                  }}
                  style={{
                    left: `${corner.x * 100}%`,
                    top: `${corner.y * 100}%`,
                  }}
                  className={`absolute -translate-x-1/2 -translate-y-1/2 w-10 h-10 flex items-center justify-center cursor-grab active:cursor-grabbing ${
                    draggingCorner === corner.key ? 'scale-125' : ''
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
          <div className="flex items-center justify-center gap-3 flex-wrap">
            <button
              onClick={autoDetectEdges}
              disabled={isDetecting}
              className="min-h-[40px] px-4 rounded-xl bg-white/10 hover:bg-white/15 text-xs font-semibold flex items-center gap-1.5 transition-colors disabled:opacity-50"
            >
              <Sparkles className="w-4 h-4 text-orange-400" />
              <span>{isDetecting ? 'Detecting…' : 'Auto Edges'}</span>
            </button>
            <button
              onClick={resetFullFrame}
              className="min-h-[40px] px-4 rounded-xl bg-white/10 hover:bg-white/15 text-xs font-semibold flex items-center gap-1.5 transition-colors"
            >
              <Maximize2 className="w-4 h-4" />
              <span>Full Page</span>
            </button>
            <button
              onClick={rotateRight}
              className="min-h-[40px] px-4 rounded-xl bg-white/10 hover:bg-white/15 text-xs font-semibold flex items-center gap-1.5 transition-colors"
            >
              <RotateCw className="w-4 h-4" />
              <span>Rotate 90°</span>
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
