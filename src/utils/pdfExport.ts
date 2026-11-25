import { jsPDF, jsPDFOptions } from 'jspdf';
import JSZip from 'jszip';
import { rectifyQuadWithNativeSkia } from './deviceRoots';
import {
  DocumentPage,
  FULL_QUAD,
  NormalizedQuad,
  OcrLanguage,
  PdfCompressPreset,
  PdfQualityPreset,
  PhotoCompressPreset,
  ScanDocument,
  ScanFilterId,
  WatermarkConfig,
} from '../types/filelens';
import {
  estimateRectifiedAspectRatio,
  isFullQuad,
  warpPerspectiveToCanvas,
} from './documentEdgeDetector';
import { triggerFileDownload } from './formatters';
import { recognizeImageWithWordBoxes } from './smartIndexer';

function getCanvasFilterString(filter: ScanFilterId, brightness: number, contrast: number): string {
  const b = brightness ?? 1;
  const c = contrast ?? 1;
  switch (filter) {
    case 'magic':
      return `contrast(${(1.14 * c).toFixed(2)}) saturate(1.18) brightness(${(1.03 * b).toFixed(2)})`;
    case 'bw':
      return `grayscale(1) contrast(${(1.65 * c).toFixed(2)}) brightness(${(1.08 * b).toFixed(2)})`;
    case 'whiteboard':
      return `contrast(${(1.38 * c).toFixed(2)}) brightness(${(1.14 * b).toFixed(2)}) saturate(1.28)`;
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

/**
 * Morphological local illumination normalization (ported from FileLensMobile OcrAndPdfEngine.kt):
 * Downsamples to a ~48px grid, takes 3x3 max-dilation to estimate paper background,
 * and divides per-channel illumination so shadows/creases become clean white.
 */
function applyMorphologicalDocFilter(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  filter: ScanFilterId
): void {
  if (filter !== 'magic' && filter !== 'bw') return;
  if (width < 16 || height < 16) return;

  const imgData = ctx.getImageData(0, 0, width, height);
  const data = imgData.data;

  // Downsample grid (~48x48) for fast 3x3 max-dilation background estimation
  const gw = Math.min(56, Math.max(12, Math.round(width / 24)));
  const gh = Math.min(56, Math.max(12, Math.round(height / 24)));
  const bgR = new Float32Array(gw * gh);
  const bgG = new Float32Array(gw * gh);
  const bgB = new Float32Array(gw * gh);

  for (let gy = 0; gy < gh; gy++) {
    const sy0 = Math.floor((gy * height) / gh);
    const sy1 = Math.min(height, Math.floor(((gy + 1) * height) / gh));
    for (let gx = 0; gx < gw; gx++) {
      const sx0 = Math.floor((gx * width) / gw);
      const sx1 = Math.min(width, Math.floor(((gx + 1) * width) / gw));
      let maxR = 140;
      let maxG = 140;
      let maxB = 140;
      const stepY = Math.max(1, Math.floor((sy1 - sy0) / 4));
      const stepX = Math.max(1, Math.floor((sx1 - sx0) / 4));
      for (let y = sy0; y < sy1; y += stepY) {
        for (let x = sx0; x < sx1; x += stepX) {
          const i = (y * width + x) * 4;
          if (data[i] > maxR) maxR = data[i];
          if (data[i + 1] > maxG) maxG = data[i + 1];
          if (data[i + 2] > maxB) maxB = data[i + 2];
        }
      }
      const gi = gy * gw + gx;
      bgR[gi] = maxR;
      bgG[gi] = maxG;
      bgB[gi] = maxB;
    }
  }

  // 3x3 max dilation pass over grid
  const dilR = new Float32Array(gw * gh);
  const dilG = new Float32Array(gw * gh);
  const dilB = new Float32Array(gw * gh);
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      let mR = 128;
      let mG = 128;
      let mB = 128;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = Math.max(0, Math.min(gh - 1, gy + dy));
        for (let dx = -1; dx <= 1; dx++) {
          const nx = Math.max(0, Math.min(gw - 1, gx + dx));
          const ni = ny * gw + nx;
          if (bgR[ni] > mR) mR = bgR[ni];
          if (bgG[ni] > mG) mG = bgG[ni];
          if (bgB[ni] > mB) mB = bgB[ni];
        }
      }
      const gi = gy * gw + gx;
      dilR[gi] = mR;
      dilG[gi] = mG;
      dilB[gi] = mB;
    }
  }

  // Normalize each pixel against local background
  for (let y = 0; y < height; y++) {
    const gy = Math.min(gh - 1, Math.floor((y * gh) / height));
    const rowOff = gy * gw;
    for (let x = 0; x < width; x++) {
      const gx = Math.min(gw - 1, Math.floor((x * gw) / width));
      const gi = rowOff + gx;
      const idx = (y * width + x) * 4;

      let r = (data[idx] * 255) / dilR[gi];
      let g = (data[idx + 1] * 255) / dilG[gi];
      let b = (data[idx + 2] * 255) / dilB[gi];

      if (filter === 'bw') {
        const lum = 0.299 * r + 0.587 * g + 0.114 * b;
        const val = lum >= 205 ? 255 : lum <= 130 ? Math.max(0, lum * 0.45) : (lum - 130) * (255 / 75);
        data[idx] = val;
        data[idx + 1] = val;
        data[idx + 2] = val;
      } else {
        // Magic color: highlight rolloff >= 216 -> pure white + 1.12x ink contrast
        if (r > 216 && g > 216 && b > 216) {
          r = 255;
          g = 255;
          b = 255;
        }
        data[idx] = Math.max(0, Math.min(255, r));
        data[idx + 1] = Math.max(0, Math.min(255, g));
        data[idx + 2] = Math.max(0, Math.min(255, b));
      }
    }
  }

  ctx.putImageData(imgData, 0, 0);
}

