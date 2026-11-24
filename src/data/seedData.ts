import {
  AppPreferences,
  DocFolder,
  FULL_QUAD,
  SavedSearch,
  ScanDocument,
  ScanFilterId,
  SmartCardCategory,
  VoiceNote,
} from '../types/filelens';

export const ASSET_IMAGES = {
  contract: '/src/assets/images/doc_contract_page_1795492402978.jpg',
  invoice: '/src/assets/images/doc_invoice_receipt_1795492402535.jpg',
  medical: '/src/assets/images/doc_medical_rx_1795492417114.jpg',
  whiteboard: '/src/assets/images/doc_whiteboard_notes_1795492404015.jpg',
  idCard: '/src/assets/images/doc_id_card_front_1795492425239.jpg',
};

export const SCAN_FILTERS: { id: ScanFilterId; label: string; shortLabel: string; description: string }[] = [
  { id: 'magic', label: 'Magic Color', shortLabel: 'Color', description: 'Auto-enhances ink and whitens paper' },
  { id: 'bw', label: 'B&W Clean', shortLabel: 'B&W', description: 'High-contrast monochrome for crisp text' },
  { id: 'whiteboard', label: 'Whiteboard', shortLabel: 'Board', description: 'Lifts glare and boosts marker colors' },
  { id: 'grayscale', label: 'Grayscale', shortLabel: 'Gray', description: 'Smooth monochrome tones for forms' },
  { id: 'original', label: 'Photo', shortLabel: 'None', description: 'Unfiltered original capture' },
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
};

