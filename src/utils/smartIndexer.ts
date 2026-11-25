import JSZip from 'jszip';
import * as pdfjsLib from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { createWorker, Worker } from 'tesseract.js';
import {
  DeviceIndexFilters,
  DeviceIndexSummary,
  DocumentPage,
  FileCategory,
  FULL_QUAD,
  IndexProgress,
  ScanDocument,
  ScanFilterId,
} from '../types/filelens';
import {
  classifyFileCategory,
  isExtensionAllowedByFilters,
} from './deviceRoots';
import { chunkDocumentPages } from './embeddingEngine';
import {
  detectSmartTags,
  extractExpiryDateIso,
  getCardSmartCategory,
  shouldAutoPromoteToSmartCard,
  suggestFolderId,
  suggestSmartDocumentTitle,
} from './smartTaxonomy';
import { detectQuadFromImageUrl } from './documentEdgeDetector';
import { formatBytes } from './formatters';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

const OCR_POOL_SIZE = 2;
let ocrPool: Promise<Worker>[] = [];
let ocrPoolLang = 'eng';
let ocrPoolIndex = 0;
let globalDocSeq = 0;

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => resolve(fallback), ms);
    promise
      .then((val) => {
        window.clearTimeout(timer);
        resolve(val);
      })
      .catch(() => {
        window.clearTimeout(timer);
        resolve(fallback);
      });
  });
}

function getOcrWorkerFromPool(lang: string = 'eng'): Promise<Worker> {
  if (ocrPool.length === 0 || ocrPoolLang !== lang) {
    if (ocrPool.length > 0) {
      ocrPool.forEach((p) => p.then((w) => w.terminate().catch(() => undefined)).catch(() => undefined));
    }
    ocrPoolLang = lang;
    ocrPool = Array.from({ length: OCR_POOL_SIZE }, () =>
      createWorker(lang).catch(async (err) => {
        if (lang !== 'eng') {
          ocrPoolLang = 'eng';
          return createWorker('eng');
        }
        throw err;
      })
    );
  }
  const idx = ocrPoolIndex % ocrPool.length;
  ocrPoolIndex++;
  return ocrPool[idx];
}

/**
 * Downscale large camera photos (>1400px) before OCR — 5-8x faster Tesseract recognition.
 */
async function downscaleForOcr(imageSource: string, maxDim = 1400): Promise<string> {
  if (!imageSource.startsWith('data:image/')) return imageSource;
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const maxSide = Math.max(img.naturalWidth, img.naturalHeight);
      if (maxSide <= maxDim || maxSide === 0) {
        resolve(imageSource);
        return;
      }
      const scale = maxDim / maxSide;
      const w = Math.max(1, Math.round(img.naturalWidth * scale));
      const h = Math.max(1, Math.round(img.naturalHeight * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        resolve(imageSource);
        return;
      }
      ctx.drawImage(img, 0, 0, w, h);
      resolve(canvas.toDataURL('image/jpeg', 0.85));
    };
    img.onerror = () => resolve(imageSource);
    img.src = imageSource;
  });
}

export async function runRealOcrOnImage(
  imageSource: string,
  ocrLanguage: 'eng+hin' | 'eng' | 'hin' = 'eng'
): Promise<string> {
  try {
    const prepared = await downscaleForOcr(imageSource, 1200);
    const recognizeTask = (async () => {
      const worker = await getOcrWorkerFromPool(ocrLanguage);
      const { data } = await worker.recognize(prepared);
      return (data.text || '').replace(/\s+/g, ' ').trim();
    })();
    return await withTimeout(recognizeTask, 10_000, '');
  } catch {
    return '';
  }
}

export interface OcrWordBox {
  text: string;
  bbox: { x0: number; y0: number; x1: number; y1: number };
}

