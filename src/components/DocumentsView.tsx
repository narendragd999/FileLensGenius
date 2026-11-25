import React, { useMemo, useState } from 'react';
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
  HardDrive,
  IdCard,
  Layers,
  List,
  Lock,
  MoreHorizontal,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import {
  DeviceIndexSummary,
  DocFolder,
  IndexProgress,
  IndexStats,
  ScanDocument,
  ScanMode,
} from '../types/filelens';
import { formatBytes, formatShortDate } from '../utils/formatters';
import { exportDocumentAsPdf } from '../utils/pdfExport';
import { PageCanvasPreview } from './PageCanvasPreview';
import { IndexDeviceTrigger, SmartIndexingBar } from './SmartIndexingBar';

interface DocumentsViewProps {
  documents: ScanDocument[];
  folders: DocFolder[];
  selectedFolderId: string;
  indexStats: IndexStats;
  linkedDeviceRootsCount: number;
  hasAllFilesPermission: boolean;
  isIndexing: boolean;
  indexProgress: IndexProgress | null;
  lastIndexSummary: DeviceIndexSummary | null;
  onOneTapIndexDevice: () => void;
  onIndexFiles: (files: File[], sourceLabel: string) => void;
  onRunDeltaReindex: () => void;
  onCancelIndexing: () => void;
  onSelectFolder: (folderId: string) => void;
  onCreateFolder: (name: string) => void;
  onOpenScanner: (mode: ScanMode) => void;
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
  indexStats,
  linkedDeviceRootsCount,
  hasAllFilesPermission,
  isIndexing,
  indexProgress,
  lastIndexSummary,
  onOneTapIndexDevice,
  onIndexFiles,
  onRunDeltaReindex,
  onCancelIndexing,
  onSelectFolder,
  onCreateFolder,
  onOpenScanner,
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
  const [showTags, setShowTags] = useState<boolean>(false);
  const [selectMode, setSelectMode] = useState<boolean>(false);
  const [selectedDocIds, setSelectedDocIds] = useState<Set<string>>(new Set());
  const [showNewFolderModal, setShowNewFolderModal] = useState<boolean>(false);
  const [newFolderName, setNewFolderName] = useState<string>('');
  const [actionSheetDoc, setActionSheetDoc] = useState<ScanDocument | null>(null);
  const [renameValue, setRenameValue] = useState<string>('');
  const [showMoveFolderModal, setShowMoveFolderModal] = useState<boolean>(false);

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
    <div className="space-y-2 sm:space-y-3">
      {/* Desktop-only compact title row (hidden on small mobile screens to maximize document list space) */}
      <div className="hidden sm:flex items-center justify-between gap-3">
        <div className="flex items-baseline gap-2.5">
          <h1 className="text-xl font-bold tracking-tight text-slate-900 dark:text-white">
            Documents
          </h1>
          <span className="text-xs text-slate-500 dark:text-slate-400 font-mono tabular-nums">
            {filteredDocs.length} files · {documents.reduce((acc, d) => acc + d.pages.length, 0)}p
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => onOpenScanner('batch')}
            className="h-9 px-3.5 rounded-xl bg-orange-600 hover:bg-orange-700 text-white text-xs font-semibold flex items-center gap-1.5 transition-colors whitespace-nowrap"
          >
            <Camera className="w-3.5 h-3.5" />
            <span>Live Scan</span>
          </button>
          <button
            type="button"
            onClick={() => onOpenScanner('idcard')}
            className="h-9 px-3 rounded-xl bg-white dark:bg-[#1C1C1E] border border-slate-200 dark:border-white/10 hover:border-orange-400 text-slate-800 dark:text-slate-100 text-xs font-semibold flex items-center gap-1.5 transition-colors whitespace-nowrap"
          >
            <IdCard className="w-3.5 h-3.5 text-orange-600 dark:text-orange-400" />
            <span>2-in-1 ID</span>
          </button>
        </div>
      </div>

      {/* Row 1: Compact Instant Search + Inline Utility Buttons */}
      <div className="flex items-center gap-1.5">
        <div className="relative flex-1 min-w-0">
          <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={filterQuery}
            onChange={(e) => setFilterQuery(e.target.value)}
            placeholder="Search files, OCR text, tags…"
            className="w-full h-9 pl-8 pr-7 rounded-xl bg-white dark:bg-[#1C1C1E] border border-slate-200/80 dark:border-white/10 text-xs sm:text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
          />
          {filterQuery && (
            <button
              type="button"
              onClick={() => setFilterQuery('')}
              aria-label="Clear filter"
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>

        {/* Mobile quick 2-in-1 ID button */}
        <button
          type="button"
          onClick={() => onOpenScanner('idcard')}
          title="Scan 2-in-1 ID Card"
          aria-label="Scan 2-in-1 ID Card"
          className="sm:hidden h-9 w-9 rounded-xl bg-white dark:bg-[#1C1C1E] border border-slate-200/80 dark:border-white/10 flex items-center justify-center text-orange-600 dark:text-orange-400 shrink-0"
        >
          <IdCard className="w-4 h-4" />
        </button>

        <button
          type="button"
          onClick={() => setViewMode((v) => (v === 'list' ? 'grid' : 'list'))}
          title={viewMode === 'list' ? 'Switch to Grid View' : 'Switch to List View'}
          aria-label={viewMode === 'list' ? 'Switch to Grid View' : 'Switch to List View'}
          className="h-9 w-9 rounded-xl bg-white dark:bg-[#1C1C1E] border border-slate-200/80 dark:border-white/10 flex items-center justify-center text-slate-600 dark:text-slate-300 shrink-0"
        >
          {viewMode === 'list' ? <Grid2X2 className="w-4 h-4" /> : <List className="w-4 h-4" />}
        </button>

        <button
          type="button"
          onClick={() => {
            setSelectMode((v) => !v);
            setSelectedDocIds(new Set());
          }}
          className={`h-9 px-2.5 rounded-xl text-xs font-semibold flex items-center gap-1 transition-colors whitespace-nowrap shrink-0 ${
            selectMode
              ? 'bg-orange-600 text-white'
              : 'bg-white dark:bg-[#1C1C1E] border border-slate-200/80 dark:border-white/10 text-slate-700 dark:text-slate-200'
          }`}
        >
          <CheckSquare className="w-3.5 h-3.5" />
          <span className="hidden sm:inline">{selectMode ? 'Done' : 'Select'}</span>
        </button>
      </div>

      {/* Row 2: Ultra-Compact Single-Line Folder Rail + Sort + Optional Tags Toggle */}
      <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar">
        <button
          type="button"
          onClick={() => onSelectFolder('all')}
          className={`h-7 px-2.5 rounded-lg text-[11px] font-semibold transition-colors whitespace-nowrap shrink-0 ${
            selectedFolderId === 'all'
              ? 'bg-slate-900 dark:bg-white text-white dark:text-slate-900'
              : 'bg-white dark:bg-[#1C1C1E] text-slate-600 dark:text-slate-300 border border-slate-200/80 dark:border-white/10'
          }`}
        >
          All ({documents.length})
        </button>
        <button
          type="button"
          onClick={() => onSelectFolder('bookmarked')}
          className={`h-7 px-2.5 rounded-lg text-[11px] font-semibold transition-colors whitespace-nowrap shrink-0 flex items-center gap-1 ${
            selectedFolderId === 'bookmarked'
              ? 'bg-slate-900 dark:bg-white text-white dark:text-slate-900'
              : 'bg-white dark:bg-[#1C1C1E] text-slate-600 dark:text-slate-300 border border-slate-200/80 dark:border-white/10'
          }`}
        >
          <Bookmark className="w-3 h-3" />
          <span>Starred</span>
        </button>
        {folders.map((folder) => (
          <button
            key={folder.id}
            type="button"
            onClick={() => onSelectFolder(folder.id)}
            className={`h-7 px-2.5 rounded-lg text-[11px] font-semibold transition-colors whitespace-nowrap shrink-0 flex items-center gap-1 ${
              selectedFolderId === folder.id
                ? 'bg-slate-900 dark:bg-white text-white dark:text-slate-900'
                : 'bg-white dark:bg-[#1C1C1E] text-slate-600 dark:text-slate-300 border border-slate-200/80 dark:border-white/10'
            }`}
          >
            <Folder className="w-3 h-3 opacity-70" />
            <span>{folder.name}</span>
          </button>
        ))}
        <button
          type="button"
          onClick={() => setShowNewFolderModal(true)}
          title="Create new folder"
          className="h-7 px-2 rounded-lg text-[11px] font-semibold text-orange-600 dark:text-orange-400 bg-orange-50 dark:bg-orange-950/30 transition-colors whitespace-nowrap shrink-0 flex items-center gap-1"
        >
          <FolderPlus className="w-3 h-3" />
          <span>New</span>
        </button>

        {allTags.length > 0 && (
          <button
            type="button"
            onClick={() => setShowTags((v) => !v)}
            className={`h-7 px-2 rounded-lg text-[11px] font-semibold transition-colors whitespace-nowrap shrink-0 ${
              showTags || selectedTag
                ? 'bg-orange-600/15 text-orange-700 dark:text-orange-300'
                : 'bg-white dark:bg-[#1C1C1E] text-slate-500 dark:text-slate-400 border border-slate-200/80 dark:border-white/10'
            }`}
          >
            {selectedTag ? `#${selectedTag}` : `#Tags (${allTags.length})`}
          </button>
        )}

        <select
          value={sortBy}
          onChange={(e) => setSortBy(e.target.value as SortKey)}
          aria-label="Sort documents"
          className="h-7 px-2 rounded-lg bg-white dark:bg-[#1C1C1E] border border-slate-200/80 dark:border-white/10 text-[11px] font-semibold text-slate-600 dark:text-slate-300 focus:outline-none shrink-0"
        >
          <option value="updated">Newest</option>
          <option value="title">A–Z</option>
          <option value="pages">Pages</option>
          <option value="size">Size</option>
        </select>
      </div>

      {/* Optional Expandable Tag Rail (hidden by default to save mobile screen space!) */}
      {(showTags || selectedTag) && allTags.length > 0 && (
        <div className="flex items-center gap-1 overflow-x-auto no-scrollbar">
          <button
            type="button"
            onClick={() => {
              setSelectedTag(null);
              setShowTags(false);
            }}
            className={`h-6 px-2 rounded-md text-[11px] font-medium whitespace-nowrap shrink-0 ${
              selectedTag === null
                ? 'bg-orange-600/12 text-orange-700 dark:text-orange-300 font-semibold'
                : 'text-slate-500 dark:text-slate-400'
            }`}
          >
            All
          </button>
          {allTags.map((tag) => (
            <button
              key={tag}
              type="button"
              onClick={() => setSelectedTag(selectedTag === tag ? null : tag)}
              className={`h-6 px-2 rounded-md text-[11px] font-medium whitespace-nowrap shrink-0 ${
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

      {/* Row 3: Single-Button FileLensMobile Device Index Bar */}
      <SmartIndexingBar
        compact
        stats={indexStats}
        linkedDeviceRootsCount={linkedDeviceRootsCount}
        hasAllFilesPermission={hasAllFilesPermission}
        isIndexing={isIndexing}
        progress={indexProgress}
        lastSummary={lastIndexSummary}
        onOneTapIndexDevice={onOneTapIndexDevice}
        onIndexFiles={onIndexFiles}
        onRunDeltaReindex={onRunDeltaReindex}
        onCancelIndexing={onCancelIndexing}
      />

      {/* Batch Multi-Select Action Bar */}
      {selectMode && (
        <div className="bg-white dark:bg-[#1C1C1E] rounded-xl px-3 py-2 border border-orange-200 dark:border-orange-900/60 flex items-center justify-between gap-2 flex-wrap">
          <span className="text-xs font-semibold text-orange-700 dark:text-orange-300">
            {selectedDocIds.size} selected
          </span>
          <div className="flex items-center gap-1.5 flex-wrap">
            <button
              type="button"
              disabled={selectedDocIds.size < 2}
              onClick={handleBatchMerge}
              className="h-8 px-2.5 rounded-lg bg-orange-600 hover:bg-orange-700 disabled:opacity-40 text-white text-xs font-semibold flex items-center gap-1"
            >
              <FilePlus2 className="w-3.5 h-3.5" />
              <span>Merge</span>
            </button>
            <button
              type="button"
              disabled={selectedDocIds.size === 0}
              onClick={() => setShowMoveFolderModal(true)}
              className="h-8 px-2.5 rounded-lg bg-slate-100 dark:bg-[#2C2C2E] disabled:opacity-40 text-xs font-semibold flex items-center gap-1"
            >
              <Folder className="w-3.5 h-3.5" />
              <span>Move</span>
            </button>
            <button
              type="button"
              disabled={selectedDocIds.size === 0}
              onClick={handleBatchDelete}
              className="h-8 px-2.5 rounded-lg bg-red-50 dark:bg-red-950/40 text-red-600 dark:text-red-400 disabled:opacity-40 text-xs font-semibold flex items-center gap-1"
            >
              <Trash2 className="w-3.5 h-3.5" />
              <span>Delete</span>
            </button>
          </div>
        </div>
      )}

      {/* Documents List / Grid */}
      {filteredDocs.length === 0 ? (
        documents.length === 0 ? (
          <div className="bg-white dark:bg-[#1C1C1E] rounded-2xl border border-slate-200/80 dark:border-white/10 p-6 sm:p-8 text-center space-y-3">
            <div className="w-11 h-11 rounded-2xl bg-orange-50 dark:bg-orange-950/40 text-orange-600 dark:text-orange-400 flex items-center justify-center mx-auto">
              <HardDrive className="w-5 h-5" />
            </div>
            <div className="space-y-1">
              <h3 className="text-sm sm:text-base font-bold text-slate-900 dark:text-white">
                Your Local Vault is Empty
              </h3>
              <p className="text-xs sm:text-sm text-slate-500 dark:text-slate-400 max-w-md mx-auto">
                Tap Index Device once to scan and OCR all files on your device, or capture with your camera.
              </p>
            </div>
            <div className="pt-1 flex flex-wrap items-center justify-center gap-2">
              <IndexDeviceTrigger
                disabled={isIndexing}
                onOneTapIndexDevice={onOneTapIndexDevice}
                className="h-10 px-4 rounded-xl bg-orange-600 hover:bg-orange-700 text-white text-xs sm:text-sm font-semibold inline-flex items-center gap-1.5"
              >
                <HardDrive className="w-4 h-4" />
                <span>Index Device</span>
              </IndexDeviceTrigger>
              <button
                type="button"
                onClick={() => onOpenScanner('batch')}
                className="h-10 px-3.5 rounded-xl bg-slate-100 dark:bg-[#2C2C2E] hover:bg-slate-200 dark:hover:bg-white/15 text-slate-800 dark:text-slate-100 text-xs sm:text-sm font-semibold inline-flex items-center gap-1.5"
              >
                <Camera className="w-4 h-4 text-orange-600 dark:text-orange-400" />
                <span>Live Scan</span>
              </button>
              <button
                type="button"
                onClick={() => onOpenScanner('idcard')}
                className="h-10 px-3.5 rounded-xl bg-slate-100 dark:bg-[#2C2C2E] hover:bg-slate-200 dark:hover:bg-white/15 text-slate-800 dark:text-slate-100 text-xs sm:text-sm font-semibold inline-flex items-center gap-1.5"
              >
                <IdCard className="w-4 h-4 text-orange-600 dark:text-orange-400" />
                <span>2-in-1 ID</span>
              </button>
            </div>
          </div>
        ) : (
          <div className="bg-white dark:bg-[#1C1C1E] rounded-2xl border border-slate-200/80 dark:border-white/10 p-6 sm:p-8 text-center space-y-2.5">
            <h3 className="text-sm sm:text-base font-bold">No matching files</h3>
            <p className="text-xs sm:text-sm text-slate-500 dark:text-slate-400 max-w-sm mx-auto">
              Try a different keyword or reset your folder and tag filters.
            </p>
            <div className="pt-1 flex items-center justify-center gap-2">
              <button
                type="button"
                onClick={() => {
                  setFilterQuery('');
                  setSelectedTag(null);
                  onSelectFolder('all');
                }}
                className="h-9 px-4 rounded-xl bg-orange-600 hover:bg-orange-700 text-white text-xs font-semibold"
              >
                Reset Filters
              </button>
            </div>
          </div>
        )
      ) : viewMode === 'list' ? (
        <div className="bg-white dark:bg-[#1C1C1E] rounded-xl sm:rounded-2xl border border-slate-200/80 dark:border-white/10 divide-y divide-slate-100 dark:divide-white/8 overflow-hidden">
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
                className={`flex items-center gap-2.5 sm:gap-3 px-2.5 py-2 sm:px-3.5 sm:py-2.5 cursor-pointer transition-colors ${
                  isSelected
                    ? 'bg-orange-50/70 dark:bg-orange-950/25'
                    : 'hover:bg-slate-50/80 dark:hover:bg-white/[0.03]'
                }`}
              >
                {selectMode && (
                  <span
                    className={`w-5 h-5 rounded-full flex items-center justify-center border shrink-0 transition-colors ${
                      isSelected
                        ? 'bg-orange-600 border-orange-600 text-white'
                        : 'border-slate-300 dark:border-slate-600'
                    }`}
                  >
                    {isSelected && <Check className="w-3 h-3 stroke-[2.5]" />}
                  </span>
                )}

                <div className="relative w-9 h-12 sm:w-11 sm:h-14 shrink-0">
                  {doc.pages.length > 1 && (
                    <div className="absolute -right-0.5 -top-0.5 w-full h-full rounded bg-slate-200 dark:bg-slate-700 border border-slate-300/60 dark:border-white/10" />
                  )}
                  <div className="relative w-full h-full rounded overflow-hidden bg-white border border-slate-200/90 shadow-xs">
                    {cover && (
                      <PageCanvasPreview
                        page={cover}
                        watermark={doc.watermark}
                        className="w-full h-full"
                      />
                    )}
                  </div>
                </div>

                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1">
                    <h3 className="text-[13px] sm:text-sm font-semibold text-slate-900 dark:text-white truncate">
                      {doc.title}
                    </h3>
                    {doc.passwordProtected && (
                      <Lock className="w-3 h-3 text-slate-400 shrink-0" />
                    )}
                  </div>

                  <div className="mt-0.5 flex items-center gap-x-1.5 text-[11px] text-slate-500 dark:text-slate-400 truncate">
                    {doc.fileExtension && doc.fileExtension !== 'pdf' && (
                      <>
                        <span className="font-mono uppercase font-semibold text-orange-600 dark:text-orange-400">
                          {doc.fileExtension}
                        </span>
                        <span aria-hidden="true">·</span>
                      </>
                    )}
                    <span className="font-mono tabular-nums font-medium text-slate-700 dark:text-slate-300">
                      {doc.pages.length}p
                    </span>
                    <span aria-hidden="true">·</span>
                    <span className="font-mono tabular-nums">{formatBytes(doc.sizeBytes)}</span>
                    <span aria-hidden="true">·</span>
                    <span>{formatShortDate(doc.updatedAt)}</span>
                    <span className="hidden sm:inline" aria-hidden="true">·</span>
                    <span className="hidden sm:inline">{folderNameMap[doc.folderId] ?? 'Inbox'}</span>
                    {doc.tags.length > 0 && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span className="text-orange-700 dark:text-orange-400 truncate">
                          {doc.tags.slice(0, 2).join(', ')}
                        </span>
                      </>
                    )}
                  </div>
                </div>

                {!selectMode && (
                  <div
                    className="flex items-center gap-0.5 shrink-0"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <button
                      type="button"
                      onClick={() => onOpenOrganizer(doc.id)}
                      title="Organize pages"
                      className="h-8 px-2 sm:px-2.5 rounded-lg bg-orange-50 dark:bg-orange-950/35 text-orange-700 dark:text-orange-300 hover:bg-orange-100 dark:hover:bg-orange-950/55 text-[11px] font-semibold flex items-center gap-1 transition-colors whitespace-nowrap"
                    >
                      <Layers className="w-3.5 h-3.5" />
                      <span className="hidden sm:inline">Organize</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => onToggleBookmark(doc.id)}
                      aria-label={doc.isBookmarked ? 'Remove star' : 'Star document'}
                      className="w-8 h-8 rounded-lg flex items-center justify-center text-slate-400 hover:text-orange-600 hover:bg-slate-100 dark:hover:bg-white/10 transition-colors"
                    >
                      <Bookmark
                        className={`w-3.5 h-3.5 ${doc.isBookmarked ? 'fill-orange-500 text-orange-500' : ''}`}
                      />
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setActionSheetDoc(doc);
                        setRenameValue(doc.title);
                      }}
                      aria-label="More document options"
                      className="w-8 h-8 rounded-lg flex items-center justify-center text-slate-400 hover:text-slate-700 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-white/10 transition-colors"
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
        <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-4 gap-2.5 sm:gap-3.5">
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
                className={`group flex flex-col rounded-xl sm:rounded-2xl p-2 sm:p-2.5 bg-white dark:bg-[#1C1C1E] border cursor-pointer transition-all ${
                  isSelected
                    ? 'border-orange-600 ring-2 ring-orange-500/30'
                    : 'border-slate-200/80 dark:border-white/10 hover:border-slate-300 dark:hover:border-white/20'
                }`}
              >
                <div className="relative aspect-[3/4] rounded-lg bg-slate-100 dark:bg-[#121214] p-1.5 mb-2 overflow-hidden">
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

      {/* Document Action Sheet */}
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
