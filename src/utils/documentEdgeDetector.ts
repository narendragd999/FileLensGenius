import { FULL_QUAD, NormalizedQuad } from '../types/filelens';

/**
 * Direct TypeScript port of FileLensMobile's DocumentEdgeDetector.kt & LiveDocumentCameraView.kt:
 * - Real-time 8x8 luma visual fingerprint for Anti-Duplicate Smart Page-Change Gate
 * - Perceptual border-vs-center contrast segmentation + RGB max-channel Sobel edge support
 * - Extracts the largest central paper quadrilateral in normalized [0..1] image coordinates
 */

export interface LiveFrameAnalysis {
  quad: NormalizedQuad | null;
  confidence: number;
  fingerprint: Float32Array;
}

export function computeLumaFingerprint8x8(
  rgba: Uint8ClampedArray,
  width: number,
  height: number
): Float32Array {
  const fp = new Float32Array(64);
  const cellW = width / 8;
  const cellH = height / 8;

  for (let gy = 0; gy < 8; gy++) {
    const y0 = Math.floor(gy * cellH);
    const y1 = Math.max(y0 + 1, Math.floor((gy + 1) * cellH));
    for (let gx = 0; gx < 8; gx++) {
      const x0 = Math.floor(gx * cellW);
      const x1 = Math.max(x0 + 1, Math.floor((gx + 1) * cellW));
      let sum = 0;
      let count = 0;
      for (let y = y0; y < y1; y += 2) {
        for (let x = x0; x < x1; x += 2) {
          const idx = (y * width + x) * 4;
          const lum = (rgba[idx] * 299 + rgba[idx + 1] * 587 + rgba[idx + 2] * 114) / 1000;
          sum += lum;
          count++;
        }
      }
      fp[gy * 8 + gx] = count > 0 ? sum / count / 255 : 0;
    }
  }
  return fp;
}

export function computeFingerprintDelta(a: Float32Array | null, b: Float32Array | null): number {
  if (!a || !b || a.length !== b.length) return 1;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff += Math.abs(a[i] - b[i]);
  }
  return diff / a.length;
}

export function computeQuadDelta(a: NormalizedQuad | null, b: NormalizedQuad | null): number {
  if (!a || !b) return 1;
  return (
    Math.abs(a.tlX - b.tlX) +
    Math.abs(a.tlY - b.tlY) +
    Math.abs(a.trX - b.trX) +
    Math.abs(a.trY - b.trY) +
    Math.abs(a.brX - b.brX) +
    Math.abs(a.brY - b.brY) +
    Math.abs(a.blX - b.blX) +
    Math.abs(a.blY - b.blY)
  ) / 8;
}

