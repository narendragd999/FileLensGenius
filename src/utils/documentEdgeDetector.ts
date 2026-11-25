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

interface Line2D {
  // Normal form: a*x + b*y + c = 0
  a: number;
  b: number;
  c: number;
}

function fitLineRansac(
  pts: { x: number; y: number; weight: number }[],
  inlierDist = 3.2
): Line2D | null {
  if (pts.length < 4) return null;
  let bestScore = -1;
  let bestLine: Line2D | null = null;

  // Deterministic pair sampling across sorted points (fast, zero randomness)
  const step = Math.max(1, Math.floor(pts.length / 10));
  for (let i = 0; i < pts.length; i += step) {
    for (let j = i + step; j < pts.length; j += step) {
      const p1 = pts[i];
      const p2 = pts[j];
      const dx = p2.x - p1.x;
      const dy = p2.y - p1.y;
      const len = Math.hypot(dx, dy);
      if (len < 8) continue;

      const a = -dy / len;
      const b = dx / len;
      const c = -(a * p1.x + b * p1.y);

      let score = 0;
      for (let k = 0; k < pts.length; k++) {
        const d = Math.abs(a * pts[k].x + b * pts[k].y + c);
        if (d <= inlierDist) score += pts[k].weight;
      }
      if (score > bestScore) {
        bestScore = score;
        bestLine = { a, b, c };
      }
    }
  }

  if (!bestLine) return null;

  // Weighted least-squares refinement over inliers
  const inliers = pts.filter(
    (p) => Math.abs(bestLine!.a * p.x + bestLine!.b * p.y + bestLine!.c) <= inlierDist
  );
  if (inliers.length < 3) return bestLine;

  let wSum = 0;
  let mx = 0;
  let my = 0;
  for (const p of inliers) {
    wSum += p.weight;
    mx += p.x * p.weight;
    my += p.y * p.weight;
  }
  mx /= wSum;
  my /= wSum;

  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (const p of inliers) {
    const dx = p.x - mx;
    const dy = p.y - my;
    sxx += p.weight * dx * dx;
    syy += p.weight * dy * dy;
    sxy += p.weight * dx * dy;
  }

  // Principal eigenvector of covariance gives line direction (vx, vy)
  const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const vx = Math.cos(theta);
  const vy = Math.sin(theta);
  const a = -vy;
  const b = vx;
  const c = -(a * mx + b * my);
  return { a, b, c };
}