export async function recognizeImageWithWordBoxes(
  imageSource: string,
  ocrLanguage: 'eng+hin' | 'eng' | 'hin' = 'eng'
): Promise<{ text: string; words: OcrWordBox[] }> {
  try {
    const worker = await getOcrWorkerFromPool(ocrLanguage);
    const { data } = await worker.recognize(imageSource);
    const rawWords = (data as unknown as { words?: Array<{ text?: string; bbox?: { x0: number; y0: number; x1: number; y1: number } }> }).words || [];
    const words: OcrWordBox[] = rawWords
      .filter((w) => w.text && w.bbox)
      .map((w) => ({
        text: w.text!.trim(),
        bbox: w.bbox!,
      }));
    return {
      text: (data.text || '').replace(/\s+/g, ' ').trim(),
      words,
    };
  } catch {
    return { text: '', words: [] };
  }
}

async function computeSha256Hex(buffer: ArrayBuffer): Promise<string> {
  try {
    const slice = buffer.byteLength > 8_000_000 ? buffer.slice(0, 8_000_000) : buffer;
    const hashBuf = await crypto.subtle.digest('SHA-256', slice);
    return Array.from(new Uint8Array(hashBuf))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  } catch {
    return `${buffer.byteLength}-${Date.now()}`;
  }
}

function stripXmlTags(xml: string): string {
  return xml
    .replace(/<w:p[^>]*>/gi, '\n')
    .replace(/<a:p[^>]*>/gi, '\n')
    .replace(/<text:p[^>]*>/gi, '\n')
    .replace(/<p[^>]*>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s+/g, '\n')
    .trim();
}