const QUALITY_CONFIG: Record<PdfQualityPreset, { maxDim: number; jpegQuality: number }> = {
  high: { maxDim: 2400, jpegQuality: 0.93 },
  balanced: { maxDim: 1700, jpegQuality: 0.80 },
  compact: { maxDim: 1200, jpegQuality: 0.62 },
  small: { maxDim: 900, jpegQuality: 0.42 },
};

export async function renderPageToDataUrl(
  page: DocumentPage,
  watermark: WatermarkConfig | null | undefined,
  quality: PdfQualityPreset
): Promise<{ dataUrl: string; width: number; height: number }> {
  const img = await loadImage(page.imageUrl);
  const { maxDim, jpegQuality } = QUALITY_CONFIG[quality];

  // Step 1: True perspective warp if quad is not full frame
  let sourceCanvas: HTMLCanvasElement;
  if (!isFullQuad(page.quad)) {
    const aspect = estimateRectifiedAspectRatio(page.quad, img.naturalWidth, img.naturalHeight);
    const baseW = Math.min(
      maxDim,
      Math.max(
        400,
        Math.round(
          Math.max(
            Math.hypot((page.quad.trX - page.quad.tlX) * img.naturalWidth, (page.quad.trY - page.quad.tlY) * img.naturalHeight),
            Math.hypot((page.quad.brX - page.quad.blX) * img.naturalWidth, (page.quad.brY - page.quad.blY) * img.naturalHeight)
          )
        )
      )
    );
    const targetW = aspect >= 1 ? baseW : Math.round(baseW * aspect);
    const targetH = aspect >= 1 ? Math.round(baseW / aspect) : baseW;
    sourceCanvas = warpPerspectiveToCanvas(img, page.quad, targetW, targetH);
  } else {
    const scale0 = Math.min(1, maxDim / Math.max(img.naturalWidth, img.naturalHeight));
    sourceCanvas = document.createElement('canvas');
    sourceCanvas.width = Math.max(1, Math.round(img.naturalWidth * scale0));
    sourceCanvas.height = Math.max(1, Math.round(img.naturalHeight * scale0));
    const sCtx = sourceCanvas.getContext('2d');
    if (sCtx) sCtx.drawImage(img, 0, 0, sourceCanvas.width, sourceCanvas.height);
  }

  const sw = sourceCanvas.width;
  const sh = sourceCanvas.height;
  const isSideways = page.rotation === 90 || page.rotation === 270;
  const outW = isSideways ? sh : sw;
  const outH = isSideways ? sw : sh;

  const canvas = document.createElement('canvas');
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Canvas 2D unavailable');

  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, outW, outH);

  ctx.save();
  ctx.filter = getCanvasFilterString(page.filter, page.brightness, page.contrast);
  ctx.translate(outW / 2, outH / 2);
  ctx.rotate((page.rotation * Math.PI) / 180);
  ctx.drawImage(sourceCanvas, -sw / 2, -sh / 2, sw, sh);
  ctx.restore();

  // Apply morphological local illumination normalization for magic/bw
  applyMorphologicalDocFilter(ctx, outW, outH, page.filter);

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

