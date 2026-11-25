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

interface Pt {
  x: number;
  y: number;
}

interface Line2D {
  // Normal form: a*x + b*y + c = 0 (unit normal: a^2 + b^2 = 1)
  a: number;
  b: number;
  c: number;
}

function fitLineRansac(
  pts: { x: number; y: number; weight: number }[],
  inlierDist = 2.8
): Line2D | null {
  if (pts.length < 4) return null;
  let bestScore = -1;
  let bestLine: Line2D | null = null;

  const step = Math.max(1, Math.floor(pts.length / 12));
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
  if (wSum <= 0) return bestLine;
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

  const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const vx = Math.cos(theta);
  const vy = Math.sin(theta);
  const a = -vy;
  const b = vx;
  const c = -(a * mx + b * my);
  return { a, b, c };
}

function intersectLines(l1: Line2D, l2: Line2D): Pt | null {
  const det = l1.a * l2.b - l2.a * l1.b;
  if (Math.abs(det) < 1e-6) return null;
  return {
    x: (l1.b * l2.c - l2.b * l1.c) / det,
    y: (l2.a * l1.c - l1.a * l2.c) / det,
  };
}

/** Separable 1D morphological dilate (isMax=true) or erode (isMax=false) of radius r */
function morph1D(
  src: Float32Array,
  w: number,
  h: number,
  r: number,
  isMax: boolean
): Float32Array {
  const tmp = new Float32Array(w * h);
  const dst = new Float32Array(w * h);

  // Horizontal pass
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r);
      const x1 = Math.min(w - 1, x + r);
      let best = src[row + x0];
      if (isMax) {
        for (let k = x0 + 1; k <= x1; k++) {
          if (src[row + k] > best) best = src[row + k];
        }
      } else {
        for (let k = x0 + 1; k <= x1; k++) {
          if (src[row + k] < best) best = src[row + k];
        }
      }
      tmp[row + x] = best;
    }
  }

  // Vertical pass
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r);
    const y1 = Math.min(h - 1, y + r);
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let best = tmp[y0 * w + x];
      if (isMax) {
        for (let k = y0 + 1; k <= y1; k++) {
          const v = tmp[k * w + x];
          if (v > best) best = v;
        }
      } else {
        for (let k = y0 + 1; k <= y1; k++) {
          const v = tmp[k * w + x];
          if (v < best) best = v;
        }
      }
      dst[row + x] = best;
    }
  }
  return dst;
}

/** Morphological closing (dilate then erode): erases dark text/table lines on bright paper */
function morphClose(src: Float32Array, w: number, h: number, r = 2): Float32Array {
  return morph1D(morph1D(src, w, h, r, true), w, h, r, false);
}

/** O(1)-per-pixel separable box blur for local illumination normalization */
function fastBoxBlur(src: Float32Array, w: number, h: number, r = 12): Float32Array {
  const tmp = new Float32Array(w * h);
  const dst = new Float32Array(w * h);

  for (let y = 0; y < h; y++) {
    const row = y * w;
    let sum = 0;
    for (let k = 0; k <= Math.min(w - 1, r); k++) sum += src[row + k];
    for (let x = 0; x < w; x++) {
      const left = x - r - 1;
      const right = x + r + 1;
      if (left >= 0) sum -= src[row + left];
      if (right < w) sum += src[row + right];
      const count = Math.min(w - 1, x + r) - Math.max(0, x - r) + 1;
      tmp[row + x] = sum / count;
    }
  }

  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let k = 0; k <= Math.min(h - 1, r); k++) sum += tmp[k * w + x];
    for (let y = 0; y < h; y++) {
      const top = y - r - 1;
      const bot = y + r + 1;
      if (top >= 0) sum -= tmp[top * w + x];
      if (bot < h) sum += tmp[bot * w + x];
      const count = Math.min(h - 1, y + r) - Math.max(0, y - r) + 1;
      dst[y * w + x] = sum / count;
    }
  }
  return dst;
}

function computeOtsuThreshold(values: Float32Array): number {
  const hist = new Int32Array(256);
  const n = values.length;
  for (let i = 0; i < n; i++) {
    const b = Math.max(0, Math.min(255, Math.round(values[i])));
    hist[b]++;
  }
  let sumAll = 0;
  for (let t = 0; t < 256; t++) sumAll += t * hist[t];

  let sumB = 0;
  let wB = 0;
  let maxVar = -1;
  let bestT = 135;

  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = n - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sumAll - sumB) / wF;
    const diff = mB - mF;
    const betweenVar = wB * wF * diff * diff;
    if (betweenVar > maxVar) {
      maxVar = betweenVar;
      bestT = t;
    }
  }
  return bestT;
}

