import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Bell,
  Calendar,
  Check,
  CheckCircle2,
  Clock,
  Copy,
  FileText,
  Globe,
  ImagePlus,
  Link2,
  Mic,
  MicOff,
  Plus,
  Repeat,
  Send,
  Trash2,
  X,
} from 'lucide-react';
import {
  RecurrenceRule,
  ScanDocument,
  TemporalClass,
  VoiceNote,
} from '../types/filelens';
import { VOICE_LANGUAGES } from '../data/seedData';
import { formatShortDate } from '../utils/formatters';
import {
  computeNextOccurrenceIso,
  extractTemporalInfo,
  TemporalExtractionResult,
} from '../utils/temporalExtractor';
import { ConfirmedPlanPayload, VoiceNoteConfirmModal } from './VoiceNoteConfirmModal';

interface SecondBrainViewProps {
  notes: VoiceNote[];
  documents: ScanDocument[];
  voiceLanguage: string;
  awarenessBellEnabled?: boolean;
  morningDigestEnabled?: boolean;
  onToggleAwarenessBell?: (v: boolean) => void;
  onToggleMorningDigest?: (v: boolean) => void;
  onChangeVoiceLanguage: (code: string) => void;
  onAddNote: (note: VoiceNote) => void;
  onUpdateNote: (updated: VoiceNote) => void;
  onDeleteNote: (id: string) => void;
  onOpenDocument: (docId: string) => void;
  onToast: (message: string) => void;
}

interface SpeechRecognitionAlternativeLike {
  transcript: string;
}

interface SpeechRecognitionResultLike {
  0: SpeechRecognitionAlternativeLike;
}

interface SpeechRecognitionEventLike {
  results: ArrayLike<SpeechRecognitionResultLike>;
}

