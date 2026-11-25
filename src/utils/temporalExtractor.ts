import { RecurrenceRule, SmartDataSummary, TemporalClass } from '../types/filelens';

export interface TemporalExtractionResult {
  temporalClass: TemporalClass;
  scheduledDateIso: string; // ISO string with date+time
  isReminderRecommended: boolean;
  suggestedTitle: string;
  checklistSteps: string[];
  hasExplicitDate?: boolean;
  hasExplicitTime?: boolean;
}

const ENGLISH_MONTHS: Record<string, number> = {
  jan: 0, january: 0,
  feb: 1, february: 1,
  mar: 2, march: 2,
  apr: 3, april: 3,
  may: 4,
  jun: 5, june: 5,
  jul: 6, july: 6,
  aug: 7, august: 7,
  sep: 8, sept: 8, september: 8,
  oct: 9, october: 9,
  nov: 10, november: 10,
  dec: 11, december: 11,
};

const HINDI_MONTHS: Record<string, number> = {
  जनवरी: 0,
  फरवरी: 1,
  मार्च: 2,
  अप्रैल: 3,
  मई: 4,
  जून: 5,
  जुलाई: 6,
  अगस्त: 7,
  सितंबर: 8,
  सितम्बर: 8,
  अक्टूबर: 9,
  नवंबर: 10,
  नवम्बर: 10,
  दिसंबर: 11,
  दिसम्बर: 11,
};

function startOfDay(d: Date): Date {
  const out = new Date(d);
  out.setHours(0, 0, 0, 0);
  return out;
}

function addDays(d: Date, days: number): Date {
  const out = new Date(d);
  out.setDate(out.getDate() + days);
  return out;
}

function parseTimeFromText(lower: string): { hour: number; minute: number; explicit: boolean } {
  // Match HH:MM am/pm/baje/बजे or H am/pm/baje
  const timeMatch = lower.match(
    /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.|baje|बजे)\b/i
  );
  if (timeMatch) {
    let hour = parseInt(timeMatch[1], 10);
    const minute = timeMatch[2] ? parseInt(timeMatch[2], 10) : 0;
    const meridiem = (timeMatch[3] || '').toLowerCase();

    if (meridiem.startsWith('p') && hour < 12) hour += 12;
    else if (meridiem.startsWith('a') && hour === 12) hour = 0;
    else if ((meridiem === 'baje' || meridiem === 'बजे') && hour < 12) {
      if (/\b(shaam|evening|raat|night|afternoon|dopahar|शाम|रात|दोपहर)\b/.test(lower)) {
        hour += 12;
      }
    }
    return {
      hour: Math.min(23, Math.max(0, hour)),
      minute: Math.min(59, Math.max(0, minute)),
      explicit: true,
    };
  }

  // Contextual time keywords
  if (/\b(morning|subah|सुबह)\b/.test(lower)) return { hour: 9, minute: 0, explicit: true };
  if (/\b(afternoon|dopahar|दोपहर)\b/.test(lower)) return { hour: 14, minute: 0, explicit: true };
  if (/\b(evening|shaam|शाम)\b/.test(lower)) return { hour: 18, minute: 0, explicit: true };
  if (/\b(night|raat|रात)\b/.test(lower)) return { hour: 20, minute: 30, explicit: true };

  return { hour: 9, minute: 0, explicit: false };
}

/**
 * Bilingual English + Hinglish + Hindi temporal extractor & action checklist parser.
 */