function convexHull(points: Pt[]): Pt[] {
  if (points.length <= 3) return points.slice();
  const sorted = points.slice().sort((a, b) => (a.x !== b.x ? a.x - b.x : a.y - b.y));
  const cross = (o: Pt, a: Pt, b: Pt) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

  const lower: Pt[] = [];
  for (const p of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
      lower.pop();
    }
    lower.push(p);
  }
  const upper: Pt[] = [];
  for (let i = sorted.length - 1; i >= 0; i--) {
    const p = sorted[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
      upper.pop();
    }
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

/** Simplify convex polygon down to 4 corners by iteratively dropping smallest-area vertex */
function simplifyHullToQuad(hull: Pt[]): [Pt, Pt, Pt, Pt] | null {
  if (hull.length < 4) return null;
  const poly = hull.slice();
  while (poly.length > 4) {
    let minArea = Infinity;
    let minIdx = 0;
    const n = poly.length;
    for (let i = 0; i < n; i++) {
      const prev = poly[(i - 1 + n) % n];
      const curr = poly[i];
      const next = poly[(i + 1) % n];
      const area = Math.abs(
        (curr.x - prev.x) * (next.y - prev.y) - (next.x - prev.x) * (curr.y - prev.y)
      );
      if (area < minArea) {
        minArea = area;
        minIdx = i;
      }
    }
    poly.splice(minIdx, 1);
  }
  return orderCorners([poly[0], poly[1], poly[2], poly[3]]);
}

function orderCorners(pts: [Pt, Pt, Pt, Pt]): [Pt, Pt, Pt, Pt] {
  const byY = pts.slice().sort((a, b) => a.y - b.y);
  const top = [byY[0], byY[1]].sort((a, b) => a.x - b.x);
  const bot = [byY[2], byY[3]].sort((a, b) => a.x - b.x);
  // [TL, TR, BR, BL]
  return [top[0], top[1], bot[1], bot[0]];
}

function pointToSegmentDist(p: Pt, a: Pt, b: Pt): { dist: number; t: number } {
  const vx = b.x - a.x;
  const vy = b.y - a.y;
  const len2 = vx * vx + vy * vy;
  if (len2 < 1e-6) return { dist: Math.hypot(p.x - a.x, p.y - a.y), t: 0 };
  const t = ((p.x - a.x) * vx + (p.y - a.y) * vy) / len2;
  const tc = Math.max(0, Math.min(1, t));
  const px = a.x + tc * vx;
  const py = a.y + tc * vy;
  return { dist: Math.hypot(p.x - px, p.y - py), t };
}

function detectQuadFromComponent(
  closedWhite: Float32Array,
  gradMag: Float32Array,
  w: number,
  h: number,
  thresh: number
): [Pt, Pt, Pt, Pt] | null {
  const totalPx = w * h;
  const visited = new Uint8Array(totalPx);
  const queue = new Int32Array(totalPx);
  const cx = w * 0.5;
  const cy = h * 0.5;

  let bestScore = -1;
  let bestPixels: number[] | null = null;

  for (let start = 0; start < totalPx; start++) {
    if (visited[start] || closedWhite[start] < thresh) continue;
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    visited[start] = 1;
    const comp: number[] = [];

    let minX = w;
    let maxX = 0;
    let minY = h;
    let maxY = 0;
    let sumX = 0;
    let sumY = 0;
    let containsCenter = false;

    while (head < tail) {
      const idx = queue[head++];
      comp.push(idx);
      const x = idx % w;
      const y = (idx - x) / w;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      sumX += x;
      sumY += y;
      if (Math.abs(x - cx) < w * 0.12 && Math.abs(y - cy) < h * 0.12) {
        containsCenter = true;
      }

      if (x > 0 && !visited[idx - 1] && closedWhite[idx - 1] >= thresh) {
        visited[idx - 1] = 1;
        queue[tail++] = idx - 1;
      }
      if (x + 1 < w && !visited[idx + 1] && closedWhite[idx + 1] >= thresh) {
        visited[idx + 1] = 1;
        queue[tail++] = idx + 1;
      }
      if (y > 0 && !visited[idx - w] && closedWhite[idx - w] >= thresh) {
        visited[idx - w] = 1;
        queue[tail++] = idx - w;
      }
      if (y + 1 < h && !visited[idx + w] && closedWhite[idx + w] >= thresh) {
        visited[idx + w] = 1;
        queue[tail++] = idx + w;
      }
    }

    const areaRatio = comp.length / totalPx;
    if (areaRatio < 0.06 || areaRatio > 0.94) continue;

    const bboxArea = Math.max(1, (maxX - minX + 1) * (maxY - minY + 1));
    const rectangularity = comp.length / bboxArea;
    if (rectangularity < 0.45) continue;

    const mx = sumX / comp.length;
    const my = sumY / comp.length;
    const centerDist = Math.hypot((mx - cx) / w, (my - cy) / h);
    const centrality = (containsCenter ? 1.0 : 0.45) * Math.max(0.2, 1 - centerDist * 1.4);

    const score = areaRatio * rectangularity * centrality;
    if (score > bestScore) {
      bestScore = score;
      bestPixels = comp;
    }
  }

  if (!bestPixels) return null;

  // Build component mask to extract clean boundary pixels
  const compMask = new Uint8Array(totalPx);
  for (let i = 0; i < bestPixels.length; i++) compMask[bestPixels[i]] = 1;

  const boundaryPts: Pt[] = [];
  for (let i = 0; i < bestPixels.length; i++) {
    const idx = bestPixels[i];
    const x = idx % w;
    const y = (idx - x) / w;
    if (
      x <= 1 ||
      x >= w - 2 ||
      y <= 1 ||
      y >= h - 2 ||
      !compMask[idx - 1] ||
      !compMask[idx + 1] ||
      !compMask[idx - w] ||
      !compMask[idx + w]
    ) {
      boundaryPts.push({ x, y });
    }
  }
  if (boundaryPts.length < 16) return null;

  const hull = convexHull(boundaryPts);
  const roughQuad = simplifyHullToQuad(hull);
  if (!roughQuad) return null;

  // Refine each of the 4 edges via weighted RANSAC on nearby boundary points
  const edges: [Pt, Pt][] = [
    [roughQuad[0], roughQuad[1]], // top
    [roughQuad[1], roughQuad[2]], // right
    [roughQuad[2], roughQuad[3]], // bottom
    [roughQuad[3], roughQuad[0]], // left
  ];

  const fittedLines: (Line2D | null)[] = edges.map(([a, b]) => {
    const nearPts: { x: number; y: number; weight: number }[] = [];
    for (let i = 0; i < boundaryPts.length; i++) {
      const p = boundaryPts[i];
      const { dist, t } = pointToSegmentDist(p, a, b);
      if (dist <= 5.5 && t >= 0.08 && t <= 0.92) {
        const ix = Math.max(0, Math.min(w - 1, Math.round(p.x)));
        const iy = Math.max(0, Math.min(h - 1, Math.round(p.y)));
        nearPts.push({ x: p.x, y: p.y, weight: 1 + gradMag[iy * w + ix] * 0.08 });
      }
    }
    return fitLineRansac(nearPts, 2.5);
  });

  if (fittedLines.some((l) => !l)) return roughQuad;

  const pTL = intersectLines(fittedLines[0]!, fittedLines[3]!);
  const pTR = intersectLines(fittedLines[0]!, fittedLines[1]!);
  const pBR = intersectLines(fittedLines[2]!, fittedLines[1]!);
  const pBL = intersectLines(fittedLines[2]!, fittedLines[3]!);
  if (!pTL || !pTR || !pBR || !pBL) return roughQuad;

  return orderCorners([pTL, pTR, pBR, pBL]);
}

function detectQuadFromClosedScanlines(
  closedGray: Float32Array,
  closedWhite: Float32Array,
  w: number,
  h: number
): [Pt, Pt, Pt, Pt] | null {
  const STRIPS = 30;
  const stepProbe = 4;

  const leftPts: { x: number; y: number; weight: number }[] = [];
  const rightPts: { x: number; y: number; weight: number }[] = [];
  const topPts: { x: number; y: number; weight: number }[] = [];
  const bottomPts: { x: number; y: number; weight: number }[] = [];

  const pushTopPeaks = (
    candidates: { pos: number; score: number }[],
    out: { x: number; y: number; weight: number }[],
    isVerticalEdge: boolean,
    fixedCoord: number
  ) => {
    candidates.sort((a, b) => b.score - a.score);
    let added = 0;
    let firstPos = -999;
    for (const c of candidates) {
      if (Math.abs(c.pos - firstPos) < 8) continue;
      out.push(
        isVerticalEdge
          ? { x: c.pos, y: fixedCoord, weight: c.score }
          : { x: fixedCoord, y: c.pos, weight: c.score }
      );
      if (added === 0) firstPos = c.pos;
      added++;
      if (added >= 2) break;
    }
  };

  for (let s = 0; s < STRIPS; s++) {
    const y = Math.round(h * (0.14 + (0.72 * s) / (STRIPS - 1)));
    const row = y * w;

    const lCands: { pos: number; score: number }[] = [];
    for (let x = Math.max(stepProbe, Math.floor(w * 0.02)); x < Math.floor(w * 0.45); x++) {
      const grad = closedGray[row + x + 2] - closedGray[row + x - 2];
      if (grad <= 3) continue;
      const outsideW = closedWhite[row + x - stepProbe];
      const insideW = closedWhite[row + x + stepProbe];
      const stepW = insideW - outsideW;
      if (insideW > 105 && stepW > 4) {
        lCands.push({ pos: x, score: grad * 1.2 + stepW * 1.4 });
      }
    }
    pushTopPeaks(lCands, leftPts, true, y);

    const rCands: { pos: number; score: number }[] = [];
    for (let x = Math.min(w - stepProbe - 1, Math.floor(w * 0.98)); x > Math.floor(w * 0.55); x--) {
      const grad = closedGray[row + x - 2] - closedGray[row + x + 2];
      if (grad <= 3) continue;
      const insideW = closedWhite[row + x - stepProbe];
      const outsideW = closedWhite[row + x + stepProbe];
      const stepW = insideW - outsideW;
      if (insideW > 105 && stepW > 4) {
        rCands.push({ pos: x, score: grad * 1.2 + stepW * 1.4 });
      }
    }
    pushTopPeaks(rCands, rightPts, true, y);
  }

  for (let s = 0; s < STRIPS; s++) {
    const x = Math.round(w * (0.16 + (0.68 * s) / (STRIPS - 1)));

    const tCands: { pos: number; score: number }[] = [];
    for (let y = Math.max(stepProbe, Math.floor(h * 0.02)); y < Math.floor(h * 0.45); y++) {
      const grad = closedGray[(y + 2) * w + x] - closedGray[(y - 2) * w + x];
      if (grad <= 3) continue;
      const outsideW = closedWhite[(y - stepProbe) * w + x];
      const insideW = closedWhite[(y + stepProbe) * w + x];
      const stepW = insideW - outsideW;
      if (insideW > 105 && stepW > 4) {
        tCands.push({ pos: y, score: grad * 1.2 + stepW * 1.4 });
      }
    }
    pushTopPeaks(tCands, topPts, false, x);

    const bCands: { pos: number; score: number }[] = [];
    for (let y = Math.min(h - stepProbe - 1, Math.floor(h * 0.98)); y > Math.floor(h * 0.55); y--) {
      const grad = closedGray[(y - 2) * w + x] - closedGray[(y + 2) * w + x];
      if (grad <= 3) continue;
      const insideW = closedWhite[(y - stepProbe) * w + x];
      const outsideW = closedWhite[(y + stepProbe) * w + x];
      const stepW = insideW - outsideW;
      if (insideW > 105 && stepW > 4) {
        bCands.push({ pos: y, score: grad * 1.2 + stepW * 1.4 });
      }
    }
    pushTopPeaks(bCands, bottomPts, false, x);
  }

  const lLeft = fitLineRansac(leftPts, 2.8);
  const lRight = fitLineRansac(rightPts, 2.8);
  const lTop = fitLineRansac(topPts, 2.8);
  const lBottom = fitLineRansac(bottomPts, 2.8);
  if (!lLeft || !lRight || !lTop || !lBottom) return null;

  const pTL = intersectLines(lTop, lLeft);
  const pTR = intersectLines(lTop, lRight);
  const pBR = intersectLines(lBottom, lRight);
  const pBL = intersectLines(lBottom, lLeft);
  if (!pTL || !pTR || !pBR || !pBL) return null;

  return orderCorners([pTL, pTR, pBR, pBL]);
}

/** Walk FROM center outward on text-free closed image and stop at the FIRST real paper-to-desk boundary */
function detectQuadCenterOutward(
  closedGray: Float32Array,
  closedWhite: Float32Array,
  w: number,
  h: number,
  centerPaperRef: number,
  closedColorMatch: Float32Array | null = null
): [Pt, Pt, Pt, Pt] | null {
  const STRIPS = 26;
  const cx = Math.floor(w * 0.5);
  const cy = Math.floor(h * 0.5);
  const probe = 4;

  const leftPts: { x: number; y: number; weight: number }[] = [];
  const rightPts: { x: number; y: number; weight: number }[] = [];
  const topPts: { x: number; y: number; weight: number }[] = [];
  const bottomPts: { x: number; y: number; weight: number }[] = [];

  for (let s = 0; s < STRIPS; s++) {
    const y = Math.round(h * (0.22 + (0.56 * s) / (STRIPS - 1)));
    const row = y * w;

    // Walk Left from center -> 2%
    for (let x = cx - Math.floor(w * 0.06); x >= Math.max(probe + 2, Math.floor(w * 0.02)); x--) {
      const grad = closedGray[row + x + 2] - closedGray[row + x - 2];
      const inW = closedWhite[row + x + probe];
      const outW = closedWhite[row + x - probe];
      const stepW = inW - outW;
      const inC = closedColorMatch ? closedColorMatch[row + x + probe] : 0;
      const outC = closedColorMatch ? closedColorMatch[row + x - probe] : 0;
      const stepC = inC - outC;
      if (
        (inW >= centerPaperRef - 38 && ((grad >= 4 && stepW >= 7) || (grad >= 9 && stepW >= 4))) ||
        (closedColorMatch !== null && inC >= 165 && stepC >= 24 && grad >= 2)
      ) {
        leftPts.push({ x, y, weight: Math.min(30, grad + Math.max(stepW, stepC * 0.35)) });
        break;
      }
    }

    // Walk Right from center -> 98%
    for (let x = cx + Math.floor(w * 0.06); x <= Math.min(w - probe - 3, Math.floor(w * 0.98)); x++) {
      const grad = closedGray[row + x - 2] - closedGray[row + x + 2];
      const inW = closedWhite[row + x - probe];
      const outW = closedWhite[row + x + probe];
      const stepW = inW - outW;
      const inC = closedColorMatch ? closedColorMatch[row + x - probe] : 0;
      const outC = closedColorMatch ? closedColorMatch[row + x + probe] : 0;
      const stepC = inC - outC;
      if (
        (inW >= centerPaperRef - 38 && ((grad >= 4 && stepW >= 7) || (grad >= 9 && stepW >= 4))) ||
        (closedColorMatch !== null && inC >= 165 && stepC >= 24 && grad >= 2)
      ) {
        rightPts.push({ x, y, weight: Math.min(30, grad + Math.max(stepW, stepC * 0.35)) });
        break;
      }
    }
  }

  for (let s = 0; s < STRIPS; s++) {
    const x = Math.round(w * (0.20 + (0.60 * s) / (STRIPS - 1)));

    // Walk Top from center -> 2%
    for (let y = cy - Math.floor(h * 0.06); y >= Math.max(probe + 2, Math.floor(h * 0.02)); y--) {
      const grad = closedGray[(y + 2) * w + x] - closedGray[(y - 2) * w + x];
      const inW = closedWhite[(y + probe) * w + x];
      const outW = closedWhite[(y - probe) * w + x];
      const stepW = inW - outW;
      const inC = closedColorMatch ? closedColorMatch[(y + probe) * w + x] : 0;
      const outC = closedColorMatch ? closedColorMatch[(y - probe) * w + x] : 0;
      const stepC = inC - outC;
      if (
        (inW >= centerPaperRef - 38 && ((grad >= 4 && stepW >= 7) || (grad >= 9 && stepW >= 4))) ||
        (closedColorMatch !== null && inC >= 165 && stepC >= 24 && grad >= 2)
      ) {
        topPts.push({ x, y, weight: Math.min(30, grad + Math.max(stepW, stepC * 0.35)) });
        break;
      }
    }

    // Walk Bottom from center -> 98%
    for (let y = cy + Math.floor(h * 0.06); y <= Math.min(h - probe - 3, Math.floor(h * 0.98)); y++) {
      const grad = closedGray[(y - 2) * w + x] - closedGray[(y + 2) * w + x];
      const inW = closedWhite[(y - probe) * w + x];
      const outW = closedWhite[(y + probe) * w + x];
      const stepW = inW - outW;
      const inC = closedColorMatch ? closedColorMatch[(y - probe) * w + x] : 0;
      const outC = closedColorMatch ? closedColorMatch[(y + probe) * w + x] : 0;
      const stepC = inC - outC;
      if (
        (inW >= centerPaperRef - 38 && ((grad >= 4 && stepW >= 7) || (grad >= 9 && stepW >= 4))) ||
        (closedColorMatch !== null && inC >= 165 && stepC >= 24 && grad >= 2)
      ) {
        bottomPts.push({ x, y, weight: Math.min(30, grad + Math.max(stepW, stepC * 0.35)) });
        break;
      }
    }
  }

  const lLeft = fitLineRansac(leftPts, 2.8);
  const lRight = fitLineRansac(rightPts, 2.8);
  const lTop = fitLineRansac(topPts, 2.8);
  const lBottom = fitLineRansac(bottomPts, 2.8);
  if (!lLeft || !lRight || !lTop || !lBottom) return null;

  const pTL = intersectLines(lTop, lLeft);
  const pTR = intersectLines(lTop, lRight);
  const pBR = intersectLines(lBottom, lRight);
  const pBL = intersectLines(lBottom, lLeft);
  if (!pTL || !pTR || !pBR || !pBL) return null;

  return orderCorners([pTL, pTR, pBR, pBL]);
}

/** Validate geometry + photometric edge alignment and return quality score in [0..1] (0 = invalid) */
function scoreQuadCandidate(
  corners: [Pt, Pt, Pt, Pt],
  closedWhite: Float32Array,
  gradMag: Float32Array,
  w: number,
  h: number,
  centerPaperRef: number,
  closedColorMatch: Float32Array | null = null
): number {
  const [tl, tr, br, bl] = corners;

  // Reject corners wildly outside image bounds
  for (const p of corners) {
    if (p.x < -w * 0.08 || p.x > w * 1.08 || p.y < -h * 0.08 || p.y > h * 1.08) {
      return 0;
    }
  }

  // Must be strictly convex (consistent cross-product sign)
  const pts = [tl, tr, br, bl];
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % 4];
    const c = pts[(i + 2) % 4];
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(cross) < 1e-3) return 0;
    const s = cross > 0 ? 1 : -1;
    if (sign === 0) sign = s;
    else if (sign !== s) return 0;
  }

  // Polygon area ratio
  const area =
    0.5 *
    Math.abs(
      tl.x * tr.y -
        tr.x * tl.y +
        (tr.x * br.y - br.x * tr.y) +
        (br.x * bl.y - bl.x * br.y) +
        (bl.x * tl.y - tl.x * bl.y)
    );
  const areaRatio = area / (w * h);
  if (areaRatio < 0.06 || areaRatio > 0.95) return 0;

  // Interior corner angles must be plausible perspective rectangle angles [58 deg .. 122 deg]
  let angleScoreSum = 0;
  const minSidePx = Math.min(w, h) * 0.14;
  for (let i = 0; i < 4; i++) {
    const prev = pts[(i + 3) % 4];
    const curr = pts[i];
    const next = pts[(i + 1) % 4];
    const v1x = prev.x - curr.x;
    const v1y = prev.y - curr.y;
    const v2x = next.x - curr.x;
    const v2y = next.y - curr.y;
    const d1 = Math.hypot(v1x, v1y);
    const d2 = Math.hypot(v2x, v2y);
    if (d1 < minSidePx || d2 < minSidePx) return 0;
    const cosA = Math.max(-1, Math.min(1, (v1x * v2x + v1y * v2y) / (d1 * d2)));
    const deg = (Math.acos(cosA) * 180) / Math.PI;
    if (deg < 58 || deg > 122) return 0;
    angleScoreSum += 1 - Math.abs(deg - 90) / 35;
  }
  const angleQuality = angleScoreSum / 4;

  // Opposite side length consistency & near-parallelism
  const topW = Math.hypot(tr.x - tl.x, tr.y - tl.y);
  const botW = Math.hypot(br.x - bl.x, br.y - bl.y);
  const leftH = Math.hypot(bl.x - tl.x, bl.y - tl.y);
  const rightH = Math.hypot(br.x - tr.x, br.y - tr.y);
  const wRatio = Math.min(topW, botW) / Math.max(1, Math.max(topW, botW));
  const hRatio = Math.min(leftH, rightH) / Math.max(1, Math.max(leftH, rightH));
  if (wRatio < 0.68 || hRatio < 0.68) return 0;

  // Photometric edge support & inside-vs-outside paper contrast along all 4 edges
  const quadCx = (tl.x + tr.x + br.x + bl.x) * 0.25;
  const quadCy = (tl.y + tr.y + br.y + bl.y) * 0.25;
  const edgePairs: [Pt, Pt][] = [
    [tl, tr],
    [tr, br],
    [br, bl],
    [bl, tl],
  ];

  let strongEdges = 0;
  let edgeSupportSum = 0;
  const SAMPLES = 20;

  for (const [a, b] of edgePairs) {
    const ex = b.x - a.x;
    const ey = b.y - a.y;
    const elen = Math.max(1, Math.hypot(ex, ey));
    // Unit normal pointing inward toward quad center
    let nx = -ey / elen;
    let ny = ex / elen;
    const midX = (a.x + b.x) * 0.5;
    const midY = (a.y + b.y) * 0.5;
    if (nx * (quadCx - midX) + ny * (quadCy - midY) < 0) {
      nx = -nx;
      ny = -ny;
    }

    let edgeHits = 0;
    let contrastSum = 0;
    let validSamples = 0;
    let nonPaperEdgeSamples = 0;
    const edgeDarkCutoff = Math.max(55, centerPaperRef - 38);

    for (let s = 1; s < SAMPLES; s++) {
      const t = s / SAMPLES;
      const px = a.x + ex * t;
      const py = a.y + ey * t;
      const ix = Math.round(px);
      const iy = Math.round(py);
      if (ix < 2 || ix >= w - 2 || iy < 2 || iy >= h - 2) continue;
      validSamples++;

      // Max gradient within +/-2px along normal
      let localMaxGrad = 0;
      for (let d = -2; d <= 2; d++) {
        const gx = Math.max(0, Math.min(w - 1, Math.round(px + nx * d)));
        const gy = Math.max(0, Math.min(h - 1, Math.round(py + ny * d)));
        const g = gradMag[gy * w + gx];
        if (g > localMaxGrad) localMaxGrad = g;
      }

      const inX = Math.max(0, Math.min(w - 1, Math.round(px + nx * 5)));
      const inY = Math.max(0, Math.min(h - 1, Math.round(py + ny * 5)));
      const inDeepX = Math.max(0, Math.min(w - 1, Math.round(px + nx * 11)));
      const inDeepY = Math.max(0, Math.min(h - 1, Math.round(py + ny * 11)));
      const outX = Math.max(0, Math.min(w - 1, Math.round(px - nx * 5)));
      const outY = Math.max(0, Math.min(h - 1, Math.round(py - ny * 5)));
      const inWhite = closedWhite[inY * w + inX];
      const inDeepWhite = closedWhite[inDeepY * w + inDeepX];
      const stepW = inWhite - closedWhite[outY * w + outX];
      const inColor = closedColorMatch ? closedColorMatch[inY * w + inX] : 255;
      const inDeepColor = closedColorMatch ? closedColorMatch[inDeepY * w + inDeepX] : 255;
      const stepColor = closedColorMatch
        ? inColor - closedColorMatch[outY * w + outX]
        : 0;
      const effectiveStep = Math.max(stepW, stepColor * 0.3);

      const isPaperInside =
        Math.max(inWhite, inDeepWhite) >= edgeDarkCutoff &&
        (!closedColorMatch || Math.max(inColor, inDeepColor) >= 145);

      if (!isPaperInside) {
        nonPaperEdgeSamples++;
      } else {
        if (localMaxGrad > 8 || stepW > 4 || stepColor > 18) edgeHits++;
        if (effectiveStep > 0) contrastSum += Math.min(16, effectiveStep);
      }
    }

    const hitRatio = validSamples > 0 ? edgeHits / validSamples : 0.4;
    const meanContrast = validSamples > 0 ? contrastSum / validSamples : 0;
    let edgeScore = hitRatio * 0.72 + Math.min(1, meanContrast / 12) * 0.28;
    if (validSamples > 0 && nonPaperEdgeSamples / validSamples > 0.35) {
      edgeScore *= 0.45;
    }
    if (edgeScore >= 0.35) strongEdges++;
    edgeSupportSum += edgeScore;
  }

  if (strongEdges < 2) return 0;
  const edgeQuality = edgeSupportSum / 4;
  if (edgeQuality < 0.22) return 0;

  // Interior paper uniformity check: reject quads that swallow dark keyboards/desks or non-white backgrounds
  let interiorHits = 0;
  let interiorDark = 0;
  let interiorColorHits = 0;
  let interiorColorMisses = 0;
  let interiorTotal = 0;
  const darkCutoff = Math.max(55, centerPaperRef - 36);
  const paperCutoff = Math.max(80, centerPaperRef - 24);
  for (let gy = 1; gy <= 6; gy++) {
    const v = 0.08 + (0.84 * (gy - 1)) / 5;
    for (let gx = 1; gx <= 6; gx++) {
      const u = 0.08 + (0.84 * (gx - 1)) / 5;
      const topX = tl.x + (tr.x - tl.x) * u;
      const topY = tl.y + (tr.y - tl.y) * u;
      const botX = bl.x + (br.x - bl.x) * u;
      const botY = bl.y + (br.y - bl.y) * u;
      const sx = Math.max(0, Math.min(w - 1, Math.round(topX + (botX - topX) * v)));
      const sy = Math.max(0, Math.min(h - 1, Math.round(topY + (botY - topY) * v)));
      const idx = sy * w + sx;
      const val = closedWhite[idx];
      interiorTotal++;
      if (val >= paperCutoff) interiorHits++;
      if (val < darkCutoff) interiorDark++;
      if (closedColorMatch) {
        const cm = closedColorMatch[idx];
        if (cm >= 165) interiorColorHits++;
        if (cm < 130) interiorColorMisses++;
      }
    }
  }
  if (interiorTotal > 0 && interiorDark / interiorTotal > 0.28) return 0;
  if (closedColorMatch && interiorTotal > 0 && interiorColorMisses / interiorTotal > 0.30) return 0;
  const lumInterior = interiorTotal > 0 ? interiorHits / interiorTotal : 0.7;
  const colorInterior =
    closedColorMatch && interiorTotal > 0 ? interiorColorHits / interiorTotal : lumInterior;
  const interiorQuality = closedColorMatch ? lumInterior * 0.55 + colorInterior * 0.45 : lumInterior;

  const shapeQuality = (angleQuality + wRatio + hRatio) / 3;
  const areaBonus = Math.min(1, areaRatio / 0.55);
  return Math.min(
    0.98,
    edgeQuality * 0.44 + interiorQuality * 0.34 + shapeQuality * 0.18 + areaBonus * 0.04
  );
}

