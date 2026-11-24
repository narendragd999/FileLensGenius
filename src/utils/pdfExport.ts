import { jsPDF } from 'jspdf';
import {
  DocumentPage,
  PdfQualityPreset,
  ScanDocument,
  ScanFilterId,
  WatermarkConfig,
} from '../types/filelens';
import { triggerFileDownload } from './formatters';

function getCanvasFilterString(filter: ScanFilterId, brightness: number, contrast: number): string {
  const b = brightness ?? 1;
  const c = contrast ?? 1;
  switch (filter) {
    case 'magic':
      return `contrast(${(1.18 * c).toFixed(2)}) saturate(1.15) brightness(${(1.04 * b).toFixed(2)})`;
    case 'bw':
      return `grayscale(1) contrast(${(1.85 * c).toFixed(2)}) brightness(${(1.12 * b).toFixed(2)})`;
    case 'whiteboard':
      return `contrast(${(1.38 * c).toFixed(2)}) brightness(${(1.16 * b).toFixed(2)}) saturate(1.25)`;
    case 'grayscale':
      return `grayscale(1) contrast(${(1.15 * c).toFixed(2)}) brightness(${(1.02 * b).toFixed(2)})`;
    case 'original':
    default:
      return `brightness(${b.toFixed(2)}) contrast(${c.toFixed(2)})`;
  }
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = (err) => reject(err);
    img.src = src;
  });
}

const QUALITY_CONFIG: Record<PdfQualityPreset, { maxDim: number; jpegQuality: number }> = {
  high: { maxDim: 1800, jpegQuality: 0.9 },
  balanced: { maxDim: 1400, jpegQuality: 0.8 },
  compact: { maxDim: 1000, jpegQuality: 0.65 },
};

