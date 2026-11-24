import { ChecklistItem, ExpiryRadarItem, ScanDocument, TemporalClass } from '../types/filelens';

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(0)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(2)} MB`;
}

export function formatShortDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: date.getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined,
  });
}

export function resolveNamingTemplate(pattern: string, seqNumber: number): string {
  const now = new Date();
  const yyyy = String(now.getFullYear());
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const seq = String(seqNumber).padStart(3, '0');
  return pattern
    .replace(/\{YYYY\}/g, yyyy)
    .replace(/\{MM\}/g, mm)
    .replace(/\{DD\}/g, dd)
    .replace(/\{SEQ\}/g, seq);
}

export function computeExpiryRadar(docs: ScanDocument[]): ExpiryRadarItem[] {
  const now = new Date();
  now.setHours(0, 0, 0, 0);

  return docs
    .filter((d) => Boolean(d.expiryDate))
    .map((doc) => {
      const target = new Date(`${doc.expiryDate}T00:00:00`);
      const diffMs = target.getTime() - now.getTime();
      const daysRemaining = Math.round(diffMs / (1000 * 60 * 60 * 24));
      let urgency: ExpiryRadarItem['urgency'] = 'safe';
      if (daysRemaining < 0) urgency = 'expired';
      else if (daysRemaining <= 30) urgency = 'critical';
      else if (daysRemaining <= 90) urgency = 'upcoming';

      return {
        doc,
        expiryDate: doc.expiryDate!,
        daysRemaining,
        urgency,
      };
    })
    .sort((a, b) => a.daysRemaining - b.daysRemaining);
}

export function classifyVoiceTranscript(transcript: string): {
  temporalClass: TemporalClass;
  title: string;
  checklist: ChecklistItem[];
  scheduledDate?: string;
} {
  const lower = transcript.toLowerCase();
  const now = new Date();
  const isoToday = now.toISOString().slice(0, 10);

  let temporalClass: TemporalClass = 'today';
  let scheduledDate: string | undefined = isoToday;

  if (/\b(yesterday|last week|ago|expired|completed|was)\b/.test(lower)) {
    temporalClass = 'history';
    const d = new Date(now);
    d.setDate(d.getDate() - 1);
    scheduledDate = d.toISOString().slice(0, 10);
  } else if (/\b(tomorrow|next week|next month|upcoming|schedule|remind|later|monday|tuesday|wednesday|thursday|friday)\b/.test(lower)) {
    temporalClass = 'upcoming';
    const d = new Date(now);
    d.setDate(d.getDate() + (lower.includes('next week') ? 7 : 1));
    scheduledDate = d.toISOString().slice(0, 10);
  }

  const trimmed = transcript.trim();
  const firstSentence = trimmed.split(/[.!?]/)[0]?.trim() || 'Voice Note';
  const title = firstSentence.length > 68 ? `${firstSentence.slice(0, 65)}…` : firstSentence;

  // Split multi-step transcripts into actionable checklist items
  const rawSteps = trimmed
    .split(/\band\b|,|;|\bthen\b/i)
    .map((s) => s.trim())
    .filter((s) => s.length >= 8);

  const checklist: ChecklistItem[] = (rawSteps.length > 1 ? rawSteps.slice(0, 4) : [title]).map(
    (step, idx) => ({
      id: `step-${Date.now()}-${idx}`,
      text: step.charAt(0).toUpperCase() + step.slice(1),
      done: false,
    })
  );

  return { temporalClass, title, checklist, scheduledDate };
}

export function triggerFileDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}
