import { ScanDocument } from '../types/filelens';

export interface StorageCategoryStat {
  id: 'pdf' | 'image' | 'office' | 'other';
  label: string;
  color: string;
  count: number;
  bytes: number;
}

export interface ExactDuplicateGroup {
  hash: string;
  totalDuplicateBytes: number;
  documents: ScanDocument[]; // Sorted oldest first (index 0 = original)
}

export interface SimilarImageItem {
  doc: ScanDocument;
  sharpness: number;
  dHash: bigint;
  isBestShot: boolean;
}

export interface VisualBurstCluster {
  clusterId: string;
  items: SimilarImageItem[];
  reclaimableBytes: number;
}

/**
 * Compute category breakdown and large files (>= 1 MB) for the vault.
 */
export function analyzeVaultStorage(documents: ScanDocument[]): {
  totalBytes: number;
  categories: StorageCategoryStat[];
  largeFiles: ScanDocument[];
} {
  const buckets: Record<StorageCategoryStat['id'], StorageCategoryStat> = {
    pdf: { id: 'pdf', label: 'PDF Documents', color: '#F97316', count: 0, bytes: 0 },
    image: { id: 'image', label: 'Images & Scans', color: '#3B82F6', count: 0, bytes: 0 },
    office: { id: 'office', label: 'Office & Text', color: '#10B981', count: 0, bytes: 0 },
    other: { id: 'other', label: 'Other Files', color: '#8B5CF6', count: 0, bytes: 0 },
  };

  let totalBytes = 0;
  for (const doc of documents) {
    totalBytes += doc.sizeBytes;
    const cat = doc.fileCategory;
    if (cat === 'image') {
      buckets.image.count++;
      buckets.image.bytes += doc.sizeBytes;
    } else if (cat === 'office' || cat === 'text_code') {
      buckets.office.count++;
      buckets.office.bytes += doc.sizeBytes;
    } else if (cat === 'audio_video' || cat === 'archive' || cat === 'other') {
      buckets.other.count++;
      buckets.other.bytes += doc.sizeBytes;
    } else {
      buckets.pdf.count++;
      buckets.pdf.bytes += doc.sizeBytes;
    }
  }

  const largeFiles = documents
    .filter((d) => d.sizeBytes >= 1_000_000)
    .sort((a, b) => b.sizeBytes - a.sizeBytes)
    .slice(0, 30);

  return {
    totalBytes,
    categories: Object.values(buckets).filter((b) => b.count > 0 || b.id === 'pdf'),
    largeFiles,
  };
}

/**
 * Group documents by exact SHA-256 contentHash, keeping oldest as original.
 */
