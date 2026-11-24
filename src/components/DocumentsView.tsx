import React, { useMemo, useRef, useState } from 'react';
import {
  Bookmark,
  Camera,
  Check,
  CheckSquare,
  Download,
  FilePlus2,
  Folder,
  FolderPlus,
  Grid2X2,
  IdCard,
  Layers,
  List,
  Lock,
  MoreHorizontal,
  Search,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { DocFolder, FULL_QUAD, ScanDocument, ScanMode } from '../types/filelens';
import { formatBytes, formatShortDate } from '../utils/formatters';
import { exportDocumentAsPdf } from '../utils/pdfExport';
import { PageCanvasPreview } from './PageCanvasPreview';

interface DocumentsViewProps {
  documents: ScanDocument[];
  folders: DocFolder[];
  selectedFolderId: string;
  onSelectFolder: (folderId: string) => void;
  onCreateFolder: (name: string) => void;
  onOpenScanner: (mode: ScanMode) => void;
  onImportFilesAsDocument: (files: FileList) => void;
  onOpenViewer: (docId: string) => void;
  onOpenOrganizer: (docId: string) => void;
  onToggleBookmark: (docId: string) => void;
  onRenameDocument: (docId: string, newTitle: string) => void;
  onMoveDocumentsToFolder: (docIds: string[], folderId: string) => void;
  onMergeDocuments: (docIds: string[]) => void;
  onDeleteDocuments: (docIds: string[]) => void;
  onToast: (message: string) => void;
}

type SortKey = 'updated' | 'title' | 'pages' | 'size';

export const DocumentsView: React.FC<DocumentsViewProps> = ({
  documents,
  folders,
  selectedFolderId,
  onSelectFolder,
  onCreateFolder,
  onOpenScanner,
  onImportFilesAsDocument,
  onOpenViewer,
  onOpenOrganizer,
  onToggleBookmark,
  onRenameDocument,
  onMoveDocumentsToFolder,
  onMergeDocuments,
  onDeleteDocuments,
  onToast,
}) => {
  const [viewMode, setViewMode] = useState<'list' | 'grid'>('list');
  const [sortBy, setSortBy] = useState<SortKey>('updated');
  const [filterQuery, setFilterQuery] = useState<string>('');
  const [selectedTag, setSelectedTag] = useState<string | null>(null);
  const [selectMode, setSelectMode] = useState<boolean>(false);
  const [selectedDocIds, setSelectedDocIds] = useState<Set<string>>(new Set());
  const [showNewFolderModal, setShowNewFolderModal] = useState<boolean>(false);
  const [newFolderName, setNewFolderName] = useState<string>('');
  const [actionSheetDoc, setActionSheetDoc] = useState<ScanDocument | null>(null);
  const [renameValue, setRenameValue] = useState<string>('');
  const [showMoveFolderModal, setShowMoveFolderModal] = useState<boolean>(false);
  const importInputRef = useRef<HTMLInputElement | null>(null);

  const allTags = useMemo(() => {
    const tagSet = new Set<string>();
    documents.forEach((d) => d.tags.forEach((t) => tagSet.add(t)));
    return Array.from(tagSet).sort();
  }, [documents]);

  const filteredDocs = useMemo(() => {
    const q = filterQuery.trim().toLowerCase();
    return documents
      .filter((d) => {
        if (selectedFolderId === 'bookmarked' && !d.isBookmarked) return false;
        if (selectedFolderId !== 'all' && selectedFolderId !== 'bookmarked' && d.folderId !== selectedFolderId) {
          return false;
        }
        if (selectedTag && !d.tags.includes(selectedTag)) return false;
        if (q) {
          const hitTitle = d.title.toLowerCase().includes(q);
          const hitTag = d.tags.some((t) => t.toLowerCase().includes(q));
          const hitOcr = d.pages.some((p) => p.ocrText.toLowerCase().includes(q));
          if (!hitTitle && !hitTag && !hitOcr) return false;
        }
        return true;
      })
      .sort((a, b) => {
        if (sortBy === 'title') return a.title.localeCompare(b.title);
        if (sortBy === 'pages') return b.pages.length - a.pages.length;
        if (sortBy === 'size') return b.sizeBytes - a.sizeBytes;
        return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
      });
  }, [documents, selectedFolderId, selectedTag, filterQuery, sortBy]);

  const toggleSelectDoc = (id: string) => {
    setSelectedDocIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleBatchMerge = () => {
    if (selectedDocIds.size < 2) {
      onToast('Select at least 2 documents to merge');
      return;
    }
    onMergeDocuments(Array.from(selectedDocIds));
    setSelectedDocIds(new Set());
    setSelectMode(false);
  };

  const handleBatchDelete = () => {
    if (selectedDocIds.size === 0) return;
    onDeleteDocuments(Array.from(selectedDocIds));
    setSelectedDocIds(new Set());
    setSelectMode(false);
  };

  const folderNameMap = useMemo(() => {
    const map: Record<string, string> = {};
    folders.forEach((f) => {
      map[f.id] = f.name;
    });
    return map;
  }, [folders]);

  return (
    <div className="space-y-5">
      {/* Header Row: iOS Large Title + Quick Scan Actions */}
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-slate-900 dark:text-white">
            Documents
          </h1>
          <p className="text-xs sm:text-sm text-slate-500 dark:text-slate-400 mt-0.5 font-mono tabular-nums">
            {filteredDocs.length} {filteredDocs.length === 1 ? 'document' : 'documents'} ·{' '}
            {documents.reduce((acc, d) => acc + d.pages.length, 0)} total pages
          </p>
        </div>

        {/* Primary Capture & Utility Strip */}
        <div className="flex items-center gap-2 flex-wrap">
          <button
            type="button"
            onClick={() => onOpenScanner('batch')}
            className="min-h-[42px] px-4 rounded-xl bg-orange-600 hover:bg-orange-700 text-white text-sm font-semibold flex items-center gap-2 transition-colors whitespace-nowrap"
          >
            <Camera className="w-4 h-4" />
            <span>Scan Document</span>
          </button>
          <button
            type="button"
            onClick={() => onOpenScanner('idcard')}
            className="min-h-[42px] px-3.5 rounded-xl bg-white dark:bg-[#1C1C1E] border border-slate-200 dark:border-white/10 hover:border-orange-400 text-slate-800 dark:text-slate-100 text-xs font-semibold flex items-center gap-1.5 transition-colors whitespace-nowrap"
          >
            <IdCard className="w-4 h-4 text-orange-600 dark:text-orange-400" />
            <span>2-in-1 ID</span>
          </button>
          <button
            type="button"
            onClick={() => importInputRef.current?.click()}
            className="min-h-[42px] px-3.5 rounded-xl bg-white dark:bg-[#1C1C1E] border border-slate-200 dark:border-white/10 hover:border-orange-400 text-slate-800 dark:text-slate-100 text-xs font-semibold flex items-center gap-1.5 transition-colors whitespace-nowrap"
          >
            <Upload className="w-4 h-4 text-orange-600 dark:text-orange-400" />
            <span>Import Photos</span>
          </button>
          <input
            ref={importInputRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={(e) => {
              if (e.target.files && e.target.files.length > 0) {
                onImportFilesAsDocument(e.target.files);
                e.target.value = '';
              }
            }}
          />
        </div>
      </div>

      {/* Folder Rail (Mobile Horizontal Scroll, synced with Desktop Sidebar) */}
      <div className="flex items-center gap-1.5 overflow-x-auto pb-1">
        <button
          type="button"
          onClick={() => onSelectFolder('all')}
          className={`min-h-[38px] px-3.5 rounded-xl text-xs font-semibold transition-colors whitespace-nowrap shrink-0 ${
            selectedFolderId === 'all'
              ? 'bg-slate-900 dark:bg-white text-white dark:text-slate-900'
              : 'bg-white dark:bg-[#1C1C1E] text-slate-600 dark:text-slate-300 border border-slate-200/80 dark:border-white/10'
          }`}
        >
          All Scans
        </button>
        <button
          type="button"
          onClick={() => onSelectFolder('bookmarked')}
          className={`min-h-[38px] px-3.5 rounded-xl text-xs font-semibold transition-colors whitespace-nowrap shrink-0 flex items-center gap-1.5 ${
            selectedFolderId === 'bookmarked'
              ? 'bg-slate-900 dark:bg-white text-white dark:text-slate-900'
              : 'bg-white dark:bg-[#1C1C1E] text-slate-600 dark:text-slate-300 border border-slate-200/80 dark:border-white/10'
          }`}
        >
          <Bookmark className="w-3.5 h-3.5" />
          <span>Starred</span>
        </button>
        {folders.map((folder) => (
          <button
            key={folder.id}
            type="button"
            onClick={() => onSelectFolder(folder.id)}
            className={`min-h-[38px] px-3.5 rounded-xl text-xs font-semibold transition-colors whitespace-nowrap shrink-0 flex items-center gap-1.5 ${
              selectedFolderId === folder.id
                ? 'bg-slate-900 dark:bg-white text-white dark:text-slate-900'
                : 'bg-white dark:bg-[#1C1C1E] text-slate-600 dark:text-slate-300 border border-slate-200/80 dark:border-white/10'
            }`}
          >
            <Folder className="w-3.5 h-3.5 opacity-75" />
            <span>{folder.name}</span>
          </button>
        ))}
        <button
          type="button"
          onClick={() => setShowNewFolderModal(true)}
          className="min-h-[38px] px-3 rounded-xl text-xs font-semibold text-orange-600 dark:text-orange-400 bg-orange-50 dark:bg-orange-950/30 hover:bg-orange-100 dark:hover:bg-orange-950/50 transition-colors whitespace-nowrap shrink-0 flex items-center gap-1"
        >
          <FolderPlus className="w-3.5 h-3.5" />
          <span>New Folder</span>
        </button>
      </div>

      {/* Search, Sort, View & Multi-Select Toolbar */}
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2.5">
        <div className="relative flex-1">
          <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={filterQuery}
            onChange={(e) => setFilterQuery(e.target.value)}
            placeholder="Filter documents by title, tag, or OCR text…"
            className="w-full h-11 pl-10 pr-9 rounded-xl bg-white dark:bg-[#1C1C1E] border border-slate-200/80 dark:border-white/10 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
          />
          {filterQuery && (
            <button
              type="button"
              onClick={() => setFilterQuery('')}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value as SortKey)}
            aria-label="Sort documents"
            className="h-11 px-3 rounded-xl bg-white dark:bg-[#1C1C1E] border border-slate-200/80 dark:border-white/10 text-xs font-semibold text-slate-700 dark:text-slate-200 focus:outline-none focus:ring-2 focus:ring-orange-500"
          >
            <option value="updated">Newest First</option>
            <option value="title">Name (A–Z)</option>
            <option value="pages">Most Pages</option>
            <option value="size">Largest File</option>
          </select>

          <div className="flex items-center p-1 rounded-xl bg-white dark:bg-[#1C1C1E] border border-slate-200/80 dark:border-white/10">
            <button
              type="button"
              onClick={() => setViewMode('list')}
              aria-label="List view"
              className={`w-9 h-9 rounded-lg flex items-center justify-center transition-colors ${
                viewMode === 'list'
                  ? 'bg-slate-100 dark:bg-[#2C2C2E] text-orange-600 dark:text-orange-400'
                  : 'text-slate-400 hover:text-slate-600'
              }`}
            >
              <List className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={() => setViewMode('grid')}
              aria-label="Grid view"
              className={`w-9 h-9 rounded-lg flex items-center justify-center transition-colors ${
                viewMode === 'grid'
                  ? 'bg-slate-100 dark:bg-[#2C2C2E] text-orange-600 dark:text-orange-400'
                  : 'text-slate-400 hover:text-slate-600'
              }`}
            >
              <Grid2X2 className="w-4 h-4" />
            </button>
          </div>

          <button
            type="button"
            onClick={() => {
              setSelectMode((v) => !v);
              setSelectedDocIds(new Set());
            }}
            className={`h-11 px-3.5 rounded-xl text-xs font-semibold flex items-center gap-1.5 transition-colors whitespace-nowrap ${
              selectMode
                ? 'bg-orange-600 text-white'
                : 'bg-white dark:bg-[#1C1C1E] border border-slate-200/80 dark:border-white/10 text-slate-700 dark:text-slate-200'
            }`}
          >
            <CheckSquare className="w-4 h-4" />
            <span>{selectMode ? 'Done' : 'Select'}</span>
          </button>
        </div>
      </div>

      {/* Interactive Tag Filter Controls */}
      {allTags.length > 0 && (
        <div className="flex items-center gap-1.5 overflow-x-auto">
          <button
            type="button"
            onClick={() => setSelectedTag(null)}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
              selectedTag === null
                ? 'bg-orange-600/12 text-orange-700 dark:text-orange-300 font-semibold'
                : 'text-slate-500 dark:text-slate-400 hover:bg-slate-200/60 dark:hover:bg-white/10'
            }`}
          >
            All Tags
          </button>
          {allTags.map((tag) => (
            <button
              key={tag}
              type="button"
              onClick={() => setSelectedTag(selectedTag === tag ? null : tag)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                selectedTag === tag
                  ? 'bg-orange-600/12 text-orange-700 dark:text-orange-300 font-semibold'
                  : 'text-slate-500 dark:text-slate-400 hover:bg-slate-200/60 dark:hover:bg-white/10'
              }`}
            >
              #{tag}
            </button>
          ))}
        </div>
      )}

      {/* Batch Multi-Select Action Bar */}
      {selectMode && (
        <div className="bg-white dark:bg-[#1C1C1E] rounded-2xl p-3 border border-orange-200 dark:border-orange-900/60 flex items-center justify-between gap-3 flex-wrap">
          <span className="text-xs font-semibold text-orange-700 dark:text-orange-300">
            {selectedDocIds.size} selected
          </span>
          <div className="flex items-center gap-2 flex-wrap">
            <button
              type="button"
              disabled={selectedDocIds.size < 2}
              onClick={handleBatchMerge}
              className="min-h-[36px] px-3 rounded-xl bg-orange-600 hover:bg-orange-700 disabled:opacity-40 text-white text-xs font-semibold flex items-center gap-1.5"
            >
              <FilePlus2 className="w-3.5 h-3.5" />
              <span>Merge PDFs</span>
            </button>
            <button
              type="button"
              disabled={selectedDocIds.size === 0}
              onClick={() => setShowMoveFolderModal(true)}
              className="min-h-[36px] px-3 rounded-xl bg-slate-100 dark:bg-[#2C2C2E] disabled:opacity-40 text-xs font-semibold flex items-center gap-1.5"
            >
              <Folder className="w-3.5 h-3.5" />
              <span>Move Folder</span>
            </button>
            <button
              type="button"
              disabled={selectedDocIds.size === 0}
              onClick={handleBatchDelete}
              className="min-h-[36px] px-3 rounded-xl bg-red-50 dark:bg-red-950/40 text-red-600 dark:text-red-400 disabled:opacity-40 text-xs font-semibold flex items-center gap-1.5"
            >
              <Trash2 className="w-3.5 h-3.5" />
              <span>Delete</span>
            </button>
          </div>
        </div>
      )}

      {/* Documents Empty State */}
      {filteredDocs.length === 0 ? (
        <div className="bg-white dark:bg-[#1C1C1E] rounded-3xl border border-slate-200/80 dark:border-white/10 p-10 text-center space-y-3">
          <div className="w-12 h-12 rounded-2xl bg-orange-50 dark:bg-orange-950/40 text-orange-600 dark:text-orange-400 flex items-center justify-center mx-auto">
            <Camera className="w-6 h-6" />
          </div>
          <h3 className="text-base font-bold">No matching scans found</h3>
          <p className="text-sm text-slate-500 dark:text-slate-400 max-w-sm mx-auto">
            Capture a crisp multi-page PDF with auto edge detection, or clear your current folder and tag filters.
          </p>
          <div className="pt-2 flex items-center justify-center gap-2">
            <button
              type="button"
              onClick={() => onOpenScanner('batch')}
              className="min-h-[42px] px-4 rounded-xl bg-orange-600 hover:bg-orange-700 text-white text-sm font-semibold"
            >
              Start Scanning
            </button>
            {(filterQuery || selectedTag || selectedFolderId !== 'all') && (
              <button
                type="button"
                onClick={() => {
                  setFilterQuery('');
                  setSelectedTag(null);
                  onSelectFolder('all');
                }}
                className="min-h-[42px] px-4 rounded-xl bg-slate-100 dark:bg-[#2C2C2E] text-sm font-semibold"
              >
                Reset Filters
              </button>
            )}
          </div>
        </div>
      ) : viewMode === 'list' ? (
        /* Genius Scan iOS Grouped List Layout */
        <div className="bg-white dark:bg-[#1C1C1E] rounded-2xl border border-slate-200/80 dark:border-white/10 divide-y divide-slate-100 dark:divide-white/8 overflow-hidden">
          {filteredDocs.map((doc) => {
            const isSelected = selectedDocIds.has(doc.id);
            const cover = doc.pages[0];
            return (
              <div
                key={doc.id}
                onClick={() => {
                  if (selectMode) toggleSelectDoc(doc.id);
                  else onOpenViewer(doc.id);
                }}
                className={`flex items-center gap-3.5 p-3.5 sm:p-4 cursor-pointer transition-colors ${
                  isSelected
                    ? 'bg-orange-50/70 dark:bg-orange-950/25'
                    : 'hover:bg-slate-50/80 dark:hover:bg-white/[0.03]'
                }`}
              >
                {selectMode && (
                  <span
                    className={`w-6 h-6 rounded-full flex items-center justify-center border shrink-0 transition-colors ${
                      isSelected
                        ? 'bg-orange-600 border-orange-600 text-white'
                        : 'border-slate-300 dark:border-slate-600'
                    }`}
                  >
                    {isSelected && <Check className="w-3.5 h-3.5 stroke-[2.5]" />}
                  </span>
                )}

                {/* Paper Stack Thumbnail */}
                <div className="relative w-12 h-16 shrink-0">
                  {doc.pages.length > 1 && (
                    <div className="absolute -right-1 -top-1 w-full h-full rounded-md bg-slate-200 dark:bg-slate-700 border border-slate-300/60 dark:border-white/10" />
                  )}
                  <div className="relative w-full h-full rounded-md overflow-hidden bg-white border border-slate-200/90 shadow-xs">
                    {cover && (
                      <PageCanvasPreview
                        page={cover}
                        watermark={doc.watermark}
                        className="w-full h-full"
                      />
                    )}
                  </div>
                </div>

                {/* Document Title & Clean Unboxed Metadata */}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <h3 className="text-sm sm:text-[15px] font-semibold text-slate-900 dark:text-white truncate">
                      {doc.title}
                    </h3>
                    {doc.passwordProtected && (
                      <Lock className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                    )}
                  </div>

                  {/* Clean unboxed typographic metadata (no pill badges) */}
                  <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-slate-500 dark:text-slate-400">
                    <span className="font-mono tabular-nums font-medium text-slate-700 dark:text-slate-300">
                      {doc.pages.length} {doc.pages.length === 1 ? 'page' : 'pages'}
                    </span>
                    <span aria-hidden="true">·</span>
                    <span className="font-mono tabular-nums">{formatBytes(doc.sizeBytes)}</span>
                    <span aria-hidden="true">·</span>
                    <span>{formatShortDate(doc.updatedAt)}</span>
                    <span aria-hidden="true">·</span>
                    <span>{folderNameMap[doc.folderId] ?? 'Inbox'}</span>
                    {doc.tags.length > 0 && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span className="text-orange-700 dark:text-orange-400">
                          {doc.tags.join(', ')}
                        </span>
                      </>
                    )}
                  </div>
                </div>

                {/* Row Actions (Organize Pages, Bookmark, More) */}
                {!selectMode && (
                  <div
                    className="flex items-center gap-1 shrink-0"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <button
                      type="button"
                      onClick={() => onOpenOrganizer(doc.id)}
                      title="Organize pages"
                      className="min-h-[38px] px-2.5 sm:px-3 rounded-xl bg-orange-50 dark:bg-orange-950/35 text-orange-700 dark:text-orange-300 hover:bg-orange-100 dark:hover:bg-orange-950/55 text-xs font-semibold flex items-center gap-1.5 transition-colors whitespace-nowrap"
                    >
                      <Layers className="w-3.5 h-3.5" />
                      <span className="hidden sm:inline">Organize</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => onToggleBookmark(doc.id)}
                      aria-label={doc.isBookmarked ? 'Remove star' : 'Star document'}
                      className="min-h-[40px] min-w-[40px] rounded-xl flex items-center justify-center text-slate-400 hover:text-orange-600 hover:bg-slate-100 dark:hover:bg-white/10 transition-colors"
                    >
                      <Bookmark
                        className={`w-4 h-4 ${doc.isBookmarked ? 'fill-orange-500 text-orange-500' : ''}`}
                      />
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setActionSheetDoc(doc);
                        setRenameValue(doc.title);
                      }}
                      aria-label="More document options"
                      className="min-h-[40px] min-w-[40px] rounded-xl flex items-center justify-center text-slate-400 hover:text-slate-700 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-white/10 transition-colors"
                    >
                      <MoreHorizontal className="w-4 h-4" />
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        /* Genius Scan iOS Document Grid View */
        <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-4 gap-4">
          {filteredDocs.map((doc) => {
            const isSelected = selectedDocIds.has(doc.id);
            const cover = doc.pages[0];
            return (
              <div
                key={doc.id}
                onClick={() => {
                  if (selectMode) toggleSelectDoc(doc.id);
                  else onOpenViewer(doc.id);
                }}
                className={`group flex flex-col rounded-2xl p-3 bg-white dark:bg-[#1C1C1E] border cursor-pointer transition-all ${
                  isSelected
                    ? 'border-orange-600 ring-2 ring-orange-500/30'
                    : 'border-slate-200/80 dark:border-white/10 hover:border-slate-300 dark:hover:border-white/20'
                }`}
              >
                <div className="relative aspect-[3/4] rounded-xl bg-slate-100 dark:bg-[#121214] p-2.5 mb-3 overflow-hidden">
                  {cover && (
                    <PageCanvasPreview
                      page={cover}
                      watermark={doc.watermark}
                      className="w-full h-full rounded shadow-xs border border-slate-200/80"
                    />
                  )}
                  <span className="absolute bottom-2 right-2 px-2 py-0.5 rounded-md bg-black/70 text-white text-[11px] font-mono tabular-nums font-semibold">
                    {doc.pages.length}p
                  </span>
                  {selectMode && (
                    <span
                      className={`absolute top-2 right-2 w-6 h-6 rounded-full flex items-center justify-center border ${
                        isSelected
                          ? 'bg-orange-600 border-orange-600 text-white'
                          : 'bg-white/90 border-slate-300'
                      }`}
                    >
                      {isSelected && <Check className="w-3.5 h-3.5 stroke-[2.5]" />}
                    </span>
                  )}
                </div>

                <h3 className="text-sm font-semibold text-slate-900 dark:text-white truncate">
                  {doc.title}
                </h3>
                <div className="mt-1 text-xs text-slate-500 dark:text-slate-400 flex items-center gap-1.5 font-mono tabular-nums">
                  <span>{formatBytes(doc.sizeBytes)}</span>
                  <span aria-hidden="true">·</span>
                  <span>{formatShortDate(doc.updatedAt)}</span>
                </div>

                {!selectMode && (
                  <div
                    className="mt-3 pt-2.5 border-t border-slate-100 dark:border-white/8 flex items-center justify-between gap-2"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <button
                      type="button"
                      onClick={() => onOpenOrganizer(doc.id)}
                      className="text-xs font-semibold text-orange-600 dark:text-orange-400 hover:underline flex items-center gap-1"
                    >
                      <Layers className="w-3.5 h-3.5" />
                      <span>Organize</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setActionSheetDoc(doc);
                        setRenameValue(doc.title);
                      }}
                      className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 dark:hover:text-white"
                      aria-label="Document options"
                    >
                      <MoreHorizontal className="w-4 h-4" />
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* New Folder Dialog */}
      {showNewFolderModal && (
        <div
          className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm flex items-end sm:items-center justify-center p-0 sm:p-4"
          onClick={() => setShowNewFolderModal(false)}
        >
          <div
            className="w-full sm:max-w-sm bg-white dark:bg-[#1C1C1E] rounded-t-3xl sm:rounded-3xl p-5 pb-safe space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-base font-bold">New Folder</h3>
            <input
              type="text"
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
              placeholder="e.g. Travel Receipts, Taxes 2026"
              className="w-full h-11 px-3.5 rounded-xl bg-slate-50 dark:bg-[#2C2C2E] border border-slate-200 dark:border-white/10 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
              autoFocus
            />
            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowNewFolderModal(false)}
                className="h-10 px-4 rounded-xl text-sm font-semibold text-slate-600 dark:text-slate-300"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={!newFolderName.trim()}
                onClick={() => {
                  onCreateFolder(newFolderName.trim());
                  setNewFolderName('');
                  setShowNewFolderModal(false);
                }}
                className="h-10 px-4 rounded-xl bg-orange-600 hover:bg-orange-700 disabled:opacity-40 text-white text-sm font-semibold"
              >
                Create
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Batch Move Folder Modal */}
      {showMoveFolderModal && (
        <div
          className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm flex items-end sm:items-center justify-center p-0 sm:p-4"
          onClick={() => setShowMoveFolderModal(false)}
        >
          <div
            className="w-full sm:max-w-sm bg-white dark:bg-[#1C1C1E] rounded-t-3xl sm:rounded-3xl p-5 pb-safe space-y-3"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-base font-bold">Move {selectedDocIds.size} Document(s)</h3>
            <div className="space-y-1.5">
              {folders.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => {
                    onMoveDocumentsToFolder(Array.from(selectedDocIds), f.id);
                    setShowMoveFolderModal(false);
                    setSelectedDocIds(new Set());
                    setSelectMode(false);
                  }}
                  className="w-full p-3 rounded-xl bg-slate-50 dark:bg-[#2C2C2E] hover:bg-orange-50 dark:hover:bg-orange-950/30 flex items-center gap-2.5 text-sm font-semibold text-left"
                >
                  <Folder className="w-4 h-4 text-orange-600" />
                  <span>{f.name}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Document Action Sheet (Rename, Folder, Organize, Export, Delete) */}
      {actionSheetDoc && (
        <div
          className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm flex items-end sm:items-center justify-center p-0 sm:p-4"
          onClick={() => setActionSheetDoc(null)}
        >
          <div
            className="w-full sm:max-w-md bg-white dark:bg-[#1C1C1E] rounded-t-3xl sm:rounded-3xl p-5 pb-safe space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="w-10 h-1.5 bg-slate-300 dark:bg-slate-700 rounded-full mx-auto sm:hidden" />
            <div className="flex items-center justify-between">
              <h3 className="text-base font-bold truncate pr-2">Document Actions</h3>
              <button
                type="button"
                onClick={() => setActionSheetDoc(null)}
                className="w-9 h-9 rounded-full flex items-center justify-center hover:bg-slate-100 dark:hover:bg-white/10"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="flex gap-2">
              <input
                type="text"
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                className="flex-1 h-10 px-3 rounded-xl bg-slate-50 dark:bg-[#2C2C2E] border border-slate-200 dark:border-white/10 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
              />
              <button
                type="button"
                onClick={() => {
                  if (renameValue.trim()) {
                    onRenameDocument(actionSheetDoc.id, renameValue.trim());
                    setActionSheetDoc(null);
                  }
                }}
                className="h-10 px-4 rounded-xl bg-slate-900 dark:bg-white text-white dark:text-slate-900 text-xs font-semibold whitespace-nowrap"
              >
                Rename
              </button>
            </div>

            <div>
              <span className="block text-xs font-semibold text-slate-500 mb-1.5">Folder</span>
              <div className="flex flex-wrap gap-1.5">
                {folders.map((f) => (
                  <button
                    key={f.id}
                    type="button"
                    onClick={() => {
                      onMoveDocumentsToFolder([actionSheetDoc.id], f.id);
                      setActionSheetDoc(null);
                    }}
                    className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                      actionSheetDoc.folderId === f.id
                        ? 'bg-orange-600 text-white'
                        : 'bg-slate-100 dark:bg-[#2C2C2E] text-slate-700 dark:text-slate-300'
                    }`}
                  >
                    {f.name}
                  </button>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2 pt-1">
              <button
                type="button"
                onClick={() => {
                  const id = actionSheetDoc.id;
                  setActionSheetDoc(null);
                  onOpenOrganizer(id);
                }}
                className="h-11 rounded-xl bg-orange-50 dark:bg-orange-950/40 text-orange-700 dark:text-orange-300 text-xs font-semibold flex items-center justify-center gap-1.5"
              >
                <Layers className="w-4 h-4" />
                <span>Organize Pages</span>
              </button>
              <button
                type="button"
                onClick={async () => {
                  const target = actionSheetDoc;
                  setActionSheetDoc(null);
                  await exportDocumentAsPdf(target);
                  onToast(`Exported "${target.title}.pdf"`);
                }}
                className="h-11 rounded-xl bg-slate-100 dark:bg-[#2C2C2E] text-xs font-semibold flex items-center justify-center gap-1.5"
              >
                <Download className="w-4 h-4" />
                <span>Export PDF</span>
              </button>
            </div>

            <button
              type="button"
              onClick={() => {
                onDeleteDocuments([actionSheetDoc.id]);
                setActionSheetDoc(null);
              }}
              className="w-full h-11 rounded-xl bg-red-50 dark:bg-red-950/40 text-red-600 dark:text-red-400 text-sm font-semibold flex items-center justify-center gap-1.5"
            >
              <Trash2 className="w-4 h-4" />
              <span>Delete Document</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
