/**
 * Offline Bilingual & Multilingual Search Engine
 * Ported from FileLensMobile's MultilingualEngine.kt:
 * - Hinglish-to-Devanagari exact dictionary + phonetic rule-based transliteration
 * - 18 Cross-lingual bilingual synonym clusters
 * - Universal Soundex phonetic equivalence across Latin & Devanagari
 */

const TRANSLIT_MAP: Record<string, string> = {
  main: 'मैं',
  mein: 'मैं',
  hum: 'हम',
  tum: 'तुम',
  aap: 'आप',
  woh: 'वह',
  yeh: 'यह',
  kya: 'क्या',
  kab: 'कब',
  kahan: 'कहाँ',
  kaise: 'कैसे',
  kyon: 'क्यों',
  kyunki: 'क्योंकि',
  kal: 'कल',
  cal: 'कल',
  aaj: 'आज',
  parson: 'परसों',
  subah: 'सुबह',
  shaam: 'शाम',
  raat: 'रात',
  dopahar: 'दोपहर',
  baje: 'बजे',
  aadhar: 'आधार',
  aadhaar: 'आधार',
  bijli: 'बिजली',
  paani: 'पानी',
  pani: 'पानी',
  rasid: 'रसीद',
  raseed: 'रसीद',
  khata: 'खाता',
  dawai: 'दवाई',
  dava: 'दवा',
  bima: 'बीमा',
  gaadi: 'गाड़ी',
  gadi: 'गाड़ी',
  paisa: 'पैसा',
  paise: 'पैसे',
  rupaye: 'रुपये',
  kharch: 'खर्च',
  kharcha: 'खर्चा',
  kiraya: 'किराया',
  vetan: 'वेतन',
  tankhwah: 'तनख्वाह',
  pariksha: 'परीक्षा',
  marksheet: 'मार्कशीट',
  patra: 'पत्र',
  parichay: 'परिचय',
  swasthya: 'स्वास्थ्य',
  dukaan: 'दुकान',
  dukandar: 'दुकानदार',
  kar: 'कर',
  bazaar: 'बाज़ार',
  yaad: 'याद',
  zaroori: 'ज़रूरी',
  kaam: 'काम',
  ghar: 'घर',
  daftar: 'दफ़्तर',
};

const CONSONANTS: [string, string][] = [
  ['chh', 'छ'],
  ['ksh', 'क्ष'],
  ['gya', 'ज्ञ'],
  ['kh', 'ख'],
  ['gh', 'घ'],
  ['ch', 'च'],
  ['jh', 'झ'],
  ['th', 'थ'],
  ['dh', 'ध'],
  ['ph', 'फ'],
  ['bh', 'भ'],
  ['sh', 'श'],
  ['tr', 'त्र'],
  ['gy', 'ज्ञ'],
  ['k', 'क'],
  ['g', 'ग'],
  ['c', 'क'],
  ['j', 'ज'],
  ['t', 'त'],
  ['d', 'द'],
  ['n', 'न'],
  ['p', 'प'],
  ['f', 'फ'],
  ['b', 'ब'],
  ['m', 'म'],
  ['y', 'य'],
  ['r', 'र'],
  ['l', 'ल'],
  ['v', 'व'],
  ['w', 'व'],
  ['s', 'स'],
  ['h', 'ह'],
  ['z', 'ज़'],
  ['q', 'क'],
  ['x', 'क्स'],
];

const VOWEL_MATRAS: [string, string][] = [
  ['aa', 'ा'],
  ['ee', 'ी'],
  ['oo', 'ू'],
  ['ai', 'ै'],
  ['au', 'ौ'],
  ['ei', 'े'],
  ['ou', 'ो'],
  ['a', ''],
  ['i', 'ि'],
  ['u', 'ु'],
  ['e', 'े'],
  ['o', 'ो'],
];

const INDEPENDENT_VOWELS: [string, string][] = [
  ['aa', 'आ'],
  ['ee', 'ई'],
  ['oo', 'ऊ'],
  ['ai', 'ऐ'],
  ['au', 'औ'],
  ['a', 'अ'],
  ['i', 'इ'],
  ['u', 'उ'],
  ['e', 'ए'],
  ['o', 'ओ'],
];