function intersectLines(l1: Line2D, l2: Line2D): { x: number; y: number } | null {
  const det = l1.a * l2.b - l2.a * l1.b;
  if (Math.abs(det) < 1e-6) return null;
  return {
    x: (l1.b * l2.c - l2.b * l1.c) / det,
    y: (l2.a * l1.c - l1.a * l2.c) / det,
  };
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
  const totalPx = width * height;

  // 1. Luminance + Paper Whiteness score (high lum, low color saturation)
  const rawGray = new Float32Array(totalPx);
  const whiteness = new Float32Array(totalPx);
  for (let i = 0; i < totalPx; i++) {
    const p = i * 4;
    const r = data[p];
    const g = data[p + 1];
    const b = data[p + 2];
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    const chroma = Math.max(r, g, b) - Math.min(r, g, b);
    rawGray[i] = lum;
    whiteness[i] = lum - chroma * 0.85;
  }

  // 2. 3x3 Gaussian blur to suppress sensor & paper-grain noise
  const gray = new Float32Array(totalPx);
  for (let y = 1; y < height - 1; y++) {
    const row = y * width;
    for (let x = 1; x < width - 1; x++) {
      const i = row + x;
      gray[i] =
        (rawGray[i - width - 1] +
          2 * rawGray[i - width] +
          rawGray[i - width + 1] +
          2 * rawGray[i - 1] +
          4 * rawGray[i] +
          2 * rawGray[i + 1] +
          rawGray[i + width - 1] +
          2 * rawGray[i + width] +
          rawGray[i + width + 1]) /
        16;
    }
  }

  const STRIPS = 28;
  const stepProbe = 4;

  const leftPts: { x: number; y: number; weight: number }[] = [];
  const rightPts: { x: number; y: number; weight: number }[] = [];
  const topPts: { x: number; y: number; weight: number }[] = [];
  const bottomPts: { x: number; y: number; weight: number }[] = [];

  // 3. Left & Right border scanlines (transition between outside desk <-> bright neutral paper)
  for (let s = 0; s < STRIPS; s++) {
    const y = Math.round(height * (0.16 + (0.68 * s) / (STRIPS - 1)));
    const row = y * width;

    // Left edge: scan from x = 3% to 44%
    let bestLX = -1;
    let bestLScore = 10;
    for (let x = Math.max(stepProbe, Math.floor(width * 0.03)); x < Math.floor(width * 0.44); x++) {
      const grad = gray[row + x + 2] - gray[row + x - 2];
      if (grad <= 4) continue;
      // Outside (left) must be darker/warmer than inside (right)
      const outsideW = whiteness[row + x - stepProbe];
      const insideW = whiteness[row + x + stepProbe];
      const stepW = insideW - outsideW;
      // Ensure inside looks like bright paper (> 125) and is a real boundary step
      if (insideW > 115 && stepW > 6) {
        const score = grad * 1.2 + stepW * 1.4;
        if (score > bestLScore) {
          bestLScore = score;
          bestLX = x;
        }
      }
    }
    if (bestLX > 0) leftPts.push({ x: bestLX, y, weight: bestLScore });

    // Right edge: scan from x = 97% down to 56%
    let bestRX = -1;
    let bestRScore = 10;
    for (
      let x = Math.min(width - stepProbe - 1, Math.floor(width * 0.97));
      x > Math.floor(width * 0.56);
      x--
    ) {
      const grad = gray[row + x - 2] - gray[row + x + 2];
      if (grad <= 4) continue;
      const insideW = whiteness[row + x - stepProbe];
      const outsideW = whiteness[row + x + stepProbe];
      const stepW = insideW - outsideW;
      if (insideW > 115 && stepW > 6) {
        const score = grad * 1.2 + stepW * 1.4;
        if (score > bestRScore) {
          bestRScore = score;
          bestRX = x;
        }
      }
    }
    if (bestRX > 0) rightPts.push({ x: bestRX, y, weight: bestRScore });
  }

  // 4. Top & Bottom border scanlines
  for (let s = 0; s < STRIPS; s++) {
    const x = Math.round(width * (0.18 + (0.64 * s) / (STRIPS - 1)));

    // Top edge: scan from y = 3% to 44%
    let bestTY = -1;
    let bestTScore = 10;
    for (
      let y = Math.max(stepProbe, Math.floor(height * 0.03));
      y < Math.floor(height * 0.44);
      y++
    ) {
      const grad = gray[(y + 2) * width + x] - gray[(y - 2) * width + x];
      if (grad <= 4) continue;
      const outsideW = whiteness[(y - stepProbe) * width + x];
      const insideW = whiteness[(y + stepProbe) * width + x];
      const stepW = insideW - outsideW;
      if (insideW > 115 && stepW > 6) {
        const score = grad * 1.2 + stepW * 1.4;
        if (score > bestTScore) {
          bestTScore = score;
          bestTY = y;
        }
      }
    }
    if (bestTY > 0) topPts.push({ x, y: bestTY, weight: bestTScore });

    // Bottom edge: scan from y = 97% down to 56%
    let bestBY = -1;
    let bestBScore = 10;
    for (
      let y = Math.min(height - stepProbe - 1, Math.floor(height * 0.97));
      y > Math.floor(height * 0.56);
      y--
    ) {
      const grad = gray[(y - 2) * width + x] - gray[(y + 2) * width + x];
      if (grad <= 4) continue;
      const insideW = whiteness[(y - stepProbe) * width + x];
      const outsideW = whiteness[(y + stepProbe) * width + x];
      const stepW = insideW - outsideW;
      if (insideW > 115 && stepW > 6) {
        const score = grad * 1.2 + stepW * 1.4;
        if (score > bestBScore) {
          bestBScore = score;
          bestBY = y;
        }
      }
    }
    if (bestBY > 0) bottomPts.push({ x, y: bestBY, weight: bestBScore });
  }

  // 5. RANSAC straight-line fit on each of the 4 paper borders
  const lLeft = fitLineRansac(leftPts, 3.0);
  const lRight = fitLineRansac(rightPts, 3.0);
  const lTop = fitLineRansac(topPts, 3.0);
  const lBottom = fitLineRansac(bottomPts, 3.0);

  if (!lLeft || !lRight || !lTop || !lBottom) {
    return { quad: null, confidence: 0, fingerprint };
  }

  const pTL = intersectLines(lTop, lLeft);
  const pTR = intersectLines(lTop, lRight);
  const pBR = intersectLines(lBottom, lRight);
  const pBL = intersectLines(lBottom, lLeft);

  if (!pTL || !pTR || !pBR || !pBL) {
    return { quad: null, confidence: 0, fingerprint };
  }

  // Tiny 1% outward margin so edge text is never clipped
  const pad = 0.01;
  const quad: NormalizedQuad = {
    tlX: Math.max(0.01, Math.min(0.48, pTL.x / width - pad)),
    tlY: Math.max(0.01, Math.min(0.48, pTL.y / height - pad)),
    trX: Math.max(0.52, Math.min(0.99, pTR.x / width + pad)),
    trY: Math.max(0.01, Math.min(0.48, pTR.y / height - pad)),
    brX: Math.max(0.52, Math.min(0.99, pBR.x / width + pad)),
    brY: Math.max(0.52, Math.min(0.99, pBR.y / height + pad)),
    blX: Math.max(0.01, Math.min(0.48, pBL.x / width - pad)),
    blY: Math.max(0.52, Math.min(0.99, pBL.y / height + pad)),
  };

  const topW = quad.trX - quad.tlX;
  const botW = quad.brX - quad.blX;
  const leftH = quad.blY - quad.tlY;
  const rightH = quad.brY - quad.trY;
  if (topW < 0.25 || botW < 0.25 || leftH < 0.25 || rightH < 0.25) {
    return { quad: null, confidence: 0, fingerprint };
  }

  const coverage =
    (leftPts.length + rightPts.length + topPts.length + bottomPts.length) / (STRIPS * 4);
  const confidence = Math.min(0.97, Math.max(0.6, coverage));
  return { quad, confidence, fingerprint };
}