export function findExactDuplicates(documents: ScanDocument[]): ExactDuplicateGroup[] {
  const byHash = new Map<string, ScanDocument[]>();
  for (const doc of documents) {
    if (!doc.contentHash || doc.sizeBytes <= 0) continue;
    const list = byHash.get(doc.contentHash) ?? [];
    list.push(doc);
    byHash.set(doc.contentHash, list);
  }

  const groups: ExactDuplicateGroup[] = [];
  for (const [hash, list] of byHash.entries()) {
    if (list.length > 1) {
      const sorted = [...list].sort(
        (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
      );
      const dupBytes = sorted.slice(1).reduce((s, d) => s + d.sizeBytes, 0);
      groups.push({ hash, totalDuplicateBytes: dupBytes, documents: sorted });
    }
  }

  return groups.sort((a, b) => b.totalDuplicateBytes - a.totalDuplicateBytes);
}

function loadImg(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

/**
 * Compute 64-bit dHash (9x8 luma) + Laplacian sharpness score on an image URL.
 */
export async function computeDHashAndSharpness(
  imageUrl: string
): Promise<{ dHash: bigint; sharpness: number } | null> {
  try {
    const img = await loadImg(imageUrl);

    // 1. 9x8 dHash
    const hashCanvas = document.createElement('canvas');
    hashCanvas.width = 9;
    hashCanvas.height = 8;
    const hCtx = hashCanvas.getContext('2d', { willReadFrequently: true });
    if (!hCtx) return null;
    hCtx.drawImage(img, 0, 0, 9, 8);
    const hd = hCtx.getImageData(0, 0, 9, 8).data;
    const luma = (x: number, y: number) => {
      const i = (y * 9 + x) * 4;
      return 0.299 * hd[i] + 0.587 * hd[i + 1] + 0.114 * hd[i + 2];
    };
    let dHash = 0n;
    let bit = 0n;
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        if (luma(x, y) > luma(x + 1, y)) {
          dHash |= 1n << bit;
        }
        bit++;
      }
    }

    // 2. Laplacian sharpness on 64x64 thumbnail
    const sCanvas = document.createElement('canvas');
    sCanvas.width = 64;
    sCanvas.height = 64;
    const sCtx = sCanvas.getContext('2d', { willReadFrequently: true });
    if (!sCtx) return { dHash, sharpness: 0 };
    sCtx.drawImage(img, 0, 0, 64, 64);
    const sd = sCtx.getImageData(0, 0, 64, 64).data;
    const gray = new Float32Array(64 * 64);
    for (let i = 0; i < 64 * 64; i++) {
      const p = i * 4;
      gray[i] = 0.299 * sd[p] + 0.587 * sd[p + 1] + 0.114 * sd[p + 2];
    }

    let sum = 0;
    let sumSq = 0;
    let count = 0;
    for (let y = 1; y < 63; y++) {
      for (let x = 1; x < 63; x++) {
        const c = y * 64 + x;
        const lap = gray[c - 64] + gray[c + 64] + gray[c - 1] + gray[c + 1] - 4 * gray[c];
        sum += lap;
        sumSq += lap * lap;
        count++;
      }
    }
    const mean = sum / Math.max(1, count);
    const sharpness = sumSq / Math.max(1, count) - mean * mean;

    return { dHash, sharpness };
  } catch {
    return null;
  }
}

function hammingDistance64(a: bigint, b: bigint): number {
  let x = a ^ b;
  let dist = 0;
  while (x > 0n) {
    dist += Number(x & 1n);
    x >>= 1n;
  }
  return dist;
}

/**
 * Cluster similar/burst photos (dHash Hamming distance <= 8) and mark sharpest as Best Shot.
 */
export async function findSimilarBurstPhotos(
  documents: ScanDocument[],
  maxImages = 80
): Promise<VisualBurstCluster[]> {
  const imageDocs = documents
    .filter((d) => d.pages.length > 0 && (d.fileCategory === 'image' || d.pages.length === 1))
    .slice(0, maxImages);

  const computed: { doc: ScanDocument; dHash: bigint; sharpness: number }[] = [];
  for (const doc of imageDocs) {
    const res = await computeDHashAndSharpness(doc.pages[0].imageUrl);
    if (res) {
      computed.push({ doc, dHash: res.dHash, sharpness: res.sharpness });
    }
  }

  const visited = new Set<string>();
  const clusters: VisualBurstCluster[] = [];

  for (let i = 0; i < computed.length; i++) {
    const seed = computed[i];
    if (visited.has(seed.doc.id)) continue;

    const group = [seed];
    for (let j = i + 1; j < computed.length; j++) {
      const cand = computed[j];
      if (visited.has(cand.doc.id)) continue;
      if (hammingDistance64(seed.dHash, cand.dHash) <= 8) {
        group.push(cand);
        visited.add(cand.doc.id);
      }
    }

    if (group.length > 1) {
      visited.add(seed.doc.id);
      group.sort((a, b) => b.sharpness - a.sharpness);
      const items: SimilarImageItem[] = group.map((g, idx) => ({
        doc: g.doc,
        sharpness: g.sharpness,
        dHash: g.dHash,
        isBestShot: idx === 0,
      }));
      const reclaimableBytes = items.slice(1).reduce((s, it) => s + it.doc.sizeBytes, 0);
      clusters.push({
        clusterId: `burst-${seed.doc.id}`,
        items,
        reclaimableBytes,
      });
    }
  }

  return clusters;
}