/**
 * Straighten a skewed/cropped quadrilateral into a full-bleed rectangular scan image
 * (with optional rotation baked in) so previews, thumbnails, and PDF exports are 100% aligned.
 */
export async function rectifyPageToStraightImage(
  rawImageUrl: string,
  quad: NormalizedQuad,
  rotation: 0 | 90 | 180 | 270 = 0,
  maxDim = 2400
): Promise<string> {
  if (isFullQuad(quad) && rotation === 0) return rawImageUrl;
  const nativeUrl = await rectifyQuadWithNativeSkia(rawImageUrl, quad, rotation, maxDim);
  if (nativeUrl) return nativeUrl;
  const img = await loadImage(rawImageUrl);

  let warped: HTMLCanvasElement;
  if (!isFullQuad(quad)) {
    const aspect = estimateRectifiedAspectRatio(quad, img.naturalWidth, img.naturalHeight);
    const baseW = Math.min(
      maxDim,
      Math.max(
        700,
        Math.round(
          Math.max(
            Math.hypot((quad.trX - quad.tlX) * img.naturalWidth, (quad.trY - quad.tlY) * img.naturalHeight),
            Math.hypot((quad.brX - quad.blX) * img.naturalWidth, (quad.brY - quad.blY) * img.naturalHeight)
          )
        )
      )
    );
    const targetW = aspect >= 1 ? baseW : Math.round(baseW * aspect);
    const targetH = aspect >= 1 ? Math.round(baseW / aspect) : baseW;
    warped = warpPerspectiveToCanvas(img, quad, targetW, targetH);
  } else {
    const scale = Math.min(1, maxDim / Math.max(img.naturalWidth, img.naturalHeight));
    warped = document.createElement('canvas');
    warped.width = Math.max(1, Math.round(img.naturalWidth * scale));
    warped.height = Math.max(1, Math.round(img.naturalHeight * scale));
    const wCtx = warped.getContext('2d');
    if (wCtx) wCtx.drawImage(img, 0, 0, warped.width, warped.height);
  }

  if (rotation === 0) {
    return warped.toDataURL('image/jpeg', 0.94);
  }

  const isSideways = rotation === 90 || rotation === 270;
  const out = document.createElement('canvas');
  out.width = isSideways ? warped.height : warped.width;
  out.height = isSideways ? warped.width : warped.height;
  const oCtx = out.getContext('2d');
  if (!oCtx) return warped.toDataURL('image/jpeg', 0.9);

  oCtx.translate(out.width / 2, out.height / 2);
  oCtx.rotate((rotation * Math.PI) / 180);
  oCtx.drawImage(warped, -warped.width / 2, -warped.height / 2);
  return out.toDataURL('image/jpeg', 0.9);
}