function stripRtfText(rtf: string): string {
  return rtf
    .replace(/\\par[d]?/g, '\n')
    .replace(/\\tab/g, ' ')
    .replace(/\\'[0-9a-fA-F]{2}/g, ' ')
    .replace(/\\[a-z]+-?\d* ?/gi, '')
    .replace(/[{}]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Extracts printable ASCII/UTF-8 text strings from legacy binary docs (.doc/.xls/.ppt)
 * or arbitrary device files so even unknown binary formats expose searchable metadata/strings.
 */
function extractPrintableStringsFromBinary(buffer: ArrayBuffer, maxChars = 6000): string {
  const bytes = new Uint8Array(buffer.slice(0, Math.min(buffer.byteLength, 512_000)));
  const found: string[] = [];
  let current = '';

  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if ((b >= 32 && b <= 126) || b === 9 || b === 10 || b === 13) {
      current += String.fromCharCode(b);
    } else {
      if (current.trim().length >= 6 && /[a-zA-Z]{3,}/.test(current)) {
        found.push(current.trim());
      }
      current = '';
      if (found.length > 260) break;
    }
  }
  if (current.trim().length >= 6 && /[a-zA-Z]{3,}/.test(current)) {
    found.push(current.trim());
  }

  return found.join(' ').replace(/\s+/g, ' ').slice(0, maxChars).trim();
}

/**
 * Real client-side parser for Office Open XML (.docx, .xlsx, .pptx),
 * OpenDocument (.odt, .ods, .odp), EPUB (.epub), and RTF (.rtf) files.
 */
async function extractOfficeDocumentText(
  buffer: ArrayBuffer,
  ext: string
): Promise<string> {
  if (ext === 'rtf') {
    const raw = new TextDecoder('utf-8', { fatal: false }).decode(buffer);
    return stripRtfText(raw).slice(0, 32_000);
  }

  if (ext === 'doc' || ext === 'xls' || ext === 'ppt') {
    return extractPrintableStringsFromBinary(buffer, 16_000);
  }

  try {
    const zip = await JSZip.loadAsync(buffer);
    const chunks: string[] = [];

    if (ext === 'docx') {
      const targets = Object.keys(zip.files).filter(
        (k) => /^word\/(document|header\d*|footer\d*|footnotes)\.xml$/i.test(k)
      );
      for (const key of targets) {
        const xml = await zip.files[key].async('text');
        chunks.push(stripXmlTags(xml));
      }
    } else if (ext === 'xlsx') {
      const shared = zip.files['xl/sharedStrings.xml'];
      if (shared) {
        chunks.push(stripXmlTags(await shared.async('text')));
      }
      const sheets = Object.keys(zip.files)
        .filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(k))
        .sort();
      for (const key of sheets.slice(0, 12)) {
        const xml = await zip.files[key].async('text');
        chunks.push(stripXmlTags(xml));
      }
    } else if (ext === 'pptx') {
      const slides = Object.keys(zip.files)
        .filter((k) => /^ppt\/slides\/slide\d+\.xml$/i.test(k))
        .sort();
      for (const key of slides.slice(0, 40)) {
        const xml = await zip.files[key].async('text');
        chunks.push(stripXmlTags(xml));
      }
    } else if (ext === 'odt' || ext === 'ods' || ext === 'odp') {
      const content = zip.files['content.xml'];
      if (content) {
        chunks.push(stripXmlTags(await content.async('text')));
      }
    } else if (ext === 'epub') {
      const htmlEntries = Object.keys(zip.files)
        .filter((k) => /\.(xhtml|html|htm)$/i.test(k))
        .sort();
      for (const key of htmlEntries.slice(0, 20)) {
        const html = await zip.files[key].async('text');
        chunks.push(stripXmlTags(html));
      }
    }

    return chunks.join('\n').replace(/\s+/g, ' ').trim().slice(0, 36_000);
  } catch {
    return extractPrintableStringsFromBinary(buffer, 8000);
  }
}

/**
 * Inspects ZIP/JAR/APK archive manifests so internal filenames & paths are searchable.
 */
async function extractArchiveManifestText(buffer: ArrayBuffer, fileName: string): Promise<string> {
  try {
    const zip = await JSZip.loadAsync(buffer);
    const names = Object.keys(zip.files).slice(0, 250);
    return `Archive ${fileName} containing ${Object.keys(zip.files).length} entries:\n${names.join('\n')}`;
  } catch {
    return `Archive file ${fileName}`;
  }
}

function getCategoryAccent(category: FileCategory): { badge: string; accent: string } {
  switch (category) {
    case 'office':
      return { badge: 'OFFICE DOCUMENT', accent: '#2563EB' };
    case 'text_code':
      return { badge: 'TEXT / CODE', accent: '#0D9488' };
    case 'audio_video':
      return { badge: 'MEDIA FILE', accent: '#9333EA' };
    case 'archive':
      return { badge: 'ARCHIVE', accent: '#D97706' };
    case 'image':
      return { badge: 'IMAGE OCR', accent: '#EA580C' };
    case 'pdf':
      return { badge: 'PDF DOCUMENT', accent: '#EA580C' };
    default:
      return { badge: 'DEVICE FILE', accent: '#475569' };
  }
}

function renderUniversalFilePreviewCard(
  title: string,
  text: string,
  ext: string,
  relPath: string,
  sizeBytes: number,
  category: FileCategory
): string {
  const canvas = document.createElement('canvas');
  canvas.width = 720;
  canvas.height = 960;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';

  const { badge, accent } = getCategoryAccent(category);

  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Header band
  ctx.fillStyle = '#F8FAFC';
  ctx.fillRect(0, 0, canvas.width, 136);
  ctx.fillStyle = '#E2E8F0';
  ctx.fillRect(0, 136, canvas.width, 2);

  // Accent bar on top
  ctx.fillStyle = accent;
  ctx.fillRect(0, 0, canvas.width, 8);

  ctx.fillStyle = accent;
  ctx.font = '700 17px "JetBrains Mono", monospace';
  ctx.fillText(`${(ext || 'FILE').toUpperCase()}  ·  ${badge}  ·  ${formatBytes(sizeBytes)}`, 44, 48);

  ctx.fillStyle = '#0F172A';
  ctx.font = '700 24px "Plus Jakarta Sans", sans-serif';
  ctx.fillText(title.slice(0, 44), 44, 86);

  ctx.fillStyle = '#64748B';
  ctx.font = '400 15px "JetBrains Mono", monospace';
  ctx.fillText(relPath.slice(0, 68), 44, 116);

  // Body extracted text / metadata lines
  ctx.fillStyle = '#334155';
  ctx.font = '400 17px "JetBrains Mono", monospace';
  const lines: string[] = [];
  const rawLines = text.slice(0, 3600).split(/\r?\n/);
  for (const raw of rawLines) {
    const clean = raw.trim();
    if (!clean) {
      lines.push('');
    } else if (clean.length <= 58) {
      lines.push(clean);
    } else {
      for (let i = 0; i < clean.length; i += 58) {
        lines.push(clean.slice(i, i + 58));
      }
    }
    if (lines.length >= 28) break;
  }

  let y = 182;
  for (const line of lines) {
    ctx.fillText(line, 44, y);
    y += 26;
  }

  return canvas.toDataURL('image/jpeg', 0.84);
}

async function parsePdfFile(
  buffer: ArrayBuffer,
  defaultFilter: ScanFilterId,
  ocrLanguage: 'eng+hin' | 'eng' | 'hin' = 'eng'
): Promise<{ pages: DocumentPage[]; combinedText: string }> {
  const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(buffer) });
  const pdf = await loadingTask.promise;
  const maxPages = Math.min(pdf.numPages, 20);
  const pages: DocumentPage[] = [];
  const textParts: string[] = [];

  for (let p = 1; p <= maxPages; p++) {
    const page = await pdf.getPage(p);
    // Extract embedded text FIRST without rendering heavy canvases on every text-based page
    const textContent = await page.getTextContent();
    let pageText = textContent.items
      .map((item) => ('str' in item ? item.str : ''))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();

    const needsOcr = pageText.length < 12 && p <= 4;
    const viewport = page.getViewport({ scale: needsOcr ? 1.25 : 0.85 });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    const ctx = canvas.getContext('2d');
    if (ctx) {
      await page.render({ canvasContext: ctx, viewport, canvas }).promise;
    }
    const imgUrl = canvas.toDataURL('image/jpeg', needsOcr ? 0.8 : 0.72);

    if (needsOcr) {
      pageText = await runRealOcrOnImage(imgUrl, ocrLanguage);
    }

    textParts.push(pageText);
    pages.push({
      id: `pg-pdf-${Date.now()}-${++globalDocSeq}-${p}`,
      imageUrl: imgUrl,
      rotation: 0,
      filter: defaultFilter,
      quad: FULL_QUAD,
      brightness: 1,
      contrast: 1,
      ocrText: pageText,
      signatures: [],
    });
  }

  return { pages, combinedText: textParts.join('\n') };
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export interface SmartIndexRunOptions {
  files: File[];
  existingDocuments: ScanDocument[];
  defaultFilter: ScanFilterId;
  sourceLabel: string;
  filePathMap?: WeakMap<File, string>;
  filters?: DeviceIndexFilters;
  ocrLanguage?: 'eng+hin' | 'eng' | 'hin';
  forceReindex?: boolean;
  signal?: AbortSignal;
  onProgress: (progress: IndexProgress) => void;
}

