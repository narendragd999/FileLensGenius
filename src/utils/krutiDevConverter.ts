/**
 * Kruti Dev 010/016 -> Unicode Devanagari converter & Devanagari OCR repair
 * Ported from FileLensProTestBundle for Indian government PDFs & forms.
 */

const KRUTI_TO_UNICODE_PAIRS: [string, string][] = [
  ['ñ', ''], ['Q+Z', 'फ़'], ['sas', 'सा'], ['aa', 'आ'],
  ['ZZ', ''], ['‘', '"'], ['’', '"'], ['“', "'"], ['”', "'"],
  ['å', '०'], ['ƒ', '१'], ['„', '२'], ['…', '३'], ['†', '४'],
  ['‡', '५'], ['ˆ', '६'], ['‰', '७'], ['Š', '८'], ['‹', '९'],
  ['¶+', 'फ़्'], ['d+', 'क़'], ['[k+', 'ख़'], ['x+', 'ग़'],
  ['T+', 'ज़'], ['t+', 'ज़'], ['M+', 'ड़'], ['<+', 'ढ़'],
  ['Q+', 'फ़'], ['u+', 'ऩ'], ['j+', 'ऱ'], ['Y+', 'य़'],
  ['Ùk', 'त्त'], ['Ù', 'त्त्'], ['ä', 'क्त'], ['–', 'दृ'],
  ['—', 'कृ'], ['é', 'न्न'], ['™', 'न्न्'], ['=kk', 'त्ता'],
  ['f=k', 'त्रि'], ['à', 'ह्ण'], ['á', 'ह्य'], ['â', 'ह्र'],
  ['ã', 'ह्व'], ['ºz', 'ह्र'], ['º', 'ह्'], ['í', 'द्द'],
  ['î', 'द्ध'], ['ï', 'द्व'], ['ð', 'द्य'], ['ñ', 'प्र'],
  ['ò', 'क्र'], ['ó', 'क्त'], ['ô', 'ष्ट'], ['õ', 'ष्ठ'],
  ['ö', 'श्व'], ['÷', 'स्ह'], ['ø', '्य'], ['ù', '्र'],
  ['ú', 'त्र'], ['û', 'ज्ञ'], ['ü', 'क्ष'], ['ý', 'श्र'],
  ['þ', 'रु'], ['ÿ', 'रू'],
  ['vks', 'ओ'], ['vkS', 'औ'], ['vk', 'आ'], ['v', 'अ'],
  ['bZ', 'ई'], ['b', 'इ'], ['m', 'उ'], ['Å', 'ऊ'],
  ['_', 'ऋ'], [',s', 'ऐ'], [',', 'ए'], ['vks', 'ओ'],
  ['D', 'क्'], ['d', 'क'], ['[k', 'ख'], ['[', 'ख्'],
  ['x', 'ग'], ['X', 'ग्'], ['?k', 'घ'], ['?', 'घ्'], ['³', 'ङ'],
  ['p', 'च'], ['P', 'च्'], ['N', 'छ'], ['t', 'ज'], ['T', 'ज्'],
  ['>', 'झ'], ['÷', 'झ्'], ['¥', 'ञ'],
  ['V', 'ट'], ['B', 'ठ'], ['M', 'ड'], ['<', 'ढ'], ['.k', 'ण'], ['.', 'ण्'],
  ['r', 'त'], ['R', 'त्'], ['Fk', 'थ'], ['F', 'थ्'], ['n', 'द'],
  ['/', 'ध्'], ['/k', 'ध'], ['u', 'न'], ['U', 'न्'],
  ['i', 'प'], ['I', 'प्'], ['Q', 'फ'], ['¶', 'फ्'],
  ['c', 'ब'], ['C', 'ब्'], ['Hk', 'भ'], ['H', 'भ्'],
  ['e', 'म'], ['E', 'म्'],
  [';', 'य'], ['j', 'र'], ['y', 'ल'], ['Y', 'ल्'],
  ['o', 'व'], ['O', 'व्'],
  ["'k", 'श'], ["'", 'श्'], ['"k', 'ष'], ['"', 'ष्'],
  ['l', 'स'], ['L', 'स्'], ['g', 'ह'], ['G', 'ह्'],
  ['{k', 'क्ष'], ['{', 'क्ष्'], ['=', 'त्र'], ['«', 'त्र्'],
  ['K', 'ज्ञ'], ['J', 'श्र'],
  ['k', 'ा'], ['h', 'ी'], ['q', 'ु'], ['w', 'ू'],
  ['`', 'ृ'], ['s', 'े'], ['S', 'ै'], ['ks', 'ो'], ['kS', 'ौ'],
  ['a', 'ं'], ['W', 'ँ'], ['%', 'ः'], ['¡', 'ँ'],
  ['~', '्'], ['z', '्र'], ['A', '।'],
];

export function isLikelyKrutiDev(text: string): boolean {
  if (!text || text.length < 16) return false;
  // Already has Devanagari Unicode -> not raw Kruti Dev
  if (/[\u0900-\u097F]/.test(text)) return false;
  const krutiMarkers = (text.match(/(?:vk|f=k|\?k|Hk|\[k|ks|kS|Ùk|¶\+|~|¡|A\s)/g) || []).length;
  return krutiMarkers >= 3;
}

export function convertKrutiDevToUnicode(input: string): string {
  if (!input) return input;
  let out = input;
  for (const [kruti, uni] of KRUTI_TO_UNICODE_PAIRS) {
    if (out.includes(kruti)) {
      out = out.split(kruti).join(uni);
    }
  }
  // Fix pre-base 'f' (ि matra) placement: f + consonant -> consonant + ि
  out = out.replace(/f([\u0915-\u0939](?:\u094D[\u0915-\u0939])*)/g, '$1ि');
  // Fix reph 'Z' (र्) placement
  out = out.replace(/([\u0915-\u0939][\u093E-\u094C\u0901-\u0903]*)Z/g, 'र्$1');
  return out;
}

/**
 * Repairs common ML Kit / Tesseract Devanagari OCR kerning & matra spacing glitches.
 */
export function normalizeDevanagariOcrText(text: string): string {
  if (!text) return text;
  if (!/[\u0900-\u097F]/.test(text)) return text;
  return text
    .replace(/\s+([\u093E-\u094D\u0901-\u0903\u0962\u0963])/g, '$1')
    .replace(/([\u0900-\u097F])\s+([\u093E-\u094C])/g, '$1$2')
    .replace(/अ\s*ा/g, 'आ')
    .replace(/आ\s*े/g, 'ओ')
    .replace(/आ\s*ै/g, 'औ')
    .replace(/ए\s*े/g, 'ऐ')
    .replace(/[ \t]{2,}/g, ' ');
}