export async function detectQuadFromImageUrl(imageUrl: string): Promise<NormalizedQuad> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      const targetW = 180;
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

export function createA4CenteredQuad(): NormalizedQuad {
  return {
    tlX: 0.06,
    tlY: 0.04,
    trX: 0.94,
    trY: 0.04,
    brX: 0.94,
    brY: 0.96,
    blX: 0.06,
    blY: 0.96,
  };
}

export function isFullQuad(q: NormalizedQuad, eps = 0.008): boolean {
  return (
    Math.abs(q.tlX) < eps &&
    Math.abs(q.tlY) < eps &&
    Math.abs(q.trX - 1) < eps &&
    Math.abs(q.trY) < eps &&
    Math.abs(q.brX - 1) < eps &&
    Math.abs(q.brY - 1) < eps &&
    Math.abs(q.blX) < eps &&
    Math.abs(q.blY - 1) < eps
  );
}

/**
 * Square up an arbitrary quadrilateral to a clean axis-aligned 90° rectangle.
 */
export function squareUpQuadToRectangle(q: NormalizedQuad): NormalizedQuad {
  const left = Math.max(0, Math.min(0.9, (q.tlX + q.blX) / 2));
  const right = Math.min(1, Math.max(left + 0.08, (q.trX + q.brX) / 2));
  const top = Math.max(0, Math.min(0.9, (q.tlY + q.trY) / 2));
  const bottom = Math.min(1, Math.max(top + 0.08, (q.blY + q.brY) / 2));
  return {
    tlX: left,
    tlY: top,
    trX: right,
    trY: top,
    brX: right,
    brY: bottom,
    blX: left,
    blY: bottom,
  };
}

/**
 * Estimate rectified width/height aspect ratio from a perspective quad.
 */
export function estimateRectifiedAspectRatio(
  q: NormalizedQuad,
  srcW: number,
  srcH: number
): number {
  const topW = Math.hypot((q.trX - q.tlX) * srcW, (q.trY - q.tlY) * srcH);
  const botW = Math.hypot((q.brX - q.blX) * srcW, (q.brY - q.blY) * srcH);
  const leftH = Math.hypot((q.blX - q.tlX) * srcW, (q.blY - q.tlY) * srcH);
  const rightH = Math.hypot((q.brX - q.trX) * srcW, (q.brY - q.trY) * srcH);
  const avgW = (topW + botW) * 0.5;
  const avgH = Math.max(1, (leftH + rightH) * 0.5);
  return Math.max(0.45, Math.min(2.2, avgW / avgH));
}

