import React, { useEffect, useState } from 'react';
import { Bell, Calendar, CheckSquare, Clock, Plus, Repeat, Sparkles, Trash2, X } from 'lucide-react';
import { RecurrenceRule, TemporalClass } from '../types/filelens';
import { TemporalExtractionResult } from '../utils/temporalExtractor';

export interface ConfirmedPlanPayload {
  title: string;
  transcript: string;
  temporalClass: TemporalClass;
  scheduledDateIso: string | undefined;
  recurrence: RecurrenceRule;
  checklistSteps: string[];
  setClockAlarm: boolean;
  addToCalendar: boolean;
}

interface VoiceNoteConfirmModalProps {
  open: boolean;
  initialTranscript: string;
  initialExtraction: TemporalExtractionResult;
  initialRecurrence: RecurrenceRule;
  onConfirm: (payload: ConfirmedPlanPayload) => void;
  onDiscard: () => void;
}

function toLocalDateInput(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function toLocalTimeInput(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export const VoiceNoteConfirmModal: React.FC<VoiceNoteConfirmModalProps> = ({
  open,
  initialTranscript,
  initialExtraction,
  initialRecurrence,
  onConfirm,
  onDiscard,
}) => {
  const [title, setTitle] = useState(initialExtraction.suggestedTitle);
  const [transcript, setTranscript] = useState(initialTranscript);
  const [dateStr, setDateStr] = useState<string>(() =>
    toLocalDateInput(new Date(initialExtraction.scheduledDateIso))
  );
  const [timeStr, setTimeStr] = useState<string>(() =>
    toLocalTimeInput(new Date(initialExtraction.scheduledDateIso))
  );
  const [isUndated, setIsUndated] = useState<boolean>(
    initialExtraction.temporalClass === 'history' && !initialExtraction.hasExplicitDate
  );
  const [recurrence, setRecurrence] = useState<RecurrenceRule>(initialRecurrence);
  const [steps, setSteps] = useState<string[]>(initialExtraction.checklistSteps);
  const [newStep, setNewStep] = useState('');
  const [setClockAlarm, setSetClockAlarm] = useState<boolean>(
    initialExtraction.isReminderRecommended
  );
  const [addToCalendar, setAddToCalendar] = useState<boolean>(false);

  useEffect(() => {
    if (!open) return;
    const d = new Date(initialExtraction.scheduledDateIso);
    const valid = !Number.isNaN(d.getTime()) ? d : new Date();
    setTitle(initialExtraction.suggestedTitle);
    setTranscript(initialTranscript);
    setDateStr(toLocalDateInput(valid));
    setTimeStr(toLocalTimeInput(valid));
    setIsUndated(initialExtraction.temporalClass === 'history' && !initialExtraction.hasExplicitDate);
    setRecurrence(initialRecurrence);
    setSteps(initialExtraction.checklistSteps.length > 0 ? initialExtraction.checklistSteps : [initialTranscript.trim()]);
    setNewStep('');
    setSetClockAlarm(initialExtraction.isReminderRecommended);
    setAddToCalendar(false);
  }, [open, initialTranscript, initialExtraction, initialRecurrence]);

  if (!open) return null;

  const computeSelectedDate = (): Date => {
    const [y, m, day] = dateStr.split('-').map((n) => parseInt(n, 10));
    const [hr, min] = timeStr.split(':').map((n) => parseInt(n, 10));
    const d = new Date();
    if (!Number.isNaN(y) && !Number.isNaN(m) && !Number.isNaN(day)) {
      d.setFullYear(y, m - 1, day);
    }
    d.setHours(Number.isNaN(hr) ? 9 : hr, Number.isNaN(min) ? 0 : min, 0, 0);
    return d;
  };

  const applyQuickOffset = (days: number) => {
    const d = new Date();
    d.setDate(d.getDate() + days);
    setDateStr(toLocalDateInput(d));
    setIsUndated(false);
  };

  const selectedDateObj = computeSelectedDate();
  const todayStr = toLocalDateInput(new Date());
  const tomorrowDate = new Date();
  tomorrowDate.setDate(tomorrowDate.getDate() + 1);
  const tomorrowStr = toLocalDateInput(tomorrowDate);
  const in2Date = new Date();
  in2Date.setDate(in2Date.getDate() + 2);
  const in2Str = toLocalDateInput(in2Date);

  const computedTemporal: TemporalClass = isUndated
    ? 'history'
    : dateStr === todayStr
      ? 'today'
      : dateStr > todayStr
        ? 'upcoming'
        : 'history';

  const hasAndroidAlarm =
    typeof window !== 'undefined' && typeof window.FileLensAndroid?.setDeviceClockAlarm === 'function';

  const handleConfirm = () => {
    const cleanedSteps = steps.map((s) => s.trim()).filter(Boolean);
    onConfirm({
      title: title.trim() || initialExtraction.suggestedTitle,
      transcript: transcript.trim() || initialTranscript.trim(),
      temporalClass: computedTemporal,
      scheduledDateIso: isUndated ? undefined : selectedDateObj.toISOString(),
      recurrence,
      checklistSteps: cleanedSteps.length > 0 ? cleanedSteps : [transcript.trim()],
      setClockAlarm: !isUndated && setClockAlarm,
      addToCalendar: !isUndated && addToCalendar,
    });
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-end sm:items-center justify-center p-0 sm:p-4"
      onClick={onDiscard}
    >
      <div
        className="w-full sm:max-w-lg max-h-[92dvh] overflow-y-auto bg-white dark:bg-[#1C1C1E] rounded-t-3xl sm:rounded-3xl p-5 pb-safe space-y-4 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-orange-600" />
            <h3 className="text-base font-bold">Verify Schedule &amp; Plan</h3>
          </div>
          <button
            type="button"
            onClick={onDiscard}
            className="w-8 h-8 rounded-full flex items-center justify-center hover:bg-slate-100 dark:hover:bg-white/10"
            aria-label="Discard"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Detection Confidence Banner */}
        <div
          className={`rounded-xl p-3 border text-xs flex items-start gap-2 ${
            initialExtraction.hasExplicitDate || initialExtraction.hasExplicitTime
              ? 'bg-emerald-50 dark:bg-emerald-950/30 border-emerald-200 dark:border-emerald-900/50 text-emerald-800 dark:text-emerald-200'
              : 'bg-amber-50 dark:bg-amber-950/30 border-amber-200 dark:border-amber-900/50 text-amber-800 dark:text-amber-200'
          }`}
        >
          <Calendar className="w-4 h-4 shrink-0 mt-0.5" />
          <div>
            <div className="font-semibold">
              {isUndated
                ? 'Saved as Undated Memo (History)'
                : `${selectedDateObj.toLocaleDateString([], {
                    weekday: 'short',
                    month: 'short',
                    day: 'numeric',
                  })} at ${selectedDateObj.toLocaleTimeString([], {
                    hour: '2-digit',
                    minute: '2-digit',
                  })}`}
            </div>
            <div className="text-[11px] opacity-85 mt-0.5">
              {initialExtraction.hasExplicitDate || initialExtraction.hasExplicitTime
                ? 'Auto-detected from your note. Adjust date, time, or steps below if needed.'
                : 'No explicit date/time detected — please pick the right date & time below.'}
            </div>
          </div>
        </div>

        {/* Editable Title & Note */}
        <div className="space-y-2">
          <label className="block text-[11px] font-semibold text-slate-500 uppercase tracking-wide">
            Plan Title &amp; Details
          </label>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Plan title…"
            className="w-full h-10 px-3 rounded-xl bg-slate-50 dark:bg-[#2C2C2E] border border-slate-200 dark:border-white/10 text-sm font-semibold focus:outline-none focus:ring-2 focus:ring-orange-500"
          />
          <textarea
            rows={2}
            value={transcript}
            onChange={(e) => setTranscript(e.target.value)}
            className="w-full p-3 rounded-xl bg-slate-50 dark:bg-[#2C2C2E] border border-slate-200 dark:border-white/10 text-xs focus:outline-none focus:ring-2 focus:ring-orange-500 resize-none"
          />
        </div>

        {/* Quick Date Presets + Native Date/Time Pickers */}
        <div className="space-y-2.5">
          <label className="block text-[11px] font-semibold text-slate-500 uppercase tracking-wide">
            Date &amp; Time
          </label>
          <div className="flex flex-wrap gap-1.5">
            <button
              type="button"
              onClick={() => applyQuickOffset(0)}
              className={`px-2.5 py-1.5 rounded-lg text-xs font-semibold ${
                !isUndated && dateStr === todayStr
                  ? 'bg-orange-600 text-white'
                  : 'bg-slate-100 dark:bg-[#2C2C2E] text-slate-700 dark:text-slate-200'
              }`}
            >
              Today
            </button>
            <button
              type="button"
              onClick={() => applyQuickOffset(1)}
              className={`px-2.5 py-1.5 rounded-lg text-xs font-semibold ${
                !isUndated && dateStr === tomorrowStr
                  ? 'bg-orange-600 text-white'
                  : 'bg-slate-100 dark:bg-[#2C2C2E] text-slate-700 dark:text-slate-200'
              }`}
            >
              Tomorrow
            </button>
            <button
              type="button"
              onClick={() => applyQuickOffset(2)}
              className={`px-2.5 py-1.5 rounded-lg text-xs font-semibold ${
                !isUndated && dateStr === in2Str
                  ? 'bg-orange-600 text-white'
                  : 'bg-slate-100 dark:bg-[#2C2C2E] text-slate-700 dark:text-slate-200'
              }`}
            >
              In 2 Days
            </button>
            <button
              type="button"
              onClick={() => setIsUndated(true)}
              className={`px-2.5 py-1.5 rounded-lg text-xs font-semibold ${
                isUndated
                  ? 'bg-slate-800 text-white dark:bg-white dark:text-slate-900'
                  : 'bg-slate-100 dark:bg-[#2C2C2E] text-slate-700 dark:text-slate-200'
              }`}
            >
              Undated Memo
            </button>
          </div>

          {!isUndated && (
            <>
              <div className="grid grid-cols-2 gap-2">
                <div className="flex items-center gap-2 px-3 h-10 rounded-xl bg-slate-50 dark:bg-[#2C2C2E] border border-slate-200 dark:border-white/10">
                  <Calendar className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                  <input
                    type="date"
                    value={dateStr}
                    onChange={(e) => {
                      if (e.target.value) setDateStr(e.target.value);
                    }}
                    className="w-full bg-transparent text-xs font-semibold focus:outline-none"
                  />
                </div>
                <div className="flex items-center gap-2 px-3 h-10 rounded-xl bg-slate-50 dark:bg-[#2C2C2E] border border-slate-200 dark:border-white/10">
                  <Clock className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                  <input
                    type="time"
                    value={timeStr}
                    onChange={(e) => {
                      if (e.target.value) setTimeStr(e.target.value);
                    }}
                    className="w-full bg-transparent text-xs font-semibold focus:outline-none"
                  />
                </div>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {[
                  { label: '9:00 AM', val: '09:00' },
                  { label: '1:00 PM', val: '13:00' },
                  { label: '6:00 PM', val: '18:00' },
                  { label: '8:00 PM', val: '20:00' },
                ].map((preset) => (
                  <button
                    key={preset.val}
                    type="button"
                    onClick={() => setTimeStr(preset.val)}
                    className={`px-2 py-1 rounded-md text-[11px] font-medium ${
                      timeStr === preset.val
                        ? 'bg-orange-100 text-orange-700 dark:bg-orange-950/60 dark:text-orange-300'
                        : 'bg-slate-100 dark:bg-[#2C2C2E] text-slate-600 dark:text-slate-300'
                    }`}
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>

        {/* Recurrence */}
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-semibold text-slate-600 dark:text-slate-300 flex items-center gap-1.5">
            <Repeat className="w-3.5 h-3.5 text-slate-400" />
            Repeat Schedule
          </span>
          <select
            value={recurrence}
            onChange={(e) => setRecurrence(e.target.value as RecurrenceRule)}
            className="h-8 px-2.5 rounded-lg bg-slate-100 dark:bg-[#2C2C2E] text-xs font-semibold"
          >
            <option value="none">One-time</option>
            <option value="daily">Daily</option>
            <option value="weekly">Weekly</option>
            <option value="monthly">Monthly</option>
          </select>
        </div>

        {/* Extracted Checklist */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide flex items-center gap-1">
              <CheckSquare className="w-3.5 h-3.5" />
              Action Steps ({steps.length})
            </span>
          </div>
          <div className="space-y-1.5 max-h-36 overflow-y-auto">
            {steps.map((step, idx) => (
              <div key={idx} className="flex items-center gap-1.5">
                <input
                  type="text"
                  value={step}
                  onChange={(e) =>
                    setSteps((prev) => prev.map((s, i) => (i === idx ? e.target.value : s)))
                  }
                  className="flex-1 h-8 px-2.5 rounded-lg bg-slate-50 dark:bg-[#2C2C2E] border border-slate-200 dark:border-white/10 text-xs"
                />
                <button
                  type="button"
                  onClick={() => setSteps((prev) => prev.filter((_, i) => i !== idx))}
                  className="w-7 h-7 rounded-lg flex items-center justify-center text-slate-400 hover:text-red-500"
                  aria-label="Remove step"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
          </div>
          <div className="flex items-center gap-1.5">
            <input
              type="text"
              value={newStep}
              onChange={(e) => setNewStep(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && newStep.trim()) {
                  e.preventDefault();
                  setSteps((prev) => [...prev, newStep.trim()]);
                  setNewStep('');
                }
              }}
              placeholder="Add another step…"
              className="flex-1 h-8 px-2.5 rounded-lg bg-slate-50 dark:bg-[#2C2C2E] border border-slate-200 dark:border-white/10 text-xs"
            />
            <button
              type="button"
              onClick={() => {
                if (!newStep.trim()) return;
                setSteps((prev) => [...prev, newStep.trim()]);
                setNewStep('');
              }}
              className="h-8 px-2.5 rounded-lg bg-slate-100 dark:bg-[#2C2C2E] text-xs font-semibold flex items-center gap-1"
            >
              <Plus className="w-3.5 h-3.5" />
              Add
            </button>
          </div>
        </div>

        {/* Native Alarm / Calendar Triggers */}
        {!isUndated && hasAndroidAlarm && (
          <div className="grid grid-cols-2 gap-2 pt-1">
            <button
              type="button"
              onClick={() => setSetClockAlarm((v) => !v)}
              className={`h-9 px-3 rounded-xl border text-xs font-semibold flex items-center justify-center gap-1.5 ${
                setClockAlarm
                  ? 'bg-orange-50 dark:bg-orange-950/40 border-orange-400 text-orange-700 dark:text-orange-300'
                  : 'bg-slate-50 dark:bg-[#2C2C2E] border-slate-200 dark:border-white/10 text-slate-600 dark:text-slate-300'
              }`}
            >
              <Bell className="w-3.5 h-3.5" />
              <span>Clock Alarm {setClockAlarm ? 'On' : 'Off'}</span>
            </button>
            <button
              type="button"
              onClick={() => setAddToCalendar((v) => !v)}
              className={`h-9 px-3 rounded-xl border text-xs font-semibold flex items-center justify-center gap-1.5 ${
                addToCalendar
                  ? 'bg-sky-50 dark:bg-sky-950/40 border-sky-400 text-sky-700 dark:text-sky-300'
                  : 'bg-slate-50 dark:bg-[#2C2C2E] border-slate-200 dark:border-white/10 text-slate-600 dark:text-slate-300'
              }`}
            >
              <Calendar className="w-3.5 h-3.5" />
              <span>Calendar {addToCalendar ? 'On' : 'Off'}</span>
            </button>
          </div>
        )}

        {/* Action Buttons */}
        <div className="flex items-center gap-2 pt-1">
          <button
            type="button"
            onClick={onDiscard}
            className="flex-1 h-11 rounded-xl bg-slate-100 dark:bg-[#2C2C2E] text-sm font-semibold text-slate-700 dark:text-slate-200"
          >
            Discard
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            className="flex-[2] h-11 rounded-xl bg-orange-600 hover:bg-orange-700 text-white text-sm font-bold shadow-lg shadow-orange-600/20"
          >
            Confirm &amp; Save Plan
          </button>
        </div>
      </div>
    </div>
  );
};