export async function exportDocumentAsPdf(
  doc: ScanDocument,
  password?: string
): Promise<void> {
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
    const widthMm = isLandscape ? 280 : 210;
    const heightMm = (imgH / imgW) * widthMm;
    return [widthMm, heightMm];
  };

  const [firstW, firstH] = getPageDimensions(firstRendered.width, firstRendered.height);
  const pdfOptions: jsPDFOptions = {
    orientation: firstW > firstH ? 'landscape' : 'portrait',
    unit: 'mm',
    format: [firstW, firstH],
  };

  if (password && password.trim()) {
    pdfOptions.encryption = {
      userPassword: password.trim(),
      ownerPassword: password.trim(),
      userPermissions: ['print', 'copy'],
    };
  }

  const pdf = new jsPDF(pdfOptions);

  const addFittedImageAndOcr = (
    pdfDoc: jsPDF,
    dataUrl: string,
    imgW: number,
    imgH: number,
    pageW: number,
    pageH: number,
    ocrText: string
  ) => {
    // Embed invisible searchable OCR text layer behind image if enabled
    if (doc.searchableOcr && ocrText && ocrText.trim()) {
      try {
        pdfDoc.setFontSize(9);
        const lines = pdfDoc.splitTextToSize(ocrText.trim(), pageW - 20).slice(0, 65);
        pdfDoc.text(lines, 10, 14, { renderingMode: 'invisible' } as never);
      } catch {
        // Fallback if renderingMode option unavailable
      }
    }

    // Full-bleed fit to PDF page (Genius Scan iOS style)
    const margin = 0;
    const availW = pageW - margin * 2;
    const availH = pageH - margin * 2;
    const ratio = Math.min(availW / imgW, availH / imgH);
    const drawW = imgW * ratio;
    const drawH = imgH * ratio;
    const x = (pageW - drawW) / 2;
    const y = (pageH - drawH) / 2;
    pdfDoc.addImage(dataUrl, 'JPEG', x, y, drawW, drawH, undefined, 'FAST');
  };

  addFittedImageAndOcr(
    pdf,
    firstRendered.dataUrl,
    firstRendered.width,
    firstRendered.height,
    firstW,
    firstH,
    doc.pages[0].ocrText
  );

  for (let i = 1; i < doc.pages.length; i++) {
    const rendered = await renderPageToDataUrl(doc.pages[i], doc.watermark, doc.qualityPreset);
    const [pW, pH] = getPageDimensions(rendered.width, rendered.height);
    pdf.addPage([pW, pH], pW > pH ? 'landscape' : 'portrait');
    addFittedImageAndOcr(
      pdf,
      rendered.dataUrl,
      rendered.width,
      rendered.height,
      pW,
      pH,
      doc.pages[i].ocrText
    );
  }

  const safeName = doc.title.replace(/[^a-zA-Z0-9._ -]/g, '').trim() || 'FileLens_Document';
  if (typeof window !== 'undefined' && typeof window.FileLensAndroid?.saveToPublicDocuments === 'function') {
    const dataUri = pdf.output('datauristring');
    const savedPath = window.FileLensAndroid.saveToPublicDocuments(`${safeName}.pdf`, 'application/pdf', dataUri);
    if (savedPath) return;
  }
  pdf.save(`${safeName}.pdf`);
}