function solveLinear8x8(A: number[][], b: number[]): number[] | null {
  const n = 8;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
    }
    if (Math.abs(M[pivot][col]) < 1e-10) return null;
    [M[col], M[pivot]] = [M[pivot], M[col]];
    const div = M[col][col];
    for (let j = col; j <= n; j++) M[col][j] /= div;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = M[r][col];
      for (let j = col; j <= n; j++) M[r][j] -= factor * M[col][j];
    }
  }
  return M.map((row) => row[n]);
}

/**
 * True 3x3 Homography Perspective Warp from normalized quad -> rectangular target canvas.
 * Maps destination pixel (u, v) back to source pixel (x, y) with bilinear interpolation.
 */
export function warpPerspectiveToCanvas(
  source: HTMLImageElement | HTMLCanvasElement,
  quad: NormalizedQuad,
  targetW: number,
  targetH: number
): HTMLCanvasElement {
  const srcW =
    source instanceof HTMLImageElement ? source.naturalWidth || source.width : source.width;
  const srcH =
    source instanceof HTMLImageElement ? source.naturalHeight || source.height : source.height;

  const outCanvas = document.createElement('canvas');
  outCanvas.width = Math.max(1, Math.round(targetW));
  outCanvas.height = Math.max(1, Math.round(targetH));
  const outCtx = outCanvas.getContext('2d', { willReadFrequently: true });
  if (!outCtx) return outCanvas;

  if (isFullQuad(quad)) {
    outCtx.drawImage(source, 0, 0, outCanvas.width, outCanvas.height);
    return outCanvas;
  }

  // Draw source into temporary canvas to read pixels
  const srcCanvas = document.createElement('canvas');
  srcCanvas.width = srcW;
  srcCanvas.height = srcH;
  const srcCtx = srcCanvas.getContext('2d', { willReadFrequently: true });
  if (!srcCtx) {
    outCtx.drawImage(source, 0, 0, outCanvas.width, outCanvas.height);
    return outCanvas;
  }
  srcCtx.drawImage(source, 0, 0, srcW, srcH);
  const srcData = srcCtx.getImageData(0, 0, srcW, srcH).data;

  const W = outCanvas.width;
  const H = outCanvas.height;

  // Destination corners -> Source corners (inverse homography)
  const dstPts: [number, number][] = [
    [0, 0],
    [W - 1, 0],
    [W - 1, H - 1],
    [0, H - 1],
  ];
  const srcPts: [number, number][] = [
    [quad.tlX * (srcW - 1), quad.tlY * (srcH - 1)],
    [quad.trX * (srcW - 1), quad.trY * (srcH - 1)],
    [quad.brX * (srcW - 1), quad.brY * (srcH - 1)],
    [quad.blX * (srcW - 1), quad.blY * (srcH - 1)],
  ];

  const A: number[][] = [];
  const b: number[] = [];
  for (let i = 0; i < 4; i++) {
    const [u, v] = dstPts[i];
    const [x, y] = srcPts[i];
    A.push([u, v, 1, 0, 0, 0, -u * x, -v * x]);
    b.push(x);
    A.push([0, 0, 0, u, v, 1, -u * y, -v * y]);
    b.push(y);
  }

  const h = solveLinear8x8(A, b);
  if (!h) {
    // Fallback to bounding box crop if degenerate quad
    const minX = Math.min(quad.tlX, quad.blX) * srcW;
    const minY = Math.min(quad.tlY, quad.trY) * srcH;
    const maxX = Math.max(quad.trX, quad.brX) * srcW;
    const maxY = Math.max(quad.blY, quad.brY) * srcH;
    outCtx.drawImage(
      source,
      minX,
      minY,
      Math.max(1, maxX - minX),
      Math.max(1, maxY - minY),
      0,
      0,
      W,
      H
    );
    return outCanvas;
  }

  const [h0, h1, h2, h3, h4, h5, h6, h7] = h;
  const outImg = outCtx.createImageData(W, H);
  const dst = outImg.data;

  for (let v = 0; v < H; v++) {
    for (let u = 0; u < W; u++) {
      const denom = h6 * u + h7 * v + 1;
      const sx = (h0 * u + h1 * v + h2) / denom;
      const sy = (h3 * u + h4 * v + h5) / denom;

      const x0 = Math.max(0, Math.min(srcW - 2, sx | 0));
      const y0 = Math.max(0, Math.min(srcH - 2, sy | 0));
      const fx = Math.max(0, Math.min(1, sx - x0));
      const fy = Math.max(0, Math.min(1, sy - y0));

      const i00 = (y0 * srcW + x0) * 4;
      const i10 = i00 + 4;
      const i01 = ((y0 + 1) * srcW + x0) * 4;
      const i11 = i01 + 4;

      const w00 = (1 - fx) * (1 - fy);
      const w10 = fx * (1 - fy);
      const w01 = (1 - fx) * fy;
      const w11 = fx * fy;

      const di = (v * W + u) * 4;
      dst[di] = srcData[i00] * w00 + srcData[i10] * w10 + srcData[i01] * w01 + srcData[i11] * w11;
      dst[di + 1] =
        srcData[i00 + 1] * w00 +
        srcData[i10 + 1] * w10 +
        srcData[i01 + 1] * w01 +
        srcData[i11 + 1] * w11;
      dst[di + 2] =
        srcData[i00 + 2] * w00 +
        srcData[i10 + 2] * w10 +
        srcData[i01 + 2] * w01 +
        srcData[i11 + 2] * w11;
      dst[di + 3] = 255;
    }
  }

  outCtx.putImageData(outImg, 0, 0);
  return outCanvas;
}

