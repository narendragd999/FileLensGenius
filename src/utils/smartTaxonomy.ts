import { ScanDocument, SemanticDuplicateGroup, SmartCardCategory } from '../types/filelens';
import { cosineSimilarity, generateEmbedding } from './embeddingEngine';

/**
 * Direct TypeScript port of FileLensMobile's SmartTaxonomy.kt, ExpiryRadarEngine.kt,
 * and suggestSmartDocumentTitle from DocumentEdgeDetector.kt.
 */

export function detectSmartTags(fileName: string, ocrText: string): string[] {
  const combined = `${fileName.toLowerCase()} ${ocrText.toLowerCase()}`;
  const rules: [string, string[]][] = [
    ['Aadhaar Card', ['aadhaar', 'aadhar', 'uidai', 'unique identification']],
    ['PAN Card', ['permanent account number', 'income tax department', 'pan card']],
    ['Passport', ['passport', 'republic of india', 'nationality']],
    ['Driving License', ['driving licence', 'driving license', 'transport department']],
    ['ID Card', ['identification card', 'member id', 'membership pass', 'specimen id']],
    ['Tax Invoice', ['tax invoice', 'gstin', 'cgst', 'sgst', 'invoice']],
    ['Receipt', ['receipt', 'paid', 'subtotal', 'total due']],
    ['Bank Statement', ['bank statement', 'account number', 'ifsc', 'iban']],
    ['Prescription', ['prescription', 'rx ', 'tablet', 'capsule', 'dr.']],
    ['Lab Report', ['pathology', 'hemoglobin', 'laboratory', 'cholesterol', 'glucose', 'lab report']],
    ['Vehicle RC', ['registration certificate', 'chassis', 'engine no', 'vehicle']],
    ['Insurance', ['insurance', 'policy no', 'premium', 'sum insured']],
    ['Utility Bill', ['electricity', 'kwh', 'meter no', 'water bill', 'gas bill']],
    ['Education', ['university', 'degree', 'bachelor', 'master', 'marksheet', 'diploma']],
    ['Contract', ['service agreement', 'rent agreement', 'lease deed', 'confidentiality', 'contract']],
    ['Whiteboard', ['architecture', 'flowchart', 'timeline', 'roadmap', 'microservices']],
  ];

  return rules
    .filter(([, keywords]) => keywords.some((kw) => combined.includes(kw)))
    .map(([label]) => label)
    .slice(0, 4);
}

export function getCardSmartCategory(
  name: string,
  tags: string[],
  ocrText: string
): SmartCardCategory {
  const combined = `${name} ${tags.join(' ')} ${ocrText}`.toLowerCase();
  if (
    ['aadhaar', 'aadhar', 'pan card', 'passport', 'voter', 'driving licen', 'kyc', 'identification', 'id card', 'membership pass'].some(
      (k) => combined.includes(k)
    )
  ) {
    return 'Govt IDs';
  }
  if (
    ['marksheet', 'degree', 'diploma', 'admit card', 'university', 'college', 'school', 'education', 'certificate'].some(
      (k) => combined.includes(k)
    )
  ) {
    return 'Education';
  }
  if (
    ['medical', 'prescription', 'doctor', 'clinic', 'hospital', 'pharmacy', 'lab report', 'blood', 'cholesterol', 'glucose', 'pathology'].some(
      (k) => combined.includes(k)
    )
  ) {
    return 'Medical';
  }
  if (
    ['vehicle', 'car', 'bike', 'rc ', 'puc', 'pollution', 'challan', 'flight', 'boarding pass', 'fastag'].some(
      (k) => combined.includes(k)
    )
  ) {
    return 'Vehicle';
  }
  if (
    ['invoice', 'gst', 'bill', 'receipt', 'electricity', 'salary', 'bank statement', 'tax', 'finance', 'paid', 'subtotal'].some(
      (k) => combined.includes(k)
    )
  ) {
    return 'Finance';
  }
  return 'Personal';
}

