import React, { useEffect, useState } from 'react';
import { FileText } from 'lucide-react';
import { DocumentPage, WatermarkConfig } from '../types/filelens';

interface PageCanvasPreviewProps {
  page: DocumentPage;
  watermark?: WatermarkConfig | null;
  className?: string;
  showWatermark?: boolean;
  showSignatures?: boolean;
  blurContent?: boolean;
}

export const PageCanvasPreview: React.FC<PageCanvasPreviewProps> = ({
  page,
  watermark,
  className = '',
  showWatermark = true,
  showSignatures = true,
  blurContent = false,
}) => {
  const [imgError, setImgError] = useState(false);

  useEffect(() => {
    setImgError(false);
  }, [page.imageUrl]);

  const filterClass = `scan-filter-${page.filter}`;
  const isSideways = page.rotation === 90 || page.rotation === 270;

  // Compute CSS clip-path from quad so perspective/crop adjustments visually reflect immediately
  const q = page.quad;
  const isCropped =
    q.tlX > 0.01 ||
    q.tlY > 0.01 ||
    q.trX < 0.99 ||
    q.trY > 0.01 ||
    q.brX < 0.99 ||
    q.brY < 0.99 ||
    q.blX > 0.01 ||
    q.blY < 0.99;

  const clipPath = isCropped
    ? `polygon(${(q.tlX * 100).toFixed(1)}% ${(q.tlY * 100).toFixed(1)}%, ${(q.trX * 100).toFixed(1)}% ${(q.trY * 100).toFixed(1)}%, ${(q.brX * 100).toFixed(1)}% ${(q.brY * 100).toFixed(1)}%, ${(q.blX * 100).toFixed(1)}% ${(q.blY * 100).toFixed(1)}%)`
    : undefined;

  const customBrightness = page.brightness !== 1 || page.contrast !== 1;
  const composeFilter = () => {
    const b = page.brightness ?? 1;
    const c = page.contrast ?? 1;
    if (!customBrightness) return undefined;
    switch (page.filter) {
      case 'magic':
        return `contrast(${(1.14 * c).toFixed(2)}) saturate(1.18) brightness(${(1.03 * b).toFixed(2)})`;
      case 'bw':
        return `grayscale(1) contrast(${(1.65 * c).toFixed(2)}) brightness(${(1.08 * b).toFixed(2)})`;
      case 'whiteboard':
        return `contrast(${(1.38 * c).toFixed(2)}) brightness(${(1.14 * b).toFixed(2)}) saturate(1.28)`;
      case 'grayscale':
        return `grayscale(1) contrast(${(1.15 * c).toFixed(2)}) brightness(${(1.02 * b).toFixed(2)})`;
      default:
        return `brightness(${b.toFixed(2)}) contrast(${c.toFixed(2)})`;
    }
  };
  const inlineFilter = composeFilter();

  return (
    <div
      className={`relative overflow-hidden bg-white select-none flex items-center justify-center ${className}`}
    >
      {imgError ? (
        <div className="flex flex-col items-center justify-center gap-2 p-4 text-center text-slate-400 bg-slate-50 w-full h-full">
          <FileText className="w-8 h-8 text-slate-300" />
          <span className="text-xs font-medium text-slate-500">Scanned Page</span>
        </div>
      ) : (
        <div
          className="relative w-full h-full flex items-center justify-center transition-transform duration-200 ease-out"
          style={{
            transform: `rotate(${page.rotation}deg) scale(${isSideways ? 0.74 : 1})`,
          }}
        >
          <img
            src={page.imageUrl}
            alt="Scanned document page"
            referrerPolicy="no-referrer"
            onError={() => setImgError(true)}
            className={`w-full h-full object-contain ${filterClass} ${
              blurContent ? 'blur-md scale-105' : ''
            }`}
            style={{
              clipPath,
              filter: inlineFilter,
            }}
            draggable={false}
          />
        </div>
      )}

      {/* Placed E-Signatures */}
      {showSignatures &&
        page.signatures.map((sig) => (
          <div
            key={sig.id}
            className="pointer-events-none absolute"
            style={{
              left: `${sig.posX * 100}%`,
              top: `${sig.posY * 100}%`,
              width: `${sig.widthFraction * 100}%`,
            }}
          >
            <img
              src={sig.dataUrl}
              alt="Document signature"
              className="w-full h-auto object-contain"
              draggable={false}
            />
            {sig.includeDateStamp && (
              <div className="text-[9px] font-mono font-semibold text-blue-900 leading-tight mt-0.5">
                {sig.dateLabel || new Date().toLocaleDateString()}
              </div>
            )}
          </div>
        ))}

      {/* Diagonal Watermark Overlay */}
      {showWatermark && watermark && watermark.text.trim() && (
        <div
          className="pointer-events-none absolute inset-0 flex items-center justify-center overflow-hidden"
          aria-hidden="true"
        >
          <span
            className="font-bold uppercase tracking-[0.2em] whitespace-nowrap -rotate-35 text-center"
            style={{
              color: watermark.color,
              opacity: watermark.opacity,
              fontSize: 'clamp(12px, 5vw, 32px)',
            }}
          >
            {watermark.text}
          </span>
        </div>
      )}
    </div>
  );
};