export interface SmartIndexRunResult {
  newDocuments: ScanDocument[];
  updatedDocuments: ScanDocument[];
  summary: DeviceIndexSummary;
}

/**
 * Universal All-File Smart Indexing Pipeline (ported & expanded from FileLensMobile DocumentIndexer.kt):
 * - Indexes EVERY file type on the device: PDFs, Images (OCR), Office (DOCX/XLSX/PPTX/ODT/EPUB/RTF),
 *   Text/Code/CSV/JSON/Email, ZIP/APK Archives, Audio/Video, and any other device binary file!
 * - Delta fingerprint check skips unchanged files on re-sync
 * - Computes SHA-256 content hash, 384-dim semantic chunks, SmartTaxonomy tags, folder routing & Expiry Radar
 */
export async function runSmartIndexingPipeline(
  options: SmartIndexRunOptions
): Promise<SmartIndexRunResult> {
  const {
    files,
    existingDocuments,
    defaultFilter,
    sourceLabel,
    filePathMap,
    filters,
    ocrLanguage = 'eng+hin',
    forceReindex = false,
    signal,
    onProgress,
  } = options;

  const startedAt = performance.now();
  const filteredPool = files.filter((f) => {
    const rel =
      filePathMap?.get(f) ||
      (f as File & { nativePath?: string }).nativePath ||
      (f as File & { webkitRelativePath?: string }).webkitRelativePath ||
      f.name;

    if (filters?.skipSystemFolders) {
      if (
        /(^|\/)(\.|node_modules|__pycache__|\$recycle\.bin|appdata|library|build|dist)\b/i.test(
          rel
        )
      ) {
        return false;
      }
    }

    if (filters) {
      return isExtensionAllowedByFilters(f.name, filters, f.type);
    }

    // When no filter object is supplied (e.g., direct file drop or pick), index EVERY file!
    return true;
  });

  const targetFiles = filters
    ? filteredPool.slice(0, filters.maxFilesPerRun)
    : filteredPool;

  const existingByFingerprint = new Map<string, ScanDocument>();
  const existingByPath = new Map<string, ScanDocument>();
  for (const doc of existingDocuments) {
    if (doc.fileFingerprint) existingByFingerprint.set(doc.fileFingerprint, doc);
    if (doc.sourcePath) existingByPath.set(doc.sourcePath, doc);
  }

  const newDocuments: ScanDocument[] = [];
  const updatedDocuments: ScanDocument[] = [];
  let skippedUnchanged = 0;
  let newOrUpdated = 0;
  let processed = 0;
  let lastProgMs = 0;

  const emitProgress = (prog: IndexProgress, force = false) => {
    const now = performance.now();
    if (force || now - lastProgMs >= 100) {
      lastProgMs = now;
      onProgress(prog);
    }
  };

  let cursor = 0;
  const CONCURRENCY = Math.min(3, Math.max(1, targetFiles.length));

  const processSingleFile = async (file: File, fileIdx: number) => {
    if (signal?.aborted) return;

    const ext = file.name.includes('.') ? file.name.split('.').pop()?.toLowerCase() ?? '' : '';
    const category = classifyFileCategory(file.name, file.type);
    const relPath =
      filePathMap?.get(file) ||
      (file as File & { nativePath?: string }).nativePath ||
      (file as File & { webkitRelativePath?: string }).webkitRelativePath ||
      file.name;
    const fingerprint = `${relPath}|${file.size}|${file.lastModified}`;

    emitProgress({
      indexed: processed,
      total: targetFiles.length,
      currentFile: relPath,
      phase: 'Scanning',
      skippedUnchanged,
      newOrUpdated,
    });

    // Delta Skip Check
    if (!forceReindex && existingByFingerprint.has(fingerprint)) {
      skippedUnchanged++;
      processed++;
      return;
    }

    const buffer = await file.arrayBuffer();
    const contentHash = await computeSha256Hex(buffer);

    emitProgress({
      indexed: processed,
      total: targetFiles.length,
      currentFile: relPath,
      phase: 'Extracting Text & OCR',
      skippedUnchanged,
      newOrUpdated,
    });

    let pages: DocumentPage[] = [];
    let combinedText = '';

    if (category === 'pdf') {
      try {
        const parsed = await withTimeout(
          parsePdfFile(buffer, defaultFilter, ocrLanguage),
          15_000,
          { pages: [], combinedText: '' }
        );
        pages = parsed.pages;
        combinedText = parsed.combinedText;
      } catch {
        pages = [];
      }
      if (pages.length === 0) {
        combinedText = `PDF document ${file.name} (${relPath})`;
        const fallbackImg = renderUniversalFilePreviewCard(
          file.name,
          combinedText,
          'pdf',
          relPath,
          file.size,
          'pdf'
        );
        pages = [
          {
            id: `pg-pdf-fb-${Date.now()}-${fileIdx}`,
            imageUrl: fallbackImg,
            rotation: 0,
            filter: defaultFilter,
            quad: FULL_QUAD,
            brightness: 1,
            contrast: 1,
            ocrText: combinedText,
            signatures: [],
          },
        ];
      }
    } else if (category === 'image') {
      const dataUrl = await readFileAsDataUrl(file);
      let ocrText = '';
      let detectedQuad = FULL_QUAD;

      if (ext === 'svg') {
        const svgRaw = await file.text();
        ocrText = stripXmlTags(svgRaw).slice(0, 12_000);
      } else {
        const [extractedOcr, quad] = await Promise.all([
          runRealOcrOnImage(dataUrl, ocrLanguage),
          withTimeout(detectQuadFromImageUrl(dataUrl), 3000, FULL_QUAD),
        ]);
        ocrText = extractedOcr;
        detectedQuad = quad;
      }

      combinedText = `${ocrText}\n${relPath}`.trim();
      pages = [
        {
          id: `pg-img-${Date.now()}-${fileIdx}`,
          imageUrl: dataUrl,
          rotation: 0,
          filter: defaultFilter,
          quad: detectedQuad,
          brightness: 1,
          contrast: 1,
          ocrText: combinedText,
          signatures: [],
        },
      ];
    } else if (category === 'office') {
      const extracted = await extractOfficeDocumentText(buffer, ext);
      combinedText = extracted || `${file.name} (${relPath})`;
      const pageImg = renderUniversalFilePreviewCard(
        file.name,
        combinedText,
        ext,
        relPath,
        file.size,
        'office'
      );
      pages = [
        {
          id: `pg-off-${Date.now()}-${processed}`,
          imageUrl: pageImg,
          rotation: 0,
          filter: 'original',
          quad: FULL_QUAD,
          brightness: 1,
          contrast: 1,
          ocrText: combinedText,
          signatures: [],
        },
      ];
    } else if (category === 'text_code') {
      const text = await file.text();
      combinedText = text.slice(0, 36_000);
      const pageImg = renderUniversalFilePreviewCard(
        file.name,
        combinedText,
        ext || 'txt',
        relPath,
        file.size,
        'text_code'
      );
      pages = [
        {
          id: `pg-txt-${Date.now()}-${processed}`,
          imageUrl: pageImg,
          rotation: 0,
          filter: 'original',
          quad: FULL_QUAD,
          brightness: 1,
          contrast: 1,
          ocrText: combinedText,
          signatures: [],
        },
      ];
    } else if (category === 'archive') {
      combinedText =
        ext === 'zip' || ext === 'jar' || ext === 'apk'
          ? await extractArchiveManifestText(buffer, file.name)
          : `Archive ${file.name}\nPath: ${relPath}\nSize: ${formatBytes(file.size)}`;
      const pageImg = renderUniversalFilePreviewCard(
        file.name,
        combinedText,
        ext || 'zip',
        relPath,
        file.size,
        'archive'
      );
      pages = [
        {
          id: `pg-arc-${Date.now()}-${processed}`,
          imageUrl: pageImg,
          rotation: 0,
          filter: 'original',
          quad: FULL_QUAD,
          brightness: 1,
          contrast: 1,
          ocrText: combinedText,
          signatures: [],
        },
      ];
    } else if (category === 'audio_video') {
      const modDate = file.lastModified
        ? new Date(file.lastModified).toISOString().slice(0, 10)
        : '';
      const metaHeader = `Media File: ${file.name}\nPath: ${relPath}\nType: ${file.type || ext.toUpperCase()}\nSize: ${formatBytes(file.size)}\nModified: ${modDate}`;
      const strings = extractPrintableStringsFromBinary(buffer, 1800);
      combinedText = strings ? `${metaHeader}\n\nEmbedded Metadata:\n${strings}` : metaHeader;
      const pageImg = renderUniversalFilePreviewCard(
        file.name,
        combinedText,
        ext || 'media',
        relPath,
        file.size,
        'audio_video'
      );
      pages = [
        {
          id: `pg-med-${Date.now()}-${processed}`,
          imageUrl: pageImg,
          rotation: 0,
          filter: 'original',
          quad: FULL_QUAD,
          brightness: 1,
          contrast: 1,
          ocrText: combinedText,
          signatures: [],
        },
      ];
    } else {
      // ANY OTHER FILE TYPE ON DEVICE (*.*)
      const modDate = file.lastModified
        ? new Date(file.lastModified).toISOString().slice(0, 10)
        : '';
      const header = `File: ${file.name}\nPath: ${relPath}\nExtension: .${ext || 'none'}\nMIME: ${file.type || 'application/octet-stream'}\nSize: ${formatBytes(file.size)}\nModified: ${modDate}`;
      const extractedStrings = extractPrintableStringsFromBinary(buffer, 4000);
      combinedText = extractedStrings
        ? `${header}\n\nExtracted Content:\n${extractedStrings}`
        : header;
      const pageImg = renderUniversalFilePreviewCard(
        file.name,
        combinedText,
        ext || 'file',
        relPath,
        file.size,
        'other'
      );
      pages = [
        {
          id: `pg-any-${Date.now()}-${processed}`,
          imageUrl: pageImg,
          rotation: 0,
          filter: 'original',
          quad: FULL_QUAD,
          brightness: 1,
          contrast: 1,
          ocrText: combinedText,
          signatures: [],
        },
      ];
    }

    emitProgress({
      indexed: processed,
      total: targetFiles.length,
      currentFile: relPath,
      phase: 'Building Semantic Index',
      skippedUnchanged,
      newOrUpdated,
    });

    const chunks = chunkDocumentPages(pages);

    emitProgress({
      indexed: processed,
      total: targetFiles.length,
      currentFile: relPath,
      phase: 'Smart Taxonomy',
      skippedUnchanged,
      newOrUpdated,
    });

    const baseTitle = file.name.includes('.') ? file.name.replace(/\.[^.]+$/, '') : file.name;
    const smartTitle =
      category === 'image' &&
      /^img_|^pxl_|^dsc|^scan_|^whatsapp image/i.test(baseTitle) &&
      combinedText.length > 14
        ? suggestSmartDocumentTitle(combinedText, 'Scan')
        : baseTitle;

    const smartTags = detectSmartTags(file.name, combinedText);
    const categoryTag =
      category === 'office'
        ? 'Office'
        : category === 'text_code'
          ? 'Text & Code'
          : category === 'audio_video'
            ? 'Media'
            : category === 'archive'
              ? 'Archive'
              : ext
                ? ext.toUpperCase()
                : 'File';

    const folderId = suggestFolderId(file.name, combinedText);
    const isCard = shouldAutoPromoteToSmartCard(file.name, combinedText);
    const cardCategory = isCard ? getCardSmartCategory(file.name, smartTags, combinedText) : undefined;
    const expiryDate = extractExpiryDateIso(combinedText);

    const existingMatch = existingByPath.get(relPath);
    const nowIso = new Date().toISOString();

    const indexedDoc: ScanDocument = {
      id: existingMatch?.id ?? `doc-idx-${Date.now()}-${++globalDocSeq}`,
      title: smartTitle,
      folderId: existingMatch?.folderId ?? folderId,
      tags: Array.from(
        new Set([...(existingMatch?.tags ?? []), ...smartTags, categoryTag, 'Indexed'])
      ),
      createdAt: existingMatch?.createdAt ?? nowIso,
      updatedAt: nowIso,
      pages,
      isBookmarked: existingMatch?.isBookmarked ?? false,
      isSmartCard: existingMatch?.isSmartCard ?? isCard,
      cardCategory: existingMatch?.cardCategory ?? cardCategory,
      expiryDate: existingMatch?.expiryDate ?? expiryDate,
      pageSizePreset: 'a4',
      qualityPreset: 'balanced',
      sizeBytes: file.size || pages.length * 320_000,
      searchableOcr: true,
      fileFingerprint: fingerprint,
      contentHash,
      sourcePath: relPath,
      fileExtension: ext || 'file',
      mimeType: file.type || undefined,
      fileCategory: category,
      ocrStatus: 'done',
      indexedAt: nowIso,
      chunksCount: Math.max(1, chunks.length),
    };

    if (existingMatch) {
      updatedDocuments.push(indexedDoc);
    } else {
      newDocuments.push(indexedDoc);
    }

    newOrUpdated++;
    processed++;
  };

  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (cursor < targetFiles.length && !signal?.aborted) {
        const myIdx = cursor++;
        await processSingleFile(targetFiles[myIdx], myIdx);
      }
    })
  );

  return {
    newDocuments,
    updatedDocuments,
    summary: {
      newOrUpdated,
      skippedUnchanged,
      totalScanned: targetFiles.length,
      elapsedMs: Math.round(performance.now() - startedAt),
      wasCancelled: Boolean(signal?.aborted),
      timestampIso: new Date().toISOString(),
      sourceLabel,
    },
  };
}

