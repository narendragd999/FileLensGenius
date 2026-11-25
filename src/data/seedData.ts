import {
  AppPreferences,
  DocFolder,
  SavedSearch,
  ScanDocument,
  ScanFilterId,
  SmartCardCategory,
  VoiceNote,
} from '../types/filelens';

export const SCAN_FILTERS: {
  id: ScanFilterId;
  label: string;
  shortLabel: string;
  description: string;
}[] = [
  {
    id: 'magic',
    label: 'Magic Color',
    shortLabel: 'Color',
    description: 'Auto-enhances ink and whitens paper',
  },
  {
    id: 'bw',
    label: 'B&W Clean',
    shortLabel: 'B&W',
    description: 'High-contrast monochrome for crisp text',
  },
  {
    id: 'whiteboard',
    label: 'Whiteboard',
    shortLabel: 'Board',
    description: 'Lifts glare and boosts marker colors',
  },
  {
    id: 'grayscale',
    label: 'Grayscale',
    shortLabel: 'Gray',
    description: 'Smooth monochrome tones for forms',
  },
  {
    id: 'original',
    label: 'Photo',
    shortLabel: 'None',
    description: 'Unfiltered original capture',
  },
];

export const SMART_CARD_CATEGORIES: SmartCardCategory[] = [
  'Govt IDs',
  'Medical',
  'Finance',
  'Vehicle',
  'Education',
  'Personal',
];

export const NAMING_TEMPLATES: { id: string; label: string; pattern: string }[] = [
  { id: 'scan_date', label: 'Scan + Date', pattern: 'Scan_{YYYY}-{MM}-{DD}_{SEQ}' },
  { id: 'receipt_date', label: 'Receipt + Date', pattern: 'Receipt_{YYYY}{MM}{DD}_{SEQ}' },
  { id: 'doc_month', label: 'Document + Month', pattern: 'Doc_{YYYY}-{MM}_{SEQ}' },
  { id: 'id_card', label: '2-in-1 ID Card', pattern: 'ID_Card_{YYYY}-{MM}-{DD}' },
];

export const VOICE_LANGUAGES: { code: string; name: string; nativeName: string }[] = [
  { code: 'en-US', name: 'English (US)', nativeName: 'English' },
  { code: 'en-IN', name: 'English (India / Hinglish)', nativeName: 'Hinglish' },
  { code: 'hi-IN', name: 'Hindi', nativeName: 'हिन्दी' },
  { code: 'mr-IN', name: 'Marathi', nativeName: 'मराठी' },
  { code: 'bn-IN', name: 'Bengali', nativeName: 'বাংলা' },
  { code: 'te-IN', name: 'Telugu', nativeName: 'తెలుగు' },
  { code: 'ta-IN', name: 'Tamil', nativeName: 'தமிழ்' },
  { code: 'gu-IN', name: 'Gujarati', nativeName: 'ગુજરાતી' },
  { code: 'kn-IN', name: 'Kannada', nativeName: 'ಕನ್ನಡ' },
  { code: 'pa-IN', name: 'Punjabi', nativeName: 'ਪੰਜਾਬੀ' },
  { code: 'es-ES', name: 'Spanish', nativeName: 'Español' },
  { code: 'fr-FR', name: 'French', nativeName: 'Français' },
  { code: 'de-DE', name: 'German', nativeName: 'Deutsch' },
  { code: 'ja-JP', name: 'Japanese', nativeName: '日本語' },
  { code: 'ar-SA', name: 'Arabic', nativeName: 'العربية' },
];

export const INITIAL_FOLDERS: DocFolder[] = [
  { id: 'inbox', name: 'Inbox', icon: 'inbox' },
  { id: 'contracts', name: 'Contracts & Work', icon: 'briefcase' },
  { id: 'finance', name: 'Receipts & Finance', icon: 'receipt' },
  { id: 'medical', name: 'Medical & Health', icon: 'heart' },
  { id: 'ids', name: 'Personal IDs', icon: 'card' },
];

export const DEFAULT_PREFERENCES: AppPreferences = {
  theme: 'light',
  defaultFilter: 'magic',
  defaultPageSize: 'a4',
  defaultQuality: 'balanced',
  autoCapture: true,
  batchPace: 'wait_page',
  searchablePdfOcrLayer: true,
  namingTemplate: 'Scan_{YYYY}-{MM}-{DD}_{SEQ}',
  voiceLanguage: 'en-US',
  privacyBlurCards: false,
  ocrLanguage: 'eng',
  awarenessBellEnabled: false,
  morningDigestEnabled: false,
  biometricCardsLock: false,
  cardsPinCode: '',
};

// Clean empty vault — zero seeded test data
export const INITIAL_DOCUMENTS: ScanDocument[] = [];
export const INITIAL_VOICE_NOTES: VoiceNote[] = [];
export const INITIAL_SAVED_SEARCHES: SavedSearch[] = [];