export function analyzeCanvasFrame(canvas: HTMLCanvasElement): LiveFrameAnalysis {
  const width = canvas.width;
  const height = canvas.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx || width < 24 || height < 24) {
    return { quad: null, confidence: 0, fingerprint: new Float32Array(64) };
  }

  const imageData = ctx.getImageData(0, 0, width, height);
  const data = imageData.data;
  const fingerprint = computeLumaFingerprint8x8(data, width, height);

  // Sample border desk RGB color (outer 8% rim)
  const marginX = Math.max(2, Math.floor(width * 0.08));
  const marginY = Math.max(2, Math.floor(height * 0.08));
  let bR = 0;
  let bG = 0;
  let bB = 0;
  let bCnt = 0;
  let cR = 0;
  let cG = 0;
  let cB = 0;
  let cCnt = 0;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      const r = data[idx];
      const g = data[idx + 1];
      const b = data[idx + 2];

      if (x < marginX || x >= width - marginX || y < marginY || y >= height - marginY) {
        bR += r;
        bG += g;
        bB += b;
        bCnt++;
      } else if (
        x >= width * 0.3 &&
        x <= width * 0.7 &&
        y >= height * 0.3 &&
        y <= height * 0.7
      ) {
        cR += r;
        cG += g;
        cB += b;
        cCnt++;
      }
    }
  }

  const borderR = bR / Math.max(1, bCnt);
  const borderG = bG / Math.max(1, bCnt);
  const borderB = bB / Math.max(1, bCnt);

  const centerR = cR / Math.max(1, cCnt);
  const centerG = cG / Math.max(1, cCnt);
  const centerB = cB / Math.max(1, cCnt);

  const centerDeskDist = Math.hypot(centerR - borderR, centerG - borderG, centerB - borderB);
  if (centerDeskDist < 22) {
    // Low contrast scene (e.g. blank wall or full-frame paper already filling frame)
    return { quad: null, confidence: 0, fingerprint };
  }

  // Perceptual RGB distance mask separating foreground paper sheet from desk background
  const distThresh = Math.max(18, centerDeskDist * 0.46);
  const mask = new Uint8Array(width * height);
  let fgCount = 0;

  for (let y = 2; y < height - 2; y++) {
    const row = y * width;
    for (let x = 2; x < width - 2; x++) {
      const idx = (row + x) * 4;
      const d = Math.hypot(data[idx] - borderR, data[idx + 1] - borderG, data[idx + 2] - borderB);
      if (d >= distThresh) {
        mask[row + x] = 1;
        fgCount++;
      }
    }
  }

  const areaRatio = fgCount / (width * height);
  if (areaRatio < 0.14 || areaRatio > 0.92) {
    return { quad: null, confidence: 0, fingerprint };
  }

  // Extract 4 extreme corners of the foreground sheet using (x+y), (x-y) diagonal projections
  let minSum = Infinity;
  let maxSum = -Infinity;
  let minDiff = Infinity;
  let maxDiff = -Infinity;

  let tlX = width * 0.1;
  let tlY = height * 0.1;
  let brX = width * 0.9;
  let brY = height * 0.9;
  let trX = width * 0.9;
  let trY = height * 0.1;
  let blX = width * 0.1;
  let blY = height * 0.9;

  for (let y = 2; y < height - 2; y++) {
    const row = y * width;
    for (let x = 2; x < width - 2; x++) {
      if (!mask[row + x]) continue;
      // Ignore single-pixel noise by checking 4-neighbors
      if (
        mask[row + x - 1] + mask[row + x + 1] + mask[row - width + x] + mask[row + width + x] <
        2
      ) {
        continue;
      }
      const sum = x + y;
      const diff = x - y;
      if (sum < minSum) {
        minSum = sum;
        tlX = x;
        tlY = y;
      }
      if (sum > maxSum) {
        maxSum = sum;
        brX = x;
        brY = y;
      }
      if (diff > maxDiff) {
        maxDiff = diff;
        trX = x;
        trY = y;
      }
      if (diff < minDiff) {
        minDiff = diff;
        blX = x;
        blY = y;
      }
    }
  }

  const quad: NormalizedQuad = {
    tlX: Math.max(0.02, Math.min(0.45, tlX / width)),
    tlY: Math.max(0.02, Math.min(0.45, tlY / height)),
    trX: Math.max(0.55, Math.min(0.98, trX / width)),
    trY: Math.max(0.02, Math.min(0.45, trY / height)),
    brX: Math.max(0.55, Math.min(0.98, brX / width)),
    brY: Math.max(0.55, Math.min(0.98, brY / height)),
    blX: Math.max(0.02, Math.min(0.45, blX / width)),
    blY: Math.max(0.55, Math.min(0.98, blY / height)),
  };

  // Sanity check quad width & height
  const topW = quad.trX - quad.tlX;
  const botW = quad.brX - quad.blX;
  const leftH = quad.blY - quad.tlY;
  const rightH = quad.brY - quad.trY;
  if (topW < 0.28 || botW < 0.28 || leftH < 0.28 || rightH < 0.28) {
    return { quad: null, confidence: 0, fingerprint };
  }

  const confidence = Math.min(0.96, Math.max(0.55, centerDeskDist / 110));
  return { quad, confidence, fingerprint };
}

export async function detectQuadFromImageUrl(imageUrl: string): Promise<NormalizedQuad> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      const targetW = 140;
      const targetH = Math.max(60, Math.min(220, Math.round((img.naturalHeight / Math.max(1, img.naturalWidth)) * targetW)));
      const canvas = document.createElement('canvas');
      canvas.width = targetW;
      canvas.height = targetH;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) {
        resolve(FULL_QUAD);
        return;
      }
      ctx.drawImage(img, 0, 0, targetW, targetH);
      const result = analyzeCanvasFrame(canvas);
      resolve(result.quad ?? FULL_QUAD);
    };
    img.onerror = () => resolve(FULL_QUAD);
    img.src = imageUrl;
  });
}