/**
 * Re-indexes existing library documents: runs real Tesseract OCR on any page
 * missing OCR text, refreshes SmartTaxonomy tags, expiry dates, and semantic chunk counts.
 */
export async function runLibraryDeltaReindex(
  documents: ScanDocument[],
  signal: AbortSignal | undefined,
  onProgress: (progress: IndexProgress) => void
): Promise<{ updatedDocs: ScanDocument[]; summary: DeviceIndexSummary }> {
  const startedAt = performance.now();
  const updatedDocs: ScanDocument[] = [];
  let newOrUpdated = 0;
  let skippedUnchanged = 0;

  for (let i = 0; i < documents.length; i++) {
    const doc = documents[i];
    if (signal?.aborted) {
      updatedDocs.push(doc);
      continue;
    }

    onProgress({
      indexed: i,
      total: documents.length,
      currentFile: doc.title,
      phase: 'Scanning',
      skippedUnchanged,
      newOrUpdated,
    });

    const needsOcr = doc.pages.some((p) => !p.ocrText || p.ocrText.trim().length < 10);
    const alreadyIndexed = doc.ocrStatus === 'done' && !needsOcr && (doc.chunksCount ?? 0) > 0;

    if (alreadyIndexed) {
      skippedUnchanged++;
      updatedDocs.push(doc);
      continue;
    }

    const enrichedPages: DocumentPage[] = [];
    for (const pg of doc.pages) {
      if (!pg.ocrText || pg.ocrText.trim().length < 10) {
        onProgress({
          indexed: i,
          total: documents.length,
          currentFile: doc.title,
          phase: 'Extracting Text & OCR',
          skippedUnchanged,
          newOrUpdated,
        });
        const extracted = await runRealOcrOnImage(pg.imageUrl);
        enrichedPages.push({ ...pg, ocrText: extracted || pg.ocrText });
      } else {
        enrichedPages.push(pg);
      }
    }

    onProgress({
      indexed: i,
      total: documents.length,
      currentFile: doc.title,
      phase: 'Building Semantic Index',
      skippedUnchanged,
      newOrUpdated,
    });

    const combinedText = enrichedPages.map((p) => p.ocrText).join('\n');
    const chunks = chunkDocumentPages(enrichedPages);
    const smartTags = detectSmartTags(doc.title, combinedText);
    const expiryDate = doc.expiryDate ?? extractExpiryDateIso(combinedText);

    newOrUpdated++;
    updatedDocs.push({
      ...doc,
      pages: enrichedPages,
      tags: Array.from(new Set([...doc.tags, ...smartTags])),
      expiryDate,
      ocrStatus: 'done',
      indexedAt: new Date().toISOString(),
      chunksCount: Math.max(1, chunks.length),
    });
  }

  return {
    updatedDocs,
    summary: {
      newOrUpdated,
      skippedUnchanged,
      totalScanned: documents.length,
      elapsedMs: Math.round(performance.now() - startedAt),
      wasCancelled: Boolean(signal?.aborted),
      timestampIso: new Date().toISOString(),
      sourceLabel: 'Vault Delta Re-Index',
    },
  };
}
