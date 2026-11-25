import React, { useEffect, useState } from 'react';
import { AlertCircle, CheckCircle2, Info, TriangleAlert, Undo2, X } from 'lucide-react';
import { SmartToastItem, ToastType } from '../types/filelens';

interface SmartToastHostProps {
  toast: SmartToastItem | null;
  onDismiss: () => void;
}

export function classifyToastType(message: string): ToastType {
  const m = message.toLowerCase();
  if (/(fail|error|unable|invalid|denied|cannot|corrupt)/.test(m)) return 'error';
  if (/(warn|cancel|skip|no |empty|limit|required|lock)/.test(m)) return 'warning';
  if (/(saved|exported|indexed|compressed|done|updated|created|copied|restored|added|merged|masked|deleted)/.test(m)) {
    return 'success';
  }
  return 'info';
}

export const SmartToastHost: React.FC<SmartToastHostProps> = ({ toast, onDismiss }) => {
  const [progress, setProgress] = useState(100);

  useEffect(() => {
    if (!toast) return;
    setProgress(100);
    const start = Date.now();
    const interval = window.setInterval(() => {
      const elapsed = Date.now() - start;
      const pct = Math.max(0, 100 - (elapsed / toast.durationMs) * 100);
      setProgress(pct);
      if (pct <= 0) {
        window.clearInterval(interval);
        onDismiss();
      }
    }, 50);
    return () => window.clearInterval(interval);
  }, [toast, onDismiss]);

  if (!toast) return null;

  const palette: Record<ToastType, { bg: string; icon: React.ReactNode; bar: string }> = {
    success: {
      bg: 'bg-slate-900/95 dark:bg-emerald-950/95 border-emerald-500/40 text-white',
      icon: <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />,
      bar: 'bg-emerald-400',
    },
    info: {
      bg: 'bg-slate-900/95 dark:bg-slate-800/95 border-slate-700 text-white',
      icon: <Info className="w-4 h-4 text-sky-400 shrink-0" />,
      bar: 'bg-sky-400',
    },
    warning: {
      bg: 'bg-amber-950/95 border-amber-500/40 text-amber-50',
      icon: <TriangleAlert className="w-4 h-4 text-amber-400 shrink-0" />,
      bar: 'bg-amber-400',
    },
    error: {
      bg: 'bg-rose-950/95 border-rose-500/40 text-rose-50',
      icon: <AlertCircle className="w-4 h-4 text-rose-400 shrink-0" />,
      bar: 'bg-rose-400',
    },
  };

  const style = palette[toast.type];

  return (
    <div className="fixed top-4 left-1/2 -translate-x-1/2 z-50 w-[min(92vw,420px)] pointer-events-auto animate-in fade-in slide-in-from-top-3 duration-200">
      <div
        className={`relative overflow-hidden rounded-2xl border shadow-2xl backdrop-blur-md px-3.5 py-2.5 flex items-center gap-2.5 ${style.bg}`}
      >
        {style.icon}
        <span className="text-xs font-medium flex-1 leading-snug">{toast.message}</span>
        {toast.onUndo && (
          <button
            type="button"
            onClick={() => {
              toast.onUndo?.();
              onDismiss();
            }}
            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-white/15 hover:bg-white/25 text-xs font-semibold text-white shrink-0 transition-colors"
          >
            <Undo2 className="w-3 h-3" />
            {toast.undoLabel || 'Undo'}
          </button>
        )}
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss notification"
          className="p-1 rounded-lg hover:bg-white/10 text-white/70 hover:text-white shrink-0"
        >
          <X className="w-3.5 h-3.5" />
        </button>
        <div
          className={`absolute bottom-0 left-0 h-0.5 transition-[width] duration-75 ${style.bar}`}
          style={{ width: `${progress}%` }}
        />
      </div>
    </div>
  );
};
