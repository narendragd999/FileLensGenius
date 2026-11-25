import React, { useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Camera,
  Check,
  CheckSquare,
  ChevronLeft,
  Copy,
  Crop,
  Download,
  FileOutput,
  FilePlus2,
  GripVertical,
  Minimize2,
  Redo2,
  RotateCcw,
  RotateCw,
  Sliders,
  Trash2,
  Undo2,
  Upload,
  X,
} from 'lucide-react';
import {
  DocumentPage,
  FULL_QUAD,
  PdfCompressPreset,
  ScanDocument,
  ScanFilterId,
} from '../types/filelens';
import { SCAN_FILTERS } from '../data/seedData';
import { formatBytes } from '../utils/formatters';
import { compressDocumentPagesReal, exportDocumentAsPdf } from '../utils/pdfExport';
import { runRealOcrOnImage } from '../utils/smartIndexer';
import { PageCanvasPreview } from './PageCanvasPreview';
import { PerspectiveCropModal } from './PerspectiveCropModal';

interface PageOrganizerModalProps {
  document: ScanDocument;
  allDocuments: ScanDocument[];
  onUpdateDocument: (updated: ScanDocument) => void;
  onExtractNewDocument: (newDoc: ScanDocument) => void;
  onLaunchAppendScan: () => void;
  onClose: () => void;
  onToast: (message: string) => void;
}

const COMPRESS_PRESETS: {
  id: PdfCompressPreset;
  label: string;
  subtitle: string;
  ratio: number;
  qualityPreset: 'compact' | 'balanced' | 'high';
}[] = [
  {
    id: 'email_small',
    label: 'Email Ready',
    subtitle: 'Ultra-small · 1280px · 62% quality',
    ratio: 0.32,
    qualityPreset: 'compact',
  },
  {
    id: 'balanced',
    label: 'Balanced',
    subtitle: 'Sharp text & photos · 1700px · 76% quality',
    ratio: 0.52,
    qualityPreset: 'balanced',
  },
  {
    id: 'print_high',
    label: 'Print High',
    subtitle: 'Crisp print detail · 2200px · 86% quality',
    ratio: 0.78,
    qualityPreset: 'high',
  },
];