export const CONCEPT_GROUPS: string[][] = [
  ['aadhaar', 'aadhar', 'uidai', 'आधार'],
  ['pan', 'pancard', 'income tax', 'पैन'],
  ['passport', 'visa', 'travel', 'पासपोर्ट', 'वीज़ा'],
  ['license', 'driving', 'dl', 'लाइसेंस'],
  ['bill', 'invoice', 'receipt', 'challan', 'rasid', 'raseed', 'बिल', 'रसीद'],
  ['electricity', 'bijli', 'power', 'bescom', 'msedcl', 'बिजली'],
  ['water', 'paani', 'pani', 'jal', 'पानी'],
  ['medical', 'prescription', 'doctor', 'medicine', 'dawai', 'rx', 'दवाई', 'डॉक्टर', 'स्वास्थ्य'],
  ['lab', 'report', 'pathology', 'blood', 'test', 'जांच', 'रिपोर्ट'],
  ['vehicle', 'car', 'bike', 'rc', 'gaadi', 'gadi', 'वाहन', 'गाड़ी'],
  ['insurance', 'policy', 'bima', 'premium', 'claim', 'बीमा'],
  ['salary', 'payslip', 'pay', 'vetan', 'tankhwah', 'वेतन', 'सैलरी'],
  ['bank', 'statement', 'account', 'khata', 'passbook', 'ifsc', 'बैंक', 'खाता'],
  ['tax', 'gst', 'itr', 'tds', 'form16', 'कर', 'टैक्स'],
  ['rent', 'lease', 'agreement', 'kiraya', 'किराया'],
  ['education', 'degree', 'marksheet', 'certificate', 'exam', 'pariksha', 'परीक्षा', 'मार्कशीट'],
  ['expense', 'kharch', 'kharcha', 'spend', 'खर्च', 'खर्चा'],
  ['meeting', 'appointment', 'schedule', 'reminder', 'yaad', 'याद'],
];

/**
 * Phonetic rule-based fallback transliteration for a single ASCII word to Devanagari.
 */
export function transliterateSingleWord(word: string): string {
  const lower = word.toLowerCase().trim();
  if (!lower || !/^[a-z]+$/.test(lower)) return '';
  if (TRANSLIT_MAP[lower]) return TRANSLIT_MAP[lower];

  let out = '';
  let i = 0;
  let lastWasConsonant = false;

  while (i < lower.length) {
    let matched = false;

    if (!lastWasConsonant) {
      for (const [lat, dev] of INDEPENDENT_VOWELS) {
        if (lower.startsWith(lat, i)) {
          out += dev;
          i += lat.length;
          lastWasConsonant = false;
          matched = true;
          break;
        }
      }
      if (matched) continue;
    } else {
      for (const [lat, matra] of VOWEL_MATRAS) {
        if (lower.startsWith(lat, i)) {
          // Omit trailing implicit schwa 'a' at word end
          if (!(lat === 'a' && i + 1 === lower.length)) {
            out += matra;
          }
          i += lat.length;
          lastWasConsonant = false;
          matched = true;
          break;
        }
      }
      if (matched) continue;
    }

    for (const [lat, dev] of CONSONANTS) {
      if (lower.startsWith(lat, i)) {
        out += dev;
        i += lat.length;
        lastWasConsonant = true;
        matched = true;
        break;
      }
    }
    if (!matched) {
      i += 1;
      lastWasConsonant = false;
    }
  }

  return out;
}

/**
 * Transliterate an entire Hinglish query string into Devanagari tokens appended alongside original.
 */
export function transliterateHinglishToHindi(text: string): string {
  const tokens = text.trim().split(/\s+/);
  const hindiTokens = tokens
    .map((t) => transliterateSingleWord(t.replace(/[^a-zA-Z]/g, '')))
    .filter((h) => h.length > 0);
  return hindiTokens.join(' ');
}

/**
 * Return cross-lingual concept variants for a search term (exact or >=4 char substring match).
 */
export function getCrossLingualConceptVariants(term: string): string[] {
  const lower = term.toLowerCase().trim();
  if (!lower) return [];
  const results = new Set<string>();

  for (const group of CONCEPT_GROUPS) {
    const matches = group.some(
      (g) => g === lower || (lower.length >= 4 && (g.includes(lower) || lower.includes(g)))
    );
    if (matches) {
      for (const g of group) results.add(g);
    }
  }
  const translit = transliterateSingleWord(lower);
  if (translit) results.add(translit);
  results.delete(lower);
  return Array.from(results);
}

/**
 * Universal Soundex across Latin and Devanagari scripts.
 */
export function toUniversalSoundex(word: string): string {
  if (!word) return '';
  let out = '';
  let prev = '';

  for (const ch of word.toLowerCase()) {
    let code = '';
    if (ch >= '0' && ch <= '9') {
      code = ch;
    } else if ('kgcqxकखगघङक़ख़ग़'.includes(ch)) {
      code = 'K';
    } else if ('tdचछजझटठडढणतथदधनड़ढ़ज़'.includes(ch)) {
      code = 'T';
    } else if ('pfbvwपफबभमफ़'.includes(ch)) {
      code = ch === 'm' || ch === 'म' ? 'M' : 'P';
    } else if ('mnनणम'.includes(ch)) {
      code = 'M';
    } else if ('rlरलयलव'.includes(ch)) {
      code = 'R';
    } else if ('szशषस'.includes(ch)) {
      code = 'S';
    } else if ('yjय'.includes(ch)) {
      code = 'Y';
    } else if ('hह'.includes(ch)) {
      code = 'H';
    }
    if (code && code !== prev) {
      out += code;
      prev = code;
    }
  }
  return out;
}