function snapQuadToOuterPaperBoundary(
  corners: [Pt, Pt, Pt, Pt],
  closedWhite: Float32Array,
  gradMag: Float32Array,
  w: number,
  h: number
): [Pt, Pt, Pt, Pt] {
  const [tl, tr, br, bl] = corners;
  const cx = (tl.x + tr.x + br.x + bl.x) * 0.25;
  const cy = (tl.y + tr.y + br.y + bl.y) * 0.25;

  const snapEdge = (a: Pt, b: Pt): Line2D => {
    const ex = b.x - a.x;
    const ey = b.y - a.y;
    const elen = Math.max(1, Math.hypot(ex, ey));
    // Outward normal (away from quad center)
    let ox = -ey / elen;
    let oy = ex / elen;
    const midX = (a.x + b.x) * 0.5;
    const midY = (a.y + b.y) * 0.5;
    if (ox * (midX - cx) + oy * (midY - cy) < 0) {
      ox = -ox;
      oy = -oy;
    }

    let bestOffset = 0;
    let bestEdgeScore = -1;
    for (let d = -3; d <= 4; d++) {
      let gradSum = 0;
      let contrastSum = 0;
      let count = 0;
      for (let s = 2; s <= 14; s++) {
        const t = s / 16;
        const px = a.x + ex * t + ox * d;
        const py = a.y + ey * t + oy * d;
        const ix = Math.round(px);
        const iy = Math.round(py);
        if (ix < 3 || ix >= w - 3 || iy < 3 || iy >= h - 3) continue;
        const inX = Math.max(0, Math.min(w - 1, Math.round(px - ox * 4)));
        const inY = Math.max(0, Math.min(h - 1, Math.round(py - oy * 4)));
        const outX = Math.max(0, Math.min(w - 1, Math.round(px + ox * 4)));
        const outY = Math.max(0, Math.min(h - 1, Math.round(py + oy * 4)));
        const stepW = closedWhite[inY * w + inX] - closedWhite[outY * w + outX];
        gradSum += gradMag[iy * w + ix];
        if (stepW > 0) contrastSum += Math.min(35, stepW);
        count++;
      }
      if (count < 4) continue;
      const sc = (gradSum / count) * 1.1 + (contrastSum / count) * 1.3;
      if (sc > bestEdgeScore) {
        bestEdgeScore = sc;
        bestOffset = d;
      }
    }

    const sa = { x: a.x + ox * bestOffset, y: a.y + oy * bestOffset };
    const sb = { x: b.x + ox * bestOffset, y: b.y + oy * bestOffset };
    const dx = sb.x - sa.x;
    const dy = sb.y - sa.y;
    const len = Math.max(1, Math.hypot(dx, dy));
    const la = -dy / len;
    const lb = dx / len;
    const lc = -(la * sa.x + lb * sa.y);
    return { a: la, b: lb, c: lc };
  };

  const lTop = snapEdge(tl, tr);
  const lRight = snapEdge(tr, br);
  const lBottom = snapEdge(br, bl);
  const lLeft = snapEdge(bl, tl);

  const pTL = intersectLines(lTop, lLeft);
  const pTR = intersectLines(lTop, lRight);
  const pBR = intersectLines(lBottom, lRight);
  const pBL = intersectLines(lBottom, lLeft);
  if (!pTL || !pTR || !pBR || !pBL) return corners;
  return orderCorners([pTL, pTR, pBR, pBL]);
}