export function suggestFolderId(name: string, ocrText: string): string {
  const cat = getCardSmartCategory(name, [], ocrText);
  if (cat === 'Govt IDs') return 'ids';
  if (cat === 'Medical') return 'medical';
  if (cat === 'Finance') return 'finance';
  const combined = `${name} ${ocrText}`.toLowerCase();
  if (['agreement', 'contract', 'roadmap', 'architecture', 'nda', 'proposal'].some((k) => combined.includes(k))) {
    return 'contracts';
  }
  return 'inbox';
}

export function shouldAutoPromoteToSmartCard(name: string, ocrText: string): boolean {
  const combined = `${name} ${ocrText}`.toLowerCase();
  return [
    'aadhaar',
    'pan card',
    'passport',
    'driving licen',
    'identification card',
    'membership pass',
    'insurance',
    'policy no',
    'prescription',
    'lab report',
    'vehicle rc',
    'invoice',
  ].some((k) => combined.includes(k));
}

export function extractExpiryDateIso(text: string): string | undefined {
  if (!text) return undefined;

  // Pattern 1: Labelled expiry date DD/MM/YYYY or MM/DD/YYYY or YYYY-MM-DD
  const labelled = text.match(
    /(?:valid\s*thru|valid\s*until|valid\s*upto|expiry|exp\.?\s*date|expires(?:\s*on)?|renewal\s*due|due\s*date)\s*[:\-]?\s*(\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[/-]\d{1,2}[/-]\d{2,4}|\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4})/i
  );
  if (!labelled) return undefined;

  const raw = labelled[1].trim();
  if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(raw)) {
    const [y, m, d] = raw.split('-').map(Number);
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }
  }

  const slashParts = raw.split(/[/-]/);
  if (slashParts.length === 3 && slashParts.every((p) => /^\d+$/.test(p))) {
    const a = Number(slashParts[0]);
    const b = Number(slashParts[1]);
    let y = Number(slashParts[2]);
    if (y < 100) y += 2000;
    const m = a > 12 ? b : a;
    const d = a > 12 ? a : b;
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31 && y >= 2020 && y <= 2050) {
      return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }
  }

  const parsed = new Date(raw);
  if (!Number.isNaN(parsed.getTime()) && parsed.getFullYear() >= 2020 && parsed.getFullYear() <= 2050) {
    return parsed.toISOString().slice(0, 10);
  }
  return undefined;
}

export function suggestSmartDocumentTitle(ocrText: string, fallbackPrefix = 'Scan'): string {
  const dateStr = new Date().toISOString().slice(0, 10);
  const cleaned = ocrText.trim();
  if (cleaned.length < 4) return `${dateStr}_${fallbackPrefix}`;

  const lower = cleaned.toLowerCase();
  let detectedType: string | null = null;
  if (lower.includes('aadhaar') || lower.includes('unique identification')) detectedType = 'Aadhaar_Card';
  else if (lower.includes('permanent account') || lower.includes('income tax')) detectedType = 'PAN_Card';
  else if (lower.includes('passport')) detectedType = 'Passport';
  else if (lower.includes('driving licen')) detectedType = 'Driving_License';
  else if (lower.includes('identification card') || lower.includes('membership pass')) detectedType = 'ID_Card';
  else if (lower.includes('registration certificate') || lower.includes('chassis')) detectedType = 'Vehicle_RC';
  else if (lower.includes('prescription') || lower.includes('lab report') || lower.includes('clinic')) detectedType = 'Medical_Report';
  else if (lower.includes('tax invoice') || lower.includes('gstin') || lower.includes('invoice')) detectedType = 'Invoice';
  else if (lower.includes('electricity') || lower.includes('water bill') || lower.includes('gas bill')) detectedType = 'Utility_Bill';
  else if (lower.includes('receipt') || lower.includes('subtotal') || lower.includes('grand total')) detectedType = 'Receipt';
  else if (lower.includes('marksheet') || lower.includes('certificate') || lower.includes('university')) detectedType = 'Certificate';
  else if (lower.includes('agreement') || lower.includes('contract') || lower.includes('lease')) detectedType = 'Agreement';
  else if (lower.includes('bank statement') || lower.includes('ifsc')) detectedType = 'Bank_Statement';

  const amountMatch = cleaned.match(/(?:\$|₹|€|£|USD|INR)\s?([0-9,]+(?:\.\d{2})?)/i);
  const amountSuffix = amountMatch?.[1]?.replace(/,/g, '').slice(0, 8);

  if (detectedType) {
    if (amountSuffix && ['Invoice', 'Receipt', 'Utility_Bill'].includes(detectedType)) {
      return `${dateStr}_${detectedType}_${amountSuffix}`;
    }
    return `${dateStr}_${detectedType}`;
  }

  const firstLine = cleaned
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length >= 4 && l.length <= 42 && /[a-zA-Z]/.test(l))
    ?.replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 28);

  return firstLine ? `${dateStr}_${firstLine}` : `${dateStr}_${fallbackPrefix}`;
}