export function extractTemporalInfo(
  transcript: string,
  referenceNow: Date = new Date()
): TemporalExtractionResult {
  const clean = transcript.trim();
  const lower = clean.toLowerCase();
  const todayStart = startOfDay(referenceNow);

  let targetDate: Date | null = null;
  let temporalClass: TemporalClass = 'today';

  // 1. Relative future & past keywords
  if (/(day after tomorrow|\bparson\b|परसों)/i.test(lower)) {
    targetDate = addDays(todayStart, 2);
    temporalClass = 'upcoming';
  } else if (/(\btomorrow\b|\bkal\b|\bcal\b|कल)/i.test(lower)) {
    targetDate = addDays(todayStart, 1);
    temporalClass = 'upcoming';
  } else if (/(next week|\bagle hafte\b|अगले हफ्ते)/i.test(lower)) {
    targetDate = addDays(todayStart, 7);
    temporalClass = 'upcoming';
  } else if (/(\byesterday\b|\blast week\b|\barchive\b|\bbita hua\b|पिछले|बीता)/i.test(lower)) {
    targetDate = addDays(todayStart, -1);
    temporalClass = 'history';
  } else if (/(\btoday\b|\baaj\b|\btonight\b|आज)/i.test(lower)) {
    targetDate = new Date(todayStart);
    temporalClass = 'today';
  }

  // 2. Explicit DD/MM/YYYY or DD-MM-YY
  if (!targetDate) {
    const dmy = clean.match(/\b(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?\b/);
    if (dmy) {
      const day = parseInt(dmy[1], 10);
      const month = parseInt(dmy[2], 10) - 1;
      let year = dmy[3] ? parseInt(dmy[3], 10) : referenceNow.getFullYear();
      if (year < 100) year += 2000;
      if (month >= 0 && month <= 11 && day >= 1 && day <= 31) {
        const candidate = new Date(year, month, day);
        targetDate = candidate;
        const diffDays = Math.round(
          (startOfDay(candidate).getTime() - todayStart.getTime()) / 86_400_000
        );
        temporalClass = diffDays > 0 ? 'upcoming' : diffDays < 0 ? 'history' : 'today';
      }
    }
  }

  // 3. Named months (e.g. "14 Sep" or "Sep 14" or Hindi month)
  if (!targetDate) {
    const allMonths = { ...ENGLISH_MONTHS, ...HINDI_MONTHS };
    for (const [mName, mIdx] of Object.entries(allMonths)) {
      const m1 = lower.match(new RegExp(`\\b(\\d{1,2})\\s+${mName}\\b`, 'i'));
      const m2 = lower.match(new RegExp(`\\b${mName}\\s+(\\d{1,2})\\b`, 'i'));
      const dayStr = m1?.[1] || m2?.[1];
      if (dayStr) {
        const day = parseInt(dayStr, 10);
        if (day >= 1 && day <= 31) {
          let candidate = new Date(referenceNow.getFullYear(), mIdx, day);
          if (startOfDay(candidate).getTime() < todayStart.getTime()) {
            // Keep as history if explicitly past, unless user said "next"
            if (lower.includes('next')) {
              candidate = new Date(referenceNow.getFullYear() + 1, mIdx, day);
            }
          }
          targetDate = candidate;
          const diffDays = Math.round(
            (startOfDay(candidate).getTime() - todayStart.getTime()) / 86_400_000
          );
          temporalClass = diffDays > 0 ? 'upcoming' : diffDays < 0 ? 'history' : 'today';
          break;
        }
      }
    }
  }

  // 4. General future cues fallback
  const hasExplicitDate = targetDate !== null;
  if (!targetDate) {
    if (
      /\b(next month|remind|schedule|due|renew|expiry|appointment|meeting|yaad|याद)\b/i.test(lower)
    ) {
      targetDate = addDays(todayStart, 1);
      temporalClass = 'upcoming';
    } else if (/\b(completed|done|old|history|paid|archived)\b/i.test(lower)) {
      targetDate = new Date(todayStart);
      temporalClass = 'history';
    } else {
      targetDate = new Date(todayStart);
      temporalClass = 'today';
    }
  }

  const { hour, minute, explicit } = parseTimeFromText(lower);
  const scheduled = new Date(targetDate);
  scheduled.setHours(hour, minute, 0, 0);

  // If today and explicit time already passed, leave as today (or user can reschedule)
  const isReminderRecommended =
    temporalClass === 'upcoming' ||
    explicit ||
    /\b(remind|alarm|notify|yaad|याद|meeting|appointment|due)\b/i.test(lower);

  // Checklist extraction
  const checklistSteps = clean
    .split(/(?:[।!?.]+|\n+|\band then\b|\bafter that\b|\baur phir\b|\buske baad\b)/i)
    .map((s) => s.replace(/^[-*•\d.)\s]+/, '').trim())
    .filter((s) => s.length > 3)
    .slice(0, 20);

  const firstClause = checklistSteps[0] || clean;
  const suggestedTitle =
    firstClause.length > 56 ? `${firstClause.slice(0, 53).trim()}...` : firstClause;

  return {
    temporalClass,
    scheduledDateIso: scheduled.toISOString(),
    isReminderRecommended,
    suggestedTitle: suggestedTitle || 'Voice Note',
    checklistSteps,
    hasExplicitDate,
    hasExplicitTime: explicit,
  };
}

/**
 * Advances a scheduled ISO date to the next occurrence strictly after referenceNow.
 */
export function computeNextOccurrenceIso(
  currentIso: string | undefined,
  recurrence: RecurrenceRule,
  referenceNow: Date = new Date()
): string | null {
  if (recurrence === 'none') return null;

  const base = currentIso ? new Date(currentIso) : new Date(referenceNow);
  if (Number.isNaN(base.getTime())) return null;

  const next = new Date(base);
  for (let i = 0; i < 120; i++) {
    if (recurrence === 'daily') next.setDate(next.getDate() + 1);
    else if (recurrence === 'weekly') next.setDate(next.getDate() + 7);
    else if (recurrence === 'monthly') next.setMonth(next.getMonth() + 1);
    else if (recurrence === 'yearly') next.setFullYear(next.getFullYear() + 1);

    if (next.getTime() > referenceNow.getTime()) {
      return next.toISOString();
    }
  }
  return next.toISOString();
}

/**
 * Smart Data Extractor (Dates, Amounts, Phones, Emails, IDs)
 * Ported from TemporalExtractor.extractSmartData in FileLensMobile.
 */
export function extractSmartData(text: string): SmartDataSummary {
  if (!text) {
    return { dates: [], amounts: [], phones: [], emails: [], ids: [] };
  }

  const unique = (matches: RegExpMatchArray | null, max: number): string[] => {
    if (!matches) return [];
    return Array.from(new Set(matches.map((m) => m.trim()).filter(Boolean))).slice(0, max);
  };

  const dates = unique(
    text.match(
      /\b(?:\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}|\d{4}[\/\-]\d{1,2}[\/\-]\d{1,2}|\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{2,4})\b/gi
    ),
    8
  );

  const amounts = unique(
    text.match(/(?:₹|Rs\.?|INR|\$|USD|EUR|€)\s*[\d,]+(?:\.\d{1,2})?/gi),
    8
  );

  const phones = unique(
    text.match(/(?:\+91[\s\-]?)?[6-9]\d{9}\b|\b(?:\+1[\s\-]?)?\(?\d{3}\)?[\s\-]?\d{3}[\s\-]?\d{4}\b/g),
    6
  );

  const emails = unique(
    text.match(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g),
    6
  );

  const panMatches = text.match(/\b[A-Z]{5}\d{4}[A-Z]\b/g) || [];
  const aadhaarMatches = text.match(/\b\d{4}[\s\-]?\d{4}[\s\-]?\d{4}\b/g) || [];
  const ids = Array.from(new Set([...panMatches, ...aadhaarMatches])).slice(0, 6);

  return { dates, amounts, phones, emails, ids };
}