export function analyzeCanvasFrame(canvas: HTMLCanvasElement, fastMode = false): LiveFrameAnalysis {
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
    whiteness[i] = Math.max(0, lum - chroma * 1.15);
  }

  // 2. Morphological Closing (3x3 in live preview for 60fps, 5x5 on capture for maximum accuracy)
  const closeRadius = fastMode ? 1 : 2;
  const closedGray = morphClose(rawGray, width, height, closeRadius);
  const closedWhite = morphClose(whiteness, width, height, closeRadius);

  // 2a. Standard White-Page Background Color Profile (center-seeded RGB + low-chroma priority)
  const cy0 = Math.floor(height * 0.36);
  const cy1 = Math.floor(height * 0.64);
  const cx0 = Math.floor(width * 0.36);
  const cx1 = Math.floor(width * 0.64);
  const centerR: number[] = [];
  const centerG: number[] = [];
  const centerB: number[] = [];
  for (let y = cy0; y < cy1; y += 2) {
    for (let x = cx0; x < cx1; x += 2) {
      const p = (y * width + x) * 4;
      const r = data[p];
      const g = data[p + 1];
      const b = data[p + 2];
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      const chroma = Math.max(r, g, b) - Math.min(r, g, b);
      if (lum >= 115 && chroma <= 38) {
        centerR.push(r);
        centerG.push(g);
        centerB.push(b);
      }
    }
  }
  let closedColorMatch: Float32Array | null = null;
  if (centerR.length >= 16) {
    centerR.sort((a, b) => a - b);
    centerG.sort((a, b) => a - b);
    centerB.sort((a, b) => a - b);
    const refIdx = Math.floor(centerR.length * 0.65);
    const refR = centerR[refIdx];
    const refG = centerG[refIdx];
    const refB = centerB[refIdx];
    const refLum = 0.299 * refR + 0.587 * refG + 0.114 * refB;
    const refChroma = Math.max(refR, refG, refB) - Math.min(refR, refG, refB);
    if (refLum >= 120 && refChroma <= 36) {
      const colorMatch = new Float32Array(totalPx);
      for (let i = 0; i < totalPx; i++) {
        const p = i * 4;
        const r = data[p];
        const g = data[p + 1];
        const b = data[p + 2];
        const chroma = Math.max(r, g, b) - Math.min(r, g, b);
        const colorDist = (Math.abs(r - refR) + Math.abs(g - refG) + Math.abs(b - refB)) / 3;
        colorMatch[i] = Math.max(0, 255 - colorDist * 2.4 - chroma * 0.8);
      }
      closedColorMatch = morphClose(colorMatch, width, height, closeRadius);
    }
  }

  // 2b. Local Illumination Normalization (cancels desk shadows & uneven lighting)
  const localBg = fastBoxBlur(closedGray, width, height, fastMode ? 10 : 14);
  const shadowNormWhite = new Float32Array(totalPx);
  for (let i = 0; i < totalPx; i++) {
    shadowNormWhite[i] = Math.max(0, Math.min(255, closedWhite[i] - localBg[i] * 0.45 + 88));
  }

  // 3. Sobel gradient magnitude + contact-shadow ridge along paper borders
  const gradMag = new Float32Array(totalPx);
  for (let y = 1; y < height - 1; y++) {
    const row = y * width;
    for (let x = 1; x < width - 1; x++) {
      const i = row + x;
      const gx =
        -closedGray[i - width - 1] +
        closedGray[i - width + 1] -
        2 * closedGray[i - 1] +
        2 * closedGray[i + 1] -
        closedGray[i + width - 1] +
        closedGray[i + width + 1];
      const gy =
        -closedGray[i - width - 1] -
        2 * closedGray[i - width] -
        closedGray[i - width + 1] +
        closedGray[i + width - 1] +
        2 * closedGray[i + width] +
        closedGray[i + width + 1];
      const sobel = (Math.abs(gx) + Math.abs(gy)) * 0.25;
      const shadowRidge = Math.max(0, localBg[i] - closedGray[i]) * 0.45;
      gradMag[i] = sobel + shadowRidge;
    }
  }

  // 4. Generate candidate quads from Otsu + center-seeded paper thresholds (separates white paper from grey desks)
  const otsu = computeOtsuThreshold(closedWhite);
  const centerSamples: number[] = [];
  for (let y = cy0; y < cy1; y += 2) {
    for (let x = cx0; x < cx1; x += 2) {
      centerSamples.push(closedWhite[y * width + x]);
    }
  }
  centerSamples.sort((a, b) => a - b);
  const centerPaperRef =
    centerSamples.length > 0
      ? centerSamples[Math.floor(centerSamples.length * 0.65)]
      : 170;

  const thresholds = Array.from(
    new Set([
      otsu,
      Math.max(70, Math.min(220, Math.round(centerPaperRef - 38))),
      Math.max(85, Math.min(230, Math.round(centerPaperRef - 24))),
      Math.max(95, Math.min(235, Math.round(centerPaperRef - 14))),
    ])
  );

  const candidates: { corners: [Pt, Pt, Pt, Pt]; bonus: number }[] = [];
  const cOut = detectQuadCenterOutward(
    closedGray,
    closedWhite,
    width,
    height,
    centerPaperRef,
    closedColorMatch
  );
  if (cOut) candidates.push({ corners: cOut, bonus: 0.06 });

  for (const t of thresholds) {
    const c = detectQuadFromComponent(closedWhite, gradMag, width, height, t);
    if (c) candidates.push({ corners: c, bonus: 0 });
  }
  if (closedColorMatch) {
    for (const ct of [175, 195]) {
      const cColor = detectQuadFromComponent(closedColorMatch, gradMag, width, height, ct);
      if (cColor) candidates.push({ corners: cColor, bonus: 0.05 });
    }
  }
  const normOtsu = computeOtsuThreshold(shadowNormWhite);
  const cNorm = detectQuadFromComponent(shadowNormWhite, gradMag, width, height, normOtsu);
  if (cNorm) candidates.push({ corners: cNorm, bonus: 0 });

  const cScan = detectQuadFromClosedScanlines(closedGray, closedWhite, width, height);
  if (cScan) candidates.push({ corners: cScan, bonus: 0.02 });

  let bestCorners: [Pt, Pt, Pt, Pt] | null = null;
  let bestScore = 0;
  for (const cand of candidates) {
    const base = scoreQuadCandidate(
      cand.corners,
      closedWhite,
      gradMag,
      width,
      height,
      centerPaperRef,
      closedColorMatch
    );
    const s = base > 0 ? base + cand.bonus : 0;
    if (s > bestScore) {
      bestScore = s;
      bestCorners = cand.corners;
    }
  }

  if (!bestCorners || bestScore < 0.30) {
    return { quad: null, confidence: 0, fingerprint };
  }

  // Snap edges outward to true paper-to-desk gradient so shaded margins are never clipped
  const snapped = snapQuadToOuterPaperBoundary(bestCorners, closedWhite, gradMag, width, height);
  const snappedScore = scoreQuadCandidate(
    snapped,
    closedWhite,
    gradMag,
    width,
    height,
    centerPaperRef,
    closedColorMatch
  );
  const finalCorners = snappedScore >= bestScore * 0.88 ? snapped : bestCorners;

  const [pTL, pTR, pBR, pBL] = finalCorners;
  const clamp01 = (v: number) => Math.max(0.01, Math.min(0.99, v));
  const quad: NormalizedQuad = {
    tlX: clamp01(pTL.x / width),
    tlY: clamp01(pTL.y / height),
    trX: clamp01(pTR.x / width),
    trY: clamp01(pTR.y / height),
    brX: clamp01(pBR.x / width),
    brY: clamp01(pBR.y / height),
    blX: clamp01(pBL.x / width),
    blY: clamp01(pBL.y / height),
  };

  return { quad, confidence: bestScore, fingerprint };
}

export async function detectQuadFromImageUrl(imageUrl: string): Promise<NormalizedQuad> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      const targetW = 280;
      const targetH = Math.max(
        100,
        Math.min(360, Math.round((img.naturalHeight / Math.max(1, img.naturalWidth)) * targetW))
      );
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
