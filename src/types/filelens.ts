export type ScanFilterId = 'magic' | 'bw' | 'whiteboard' | 'grayscale' | 'original';

export type ScanMode = 'batch' | 'single' | 'idcard';

export type BatchAutoPace = 'wait_page' | 'delay_3s' | 'delay_5s';

export type PdfPageSizePreset = 'auto' | 'a4' | 'letter';

export type PdfQualityPreset = 'high' | 'balanced' | 'compact';

export type PdfCompressPreset = 'email_small' | 'balanced' | 'print_high';

export type SearchMode = 'quick' | 'natural' | 'exact' | 'whole' | 'wildcard' | 'boolean';

export type SmartCardCategory =
  | 'Medical'
  | 'Vehicle'
  | 'Finance'
  | 'Govt IDs'
  | 'Education'
  | 'Personal';

export type TemporalClass = 'today' | 'upcoming' | 'history';

export type RecurrenceRule = 'none' | 'daily' | 'weekly' | 'monthly';

export type AppTab = 'documents' | 'search' | 'brain' | 'cards' | 'settings';

export type OcrStatus = 'done' | 'pending' | 'running';

export interface NormalizedQuad {
  tlX: number;
  tlY: number;
  trX: number;
  trY: number;
  brX: number;
  brY: number;
  blX: number;
  blY: number;
}

export const FULL_QUAD: NormalizedQuad = {
  tlX: 0,
  tlY: 0,
  trX: 1,
  trY: 0,
  brX: 1,
  brY: 1,
  blX: 0,
  blY: 1,
};

export interface PlacedSignature {
  id: string;
  dataUrl: string;
  posX: number; // 0..1
  posY: number; // 0..1
  widthFraction: number; // 0.15..0.55
  includeDateStamp: boolean;
  dateLabel?: string;
}

export interface SavedSignature {
  id: string;
  name: string;
  dataUrl: string;
  createdAt: string;
}

export interface WatermarkConfig {
  text: string;
  color: string;
  opacity: number; // 0.08..0.6
}

export interface DocumentPage {
  id: string;
  imageUrl: string;
  rotation: 0 | 90 | 180 | 270;
  filter: ScanFilterId;
  quad: NormalizedQuad;
  brightness: number; // 0.7..1.3, default 1
  contrast: number; // 0.7..1.4, default 1
  ocrText: string;
  signatures: PlacedSignature[];
}

export interface IndexedChunk {
  pageIndex: number;
  text: string;
}

export interface ScanDocument {
  id: string;
  title: string;
  folderId: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  pages: DocumentPage[];
  isBookmarked: boolean;
  isSmartCard: boolean;
  cardCategory?: SmartCardCategory;
  expiryDate?: string; // ISO YYYY-MM-DD
  passwordProtected?: boolean;
  pageSizePreset: PdfPageSizePreset;
  qualityPreset: PdfQualityPreset;
  watermark?: WatermarkConfig | null;
  sizeBytes: number;
  searchableOcr: boolean;
  // Smart Indexing fields (ported from FileLensMobile FileEntity & DocumentIndexer)
  fileFingerprint?: string;
  contentHash?: string;
  sourcePath?: string;
  fileExtension?: string;
  mimeType?: string;
  fileCategory?: FileCategory;
  ocrStatus?: OcrStatus;
  indexedAt?: string;
  chunksCount?: number;
}

export type FileCategory =
  | 'pdf'
  | 'image'
  | 'office'
  | 'text_code'
  | 'audio_video'
  | 'archive'
  | 'other';

export interface IndexProgress {
  indexed: number;
  total: number;
  currentFile: string;
  phase:
    | 'Discovering Device Folders'
    | 'Scanning'
    | 'Extracting Text & OCR'
    | 'Building Semantic Index'
    | 'Smart Taxonomy';
  skippedUnchanged: number;
  newOrUpdated: number;
  foldersScanned?: number;
}

export type DeviceRootPreset = 'documents' | 'downloads' | 'pictures' | 'desktop' | 'custom';

export interface DeviceStorageRoot {
  id: string;
  name: string;
  preset: DeviceRootPreset;
  linkedAtIso: string;
  lastSyncedIso?: string;
  lastFileCount: number;
  foldersScanned: number;
  hasPersistentHandle: boolean;
}

export interface DeviceIndexFilters {
  includePdf: boolean;
  includeImages: boolean;
  includeOfficeDocs: boolean;
  includeTextDocs: boolean;
  includeMediaAndArchives: boolean;
  includeAllOtherFiles: boolean;
  skipSystemFolders: boolean;
  maxFilesPerRun: number;
}

export interface DeviceIndexSummary {
  newOrUpdated: number;
  skippedUnchanged: number;
  totalScanned: number;
  elapsedMs: number;
  wasCancelled?: boolean;
  timestampIso: string;
  sourceLabel: string;
}

export interface IndexStats {
  totalFiles: number;
  ocrDone: number;
  ocrPending: number;
  totalChunks: number;
  cardsCount: number;
}

export interface SemanticDuplicateGroup {
  groupId: string;
  similarity: number;
  documents: ScanDocument[];
}

export interface DocFolder {
  id: string;
  name: string;
  icon: string;
}

export interface ChecklistItem {
  id: string;
  text: string;
  done: boolean;
}

export interface VoiceNote {
  id: string;
  title: string;
  transcript: string;
  temporalClass: TemporalClass;
  scheduledDate?: string;
  recurrence: RecurrenceRule;
  checklist: ChecklistItem[];
  linkedDocId?: string;
  languageCode: string;
  createdAt: string;
}

export interface SavedSearch {
  id: string;
  query: string;
  mode: SearchMode;
  createdAt: string;
}

export interface AppPreferences {
  theme: 'light' | 'dark';
  defaultFilter: ScanFilterId;
  defaultPageSize: PdfPageSizePreset;
  defaultQuality: PdfQualityPreset;
  autoCapture: boolean;
  batchPace: BatchAutoPace;
  searchablePdfOcrLayer: boolean;
  namingTemplate: string;
  voiceLanguage: string;
  privacyBlurCards: boolean;
}

export interface ExpiryRadarItem {
  doc: ScanDocument;
  expiryDate: string;
  daysRemaining: number;
  urgency: 'expired' | 'critical' | 'upcoming' | 'safe';
}