interface SpeechRecognitionLike {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((ev: SpeechRecognitionEventLike) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
}

function toLocalDateTimeInputValue(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours()
  )}:${pad(date.getMinutes())}`;
}

export const SecondBrainView: React.FC<SecondBrainViewProps> = ({
  notes,
  documents,
  voiceLanguage,
  awarenessBellEnabled = false,
  morningDigestEnabled = false,
  onToggleAwarenessBell,
  onToggleMorningDigest,
  onChangeVoiceLanguage,
  onAddNote,
  onUpdateNote,
  onDeleteNote,
  onOpenDocument,
  onToast,
}) => {
  const [activeTab, setActiveTab] = useState<TemporalClass>('today');
  const [draftText, setDraftText] = useState<string>('');
  const [recurrence, setRecurrence] = useState<RecurrenceRule>('none');
  const [customScheduleInput, setCustomScheduleInput] = useState<string>('');
  const [draftImages, setDraftImages] = useState<string[]>([]);
  const [isListening, setIsListening] = useState<boolean>(false);
  const [searchFilter, setSearchFilter] = useState<string>('');
  const [linkingNoteId, setLinkingNoteId] = useState<string | null>(null);
  const [addingStepNoteId, setAddingStepNoteId] = useState<string | null>(null);
  const [newStepText, setNewStepText] = useState<string>('');
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const photoInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const onPartial = (e: Event) => {
      const text = (e as CustomEvent<{ text?: string }>).detail?.text;
      if (text) setDraftText(text);
    };
    const onResult = (e: Event) => {
      const text = (e as CustomEvent<{ text?: string }>).detail?.text;
      if (text) setDraftText(text);
      setIsListening(false);
    };
    const onEnd = () => setIsListening(false);
    const onErr = (e: Event) => {
      setIsListening(false);
      const code = (e as CustomEvent<{ text?: string }>).detail?.text;
      if (code !== '7' && code !== '6') {
        onToast('Microphone capture paused — tap mic to retry or type directly');
      }
    };
    window.addEventListener('filelens-voice-partial', onPartial);
    window.addEventListener('filelens-voice-result', onResult);
    window.addEventListener('filelens-voice-end', onEnd);
    window.addEventListener('filelens-voice-error', onErr);
    return () => {
      window.removeEventListener('filelens-voice-partial', onPartial);
      window.removeEventListener('filelens-voice-result', onResult);
      window.removeEventListener('filelens-voice-end', onEnd);
      window.removeEventListener('filelens-voice-error', onErr);
    };
  }, [onToast]);

  const counts = useMemo(
    () => ({
      today: notes.filter((n) => n.temporalClass === 'today').length,
      upcoming: notes.filter((n) => n.temporalClass === 'upcoming').length,
      history: notes.filter((n) => n.temporalClass === 'history').length,
    }),
    [notes]
  );

  const visibleNotes = useMemo(() => {
    const q = searchFilter.trim().toLowerCase();
    return notes.filter((n) => {
      if (n.temporalClass !== activeTab) return false;
      if (!q) return true;
      return (
        n.title.toLowerCase().includes(q) ||
        n.transcript.toLowerCase().includes(q) ||
        n.checklist.some((c) => c.text.toLowerCase().includes(q))
      );
    });
  }, [notes, activeTab, searchFilter]);

  const docMap = useMemo(() => {
    const map: Record<string, ScanDocument> = {};
    documents.forEach((d) => {
      map[d.id] = d;
    });
    return map;
  }, [documents]);

  const toggleVoiceCapture = () => {
    if (isListening) {
      if (window.FileLensAndroid?.stopVoiceCapture) {
        window.FileLensAndroid.stopVoiceCapture();
      } else {
        recognitionRef.current?.stop();
      }
      setIsListening(false);
      return;
    }

    if (window.FileLensAndroid?.startVoiceCapture) {
      const started = window.FileLensAndroid.startVoiceCapture(voiceLanguage);
      if (started) {
        setIsListening(true);
      } else {
        onToast('Allow Microphone permission to start voice capture');
      }
      return;
    }

    const win = window as unknown as {
      SpeechRecognition?: new () => SpeechRecognitionLike;
      webkitSpeechRecognition?: new () => SpeechRecognitionLike;
    };
    const SpeechRec = win.SpeechRecognition || win.webkitSpeechRecognition;

    if (!SpeechRec) {
      onToast('Browser speech API unavailable — type your voice note below');
      return;
    }

    try {
      const rec = new SpeechRec();
      rec.lang = voiceLanguage;
      rec.interimResults = true;
      rec.continuous = false;
      rec.onresult = (event) => {
        let combined = '';
        for (let i = 0; i < event.results.length; i++) {
          combined += event.results[i][0].transcript;
        }
        setDraftText(combined);
      };
      rec.onerror = () => {
        setIsListening(false);
        onToast('Microphone capture paused — you can edit or type directly');
      };
      rec.onend = () => {
        setIsListening(false);
      };
      recognitionRef.current = rec;
      rec.start();
      setIsListening(true);
    } catch {
      setIsListening(false);
      onToast('Could not start microphone');
    }
  };

  const applySchedulePreset = (preset: '1h' | 'today6pm' | 'tomorrow9am' | 'nextweek') => {
    const now = new Date();
    const d = new Date(now);
    if (preset === '1h') {
      d.setHours(d.getHours() + 1);
    } else if (preset === 'today6pm') {
      d.setHours(18, 0, 0, 0);
      if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1);
    } else if (preset === 'tomorrow9am') {
      d.setDate(d.getDate() + 1);
      d.setHours(9, 0, 0, 0);
    } else {
      d.setDate(d.getDate() + 7);
      d.setHours(9, 0, 0, 0);
    }
    setCustomScheduleInput(toLocalDateTimeInputValue(d));
  };

  const handleAttachPhotos = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    Array.from(files)
      .slice(0, 4)
      .forEach((f) => {
        const reader = new FileReader();
        reader.onload = () => {
          setDraftImages((prev) => [...prev.slice(0, 3), String(reader.result)]);
        };
        reader.readAsDataURL(f);
      });
    e.target.value = '';
  };

  const [pendingConfirm, setPendingConfirm] = useState<{
    transcript: string;
    extraction: TemporalExtractionResult;
  } | null>(null);

  const handleSaveNote = () => {
    const clean = draftText.trim();
    if (!clean) return;
    const parsed = extractTemporalInfo(clean);

    let finalClass = parsed.temporalClass;
    let finalScheduledIso = parsed.scheduledDateIso;
    let hasExplicitDate = parsed.hasExplicitDate;

    if (customScheduleInput) {
      const customDate = new Date(customScheduleInput);
      if (!Number.isNaN(customDate.getTime())) {
        finalScheduledIso = customDate.toISOString();
        const todayStart = new Date();
        todayStart.setHours(0, 0, 0, 0);
        const targetStart = new Date(customDate);
        targetStart.setHours(0, 0, 0, 0);
        const diff = targetStart.getTime() - todayStart.getTime();
        finalClass = diff > 0 ? 'upcoming' : diff < 0 ? 'history' : 'today';
        hasExplicitDate = true;
      }
    }

    setPendingConfirm({
      transcript: clean,
      extraction: {
        ...parsed,
        temporalClass: finalClass,
        scheduledDateIso: finalScheduledIso,
        hasExplicitDate,
      },
    });
  };

  const handleConfirmPlan = (confirmed: ConfirmedPlanPayload) => {
    const checklist = confirmed.checklistSteps.map((text, idx) => ({
      id: `step-${Date.now()}-${idx}`,
      text,
      done: false,
    }));

    const note: VoiceNote = {
      id: `vn-${Date.now()}`,
      title: confirmed.title,
      transcript: confirmed.transcript,
      temporalClass: confirmed.temporalClass,
      scheduledDate: confirmed.scheduledDateIso,
      recurrence: confirmed.recurrence,
      checklist,
      imageDataUrls: draftImages.length > 0 ? draftImages : undefined,
      languageCode: voiceLanguage,
      createdAt: new Date().toISOString(),
    };
    onAddNote(note);

    if (confirmed.scheduledDateIso) {
      const dt = new Date(confirmed.scheduledDateIso);
      if (!Number.isNaN(dt.getTime())) {
        if (confirmed.setClockAlarm) {
          const triggerMs = dt.getTime();
          window.FileLensAndroid?.scheduleAutoReminder?.(
            `${note.id}-main`,
            triggerMs,
            `⏰ ${confirmed.title}`,
            confirmed.transcript
          );
          if (triggerMs - Date.now() > 20 * 60_000) {
            window.FileLensAndroid?.scheduleAutoReminder?.(
              `${note.id}-15m`,
              triggerMs - 15 * 60_000,
              `Upcoming in 15m: ${confirmed.title}`,
              confirmed.transcript
            );
          }
        }
        if (confirmed.addToCalendar) {
          window.FileLensAndroid?.openDeviceCalendarEvent?.(
            confirmed.title,
            dt.getTime(),
            confirmed.transcript
          );
        }
      }
    }

    setPendingConfirm(null);
    setDraftText('');
    setRecurrence('none');
    setCustomScheduleInput('');
    setDraftImages([]);
    setActiveTab(confirmed.temporalClass);
    onToast(`Filed under ${confirmed.temporalClass} with ${checklist.length} action step(s)`);
  };

  const handleMarkDone = (note: VoiceNote) => {
    if (note.recurrence !== 'none') {
      const nextIso = computeNextOccurrenceIso(note.scheduledDate, note.recurrence);
      if (nextIso) {
        onUpdateNote({
          ...note,
          scheduledDate: nextIso,
          temporalClass: 'upcoming',
          checklist: note.checklist.map((c) => ({ ...c, done: false })),
        });
        onToast(`Advanced ${note.recurrence} reminder to ${formatShortDate(nextIso)}`);
        return;
      }
    }
    onUpdateNote({
      ...note,
      isDone: true,
      temporalClass: 'history',
      checklist: note.checklist.map((c) => ({ ...c, done: true })),
    });
    onToast('Marked done & moved to History');
  };

  const handleSnooze = (note: VoiceNote, mode: '15m' | 'tomorrow9am') => {
    const next = new Date();
    if (mode === '15m') {
      next.setMinutes(next.getMinutes() + 15);
    } else {
      next.setDate(next.getDate() + 1);
      next.setHours(9, 0, 0, 0);
    }
    onUpdateNote({
      ...note,
      scheduledDate: next.toISOString(),
      temporalClass: mode === 'tomorrow9am' ? 'upcoming' : 'today',
    });
    onToast(mode === '15m' ? 'Snoozed for 15 minutes' : 'Snoozed until tomorrow 9:00 AM');
  };

  const toggleChecklist = (note: VoiceNote, itemId: string) => {
    onUpdateNote({
      ...note,
      checklist: note.checklist.map((c) => (c.id === itemId ? { ...c, done: !c.done } : c)),
    });
  };

  const addChecklistStep = (note: VoiceNote) => {
    const clean = newStepText.trim();
    if (!clean) return;
    onUpdateNote({
      ...note,
      checklist: [...note.checklist, { id: `step-${Date.now()}`, text: clean, done: false }],
    });
    setNewStepText('');
    setAddingStepNoteId(null);
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <h1 className="text-lg sm:text-xl font-bold tracking-tight text-slate-900 dark:text-white truncate">
          Second Brain
        </h1>

        <div className="flex items-center gap-1.5 flex-wrap">
          {onToggleAwarenessBell && (
            <button
              type="button"
              onClick={() => {
                onToggleAwarenessBell(!awarenessBellEnabled);
                onToast(
                  !awarenessBellEnabled
                    ? 'Awareness Bell enabled (hourly focus check-in)'
                    : 'Awareness Bell paused'
                );
              }}
              className={`h-8 px-2.5 rounded-lg text-[11px] font-semibold border flex items-center gap-1 transition-colors ${
                awarenessBellEnabled
                  ? 'bg-orange-50 dark:bg-orange-950/40 border-orange-300 dark:border-orange-700 text-orange-700 dark:text-orange-300'
                  : 'bg-white dark:bg-[#1C1C1E] border-slate-200/80 dark:border-white/10 text-slate-500'
              }`}
              title="Hourly Awareness Bell"
            >
              <Bell className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Bell</span>
            </button>
          )}
          {onToggleMorningDigest && (
            <button
              type="button"
              onClick={() => {
                onToggleMorningDigest(!morningDigestEnabled);
                onToast(
                  !morningDigestEnabled
                    ? 'Morning Daily Digest (8:00 AM) enabled'
                    : 'Morning Daily Digest disabled'
                );
              }}
              className={`h-8 px-2.5 rounded-lg text-[11px] font-semibold border flex items-center gap-1 transition-colors ${
                morningDigestEnabled
                  ? 'bg-emerald-50 dark:bg-emerald-950/40 border-emerald-300 dark:border-emerald-700 text-emerald-700 dark:text-emerald-300'
                  : 'bg-white dark:bg-[#1C1C1E] border-slate-200/80 dark:border-white/10 text-slate-500'
              }`}
              title="Morning Daily Digest at 8:00 AM"
            >
              <Clock className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">8 AM Digest</span>
            </button>
          )}
          <label className="flex items-center gap-1.5 text-xs font-semibold text-slate-600 dark:text-slate-300 bg-white dark:bg-[#1C1C1E] border border-slate-200/80 dark:border-white/10 rounded-lg px-2.5 h-8 shrink-0">
            <Globe className="w-3.5 h-3.5 text-orange-600 dark:text-orange-400" />
            <select
              value={voiceLanguage}
              onChange={(e) => onChangeVoiceLanguage(e.target.value)}
              className="bg-transparent focus:outline-none text-[11px] font-semibold"
            >
              {VOICE_LANGUAGES.map((lang) => (
                <option key={lang.code} value={lang.code} className="text-slate-900">
                  {lang.name} ({lang.nativeName})
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      {/* Voice + Quick Text Composer */}
      <div className="bg-white dark:bg-[#1C1C1E] rounded-xl sm:rounded-2xl p-3 sm:p-4 border border-slate-200/80 dark:border-white/10 space-y-2.5">
        <div className="flex items-start gap-3">
          <button
            type="button"
            onClick={toggleVoiceCapture}
            aria-label={isListening ? 'Stop voice capture' : 'Start voice capture'}
            className={`w-12 h-12 rounded-2xl flex items-center justify-center shrink-0 transition-all ${
              isListening
                ? 'bg-red-600 text-white shadow-lg shadow-red-600/25 animate-pulse ring-4 ring-red-500/30'
                : 'bg-orange-600 hover:bg-orange-700 text-white'
            }`}
          >
            {isListening ? <MicOff className="w-5 h-5" /> : <Mic className="w-5 h-5" />}
          </button>
          <textarea
            rows={2}
            value={draftText}
            onChange={(e) => setDraftText(e.target.value)}
            placeholder={
              isListening
                ? 'Listening… speak naturally (tap red mic to pause)'
                : 'Speak or type (English / Hinglish / Hindi): "Kal shaam 6 baje bijli bill bharna hai aur receipt scan karni hai…"'
            }
            className="flex-1 rounded-xl bg-slate-50 dark:bg-[#2C2C2E] border border-slate-200 dark:border-white/10 p-3 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500 resize-none"
          />
        </div>
        {isListening && (
          <div className="flex items-center gap-2 text-[11px] font-semibold text-red-600 dark:text-red-400">
            <span className="w-2 h-2 rounded-full bg-red-600 animate-ping" />
            <span>Listening live… tap the red mic button when finished</span>
          </div>
        )}

        {/* Attached Photos Preview */}
        {draftImages.length > 0 && (
          <div className="flex items-center gap-2 overflow-x-auto py-1">
            {draftImages.map((src, idx) => (
              <div key={idx} className="relative w-14 h-14 rounded-lg overflow-hidden border border-slate-200 dark:border-white/10 shrink-0">
                <img src={src} alt="Attachment" className="w-full h-full object-cover" />
                <button
                  type="button"
                  onClick={() => setDraftImages((prev) => prev.filter((_, i) => i !== idx))}
                  className="absolute top-0.5 right-0.5 w-4 h-4 rounded-full bg-black/70 text-white flex items-center justify-center"
                >
                  <X className="w-2.5 h-2.5" />
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Schedule Date/Time Presets + Picker */}
        <div className="flex items-center gap-1.5 flex-wrap text-[11px]">
          <span className="text-slate-500 flex items-center gap-1 mr-0.5">
            <Calendar className="w-3.5 h-3.5" />
            <span>Schedule:</span>
          </span>
          {(
            [
              { id: '1h', label: 'In 1 hr' },
              { id: 'today6pm', label: 'Today 6 PM' },
              { id: 'tomorrow9am', label: 'Tomorrow 9 AM' },
              { id: 'nextweek', label: 'Next Week' },
            ] as const
          ).map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => applySchedulePreset(p.id)}
              className="px-2 py-1 rounded-lg bg-slate-100 dark:bg-[#2C2C2E] hover:bg-orange-50 dark:hover:bg-orange-950/40 text-slate-600 dark:text-slate-300 font-medium"
            >
              {p.label}
            </button>
          ))}
          <input
            type="datetime-local"
            value={customScheduleInput}
            onChange={(e) => setCustomScheduleInput(e.target.value)}
            aria-label="Custom schedule date and time"
            className="px-2 py-1 rounded-lg bg-slate-50 dark:bg-[#2C2C2E] border border-slate-200 dark:border-white/10 text-[11px]"
          />
          {customScheduleInput && (
            <button
              type="button"
              onClick={() => setCustomScheduleInput('')}
              className="text-slate-400 hover:text-slate-600"
              title="Clear custom date (auto-detect from text)"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>

        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-xs text-slate-500 flex items-center gap-1 mr-1">
              <Repeat className="w-3.5 h-3.5" />
              <span>Repeat:</span>
            </span>
            {(['none', 'daily', 'weekly', 'monthly', 'yearly'] as const).map((r) => (
              <button
                key={r}
                type="button"
                onClick={() => setRecurrence(r)}
                className={`px-2.5 py-1 rounded-lg text-xs font-semibold capitalize transition-colors ${
                  recurrence === r
                    ? 'bg-orange-600/12 text-orange-700 dark:text-orange-300'
                    : 'bg-slate-100 dark:bg-[#2C2C2E] text-slate-500 dark:text-slate-400'
                }`}
              >
                {r}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-2">
            <input
              ref={photoInputRef}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={handleAttachPhotos}
            />
            <button
              type="button"
              onClick={() => photoInputRef.current?.click()}
              className="min-h-[38px] px-3 rounded-xl bg-slate-100 dark:bg-[#2C2C2E] hover:bg-slate-200 dark:hover:bg-white/15 text-xs font-semibold flex items-center gap-1.5"
              title="Attach photo to note"
            >
              <ImagePlus className="w-4 h-4 text-orange-600 dark:text-orange-400" />
              <span className="hidden sm:inline">Photo</span>
            </button>
            <button
              type="button"
              disabled={!draftText.trim()}
              onClick={handleSaveNote}
              className="min-h-[38px] px-4 rounded-xl bg-orange-600 hover:bg-orange-700 disabled:opacity-40 text-white text-xs font-semibold flex items-center gap-1.5 transition-colors"
            >
              <Send className="w-3.5 h-3.5" />
              <span>Capture Note</span>
            </button>
          </div>
        </div>
      </div>

      {/* Temporal Tabs + Filter */}
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3">
        <div className="grid grid-cols-3 gap-1 p-1 rounded-xl bg-white dark:bg-[#1C1C1E] border border-slate-200/80 dark:border-white/10 sm:w-auto">
          {(
            [
              { id: 'today', label: `Today (${counts.today})` },
              { id: 'upcoming', label: `Upcoming (${counts.upcoming})` },
              { id: 'history', label: `History (${counts.history})` },
            ] as const
          ).map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setActiveTab(t.id)}
              className={`min-h-[38px] px-3.5 rounded-lg text-xs font-semibold transition-colors whitespace-nowrap ${
                activeTab === t.id
                  ? 'bg-orange-600 text-white'
                  : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-white/10'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        <input
          type="text"
          value={searchFilter}
          onChange={(e) => setSearchFilter(e.target.value)}
          placeholder="Filter voice notes & checklists…"
          className="h-10 px-3.5 rounded-xl bg-white dark:bg-[#1C1C1E] border border-slate-200/80 dark:border-white/10 text-xs focus:outline-none focus:ring-2 focus:ring-orange-500 sm:w-64"
        />
      </div>

      {/* Voice Notes List */}
      {visibleNotes.length === 0 ? (
        <div className="bg-white dark:bg-[#1C1C1E] rounded-2xl border border-slate-200/80 dark:border-white/10 p-10 text-center space-y-1.5">
          <h3 className="text-sm font-bold">Your Second Brain is clear here</h3>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Capture a voice memo or reminder above — words like &ldquo;tomorrow&rdquo;, &ldquo;kal&rdquo;, or &ldquo;next week&rdquo; automatically file under Upcoming.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {visibleNotes.map((note) => {
            const linkedDoc = note.linkedDocId ? docMap[note.linkedDocId] : undefined;
            const completedCount = note.checklist.filter((c) => c.done).length;
            const totalSteps = Math.max(1, note.checklist.length);
            const pct = Math.round((completedCount / totalSteps) * 100);
            return (
              <article
                key={note.id}
                className="bg-white dark:bg-[#1C1C1E] rounded-2xl p-4 sm:p-5 border border-slate-200/80 dark:border-white/10 flex flex-col gap-3"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h3 className="text-sm sm:text-base font-bold text-slate-900 dark:text-white leading-snug">
                      {note.title}
                    </h3>
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-500 dark:text-slate-400 font-mono tabular-nums">
                      {note.scheduledDate && (
                        <span className="flex items-center gap-1">
                          <Calendar className="w-3 h-3" />
                          {formatShortDate(note.scheduledDate)}
                        </span>
                      )}
                      {note.recurrence !== 'none' && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span className="capitalize text-orange-600 dark:text-orange-400 font-semibold">
                            {note.recurrence}
                          </span>
                        </>
                      )}
                      <span aria-hidden="true">·</span>
                      <span>
                        {completedCount}/{note.checklist.length} done
                      </span>
                    </div>
                  </div>

                  <div className="flex items-center gap-1 shrink-0">
                    {note.temporalClass !== 'history' && (
                      <button
                        type="button"
                        onClick={() => handleMarkDone(note)}
                        title={
                          note.recurrence !== 'none'
                            ? `Complete & advance ${note.recurrence}`
                            : 'Mark Done & Archive'
                        }
                        className="w-8 h-8 rounded-lg flex items-center justify-center text-emerald-600 hover:bg-emerald-50 dark:hover:bg-emerald-950/40"
                      >
                        <CheckCircle2 className="w-4 h-4" />
                      </button>
                    )}
                    {typeof window !== 'undefined' &&
                      typeof window.FileLensAndroid?.setDeviceClockAlarm === 'function' && (
                        <>
                          <button
                            type="button"
                            onClick={() => {
                              const dt = note.scheduledDate ? new Date(note.scheduledDate) : new Date(Date.now() + 3600_000);
                              const hr = Number.isNaN(dt.getTime()) ? 9 : dt.getHours();
                              const min = Number.isNaN(dt.getTime()) ? 0 : dt.getMinutes();
                              window.FileLensAndroid?.setDeviceClockAlarm?.(hr, min, note.title);
                              onToast('Opening Clock Alarm…');
                            }}
                            title="Set Android Clock Alarm"
                            className="w-8 h-8 rounded-lg flex items-center justify-center text-slate-400 hover:text-orange-500"
                          >
                            <Bell className="w-4 h-4" />
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              const dt = note.scheduledDate ? new Date(note.scheduledDate) : new Date(Date.now() + 3600_000);
                              const ms = Number.isNaN(dt.getTime()) ? Date.now() + 3600_000 : dt.getTime();
                              window.FileLensAndroid?.openDeviceCalendarEvent?.(
                                note.title,
                                ms,
                                note.transcript
                              );
                              onToast('Opening Calendar event…');
                            }}
                            title="Add to Android Calendar"
                            className="w-8 h-8 rounded-lg flex items-center justify-center text-slate-400 hover:text-sky-500"
                          >
                            <Calendar className="w-4 h-4" />
                          </button>
                        </>
                      )}
                    <button
                      type="button"
                      onClick={async () => {
                        await navigator.clipboard
                          .writeText(`${note.title}\n${note.transcript}`)
                          .catch(() => {});
                        onToast('Copied voice note');
                      }}
                      title="Copy transcript"
                      className="w-8 h-8 rounded-lg flex items-center justify-center text-slate-400 hover:text-slate-700 dark:hover:text-white"
                    >
                      <Copy className="w-4 h-4" />
                    </button>
                    <button
                      type="button"
                      onClick={() => onDeleteNote(note.id)}
                      title="Delete note"
                      className="w-8 h-8 rounded-lg flex items-center justify-center text-slate-400 hover:text-red-600"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>

                {/* Checklist Progress Bar */}
                {note.checklist.length > 0 && (
                  <div className="h-1.5 rounded-full bg-slate-100 dark:bg-[#2C2C2E] overflow-hidden">
                    <div
                      className="h-full bg-orange-500 transition-all duration-300"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                )}

                <p className="text-xs sm:text-sm text-slate-600 dark:text-slate-300 leading-relaxed">
                  {note.transcript}
                </p>

                {/* Attached Photos */}
                {note.imageDataUrls && note.imageDataUrls.length > 0 && (
                  <div className="flex items-center gap-2 overflow-x-auto">
                    {note.imageDataUrls.map((src, i) => (
                      <img
                        key={i}
                        src={src}
                        alt="Note attachment"
                        className="w-16 h-16 rounded-xl object-cover border border-slate-200 dark:border-white/10 shrink-0"
                      />
                    ))}
                  </div>
                )}

                {/* Action Checklist */}
                <div className="space-y-1.5 pt-1">
                  {note.checklist.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => toggleChecklist(note, item.id)}
                      className="w-full flex items-center gap-2.5 py-1 text-left group"
                    >
                      <span
                        className={`w-5 h-5 rounded-md flex items-center justify-center border shrink-0 transition-colors ${
                          item.done
                            ? 'bg-orange-600 border-orange-600 text-white'
                            : 'border-slate-300 dark:border-slate-600 group-hover:border-orange-500'
                        }`}
                      >
                        {item.done && <Check className="w-3.5 h-3.5 stroke-[2.5]" />}
                      </span>
                      <span
                        className={`text-xs sm:text-sm ${
                          item.done
                            ? 'line-through text-slate-400 dark:text-slate-500'
                            : 'text-slate-800 dark:text-slate-200'
                        }`}
                      >
                        {item.text}
                      </span>
                    </button>
                  ))}

                  {addingStepNoteId === note.id ? (
                    <div className="flex items-center gap-2 pt-1">
                      <input
                        type="text"
                        value={newStepText}
                        onChange={(e) => setNewStepText(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && addChecklistStep(note)}
                        placeholder="New action step…"
                        className="flex-1 h-9 px-3 rounded-lg bg-slate-50 dark:bg-[#2C2C2E] border border-slate-200 dark:border-white/10 text-xs"
                        autoFocus
                      />
                      <button
                        type="button"
                        onClick={() => addChecklistStep(note)}
                        className="h-9 px-3 rounded-lg bg-orange-600 text-white text-xs font-semibold"
                      >
                        Add
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setAddingStepNoteId(null);
                          setNewStepText('');
                        }}
                        className="h-9 px-2 text-slate-400"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setAddingStepNoteId(note.id)}
                      className="text-xs font-semibold text-orange-600 dark:text-orange-400 hover:underline flex items-center gap-1 pt-1"
                    >
                      <Plus className="w-3.5 h-3.5" />
                      <span>Add step</span>
                    </button>
                  )}
                </div>

                {/* Linked Document + Snooze Footer */}
                <div className="pt-2 border-t border-slate-100 dark:border-white/5 flex items-center justify-between gap-2 flex-wrap">
                  {linkedDoc ? (
                    <button
                      type="button"
                      onClick={() => onOpenDocument(linkedDoc.id)}
                      className="px-3 py-1.5 rounded-xl bg-orange-50 dark:bg-orange-950/40 text-orange-700 dark:text-orange-300 text-xs font-semibold flex items-center gap-1.5 hover:bg-orange-100 transition-colors"
                    >
                      <FileText className="w-3.5 h-3.5" />
                      <span className="truncate max-w-[180px]">{linkedDoc.title}</span>
                    </button>
                  ) : (
                    <span className="text-xs text-slate-400">No linked scan</span>
                  )}
                  <div className="flex items-center gap-1.5">
                    {note.temporalClass !== 'history' && (
                      <>
                        <button
                          type="button"
                          onClick={() => handleSnooze(note, '15m')}
                          className="px-2 py-1 rounded-lg bg-slate-100 dark:bg-[#2C2C2E] hover:bg-slate-200 text-[11px] font-medium"
                        >
                          +15m
                        </button>
                        <button
                          type="button"
                          onClick={() => handleSnooze(note, 'tomorrow9am')}
                          className="px-2 py-1 rounded-lg bg-slate-100 dark:bg-[#2C2C2E] hover:bg-slate-200 text-[11px] font-medium"
                        >
                          Tmrw
                        </button>
                      </>
                    )}
                    <button
                      type="button"
                      onClick={() => setLinkingNoteId(note.id)}
                      className="px-2.5 py-1 rounded-lg bg-slate-100 dark:bg-[#2C2C2E] hover:bg-slate-200 text-[11px] font-semibold flex items-center gap-1"
                    >
                      <Link2 className="w-3 h-3" />
                      <span>{linkedDoc ? 'Change' : 'Link PDF'}</span>
                    </button>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}

      {/* Link Document Modal */}
      {linkingNoteId && (
        <div
          className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm flex items-end sm:items-center justify-center p-0 sm:p-4"
          onClick={() => setLinkingNoteId(null)}
        >
          <div
            className="w-full sm:max-w-md bg-white dark:bg-[#1C1C1E] rounded-t-3xl sm:rounded-3xl p-5 pb-safe space-y-3 max-h-[80vh] flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <h3 className="text-base font-bold">Link Scanned Document</h3>
              <button
                onClick={() => setLinkingNoteId(null)}
                className="w-8 h-8 rounded-full flex items-center justify-center hover:bg-slate-100 dark:hover:bg-white/10"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="overflow-y-auto space-y-2">
              {documents.map((d) => (
                <button
                  key={d.id}
                  type="button"
                  onClick={() => {
                    const target = notes.find((n) => n.id === linkingNoteId);
                    if (target) {
                      onUpdateNote({ ...target, linkedDocId: d.id });
                      onToast(`Linked "${d.title}" to note`);
                    }
                    setLinkingNoteId(null);
                  }}
                  className="w-full p-3 rounded-xl bg-slate-50 dark:bg-[#2C2C2E] hover:bg-orange-50 dark:hover:bg-orange-950/30 flex items-center justify-between gap-3 text-left"
                >
                  <div className="min-w-0">
                    <div className="text-sm font-semibold truncate">{d.title}</div>
                    <div className="text-xs text-slate-500">
                      {d.pages.length} page(s) · {formatShortDate(d.updatedAt)}
                    </div>
                  </div>
                  <Link2 className="w-4 h-4 text-orange-600 shrink-0" />
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {pendingConfirm && (
        <VoiceNoteConfirmModal
          open={Boolean(pendingConfirm)}
          initialTranscript={pendingConfirm.transcript}
          initialExtraction={pendingConfirm.extraction}
          initialRecurrence={recurrence}
          onConfirm={handleConfirmPlan}
          onDiscard={() => setPendingConfirm(null)}
        />
      )}
    </div>
  );
};
