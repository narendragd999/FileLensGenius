import React, { useMemo, useRef, useState } from 'react';
import {
  Calendar,
  Check,
  Copy,
  FileText,
  Globe,
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
import { classifyVoiceTranscript, formatShortDate } from '../utils/formatters';

interface SecondBrainViewProps {
  notes: VoiceNote[];
  documents: ScanDocument[];
  voiceLanguage: string;
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

export const SecondBrainView: React.FC<SecondBrainViewProps> = ({
  notes,
  documents,
  voiceLanguage,
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
  const [isListening, setIsListening] = useState<boolean>(false);
  const [searchFilter, setSearchFilter] = useState<string>('');
  const [linkingNoteId, setLinkingNoteId] = useState<string | null>(null);
  const [addingStepNoteId, setAddingStepNoteId] = useState<string | null>(null);
  const [newStepText, setNewStepText] = useState<string>('');
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);

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
      recognitionRef.current?.stop();
      setIsListening(false);
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

  const handleSaveNote = () => {
    const clean = draftText.trim();
    if (!clean) return;
    const parsed = classifyVoiceTranscript(clean);
    const note: VoiceNote = {
      id: `vn-${Date.now()}`,
      title: parsed.title,
      transcript: clean,
      temporalClass: parsed.temporalClass,
      scheduledDate: parsed.scheduledDate,
      recurrence,
      checklist: parsed.checklist,
      languageCode: voiceLanguage,
      createdAt: new Date().toISOString(),
    };
    onAddNote(note);
    setDraftText('');
    setRecurrence('none');
    setActiveTab(parsed.temporalClass);
    onToast(`Filed under ${parsed.temporalClass} with ${parsed.checklist.length} action step(s)`);
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
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-lg sm:text-xl font-bold tracking-tight text-slate-900 dark:text-white truncate">
          Second Brain
        </h1>

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

      {/* Voice + Quick Text Composer */}
      <div className="bg-white dark:bg-[#1C1C1E] rounded-xl sm:rounded-2xl p-3 sm:p-4 border border-slate-200/80 dark:border-white/10 space-y-2.5">
        <div className="flex items-start gap-3">
          <button
            type="button"
            onClick={toggleVoiceCapture}
            aria-label={isListening ? 'Stop voice capture' : 'Start voice capture'}
            className={`w-12 h-12 rounded-2xl flex items-center justify-center shrink-0 transition-all ${
              isListening
                ? 'bg-red-600 text-white shadow-lg shadow-red-600/25'
                : 'bg-orange-600 hover:bg-orange-700 text-white'
            }`}
          >
            {isListening ? <MicOff className="w-5 h-5" /> : <Mic className="w-5 h-5" />}
          </button>
          <textarea
            rows={2}
            value={draftText}
            onChange={(e) => setDraftText(e.target.value)}
            placeholder='Speak or type: "Remind me tomorrow to submit the signed contract and send the invoice PDF…"'
            className="flex-1 rounded-xl bg-slate-50 dark:bg-[#2C2C2E] border border-slate-200 dark:border-white/10 p-3 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500 resize-none"
          />
        </div>

        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-xs text-slate-500 flex items-center gap-1 mr-1">
              <Repeat className="w-3.5 h-3.5" />
              <span>Repeat:</span>
            </span>
            {(['none', 'daily', 'weekly', 'monthly'] as const).map((r) => (
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

          <button
            type="button"
            disabled={!draftText.trim()}
            onClick={handleSaveNote}
            className="min-h-[40px] px-4 rounded-xl bg-orange-600 hover:bg-orange-700 disabled:opacity-40 text-white text-xs font-semibold flex items-center gap-1.5 transition-colors"
          >
            <Send className="w-3.5 h-3.5" />
            <span>Capture Note</span>
          </button>
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
            Capture a voice memo or reminder above — words like &ldquo;tomorrow&rdquo; or &ldquo;next week&rdquo; automatically file under Upcoming.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {visibleNotes.map((note) => {
            const linkedDoc = note.linkedDocId ? docMap[note.linkedDocId] : undefined;
            const completedCount = note.checklist.filter((c) => c.done).length;
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
                          <span className="capitalize">{note.recurrence}</span>
                        </>
                      )}
                      <span aria-hidden="true">·</span>
                      <span>
                        {completedCount}/{note.checklist.length} done
                      </span>
                    </div>
                  </div>

                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      type="button"
                      onClick={async () => {
                        await navigator.clipboard.writeText(`${note.title}\n${note.transcript}`).catch(() => {});
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

                <p className="text-xs sm:text-sm text-slate-600 dark:text-slate-300 leading-relaxed">
                  {note.transcript}
                </p>

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
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') addChecklistStep(note);
                        }}
                        placeholder="Add action step…"
                        className="flex-1 h-9 px-3 rounded-lg bg-slate-50 dark:bg-[#2C2C2E] border border-slate-200 dark:border-white/10 text-xs focus:outline-none focus:ring-2 focus:ring-orange-500"
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
                        className="w-8 h-8 flex items-center justify-center text-slate-400"
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

                {/* Linked Document Row */}
                <div className="pt-2.5 mt-auto border-t border-slate-100 dark:border-white/8 flex items-center justify-between gap-2">
                  {linkedDoc ? (
                    <button
                      type="button"
                      onClick={() => onOpenDocument(linkedDoc.id)}
                      className="flex items-center gap-1.5 text-xs font-semibold text-slate-700 dark:text-slate-200 hover:text-orange-600 truncate"
                    >
                      <FileText className="w-3.5 h-3.5 text-orange-600 shrink-0" />
                      <span className="truncate">{linkedDoc.title}</span>
                    </button>
                  ) : (
                    <span className="text-xs text-slate-400">No linked document</span>
                  )}

                  <button
                    type="button"
                    onClick={() => setLinkingNoteId(note.id)}
                    className="text-xs font-semibold text-slate-500 hover:text-orange-600 flex items-center gap-1 shrink-0"
                  >
                    <Link2 className="w-3.5 h-3.5" />
                    <span>{linkedDoc ? 'Change' : 'Link PDF'}</span>
                  </button>
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
            className="w-full sm:max-w-md bg-white dark:bg-[#1C1C1E] rounded-t-3xl sm:rounded-3xl p-5 pb-safe space-y-3 max-h-[75vh] flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <h3 className="text-base font-bold">Link Indexed Document</h3>
              <button
                type="button"
                onClick={() => setLinkingNoteId(null)}
                className="w-9 h-9 rounded-full flex items-center justify-center hover:bg-slate-100 dark:hover:bg-white/10"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="overflow-y-auto space-y-1.5">
              {documents.length === 0 ? (
                <p className="text-xs text-slate-500 dark:text-slate-400 py-4 text-center">
                  No indexed files yet. Index device files or scan a document first.
                </p>
              ) : (
                documents.map((doc) => (
                  <button
                    key={doc.id}
                    type="button"
                    onClick={() => {
                      const target = notes.find((n) => n.id === linkingNoteId);
                      if (target) {
                        onUpdateNote({ ...target, linkedDocId: doc.id });
                        onToast(`Linked "${doc.title}"`);
                      }
                      setLinkingNoteId(null);
                    }}
                    className="w-full p-3 rounded-xl bg-slate-50 dark:bg-[#2C2C2E] hover:bg-orange-50 dark:hover:bg-orange-950/30 flex items-center justify-between gap-2 text-left"
                  >
                    <span className="text-sm font-semibold truncate">{doc.title}</span>
                    <span className="text-xs font-mono text-slate-500 shrink-0">
                      {doc.pages.length}p
                    </span>
                  </button>
                ))
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