export function findSemanticDuplicates(
  docs: ScanDocument[],
  threshold = 0.84
): SemanticDuplicateGroup[] {
  const candidates = docs.filter((d) =>
    d.pages.some((p) => p.ocrText && p.ocrText.trim().length > 20)
  );
  const vectors = new Map<string, Float32Array>();
  for (const d of candidates) {
    const txt = `${d.title} ${d.pages.map((p) => p.ocrText).join(' ')}`.slice(0, 1400);
    vectors.set(d.id, generateEmbedding(txt));
  }

  const visited = new Set<string>();
  const groups: SemanticDuplicateGroup[] = [];

  for (let i = 0; i < candidates.length; i++) {
    const a = candidates[i];
    if (visited.has(a.id)) continue;
    const vecA = vectors.get(a.id)!;
    const members: ScanDocument[] = [a];
    let minSim = 1.0;

    for (let j = i + 1; j < candidates.length; j++) {
      const b = candidates[j];
      if (visited.has(b.id)) continue;
      const vecB = vectors.get(b.id)!;
      const sim = cosineSimilarity(vecA, vecB);
      if (sim >= threshold) {
        members.push(b);
        minSim = Math.min(minSim, sim);
        visited.add(b.id);
      }
    }

    if (members.length > 1) {
      visited.add(a.id);
      members.sort((x, y) => y.sizeBytes - x.sizeBytes);
      groups.push({
        groupId: `sem-${a.id}`,
        similarity: minSim,
        documents: members,
      });
    }
  }

  return groups;
}

export interface RelatedCardMatch {
  doc: ScanDocument;
  similarity: number;
}

/**
 * Find up to 3 related Smart Cards via 384-dim cosine similarity >= 0.30.
 */
export function findRelatedCards(
  target: ScanDocument,
  allCards: ScanDocument[],
  threshold = 0.30,
  limit = 3
): RelatedCardMatch[] {
  const targetText = `${target.title} ${target.cardCategory || ''} ${target.tags.join(' ')} ${target.pages
    .map((p) => p.ocrText)
    .join(' ')}`.slice(0, 1400);
  const targetVec = generateEmbedding(targetText);

  const matches: RelatedCardMatch[] = [];
  for (const card of allCards) {
    if (card.id === target.id) continue;
    const text = `${card.title} ${card.cardCategory || ''} ${card.tags.join(' ')} ${card.pages
      .map((p) => p.ocrText)
      .join(' ')}`.slice(0, 1400);
    const sim = cosineSimilarity(targetVec, generateEmbedding(text));
    if (sim >= threshold) {
      matches.push({ doc: card, similarity: sim });
    }
  }

  return matches.sort((a, b) => b.similarity - a.similarity).slice(0, limit);
}
