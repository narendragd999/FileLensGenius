import { IndexedChunk } from '../types/filelens';

/**
 * Direct TypeScript port of FileLensMobile's EmbeddingEngine.kt:
 * 384-dimensional offline bilingual semantic embedding generator using
 * multi-seed FNV-1a unigrams, universal phonetic Soundex projection,
 * word bigrams, and character 3-gram / 4-gram hashing with L2 normalization.
 */
export const EMBEDDING_DIMENSION = 384;

const WORD_REGEX = /[\u0900-\u097F]+|[a-z0-9]+/gi;

// Lightweight transliteration/normalization matching FileLensMobile MultilingualEngine
export function normalizeMultilingualText(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function toUniversalSoundex(word: string): string {
  const clean = word.replace(/[^a-z]/g, '');
  if (clean.length < 2) return clean;
  const first = clean[0];
  const map: Record<string, string> = {
    b: '1', f: '1', p: '1', v: '1',
    c: '2', g: '2', j: '2', k: '2', q: '2', s: '2', x: '2', z: '2',
    d: '3', t: '3',
    l: '4',
    m: '5', n: '5',
    r: '6',
  };
  let out = first;
  let lastCode = map[first] ?? '';
  for (let i = 1; i < clean.length && out.length < 4; i++) {
    const code = map[clean[i]] ?? '';
    if (code && code !== lastCode) {
      out += code;
    }
    if (code) lastCode = code;
  }
  return out;
}

function fnv1aHash(str: string, seed = 0): number {
  let hash = (2166136261 ^ seed) | 0;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash;
}

export function l2Normalize(vector: Float32Array): Float32Array {
  let sumSq = 0;
  for (let i = 0; i < vector.length; i++) {
    sumSq += vector[i] * vector[i];
  }
  const norm = Math.sqrt(sumSq);
  if (norm < 1e-12) return vector;
  for (let i = 0; i < vector.length; i++) {
    vector[i] /= norm;
  }
  return vector;
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
  }
  return dot;
}

export function generateEmbedding(text: string): Float32Array {
  const vector = new Float32Array(EMBEDDING_DIMENSION);
  if (!text || !text.trim()) return vector;

  const normalized = normalizeMultilingualText(text);
  const words = normalized.match(WORD_REGEX) ?? [];

  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    const hasDigit = /\d/.test(word);
    const weight = hasDigit || word.length <= 4 ? 1.6 : 1.0;

    // 1. Multi-seed FNV-1a unigram hashing
    for (let seed = 0; seed < 4; seed++) {
      const h = fnv1aHash(word, seed);
      const dim = Math.abs(h) % EMBEDDING_DIMENSION;
      const sign = (h & 1) === 0 ? 1 : -1;
      vector[dim] += sign * weight;
    }

    // 2. Phonetic Soundex invariant projection
    const soundex = toUniversalSoundex(word);
    if (soundex.length >= 2) {
      for (let seed = 0; seed < 4; seed++) {
        const sHash = fnv1aHash(soundex, seed);
        const dim = Math.abs(sHash) % EMBEDDING_DIMENSION;
        const sign = (sHash & 1) === 0 ? 1 : -1;
        vector[dim] += sign * 1.8 * weight;
      }
    }

    // 3. Word bigrams
    if (i < words.length - 1) {
      const bigram = `${word}_${words[i + 1]}`;
      const biHash = fnv1aHash(bigram);
      const dim = Math.abs(biHash) % EMBEDDING_DIMENSION;
      const sign = (biHash & 1) === 0 ? 1 : -1;
      vector[dim] += sign * 1.5 * weight;
    }

    // 4. Character 3-grams and 4-grams for typo & stem invariance
    if (word.length >= 3) {
      for (let j = 0; j <= word.length - 3; j++) {
        const tri = word.slice(j, j + 3);
        const triHash = fnv1aHash(tri);
        const dim = Math.abs(triHash) % EMBEDDING_DIMENSION;
        const sign = (triHash & 1) === 0 ? 1 : -1;
        vector[dim] += sign * 0.5;
      }
    }

    if (word.length >= 4) {
      for (let j = 0; j <= word.length - 4; j++) {
        const four = word.slice(j, j + 4);
        const fourHash = fnv1aHash(four);
        const dim = Math.abs(fourHash) % EMBEDDING_DIMENSION;
        const sign = (fourHash & 1) === 0 ? 1 : -1;
        vector[dim] += sign * 0.6;
      }
    }
  }

  return l2Normalize(vector);
}

export function chunkDocumentPages(
  pages: { ocrText: string }[],
  chunkSize = 550,
  overlap = 80
): IndexedChunk[] {
  const chunks: IndexedChunk[] = [];
  pages.forEach((pg, pageIndex) => {
    const clean = (pg.ocrText || '').trim();
    if (!clean) return;
    if (clean.length <= chunkSize) {
      chunks.push({ pageIndex, text: clean });
      return;
    }
    let idx = 0;
    while (idx < clean.length) {
      const end = Math.min(clean.length, idx + chunkSize);
      const slice = clean.slice(idx, end).trim();
      if (slice) chunks.push({ pageIndex, text: slice });
      if (end >= clean.length) break;
      idx = Math.max(idx + 1, end - overlap);
    }
  });
  return chunks;
}