export async function renderPageToDataUrl(
  page: DocumentPage,
  watermark: WatermarkConfig | null | undefined,
  quality: PdfQualityPreset
): Promise<{ dataUrl: string; width: number; height: number }> {
  const img = await loadImage(page.imageUrl);
  const { maxDim, jpegQuality } = QUALITY_CONFIG[quality];

  // Crop bounding box from normalized quad
  const minX = Math.max(0, Math.min(page.quad.tlX, page.quad.blX));
  const maxX = Math.min(1, Math.max(page.quad.trX, page.quad.brX));
  const minY = Math.max(0, Math.min(page.quad.tlY, page.quad.trY));
  const maxY = Math.min(1, Math.max(page.quad.blY, page.quad.brY));

  const sx = minX * img.naturalWidth;
  const sy = minY * img.naturalHeight;
  const sw = Math.max(20, (maxX - minX) * img.naturalWidth);
  const sh = Math.max(20, (maxY - minY) * img.naturalHeight);

  const isSideways = page.rotation === 90 || page.rotation === 270;
  const rawW = isSideways ? sh : sw;
  const rawH = isSideways ? sw : sh;

  const scale = Math.min(1, maxDim / Math.max(rawW, rawH));
  const outW = Math.round(rawW * scale);
  const outH = Math.round(rawH * scale);

  const canvas = document.createElement('canvas');
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D unavailable');

  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, outW, outH);

  ctx.save();
  ctx.filter = getCanvasFilterString(page.filter, page.brightness, page.contrast);
  ctx.translate(outW / 2, outH / 2);
  ctx.rotate((page.rotation * Math.PI) / 180);
  const drawW = Math.round(sw * scale);
  const drawH = Math.round(sh * scale);
  ctx.drawImage(img, sx, sy, sw, sh, -drawW / 2, -drawH / 2, drawW, drawH);
  ctx.restore();

  // Render placed e-signatures
  for (const sig of page.signatures) {
    try {
      const sigImg = await loadImage(sig.dataUrl);
      const sigW = outW * sig.widthFraction;
      const sigH = (sigImg.naturalHeight / Math.max(1, sigImg.naturalWidth)) * sigW;
      const x = sig.posX * outW;
      const y = sig.posY * outH;
      ctx.drawImage(sigImg, x, y, sigW, sigH);
      if (sig.includeDateStamp) {
        ctx.font = `600 ${Math.max(12, Math.round(outW * 0.018))}px "Plus Jakarta Sans", sans-serif`;
        ctx.fillStyle = '#1E3A8A';
        ctx.fillText(sig.dateLabel || new Date().toLocaleDateString(), x, y + sigH + 18);
      }
    } catch {
      // Skip unreadable signature
    }
  }

  // Render diagonal watermark if enabled
  if (watermark && watermark.text.trim()) {
    ctx.save();
    ctx.translate(outW / 2, outH / 2);
    ctx.rotate((-35 * Math.PI) / 180);
    ctx.globalAlpha = watermark.opacity;
    ctx.fillStyle = watermark.color;
    const fontSize = Math.max(24, Math.round(outW * 0.095));
    ctx.font = `700 ${fontSize}px "Plus Jakarta Sans", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(watermark.text.toUpperCase(), 0, 0);
    ctx.restore();
  }

  return {
    dataUrl: canvas.toDataURL('image/jpeg', jpegQuality),
    width: outW,
    height: outH,
  };
}

export async function exportDocumentAsPdf(doc: ScanDocument): Promise<void> {
  if (doc.pages.length === 0) return;

  const firstRendered = await renderPageToDataUrl(doc.pages[0], doc.watermark, doc.qualityPreset);

  const getPageDimensions = (imgW: number, imgH: number): [number, number] => {
    const isLandscape = imgW > imgH;
    if (doc.pageSizePreset === 'a4') {
      return isLandscape ? [297, 210] : [210, 297];
    }
    if (doc.pageSizePreset === 'letter') {
      return isLandscape ? [279.4, 215.9] : [215.9, 279.4];
    }
    // Auto fit (mm proportional to pixels at ~96dpi scaled to A4 width)
    const widthMm = isLandscape ? 280 : 210;
    const heightMm = (imgH / imgW) * widthMm;
    return [widthMm, heightMm];
  };

  const [firstW, firstH] = getPageDimensions(firstRendered.width, firstRendered.height);
  const pdf = new jsPDF({
    orientation: firstW > firstH ? 'landscape' : 'portrait',
    unit: 'mm',
    format: [firstW, firstH],
  });

  const addFittedImage = (
    pdfDoc: jsPDF,
    dataUrl: string,
    imgW: number,
    imgH: number,
    pageW: number,
    pageH: number
  ) => {
    const margin = doc.pageSizePreset === 'auto' ? 0 : 8;
    const availW = pageW - margin * 2;
    const availH = pageH - margin * 2;
    const ratio = Math.min(availW / imgW, availH / imgH);
    const drawW = imgW * ratio;
    const drawH = imgH * ratio;
    const x = (pageW - drawW) / 2;
    const y = (pageH - drawH) / 2;
    pdfDoc.addImage(dataUrl, 'JPEG', x, y, drawW, drawH, undefined, 'FAST');
  };

  addFittedImage(pdf, firstRendered.dataUrl, firstRendered.width, firstRendered.height, firstW, firstH);

  for (let i = 1; i < doc.pages.length; i++) {
    const rendered = await renderPageToDataUrl(doc.pages[i], doc.watermark, doc.qualityPreset);
    const [pW, pH] = getPageDimensions(rendered.width, rendered.height);
    pdf.addPage([pW, pH], pW > pH ? 'landscape' : 'portrait');
    addFittedImage(pdf, rendered.dataUrl, rendered.width, rendered.height, pW, pH);
  }

  const safeName = doc.title.replace(/[^a-zA-Z0-9._ -]/g, '').trim() || 'FileLens_Document';
  pdf.save(`${safeName}.pdf`);
}

export async function exportSinglePageAsJpeg(
  doc: ScanDocument,
  pageIndex: number
): Promise<void> {
  const page = doc.pages[pageIndex];
  if (!page) return;
  const rendered = await renderPageToDataUrl(page, doc.watermark, doc.qualityPreset);
  const res = await fetch(rendered.dataUrl);
  const blob = await res.blob();
  const safeName = doc.title.replace(/[^a-zA-Z0-9._ -]/g, '').trim() || 'Scan';
  triggerFileDownload(blob, `${safeName}_Page${pageIndex + 1}.jpg`);
}

export async function composeTwoInOneA4IdCard(frontUrl: string, backUrl: string): Promise<string> {
  const canvas = document.createElement('canvas');
  canvas.width = 1240;
  canvas.height = 1754; // A4 @ 150dpi
  const ctx = canvas.getContext('2d');
  if (!ctx) return frontUrl;

  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const drawCard = async (url: string, centerY: number, label: string) => {
    const img = await loadImage(url);
    const maxW = 860;
    const maxH = 560;
    const ratio = Math.min(maxW / img.naturalWidth, maxH / img.naturalHeight);
    const w = img.naturalWidth * ratio;
    const h = img.naturalHeight * ratio;
    const x = (canvas.width - w) / 2;
    const y = centerY - h / 2;

    ctx.save();
    ctx.shadowColor = 'rgba(15, 23, 42, 0.12)';
    ctx.shadowBlur = 18;
    ctx.shadowOffsetY = 6;
    ctx.drawImage(img, x, y, w, h);
    ctx.restore();

    ctx.strokeStyle = '#E2E8F0';
    ctx.lineWidth = 2;
    ctx.strokeRect(x, y, w, h);

    ctx.fillStyle = '#64748B';
    ctx.font = '600 22px "Plus Jakarta Sans", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(label, canvas.width / 2, y + h + 40);
  };

  await drawCard(frontUrl, 520, 'FRONT SIDE');
  await drawCard(backUrl, 1220, 'BACK SIDE');

  return canvas.toDataURL('image/jpeg', 0.9);
}