export const PageOrganizerModal: React.FC<PageOrganizerModalProps> = ({
  document: doc,
  allDocuments,
  onUpdateDocument,
  onExtractNewDocument,
  onLaunchAppendScan,
  onClose,
  onToast,
}) => {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [undoStack, setUndoStack] = useState<DocumentPage[][]>([]);
  const [redoStack, setRedoStack] = useState<DocumentPage[][]>([]);
  const [editingPageIdx, setEditingPageIdx] = useState<number | null>(null);
  const [showFilterSheet, setShowFilterSheet] = useState(false);
  const [showMergeSheet, setShowMergeSheet] = useState(false);
  const [showCompressSheet, setShowCompressSheet] = useState(false);
  const [draggedIdx, setDraggedIdx] = useState<number | null>(null);
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);
  const [isExporting, setIsExporting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const selectedIndices = useMemo(() => {
    return doc.pages
      .map((p, idx) => (selectedIds.has(p.id) ? idx : -1))
      .filter((idx) => idx !== -1);
  }, [doc.pages, selectedIds]);

  const singleSelectedIdx = selectedIndices.length === 1 ? selectedIndices[0] : null;
  const otherDocs = useMemo(
    () => allDocuments.filter((d) => d.id !== doc.id),
    [allDocuments, doc.id]
  );

  const commitPages = (nextPages: DocumentPage[], nextSizeBytes?: number, extra?: Partial<ScanDocument>) => {
    setUndoStack((prev) => [...prev.slice(-14), doc.pages]);
    setRedoStack([]);
    onUpdateDocument({
      ...doc,
      ...extra,
      pages: nextPages,
      sizeBytes: nextSizeBytes ?? Math.max(120_000, Math.round((doc.sizeBytes / Math.max(1, doc.pages.length)) * nextPages.length)),
      updatedAt: new Date().toISOString(),
    });
  };

  const handleUndo = () => {
    if (undoStack.length === 0) return;
    const previous = undoStack[undoStack.length - 1];
    setRedoStack((r) => [...r, doc.pages]);
    setUndoStack((u) => u.slice(0, -1));
    onUpdateDocument({ ...doc, pages: previous, updatedAt: new Date().toISOString() });
    onToast('Undid last page change');
  };

  const handleRedo = () => {
    if (redoStack.length === 0) return;
    const next = redoStack[redoStack.length - 1];
    setUndoStack((u) => [...u, doc.pages]);
    setRedoStack((r) => r.slice(0, -1));
    onUpdateDocument({ ...doc, pages: next, updatedAt: new Date().toISOString() });
    onToast('Redid page change');
  };

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (selectedIds.size === doc.pages.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(doc.pages.map((p) => p.id)));
    }
  };

  const rotatePages = (targetIds: Set<string>, delta: -90 | 90) => {
    if (targetIds.size === 0) return;
    const next = doc.pages.map((p) => {
      if (!targetIds.has(p.id)) return p;
      const rot = (((p.rotation + delta) % 360) + 360) % 360;
      return { ...p, rotation: rot as 0 | 90 | 180 | 270 };
    });
    commitPages(next);
    onToast(`Rotated ${targetIds.size} page${targetIds.size > 1 ? 's' : ''}`);
  };

  const moveSelected = (direction: -1 | 1) => {
    if (singleSelectedIdx === null) return;
    const target = singleSelectedIdx + direction;
    if (target < 0 || target >= doc.pages.length) return;
    const next = [...doc.pages];
    const [moved] = next.splice(singleSelectedIdx, 1);
    next.splice(target, 0, moved);
    commitPages(next);
  };

  const handleDropReorder = (fromIdx: number, toIdx: number) => {
    if (fromIdx === toIdx || fromIdx < 0 || toIdx < 0) return;
    const next = [...doc.pages];
    const [moved] = next.splice(fromIdx, 1);
    next.splice(toIdx, 0, moved);
    commitPages(next);
    onToast(`Moved page ${fromIdx + 1} to position ${toIdx + 1}`);
  };

  const duplicateSelected = () => {
    if (selectedIndices.length === 0) return;
    const clones: DocumentPage[] = [];
    const next = [...doc.pages];
    // Insert clones right after last selected index
    const insertAt = Math.max(...selectedIndices) + 1;
    selectedIndices.forEach((idx, offset) => {
      const src = doc.pages[idx];
      clones.push({
        ...src,
        id: `pg-dup-${Date.now()}-${offset}`,
        signatures: src.signatures.map((s) => ({ ...s })),
      });
    });
    next.splice(insertAt, 0, ...clones);
    commitPages(next);
    onToast(`Duplicated ${clones.length} page${clones.length > 1 ? 's' : ''}`);
  };

  const deleteSelected = () => {
    if (selectedIds.size === 0) return;
    if (selectedIds.size >= doc.pages.length) {
      onToast('A document must keep at least 1 page');
      return;
    }
    const next = doc.pages.filter((p) => !selectedIds.has(p.id));
    const removedCount = selectedIds.size;
    setSelectedIds(new Set());
    commitPages(next);
    onToast(`Removed ${removedCount} page${removedCount > 1 ? 's' : ''} (Undo available)`);
  };

  const extractSelectedToNewPdf = () => {
    if (selectedIndices.length === 0) return;
    const extractedPages = selectedIndices.map((idx, offset) => ({
      ...doc.pages[idx],
      id: `pg-ext-${Date.now()}-${offset}`,
    }));
    const newDoc: ScanDocument = {
      ...doc,
      id: `doc-extract-${Date.now()}`,
      title: `${doc.title} (Extracted P${selectedIndices.map((i) => i + 1).join(',')})`,
      pages: extractedPages,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      sizeBytes: Math.max(140_000, Math.round((doc.sizeBytes / Math.max(1, doc.pages.length)) * extractedPages.length)),
    };
    onExtractNewDocument(newDoc);
    setSelectedIds(new Set());
    onToast(`Extracted ${extractedPages.length} page(s) into a new PDF`);
  };

  const applyFilterBatch = (filterId: ScanFilterId, applyToAll: boolean) => {
    const next = doc.pages.map((p) => {
      if (applyToAll || selectedIds.has(p.id)) {
        return { ...p, filter: filterId };
      }
      return p;
    });
    commitPages(next);
    setShowFilterSheet(false);
    const label = SCAN_FILTERS.find((f) => f.id === filterId)?.label ?? filterId;
    onToast(`Applied ${label} to ${applyToAll ? 'all pages' : `${selectedIds.size} page(s)`}`);
  };

  const handleMergeDocument = (sourceDoc: ScanDocument) => {
    const mergedPages = sourceDoc.pages.map((p, idx) => ({
      ...p,
      id: `pg-merge-${Date.now()}-${idx}`,
    }));
    commitPages([...doc.pages, ...mergedPages], doc.sizeBytes + sourceDoc.sizeBytes);
    setShowMergeSheet(false);
    onToast(`Merged ${mergedPages.length} page(s) from "${sourceDoc.title}"`);
  };

  const handleCompressPdf = async (preset: (typeof COMPRESS_PRESETS)[number]) => {
    setIsExporting(true);
    try {
      const { updatedDoc, savedBytes, didCompress } = await compressDocumentPagesReal(doc, preset.id);
      setShowCompressSheet(false);
      if (didCompress) {
        commitPages(updatedDoc.pages, updatedDoc.sizeBytes, {
          qualityPreset: updatedDoc.qualityPreset,
        });
        onToast(`Compressed with ${preset.label} · Saved ${formatBytes(savedBytes)}`);
      } else {
        onToast('Pages are already optimally compressed (<8% savings)');
      }
    } catch {
      onToast('Compression failed on this document');
    } finally {
      setIsExporting(false);
    }
  };

  const handleImportImageFiles = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    const readers = Array.from(files).map(
      (file, idx) =>
        new Promise<DocumentPage>((resolve) => {
          const reader = new FileReader();
          reader.onload = async () => {
            const dataUrl = String(reader.result);
            const ocrText = await runRealOcrOnImage(dataUrl).catch(() => '');
            resolve({
              id: `pg-imp-${Date.now()}-${idx}`,
              imageUrl: dataUrl,
              rotation: 0,
              filter: 'magic',
              quad: FULL_QUAD,
              brightness: 1,
              contrast: 1,
              ocrText: ocrText || `Imported page ${file.name}`,
              signatures: [],
            });
          };
          reader.readAsDataURL(file);
        })
    );
    Promise.all(readers).then((newPages) => {
      commitPages([...doc.pages, ...newPages]);
      onToast(`Appended ${newPages.length} OCR-indexed page${newPages.length > 1 ? 's' : ''}`);
    });
    e.target.value = '';
  };

  const handleExportPdf = async () => {
    setIsExporting(true);
    try {
      await exportDocumentAsPdf(doc);
      onToast(`Exported "${doc.title}.pdf" (${doc.pages.length} pages)`);
    } catch {
      onToast('Could not generate PDF export');
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 h-[100dvh] max-h-[100dvh] w-full overflow-hidden z-40 flex flex-col bg-[#F2F2F7] dark:bg-[#000000] text-slate-900 dark:text-slate-100"
      role="dialog"
      aria-modal="true"
      aria-label="Organize Pages"
    >
      {/* Top iOS Navigation Bar */}
      <header className="shrink-0 z-20 pt-safe bg-white/90 dark:bg-[#1C1C1E]/90 backdrop-blur-md border-b border-slate-200/80 dark:border-white/10 px-3 sm:px-6 min-h-[52px] py-1.5 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <button
            onClick={onClose}
            className="min-h-[44px] px-2 -ml-2 flex items-center gap-1 text-orange-600 dark:text-orange-400 font-semibold text-sm hover:opacity-80 transition-opacity shrink-0"
          >
            <ChevronLeft className="w-5 h-5" />
            <span>Done</span>
          </button>
          <div className="min-w-0 hidden sm:block border-l border-slate-200 dark:border-white/10 pl-3">
            <h1 className="text-sm font-bold truncate">{doc.title}</h1>
            <p className="text-xs text-slate-500 dark:text-slate-400 font-mono tabular-nums">
              {doc.pages.length} {doc.pages.length === 1 ? 'page' : 'pages'} · {formatBytes(doc.sizeBytes)}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
          <button
            onClick={handleUndo}
            disabled={undoStack.length === 0}
            title="Undo"
            className="min-h-[40px] min-w-[40px] rounded-xl flex items-center justify-center text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-white/10 disabled:opacity-30 transition-colors"
          >
            <Undo2 className="w-4 h-4" />
          </button>
          <button
            onClick={handleRedo}
            disabled={redoStack.length === 0}
            title="Redo"
            className="min-h-[40px] min-w-[40px] rounded-xl flex items-center justify-center text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-white/10 disabled:opacity-30 transition-colors"
          >
            <Redo2 className="w-4 h-4" />
          </button>
          <button
            onClick={toggleSelectAll}
            className="min-h-[40px] px-3 rounded-xl text-xs font-semibold text-slate-700 dark:text-slate-200 bg-slate-100 dark:bg-white/10 hover:bg-slate-200 dark:hover:bg-white/15 transition-colors flex items-center gap-1.5 whitespace-nowrap"
          >
            <CheckSquare className="w-3.5 h-3.5 text-orange-600 dark:text-orange-400" />
            <span>{selectedIds.size === doc.pages.length ? 'Clear' : 'Select All'}</span>
          </button>
          <button
            onClick={handleExportPdf}
            disabled={isExporting}
            className="min-h-[40px] px-3.5 rounded-xl bg-orange-600 hover:bg-orange-700 text-white text-xs font-semibold flex items-center gap-1.5 transition-colors whitespace-nowrap disabled:opacity-60"
          >
            <Download className="w-3.5 h-3.5" />
            <span>{isExporting ? 'Exporting…' : 'Export PDF'}</span>
          </button>
        </div>
      </header>

      {/* Secondary Quick Insert & Status Strip */}
      <div className="bg-white/60 dark:bg-[#1C1C1E]/60 border-b border-slate-200/70 dark:border-white/8 px-4 sm:px-6 py-2.5 flex items-center justify-between gap-3 flex-wrap shrink-0">
        <div className="text-xs text-slate-600 dark:text-slate-400">
          {selectedIds.size > 0 ? (
            <span className="font-semibold text-orange-600 dark:text-orange-400">
              {selectedIds.size} of {doc.pages.length} selected
            </span>
          ) : (
            <span>Drag sheets to reorder · Tap to select · Double-tap to crop & enhance</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={onLaunchAppendScan}
            className="min-h-[36px] px-3 rounded-lg text-xs font-semibold bg-white dark:bg-[#2C2C2E] border border-slate-200 dark:border-white/10 hover:border-orange-400 text-slate-800 dark:text-slate-100 flex items-center gap-1.5 transition-colors whitespace-nowrap"
          >
            <Camera className="w-3.5 h-3.5 text-orange-600 dark:text-orange-400" />
            <span>Scan More</span>
          </button>
          <button
            onClick={() => fileInputRef.current?.click()}
            className="min-h-[36px] px-3 rounded-lg text-xs font-semibold bg-white dark:bg-[#2C2C2E] border border-slate-200 dark:border-white/10 hover:border-orange-400 text-slate-800 dark:text-slate-100 flex items-center gap-1.5 transition-colors whitespace-nowrap"
          >
            <Upload className="w-3.5 h-3.5 text-orange-600 dark:text-orange-400" />
            <span>Add Photos</span>
          </button>
          <button
            onClick={() => setShowMergeSheet(true)}
            className="min-h-[36px] px-3 rounded-lg text-xs font-semibold bg-white dark:bg-[#2C2C2E] border border-slate-200 dark:border-white/10 hover:border-orange-400 text-slate-800 dark:text-slate-100 flex items-center gap-1.5 transition-colors whitespace-nowrap"
          >
            <FilePlus2 className="w-3.5 h-3.5 text-orange-600 dark:text-orange-400" />
            <span>Merge PDF</span>
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={handleImportImageFiles}
          />
        </div>
      </div>

      {/* Main Draggable Paper Grid */}
      <div className="flex-1 overflow-y-auto px-4 sm:px-6 py-6">
        <div className="max-w-6xl mx-auto grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4 sm:gap-5">
          {doc.pages.map((page, idx) => {
            const isSelected = selectedIds.has(page.id);
            const isDropTarget = dragOverIdx === idx && draggedIdx !== null && draggedIdx !== idx;
            const filterMeta = SCAN_FILTERS.find((f) => f.id === page.filter);

            return (
              <div
                key={page.id}
                draggable
                onDragStart={() => setDraggedIdx(idx)}
                onDragOver={(e) => {
                  e.preventDefault();
                  if (dragOverIdx !== idx) setDragOverIdx(idx);
                }}
                onDragLeave={() => {
                  if (dragOverIdx === idx) setDragOverIdx(null);
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  if (draggedIdx !== null) {
                    handleDropReorder(draggedIdx, idx);
                  }
                  setDraggedIdx(null);
                  setDragOverIdx(null);
                }}
                onDragEnd={() => {
                  setDraggedIdx(null);
                  setDragOverIdx(null);
                }}
                onClick={() => toggleSelect(page.id)}
                onDoubleClick={() => setEditingPageIdx(idx)}
                className={`group relative flex flex-col rounded-2xl p-2.5 transition-all cursor-pointer select-none ${
                  isSelected
                    ? 'bg-orange-50/90 dark:bg-orange-950/35 ring-2 ring-orange-600 dark:ring-orange-500'
                    : 'bg-white dark:bg-[#1C1C1E] border border-slate-200/80 dark:border-white/10 hover:border-slate-300 dark:hover:border-white/20'
                } ${isDropTarget ? 'ring-2 ring-dashed ring-orange-500 scale-[1.02]' : ''} ${
                  draggedIdx === idx ? 'opacity-45' : ''
                }`}
              >
                {/* Top Controls Row (Drag Handle + Check Circle) */}
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-1 text-slate-400 dark:text-slate-500">
                    <GripVertical className="w-4 h-4 cursor-grab" />
                    <span className="text-xs font-mono font-semibold tabular-nums text-slate-700 dark:text-slate-300">
                      P{idx + 1}
                    </span>
                  </div>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setEditingPageIdx(idx);
                      }}
                      title="Crop & enhance page"
                      className="w-8 h-8 rounded-lg flex items-center justify-center text-slate-500 hover:text-orange-600 hover:bg-slate-100 dark:hover:bg-white/10 transition-colors"
                    >
                      <Crop className="w-3.5 h-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        rotatePages(new Set([page.id]), 90);
                      }}
                      title="Quick rotate 90° right"
                      className="w-8 h-8 rounded-lg flex items-center justify-center text-slate-500 hover:text-orange-600 hover:bg-slate-100 dark:hover:bg-white/10 transition-colors"
                    >
                      <RotateCw className="w-3.5 h-3.5" />
                    </button>
                    <span
                      className={`w-6 h-6 rounded-full flex items-center justify-center border transition-colors ${
                        isSelected
                          ? 'bg-orange-600 border-orange-600 text-white'
                          : 'border-slate-300 dark:border-slate-600 bg-transparent'
                      }`}
                    >
                      {isSelected && <Check className="w-3.5 h-3.5 stroke-[2.5]" />}
                    </span>
                  </div>
                </div>

                {/* Uncropped Paper Sheet Preview */}
                <div className="relative aspect-[3/4] w-full rounded-xl bg-slate-100 dark:bg-[#121214] p-2 flex items-center justify-center overflow-hidden">
                  <PageCanvasPreview
                    page={page}
                    watermark={doc.watermark}
                    className="w-full h-full rounded shadow-sm border border-slate-200/80"
                  />
                </div>

                {/* Quiet Unboxed Footer Metadata */}
                <div className="mt-2 px-0.5 flex items-center justify-between text-[11px] text-slate-500 dark:text-slate-400">
                  <span>{filterMeta?.shortLabel ?? 'Color'}</span>
                  <span className="font-mono tabular-nums">
                    {page.rotation > 0 ? `${page.rotation}°` : '0°'}
                  </span>
                </div>
              </div>
            );
          })}

          {/* Append Page Tile (Genius Scan Add Page Affordance) */}
          <button
            type="button"
            onClick={onLaunchAppendScan}
            className="min-h-[220px] rounded-2xl border-2 border-dashed border-slate-300 dark:border-white/15 hover:border-orange-500 dark:hover:border-orange-400 bg-white/40 dark:bg-white/[0.02] flex flex-col items-center justify-center gap-2.5 text-slate-500 dark:text-slate-400 hover:text-orange-600 dark:hover:text-orange-400 transition-colors p-4"
          >
            <div className="w-11 h-11 rounded-2xl bg-orange-50 dark:bg-orange-950/40 flex items-center justify-center text-orange-600 dark:text-orange-400">
              <Camera className="w-5 h-5" />
            </div>
            <span className="text-sm font-semibold">Scan New Page</span>
            <span className="text-xs text-slate-400 dark:text-slate-500 text-center">
              Append directly to this PDF
            </span>
          </button>
        </div>
      </div>

      {/* Bottom Page Operations Dock (Thumb-Zone Ergonomic Bar) */}
      <footer className="sticky bottom-0 z-20 bg-white/95 dark:bg-[#1C1C1E]/95 backdrop-blur-md border-t border-slate-200 dark:border-white/10 px-3 sm:px-6 py-2.5 pb-safe shrink-0">
        <div className="max-w-6xl mx-auto flex items-center justify-start sm:justify-center gap-1.5 overflow-x-auto">
          <OrganizerActionButton
            icon={<RotateCcw className="w-4 h-4" />}
            label="Left"
            disabled={selectedIds.size === 0}
            onClick={() => rotatePages(selectedIds, -90)}
          />
          <OrganizerActionButton
            icon={<RotateCw className="w-4 h-4" />}
            label="Right"
            disabled={selectedIds.size === 0}
            onClick={() => rotatePages(selectedIds, 90)}
          />
          <OrganizerActionButton
            icon={<ArrowLeft className="w-4 h-4" />}
            label="Earlier"
            disabled={singleSelectedIdx === null || singleSelectedIdx === 0}
            onClick={() => moveSelected(-1)}
          />
          <OrganizerActionButton
            icon={<ArrowRight className="w-4 h-4" />}
            label="Later"
            disabled={singleSelectedIdx === null || singleSelectedIdx >= doc.pages.length - 1}
            onClick={() => moveSelected(1)}
          />
          <OrganizerActionButton
            icon={<Crop className="w-4 h-4" />}
            label="Crop"
            disabled={singleSelectedIdx === null}
            onClick={() => {
              if (singleSelectedIdx !== null) setEditingPageIdx(singleSelectedIdx);
            }}
          />
          <OrganizerActionButton
            icon={<Sliders className="w-4 h-4" />}
            label="Filter"
            disabled={false}
            onClick={() => setShowFilterSheet(true)}
          />
          <OrganizerActionButton
            icon={<Copy className="w-4 h-4" />}
            label="Duplicate"
            disabled={selectedIds.size === 0}
            onClick={duplicateSelected}
          />
          <OrganizerActionButton
            icon={<FileOutput className="w-4 h-4" />}
            label="Extract"
            disabled={selectedIds.size === 0}
            onClick={extractSelectedToNewPdf}
          />
          <OrganizerActionButton
            icon={<Minimize2 className="w-4 h-4" />}
            label="Compress"
            disabled={false}
            onClick={() => setShowCompressSheet(true)}
          />
          <OrganizerActionButton
            icon={<Trash2 className="w-4 h-4" />}
            label="Delete"
            danger
            disabled={selectedIds.size === 0}
            onClick={deleteSelected}
          />
        </div>
      </footer>

      {/* Page Crop & Filter Editor Modal */}
      {editingPageIdx !== null && doc.pages[editingPageIdx] && (
        <PerspectiveCropModal
          page={doc.pages[editingPageIdx]}
          pageNumber={editingPageIdx + 1}
          onClose={() => setEditingPageIdx(null)}
          onSave={(updatedPage) => {
            const next = doc.pages.map((p, idx) => (idx === editingPageIdx ? updatedPage : p));
            commitPages(next);
            setEditingPageIdx(null);
            onToast(`Updated Page ${editingPageIdx + 1}`);
          }}
        />
      )}

      {/* Batch Filter Bottom Sheet */}
      {showFilterSheet && (
        <div
          className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm flex items-end sm:items-center justify-center p-0 sm:p-4"
          onClick={() => setShowFilterSheet(false)}
        >
          <div
            className="w-full sm:max-w-md bg-white dark:bg-[#1C1C1E] rounded-t-3xl sm:rounded-3xl p-5 pb-safe space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="w-10 h-1.5 bg-slate-300 dark:bg-slate-700 rounded-full mx-auto sm:hidden" />
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-base font-bold">Apply Scan Filter</h3>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  {selectedIds.size > 0
                    ? `Applying to ${selectedIds.size} selected page(s) or entire document`
                    : 'Choose an optical cleanup filter for all pages'}
                </p>
              </div>
              <button
                onClick={() => setShowFilterSheet(false)}
                className="w-9 h-9 rounded-full flex items-center justify-center hover:bg-slate-100 dark:hover:bg-white/10"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="space-y-2">
              {SCAN_FILTERS.map((f) => (
                <div
                  key={f.id}
                  className="flex items-center justify-between p-3 rounded-2xl bg-slate-50 dark:bg-[#2C2C2E] border border-slate-200/70 dark:border-white/5 gap-3"
                >
                  <div>
                    <div className="text-sm font-semibold">{f.label}</div>
                    <div className="text-xs text-slate-500 dark:text-slate-400">{f.description}</div>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    {selectedIds.size > 0 && (
                      <button
                        onClick={() => applyFilterBatch(f.id, false)}
                        className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-orange-600 text-white hover:bg-orange-700 whitespace-nowrap"
                      >
                        Selected
                      </button>
                    )}
                    <button
                      onClick={() => applyFilterBatch(f.id, true)}
                      className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-slate-200 dark:bg-white/10 hover:bg-slate-300 dark:hover:bg-white/20 whitespace-nowrap"
                    >
                      All Pages
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Merge PDF Bottom Sheet */}
      {showMergeSheet && (
        <div
          className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm flex items-end sm:items-center justify-center p-0 sm:p-4"
          onClick={() => setShowMergeSheet(false)}
        >
          <div
            className="w-full sm:max-w-md bg-white dark:bg-[#1C1C1E] rounded-t-3xl sm:rounded-3xl p-5 pb-safe space-y-4 max-h-[80vh] flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="w-10 h-1.5 bg-slate-300 dark:bg-slate-700 rounded-full mx-auto sm:hidden" />
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-base font-bold">Merge Another PDF</h3>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  Append all pages from another document into this scan
                </p>
              </div>
              <button
                onClick={() => setShowMergeSheet(false)}
                className="w-9 h-9 rounded-full flex items-center justify-center hover:bg-slate-100 dark:hover:bg-white/10"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="overflow-y-auto space-y-2 pr-1">
              {otherDocs.length === 0 ? (
                <p className="text-sm text-slate-500 text-center py-8">
                  No other documents available to merge.
                </p>
              ) : (
                otherDocs.map((other) => (
                  <button
                    key={other.id}
                    onClick={() => handleMergeDocument(other)}
                    className="w-full flex items-center gap-3 p-3 rounded-2xl bg-slate-50 dark:bg-[#2C2C2E] hover:bg-orange-50 dark:hover:bg-orange-950/30 border border-slate-200/70 dark:border-white/5 text-left transition-colors"
                  >
                    <div className="w-11 h-14 rounded-lg overflow-hidden bg-white border border-slate-200 shrink-0">
                      {other.pages[0] && (
                        <PageCanvasPreview page={other.pages[0]} className="w-full h-full" />
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-semibold truncate">{other.title}</div>
                      <div className="text-xs text-slate-500 dark:text-slate-400 font-mono tabular-nums mt-0.5">
                        +{other.pages.length} {other.pages.length === 1 ? 'page' : 'pages'} · {formatBytes(other.sizeBytes)}
                      </div>
                    </div>
                    <span className="text-xs font-semibold text-orange-600 dark:text-orange-400 shrink-0">
                      Merge
                    </span>
                  </button>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {/* Compress PDF Bottom Sheet */}
      {showCompressSheet && (
        <div
          className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm flex items-end sm:items-center justify-center p-0 sm:p-4"
          onClick={() => setShowCompressSheet(false)}
        >
          <div
            className="w-full sm:max-w-md bg-white dark:bg-[#1C1C1E] rounded-t-3xl sm:rounded-3xl p-5 pb-safe space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="w-10 h-1.5 bg-slate-300 dark:bg-slate-700 rounded-full mx-auto sm:hidden" />
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-base font-bold">Compress PDF</h3>
                <p className="text-xs text-slate-500 dark:text-slate-400 font-mono tabular-nums">
                  Current size: {formatBytes(doc.sizeBytes)}
                </p>
              </div>
              <button
                onClick={() => setShowCompressSheet(false)}
                className="w-9 h-9 rounded-full flex items-center justify-center hover:bg-slate-100 dark:hover:bg-white/10"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="space-y-2.5">
              {COMPRESS_PRESETS.map((preset) => {
                const estBytes = Math.max(85_000, Math.round(doc.sizeBytes * preset.ratio));
                return (
                  <button
                    key={preset.id}
                    onClick={() => handleCompressPdf(preset)}
                    className="w-full p-3.5 rounded-2xl bg-slate-50 dark:bg-[#2C2C2E] hover:bg-orange-50 dark:hover:bg-orange-950/30 border border-slate-200/70 dark:border-white/5 flex items-center justify-between gap-3 text-left transition-colors"
                  >
                    <div>
                      <div className="text-sm font-semibold">{preset.label}</div>
                      <div className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                        {preset.subtitle}
                      </div>
                    </div>
                    <div className="text-right shrink-0 font-mono tabular-nums">
                      <div className="text-xs font-bold text-orange-600 dark:text-orange-400">
                        ~{formatBytes(estBytes)}
                      </div>
                      <div className="text-[11px] text-emerald-600 dark:text-emerald-400">
                        -{Math.round((1 - preset.ratio) * 100)}%
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

interface OrganizerActionButtonProps {
  icon: React.ReactNode;
  label: string;
  disabled?: boolean;
  danger?: boolean;
  onClick: () => void;
}

const OrganizerActionButton: React.FC<OrganizerActionButtonProps> = ({
  icon,
  label,
  disabled,
  danger,
  onClick,
}) => (
  <button
    type="button"
    disabled={disabled}
    onClick={onClick}
    className={`min-h-[48px] min-w-[60px] px-2.5 py-1.5 rounded-xl flex flex-col items-center justify-center gap-1 text-[11px] font-medium transition-colors shrink-0 disabled:opacity-35 ${
      danger
        ? 'text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30'
        : 'text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-white/10'
    }`}
  >
    {icon}
    <span className="whitespace-nowrap">{label}</span>
  </button>
);