async function buildPortablePdfDataUri(doc: ScanDocument): Promise<{ safeName: string; dataUri: string }> {
  const safeName = doc.title.replace(/[^a-zA-Z0-9._ -]/g, '').trim() || 'FileLens_Document';
  const firstRendered = await renderPageToDataUrl(doc.pages[0], doc.watermark, doc.qualityPreset);
  const firstOri = firstRendered.width > firstRendered.height ? 'landscape' : 'portrait';
  const pdf = new jsPDF({ orientation: firstOri, unit: 'mm', format: 'a4' });
  for (let i = 0; i < doc.pages.length; i++) {
    const rendered =
      i === 0 ? firstRendered : await renderPageToDataUrl(doc.pages[i], doc.watermark, doc.qualityPreset);
    const w = pdf.internal.pageSize.getWidth();
    const h = pdf.internal.pageSize.getHeight();
    if (i > 0) pdf.addPage('a4', rendered.width > rendered.height ? 'landscape' : 'portrait');
    const ratio = Math.min(w / rendered.width, h / rendered.height);
    const dw = rendered.width * ratio;
    const dh = rendered.height * ratio;
    pdf.addImage(rendered.dataUrl, 'JPEG', (w - dw) / 2, (h - dh) / 2, dw, dh, undefined, 'FAST');
  }
  return { safeName, dataUri: pdf.output('datauristring') };
}

export async function openDocumentInNativeViewer(doc: ScanDocument): Promise<boolean> {
  if (
    doc.pages.length === 0 ||
    typeof window === 'undefined' ||
    typeof window.FileLensAndroid?.openInNativeViewer !== 'function'
  ) {
    return false;
  }
  const { safeName, dataUri } = await buildPortablePdfDataUri(doc);
  return window.FileLensAndroid.openInNativeViewer(`${safeName}.pdf`, 'application/pdf', dataUri);
}

export async function shareDocumentAsPdf(doc: ScanDocument): Promise<boolean> {
  if (
    doc.pages.length === 0 ||
    typeof window === 'undefined' ||
    typeof window.FileLensAndroid?.shareFileViaNativeChooser !== 'function'
  ) {
    return false;
  }
  const { safeName, dataUri } = await buildPortablePdfDataUri(doc);
  return window.FileLensAndroid.shareFileViaNativeChooser(`${safeName}.pdf`, 'application/pdf', dataUri);
}