/**
 * Compute a lightweight 160x160 Sobel edge-strength map for magnetic corner snapping.
 */
export async function computeEdgeSnapMap(
  imageUrl: string,
  size = 160
): Promise<{ map: Float32Array; size: number } | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = size;
      c.height = size;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      if (!ctx) {
        resolve(null);
        return;
      }
      ctx.drawImage(img, 0, 0, size, size);
      const rgba = ctx.getImageData(0, 0, size, size).data;
      const gray = new Float32Array(size * size);
      for (let i = 0; i < size * size; i++) {
        const p = i * 4;
        gray[i] = 0.299 * rgba[p] + 0.587 * rgba[p + 1] + 0.114 * rgba[p + 2];
      }
      const map = new Float32Array(size * size);
      for (let y = 1; y < size - 1; y++) {
        for (let x = 1; x < size - 1; x++) {
          const i = y * size + x;
          const gx =
            -gray[i - size - 1] + gray[i - size + 1] - 2 * gray[i - 1] + 2 * gray[i + 1] - gray[i + size - 1] + gray[i + size + 1];
          const gy =
            -gray[i - size - 1] - 2 * gray[i - size] - gray[i - size + 1] + gray[i + size - 1] + 2 * gray[i + size] + gray[i + size + 1];
          map[i] = Math.hypot(gx, gy);
        }
      }
      resolve({ map, size });
    };
    img.onerror = () => resolve(null);
    img.src = imageUrl;
  });
}

/**
 * Magnetic snap of a normalized corner (nx, ny) to the strongest edge/corner within radius.
 */
export function snapCornerToEdge(
  snapData: { map: Float32Array; size: number } | null,
  nx: number,
  ny: number,
  radiusPx = 6
): { x: number; y: number } {
  if (!snapData) return { x: nx, y: ny };
  const { map, size } = snapData;
  const cx = Math.round(nx * (size - 1));
  const cy = Math.round(ny * (size - 1));
  let bestScore = 45; // minimum edge strength threshold
  let bestX = cx;
  let bestY = cy;

  for (let dy = -radiusPx; dy <= radiusPx; dy++) {
    const y = cy + dy;
    if (y <= 1 || y >= size - 1) continue;
    for (let dx = -radiusPx; dx <= radiusPx; dx++) {
      const x = cx + dx;
      if (x <= 1 || x >= size - 1) continue;
      const distPenalty = 1 - Math.hypot(dx, dy) / (radiusPx * 1.5);
      const s = map[y * size + x] * distPenalty;
      if (s > bestScore) {
        bestScore = s;
        bestX = x;
        bestY = y;
      }
    }
  }

  return {
    x: Math.max(0.01, Math.min(0.99, bestX / (size - 1))),
    y: Math.max(0.01, Math.min(0.99, bestY / (size - 1))),
  };
}