function daysFromToday(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

export const INITIAL_DOCUMENTS: ScanDocument[] = [
  {
    id: 'doc-service-agreement',
    title: 'Apex Solutions Service Agreement',
    folderId: 'contracts',
    tags: ['Contract', 'Signed', 'Legal'],
    createdAt: '2026-11-21T14:22:00Z',
    updatedAt: '2026-11-22T09:15:00Z',
    isBookmarked: true,
    isSmartCard: false,
    pageSizePreset: 'a4',
    qualityPreset: 'high',
    sizeBytes: 1842600,
    searchableOcr: true,
    pages: [
      {
        id: 'pg-contract-1',
        imageUrl: ASSET_IMAGES.contract,
        rotation: 0,
        filter: 'magic',
        quad: FULL_QUAD,
        brightness: 1,
        contrast: 1,
        ocrText:
          'SERVICE AGREEMENT. Between Apex Solutions Inc. (Service Provider) and Quantum Dynamics LLC (Client). 1. Scope of Services. 2. Fees & Payment: total fee of $15,000. 3. Term & Termination: November 1 to October 31. 4. Confidentiality. Signed Jonathan Chen, CEO Apex Solutions Inc.',
        signatures: [],
      },
      {
        id: 'pg-contract-2',
        imageUrl: ASSET_IMAGES.invoice,
        rotation: 0,
        filter: 'magic',
        quad: FULL_QUAD,
        brightness: 1,
        contrast: 1,
        ocrText:
          'EXHIBIT B — SCHEDULE OF FEES. Nova Design Studio Invoice #NDS-1089. Client Sarah Jenkins, Creative Co. Brand Identity Package $3,000.00. Website Design & Development $7,875.00. UI/UX Consulting $1,600.00. Subtotal $12,475.00. Tax 8.25% $1,029.19. Total Due $13,504.19 USD. PAID.',
        signatures: [],
      },
      {
        id: 'pg-contract-3',
        imageUrl: ASSET_IMAGES.whiteboard,
        rotation: 0,
        filter: 'whiteboard',
        quad: FULL_QUAD,
        brightness: 1,
        contrast: 1,
        ocrText:
          'EXHIBIT C — PRODUCT ARCHITECTURE FLOW. Architecture Map v2.1, API Gateway Auth Routing, Microservices gRPC REST, Service A Authentication DB, Service B User Data, Service C Notifications Queue Deploy Dec 15, Service D Analytics Monitoring Prometheus. Q4 Timeline Oct Nov Dec.',
        signatures: [],
      },
    ],
  },
  {
    id: 'doc-nova-invoice',
    title: 'Nova Design Studio Invoice #NDS-1089',
    folderId: 'finance',
    tags: ['Receipt', 'Paid', 'Tax 2026'],
    createdAt: '2026-11-19T18:04:00Z',
    updatedAt: '2026-11-19T18:04:00Z',
    isBookmarked: true,
    isSmartCard: true,
    cardCategory: 'Finance',
    expiryDate: daysFromToday(62),
    pageSizePreset: 'a4',
    qualityPreset: 'balanced',
    sizeBytes: 684200,
    searchableOcr: true,
    pages: [
      {
        id: 'pg-inv-1',
        imageUrl: ASSET_IMAGES.invoice,
        rotation: 0,
        filter: 'magic',
        quad: FULL_QUAD,
        brightness: 1,
        contrast: 1,
        ocrText:
          'NOVA DESIGN STUDIO 123 Creative Ave Austin TX. INVOICE #NDS-1089. Client Sarah Jenkins Creative Co. Brand Identity Package 20 hrs $3,000.00. Website Design & Development 45 hrs $7,875.00. UI/UX Consulting 10 hrs $1,600.00. Subtotal $12,475.00. Tax 8.25% $1,029.19. TOTAL DUE $13,504.19 USD. PAID.',
        signatures: [],
      },
    ],
  },
  {
    id: 'doc-medical-lab',
    title: 'Cityway Clinic Annual Lab Panel',
    folderId: 'medical',
    tags: ['Medical', 'Lab Report'],
    createdAt: '2026-11-16T11:30:00Z',
    updatedAt: '2026-11-16T11:30:00Z',
    isBookmarked: false,
    isSmartCard: true,
    cardCategory: 'Medical',
    expiryDate: daysFromToday(18),
    pageSizePreset: 'a4',
    qualityPreset: 'high',
    sizeBytes: 942100,
    searchableOcr: true,
    pages: [
      {
        id: 'pg-med-1',
        imageUrl: ASSET_IMAGES.medical,
        rotation: 0,
        filter: 'bw',
        quad: FULL_QUAD,
        brightness: 1,
        contrast: 1,
        ocrText:
          'CITYWAY WELLNESS CLINIC PATIENT LAB REPORT & SUMMARY. Physician Dr. Sarah J. Chen. Complete Blood Count WBC 6.8, RBC 5.1, Hgb 15.2, Platelets 215. Glucose 88 mg/dL, Creatinine 1.02. Total Cholesterol 188, LDL-C 110, HDL-C 56, Triglycerides 108. Annual wellness follow-up in 12 months.',
        signatures: [],
      },
    ],
  },
  {
    id: 'doc-whiteboard-roadmap',
    title: 'Q4 Product Architecture Whiteboard',
    folderId: 'contracts',
    tags: ['Whiteboard', 'Roadmap'],
    createdAt: '2026-11-14T16:45:00Z',
    updatedAt: '2026-11-15T10:12:00Z',
    isBookmarked: false,
    isSmartCard: false,
    pageSizePreset: 'auto',
    qualityPreset: 'balanced',
    sizeBytes: 1218400,
    searchableOcr: true,
    pages: [
      {
        id: 'pg-wb-1',
        imageUrl: ASSET_IMAGES.whiteboard,
        rotation: 0,
        filter: 'whiteboard',
        quad: FULL_QUAD,
        brightness: 1,
        contrast: 1,
        ocrText:
          'PRODUCT ARCHITECTURE FLOW. API Gateway Auth Routing. Microservices Service A Authentication DB, Service B User Data MongoDB, Service C Notifications Queue Deploy Dec 15, Service D Analytics ELK Prometheus. Q4 Timeline OCT API Revamp, NOV Integration Testing Beta Feedback, DEC Product Launch.',
        signatures: [],
      },
      {
        id: 'pg-wb-2',
        imageUrl: ASSET_IMAGES.contract,
        rotation: 0,
        filter: 'bw',
        quad: FULL_QUAD,
        brightness: 1,
        contrast: 1,
        ocrText:
          'MEETING SIGN-OFF APPENDIX. Scope of services, milestones, fee schedule, and confidentiality terms signed by leadership.',
        signatures: [],
      },
    ],
  },
  {
    id: 'doc-id-specimen',
    title: 'Accreditation ID & Membership Pass (2-in-1 A4)',
    folderId: 'ids',
    tags: ['ID Card', '2-in-1 A4'],
    createdAt: '2026-11-10T08:15:00Z',
    updatedAt: '2026-11-10T08:15:00Z',
    isBookmarked: true,
    isSmartCard: true,
    cardCategory: 'Govt IDs',
    expiryDate: daysFromToday(-5),
    pageSizePreset: 'a4',
    qualityPreset: 'high',
    sizeBytes: 512800,
    searchableOcr: true,
    pages: [
      {
        id: 'pg-id-1',
        imageUrl: ASSET_IMAGES.idCard,
        rotation: 0,
        filter: 'original',
        quad: FULL_QUAD,
        brightness: 1,
        contrast: 1,
        ocrText:
          'SPECIMEN IDENTIFICATION CARD Global Accreditation Unit. Member ID 123456789. Name Alexa R. Chen. Rank Senior Analyst. Specimen ID SPEC-045. MEMBERSHIP PASS Member No M-987-005 Access Level FULL.',
        signatures: [],
      },
    ],
  },
];

export const INITIAL_VOICE_NOTES: VoiceNote[] = [
  {
    id: 'vn-1',
    title: 'Send signed Apex agreement & invoice to finance',
    transcript:
      'Today before 5pm merge the signed Apex service agreement with the Nova Design Studio paid receipt and email the compressed PDF to accounting.',
    temporalClass: 'today',
    scheduledDate: daysFromToday(0),
    recurrence: 'none',
    linkedDocId: 'doc-service-agreement',
    languageCode: 'en-US',
    createdAt: '2026-11-23T09:10:00Z',
    checklist: [
      { id: 'c1', text: 'Verify page order in Page Organizer', done: true },
      { id: 'c2', text: 'Compress PDF with Email Ready preset', done: false },
      { id: 'c3', text: 'Send signed copy to Sarah at Creative Co.', done: false },
    ],
  },
  {
    id: 'vn-2',
    title: 'Schedule annual follow-up lab panel at Cityway Clinic',
    transcript:
      'Remind me next week to book the annual wellness follow-up with Dr. Sarah Chen and carry the printed lab report.',
    temporalClass: 'upcoming',
    scheduledDate: daysFromToday(7),
    recurrence: 'none',
    linkedDocId: 'doc-medical-lab',
    languageCode: 'en-US',
    createdAt: '2026-11-22T15:40:00Z',
    checklist: [
      { id: 'c4', text: 'Call Cityway Wellness Clinic reception', done: false },
      { id: 'c5', text: 'Export lab summary as A4 PDF', done: false },
    ],
  },
  {
    id: 'vn-3',
    title: 'Renew Global Accreditation membership pass',
    transcript:
      'Membership pass expired last week — scan the updated 2-in-1 A4 front and back ID card once it arrives in mail.',
    temporalClass: 'history',
    scheduledDate: daysFromToday(-3),
    recurrence: 'monthly',
    linkedDocId: 'doc-id-specimen',
    languageCode: 'en-US',
    createdAt: '2026-11-18T11:05:00Z',
    checklist: [
      { id: 'c6', text: 'Submit renewal form online', done: true },
      { id: 'c7', text: 'Scan new card in 2-in-1 ID mode', done: false },
    ],
  },
];

export const INITIAL_SAVED_SEARCHES: SavedSearch[] = [
  { id: 'ss-1', query: 'PAID AND Invoice', mode: 'boolean', createdAt: '2026-11-20T12:00:00Z' },
  { id: 'ss-2', query: 'cholesterol OR glucose', mode: 'boolean', createdAt: '2026-11-19T10:30:00Z' },
  { id: 'ss-3', query: 'Apex*', mode: 'wildcard', createdAt: '2026-11-17T08:15:00Z' },
];