export async function exportDocumentPagesAsZip(doc: ScanDocument): Promise<void> {
  if (doc.pages.length === 0) return;
  const zip = new JSZip();
  const safeName = doc.title.replace(/[^a-zA-Z0-9._ -]/g, '').trim() || 'FileLens_Document';
  for (let i = 0; i < doc.pages.length; i++) {
    const rendered = await renderPageToDataUrl(doc.pages[i], doc.watermark, doc.qualityPreset);
    const b64 = rendered.dataUrl.includes(',') ? rendered.dataUrl.split(',')[1] : rendered.dataUrl;
    zip.file(`${safeName}_Page_${i + 1}.jpg`, b64, { base64: true });
  }
  if (typeof window !== 'undefined' && typeof window.FileLensAndroid?.saveToPublicDocuments === 'function') {
    const zipB64 = await zip.generateAsync({ type: 'base64' });
    const saved = window.FileLensAndroid.saveToPublicDocuments(`${safeName}_Pages.zip`, 'application/zip', zipB64);
    if (saved) return;
  }
  const blob = await zip.generateAsync({ type: 'blob' });
  triggerFileDownload(blob, `${safeName}_Pages.zip`);
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
    const slotW = Math.round(canvas.width * 0.76);
    const slotH = Math.round(slotW * 0.63); // ISO/IEC 7810 ID-1 aspect ratio
    const ratio = Math.min(slotW / img.naturalWidth, slotH / img.naturalHeight);
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

    ctx.strokeStyle = '#3B82F6';
    ctx.lineWidth = 2.5;
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

const PDF_COMPRESS_SPEC: Record<PdfCompressPreset, { maxDim: number; quality: number }> = {
  email_small: { maxDim: 1280, quality: 0.62 },
  balanced: { maxDim: 1700, quality: 0.76 },
  print_high: { maxDim: 2200, quality: 0.86 },
};

const PHOTO_COMPRESS_SPEC: Record<PhotoCompressPreset, { maxDim: number; quality: number }> = {
  ultra_compact: { maxDim: 1920, quality: 0.76 },
  lossless_look: { maxDim: 2560, quality: 0.84 },
  max_quality: { maxDim: 3840, quality: 0.9 },
};

function estimateDataUrlBytes(dataUrl: string): number {
  const comma = dataUrl.indexOf(',');
  if (comma === -1) return 0;
  return Math.round(((dataUrl.length - comma - 1) * 3) / 4);
}

async function reencodeImageToSpec(
  imageUrl: string,
  maxDim: number,
  quality: number
): Promise<{ dataUrl: string; bytes: number }> {
  const img = await loadImage(imageUrl);
  const scale = Math.min(1, maxDim / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas unavailable');
  ctx.drawImage(img, 0, 0, w, h);
  const dataUrl = canvas.toDataURL('image/jpeg', quality);
  return { dataUrl, bytes: estimateDataUrlBytes(dataUrl) };
}

/**
 * Real PDF page image compression with 8% savings guard (ported from FileLensMobile).
 */
export async function compressDocumentPagesReal(
  doc: ScanDocument,
  preset: PdfCompressPreset
): Promise<{ updatedDoc: ScanDocument; savedBytes: number; didCompress: boolean }> {
  const { maxDim, quality } = PDF_COMPRESS_SPEC[preset];
  const compressedPages: DocumentPage[] = [];
  let newTotalBytes = 0;

  for (const page of doc.pages) {
    try {
      const { dataUrl, bytes } = await reencodeImageToSpec(page.imageUrl, maxDim, quality);
      const origBytes = estimateDataUrlBytes(page.imageUrl) || Math.round(doc.sizeBytes / Math.max(1, doc.pages.length));
      if (bytes < origBytes * 0.92) {
        compressedPages.push({ ...page, imageUrl: dataUrl });
        newTotalBytes += bytes;
      } else {
        compressedPages.push(page);
        newTotalBytes += origBytes;
      }
    } catch {
      compressedPages.push(page);
    }
  }

  const finalBytes = Math.max(24_000, newTotalBytes);
  const savedBytes = Math.max(0, doc.sizeBytes - finalBytes);
  const didCompress = finalBytes < doc.sizeBytes * 0.92;

  if (!didCompress) {
    return { updatedDoc: doc, savedBytes: 0, didCompress: false };
  }

  const nextQuality: PdfQualityPreset =
    preset === 'email_small' ? 'compact' : preset === 'print_high' ? 'high' : 'balanced';

  return {
    updatedDoc: {
      ...doc,
      pages: compressedPages,
      sizeBytes: finalBytes,
      qualityPreset: nextQuality,
      updatedAt: new Date().toISOString(),
    },
    savedBytes,
    didCompress: true,
  };
}

/**
 * Real Photo compression with 8% savings guard (ported from FileLensMobile smartCompressPhoto).
 */
export async function compressPhotoReal(
  imageUrl: string,
  preset: PhotoCompressPreset,
  origSizeBytes: number
): Promise<{ dataUrl: string; newBytes: number; didCompress: boolean }> {
  const { maxDim, quality } = PHOTO_COMPRESS_SPEC[preset];
  const { dataUrl, bytes } = await reencodeImageToSpec(imageUrl, maxDim, quality);
  if (bytes < origSizeBytes * 0.92) {
    return { dataUrl, newBytes: bytes, didCompress: true };
  }
  return { dataUrl: imageUrl, newBytes: origSizeBytes, didCompress: false };
}

const SENSITIVE_TOKEN_RX =
  /\b(?:\d{4}[\s\-]?\d{4}[\s\-]?\d{4}|[A-Z]{5}\d{4}[A-Z]|(?:\+91[\s\-]?)?[6-9]\d{9}|\d{9,16})\b/g;

/**
 * Privacy Redaction ("Mask & Share Safely", ported from FileLensMobile OcrAndPdfEngine.kt):
 * Detects Aadhaar, PAN, phone, and 9-16 digit numbers via Tesseract word boxes,
 * pixelates and overlays dark rounded mask bars + privacy footer stamp.
 */
export async function redactSensitiveInfoForSharing(
  imageUrl: string,
  ocrLanguage: OcrLanguage = 'eng+hin'
): Promise<{ redactedDataUrl: string; redactedCount: number }> {
  const img = await loadImage(imageUrl);
  const w = img.naturalWidth;
  const h = img.naturalHeight;

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return { redactedDataUrl: imageUrl, redactedCount: 0 };

  ctx.drawImage(img, 0, 0, w, h);

  const { words } = await recognizeImageWithWordBoxes(imageUrl, ocrLanguage);
  let redactedCount = 0;

  // Group adjacent numeric tokens (e.g. 4-4-4 Aadhaar) or match individual sensitive words
  for (let i = 0; i < words.length; i++) {
    const w0 = words[i];
    const combined3 =
      i + 2 < words.length ? `${w0.text} ${words[i + 1].text} ${words[i + 2].text}` : '';

    let box: { x0: number; y0: number; x1: number; y1: number } | null = null;
    if (combined3 && /^\d{4}\s+\d{4}\s+\d{4}$/.test(combined3)) {
      box = {
        x0: Math.min(w0.bbox.x0, words[i + 2].bbox.x0),
        y0: Math.min(w0.bbox.y0, words[i + 1].bbox.y0, words[i + 2].bbox.y0),
        x1: Math.max(w0.bbox.x1, words[i + 1].bbox.x1, words[i + 2].bbox.x1),
        y1: Math.max(w0.bbox.y1, words[i + 1].bbox.y1, words[i + 2].bbox.y1),
      };
      i += 2;
    } else if (SENSITIVE_TOKEN_RX.test(w0.text)) {
      SENSITIVE_TOKEN_RX.lastIndex = 0;
      box = w0.bbox;
    }

    if (box) {
      redactedCount++;
      const pad = 4;
      const rx = Math.max(0, box.x0 - pad);
      const ry = Math.max(0, box.y0 - pad);
      const rw = Math.min(w - rx, box.x1 - box.x0 + pad * 2);
      const rh = Math.min(h - ry, box.y1 - box.y0 + pad * 2);

      // Pixelate region first
      const pix = document.createElement('canvas');
      pix.width = Math.max(4, Math.round(rw / 12));
      pix.height = Math.max(4, Math.round(rh / 12));
      const pCtx = pix.getContext('2d');
      if (pCtx) {
        pCtx.drawImage(canvas, rx, ry, rw, rh, 0, 0, pix.width, pix.height);
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(pix, 0, 0, pix.width, pix.height, rx, ry, rw, rh);
        ctx.imageSmoothingEnabled = true;
      }

      // Draw dark rounded mask bar + bullets
      ctx.fillStyle = 'rgba(15, 23, 42, 0.94)';
      ctx.beginPath();
      ctx.roundRect(rx, ry, rw, rh, 6);
      ctx.fill();

      ctx.fillStyle = '#F8FAFC';
      ctx.font = `700 ${Math.max(10, Math.round(rh * 0.55))}px monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('•••• ••••', rx + rw / 2, ry + rh / 2);
    }
  }

  // Privacy footer stamp
  const bannerH = Math.max(28, Math.round(h * 0.04));
  ctx.fillStyle = 'rgba(15, 23, 42, 0.86)';
  ctx.fillRect(0, h - bannerH, w, bannerH);
  ctx.fillStyle = '#F8FAFC';
  ctx.font = `600 ${Math.max(11, Math.round(bannerH * 0.48))}px "Plus Jakarta Sans", sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(
    `PRIVACY REDACTED (${redactedCount} field${redactedCount === 1 ? '' : 's'}) • FILELENS SCAN`,
    w / 2,
    h - bannerH / 2
  );

  return {
    redactedDataUrl: canvas.toDataURL('image/jpeg', 0.9),
    redactedCount,
  };
}
