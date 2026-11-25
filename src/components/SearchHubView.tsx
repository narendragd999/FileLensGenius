import React, { useEffect, useMemo, useState } from 'react';
import {
  ArrowUpDown,
  Bookmark,
  BookmarkPlus,
  ChevronLeft,
  ChevronRight,
  Download,
  Layers,
  Search,
  SlidersHorizontal,
  Trash2,
  X,
} from 'lucide-react';
import {
  DeviceIndexSummary,
  FileCategory,
  IndexProgress,
  IndexStats,
  SavedSearch,
  ScanDocument,
  SearchFilters,
  SearchMode,
  SortColumn,
  SortOrder,
} from '../types/filelens';
import { formatBytes, formatShortDate, triggerFileDownload } from '../utils/formatters';
import { exportSearchResults, runDocumentSearch } from '../utils/searchEngine';
import { PageCanvasPreview } from './PageCanvasPreview';
import { IndexDeviceTrigger, SmartIndexingBar } from './SmartIndexingBar';

interface SearchHubViewProps {
  documents: ScanDocument[];
  savedSearches: SavedSearch[];
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
  onSaveSearch: (query: string, mode: SearchMode) => void;
  onDeleteSavedSearch: (id: string) => void;
  onOpenDocumentAtPage: (docId: string, pageIndex: number) => void;
  onOpenOrganizer: (docId: string) => void;
  onToast: (message: string) => void;
}

const SEARCH_MODES: { id: SearchMode; label: string; hint: string }[] = [
  { id: 'quick', label: 'Quick Search', hint: 'Partial + bilingual Hinglish/concept expansion across ALL indexed device files (try "bill", "doctor", "pdf")' },
  { id: 'natural', label: 'Natural Language', hint: '384-dim offline semantic vector similarity across all files & OCR text' },
  { id: 'exact', label: 'Exact Match', hint: 'Exact phrase substring match across PDFs, Office, OCR photos, code & filenames' },
  { id: 'whole', label: 'Whole Word', hint: 'Strict word boundary matching across indexed content' },
  { id: 'wildcard', label: 'Wildcard', hint: 'Use * and ? wildcards (try "inv*" or "2026-??")' },
  { id: 'boolean', label: 'Boolean', hint: 'Combine AND / OR / NOT operators (try "Invoice AND Paid")' },
];

const FILE_TYPE_FILTERS: { id: 'all' | FileCategory; label: string }[] = [
  { id: 'all', label: 'All File Types' },
  { id: 'pdf', label: 'PDF' },
  { id: 'image', label: 'Images & OCR' },
  { id: 'office', label: 'Office (DOCX/XLSX/PPTX)' },
  { id: 'text_code', label: 'Text & Code' },
  { id: 'archive', label: 'Archives' },
  { id: 'audio_video', label: 'Media' },
  { id: 'other', label: 'Other' },
];

const QUICK_CONCEPTS = ['Invoice', 'Receipt', 'Contract', 'Medical', 'ID Card', 'Tax'];

function highlightText(text: string, terms: string[]): React.ReactNode {
  if (!terms.length) return text;
  const escaped = terms
    .filter((t) => t.length > 0)
    .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (!escaped.length) return text;
  const rx = new RegExp(`(${escaped.join('|')})`, 'gi');
  const parts = text.split(rx);
  return parts.map((part, idx) =>
    idx % 2 === 1 ? (
      <mark
        key={idx}
        className="bg-orange-200/80 dark:bg-orange-500/35 text-slate-900 dark:text-orange-100 rounded px-0.5"
      >
        {part}
      </mark>
    ) : (
      <React.Fragment key={idx}>{part}</React.Fragment>
    )
  );
}

export const SearchHubView: React.FC<SearchHubViewProps> = ({
  documents,
  savedSearches,
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
  onSaveSearch,
  onDeleteSavedSearch,
  onOpenDocumentAtPage,
  onOpenOrganizer,
  onToast,
}) => {
  const [query, setQuery] = useState<string>('');
  const [mode, setMode] = useState<SearchMode>('quick');
  const [fileTypeFilter, setFileTypeFilter] = useState<'all' | FileCategory>('all');
  const [sizeFilter, setSizeFilter] = useState<'all' | 'lt100k' | '100k_1m' | '1m_10m' | 'gt10m'>('all');
  const [dateFilter, setDateFilter] = useState<'all' | '7d' | '30d'>('all');
  const [sortBy, setSortBy] = useState<SortColumn>('score');
  const [sortOrder, setSortOrder] = useState<SortOrder>('desc');
  const [showFilterPanel, setShowFilterPanel] = useState<boolean>(false);
  const [activeMatchIdx, setActiveMatchIdx] = useState<number>(0);

  const searchFilters = useMemo<SearchFilters>(() => {
    const f: SearchFilters = {};
    if (fileTypeFilter !== 'all') f.fileCategories = [fileTypeFilter];
    if (sizeFilter === 'lt100k') f.maxSizeBytes = 100 * 1024;
    else if (sizeFilter === '100k_1m') {
      f.minSizeBytes = 100 * 1024;
      f.maxSizeBytes = 1024 * 1024;
    } else if (sizeFilter === '1m_10m') {
      f.minSizeBytes = 1024 * 1024;
      f.maxSizeBytes = 10 * 1024 * 1024;
    } else if (sizeFilter === 'gt10m') {
      f.minSizeBytes = 10 * 1024 * 1024;
    }
    if (dateFilter === '7d') {
      f.modifiedAfterIso = new Date(Date.now() - 7 * 86_400_000).toISOString();
    } else if (dateFilter === '30d') {
      f.modifiedAfterIso = new Date(Date.now() - 30 * 86_400_000).toISOString();
    }
    return f;
  }, [fileTypeFilter, sizeFilter, dateFilter]);

  const [debouncedQuery, setDebouncedQuery] = useState(query);
  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedQuery(query), 180);
    return () => window.clearTimeout(t);
  }, [query]);

  const results = useMemo(
    () => runDocumentSearch(documents, debouncedQuery, mode, { filters: searchFilters, sortBy, sortOrder }),
    [documents, debouncedQuery, mode, searchFilters, sortBy, sortOrder]
  );
  const [visibleResultCount, setVisibleResultCount] = useState(30);
  useEffect(() => {
    setVisibleResultCount(30);
  }, [debouncedQuery, mode, searchFilters, sortBy, sortOrder]);
  const visibleResults = useMemo(
    () => results.slice(0, visibleResultCount),
    [results, visibleResultCount]
  );

  const activeFilterCount =
    (fileTypeFilter !== 'all' ? 1 : 0) +
    (sizeFilter !== 'all' ? 1 : 0) +
    (dateFilter !== 'all' ? 1 : 0);

  const safeMatchIdx = results.length > 0 ? Math.min(activeMatchIdx, results.length - 1) : 0;
  const currentModeMeta = SEARCH_MODES.find((m) => m.id === mode)!;

  const handleExport = (format: 'txt' | 'md' | 'csv' | 'json') => {
    if (results.length === 0) return;
    const { content, mime, ext } = exportSearchResults(results, query, format);
    const blob = new Blob([content], { type: mime });
    triggerFileDownload(blob, `FileLens_Search_${Date.now()}.${ext}`);
    onToast(`Exported ${results.length} search result(s) as ${ext.toUpperCase()}`);
  };

  return (
    <div className="space-y-2 sm:space-y-3">
      {/* Search-First Sticky Command Card right at the top of the screen! */}
      <div className="bg-white dark:bg-[#1C1C1E] rounded-xl sm:rounded-2xl p-2.5 sm:p-3.5 border border-slate-200/80 dark:border-white/10 space-y-2">
        <div className="flex items-center gap-1.5">
          <div className="relative flex-1 min-w-0">
            <Search className="w-4 h-4 text-orange-600 dark:text-orange-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setActiveMatchIdx(0);
              }}
              placeholder="Search ANY device file, OCR text, DOCX, PDF, ZIP…"
              className="w-full h-10 pl-9 pr-8 rounded-xl bg-slate-50 dark:bg-[#2C2C2E] border border-slate-200 dark:border-white/10 text-xs sm:text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery('')}
                aria-label="Clear search"
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
              >
                <X className="w-4 h-4" />
              </button>
            )}
          </div>
          <button
            type="button"
            onClick={() => setShowFilterPanel((v) => !v)}
            title="Filters & Sort"
            className={`h-10 px-2.5 rounded-xl flex items-center gap-1 text-xs font-semibold shrink-0 transition-colors ${
              showFilterPanel || activeFilterCount > 0
                ? 'bg-orange-100 dark:bg-orange-950/50 text-orange-600 dark:text-orange-400'
                : 'bg-slate-100 dark:bg-[#2C2C2E] text-slate-700 dark:text-slate-200 hover:bg-slate-200 dark:hover:bg-white/15'
            }`}
          >
            <SlidersHorizontal className="w-4 h-4" />
            {activeFilterCount > 0 && (
              <span className="px-1.5 py-0.5 rounded-full bg-orange-600 text-white text-[10px]">
                {activeFilterCount}
              </span>
            )}
          </button>
          <button
            type="button"
            disabled={!query.trim()}
            onClick={() => {
              onSaveSearch(query.trim(), mode);
              onToast('Saved search query');
            }}
            title="Save this search"
            className="h-10 px-2.5 sm:px-3 rounded-xl bg-slate-100 dark:bg-[#2C2C2E] hover:bg-orange-50 dark:hover:bg-orange-950/40 text-slate-700 dark:text-slate-200 hover:text-orange-600 disabled:opacity-40 flex items-center gap-1 text-xs font-semibold whitespace-nowrap transition-colors shrink-0"
          >
            <BookmarkPlus className="w-4 h-4" />
            <span className="hidden sm:inline">Save</span>
          </button>
        </div>

        {/* Collapsible Size, Date & Sort Panel */}
        {showFilterPanel && (
          <div className="p-2.5 rounded-xl bg-slate-50 dark:bg-[#2C2C2E] border border-slate-200/70 dark:border-white/10 space-y-2 text-[11px]">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="font-semibold text-slate-500 mr-1">Size:</span>
              {(
                [
                  { id: 'all', label: 'Any' },
                  { id: 'lt100k', label: '<100 KB' },
                  { id: '100k_1m', label: '100KB–1MB' },
                  { id: '1m_10m', label: '1–10 MB' },
                  { id: 'gt10m', label: '>10 MB' },
                ] as const
              ).map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => setSizeFilter(s.id)}
                  className={`px-2 py-1 rounded-md font-medium ${
                    sizeFilter === s.id
                      ? 'bg-orange-600 text-white'
                      : 'bg-white dark:bg-[#1C1C1E] text-slate-600 dark:text-slate-300'
                  }`}
                >
                  {s.label}
                </button>
              ))}
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="font-semibold text-slate-500 mr-1">Modified:</span>
                {(
                  [
                    { id: 'all', label: 'Anytime' },
                    { id: '7d', label: 'Last 7d' },
                    { id: '30d', label: 'Last 30d' },
                  ] as const
                ).map((d) => (
                  <button
                    key={d.id}
                    type="button"
                    onClick={() => setDateFilter(d.id)}
                    className={`px-2 py-1 rounded-md font-medium ${
                      dateFilter === d.id
                        ? 'bg-orange-600 text-white'
                        : 'bg-white dark:bg-[#1C1C1E] text-slate-600 dark:text-slate-300'
                    }`}
                  >
                    {d.label}
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-1.5">
                <select
                  value={sortBy}
                  onChange={(e) => setSortBy(e.target.value as SortColumn)}
                  aria-label="Sort search results"
                  className="px-2 py-1 rounded-md bg-white dark:bg-[#1C1C1E] border border-slate-200 dark:border-white/10 font-medium"
                >
                  <option value="score">Relevance</option>
                  <option value="name">Name</option>
                  <option value="size">Size</option>
                  <option value="modified">Modified</option>
                  <option value="extension">Type</option>
                </select>
                <button
                  type="button"
                  onClick={() => setSortOrder((o) => (o === 'desc' ? 'asc' : 'desc'))}
                  className="px-2 py-1 rounded-md bg-white dark:bg-[#1C1C1E] border border-slate-200 dark:border-white/10 flex items-center gap-1 font-medium"
                >
                  <ArrowUpDown className="w-3 h-3" />
                  <span>{sortOrder === 'desc' ? 'Desc' : 'Asc'}</span>
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Single-Row Compact 6 Search Modes */}
        <div className="flex items-center gap-1 overflow-x-auto no-scrollbar">
          {SEARCH_MODES.map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={() => {
                setMode(m.id);
                setActiveMatchIdx(0);
              }}
              className={`h-7 px-2.5 rounded-lg text-[11px] font-semibold transition-colors whitespace-nowrap shrink-0 ${
                mode === m.id
                  ? 'bg-orange-600 text-white'
                  : 'bg-slate-100 dark:bg-[#2C2C2E] text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-white/15'
              }`}
            >
              {m.label}
            </button>
          ))}
        </div>

        {/* Single-Row Compact Universal File Type Filters */}
        <div className="flex items-center gap-1 overflow-x-auto no-scrollbar">
          {FILE_TYPE_FILTERS.map((ft) => (
            <button
              key={ft.id}
              type="button"
              onClick={() => {
                setFileTypeFilter(ft.id);
                setActiveMatchIdx(0);
              }}
              className={`h-6 px-2 rounded-md text-[11px] font-medium transition-colors whitespace-nowrap shrink-0 ${
                fileTypeFilter === ft.id
                  ? 'bg-slate-900 dark:bg-white text-white dark:text-slate-900 font-semibold'
                  : 'bg-slate-50 dark:bg-[#2C2C2E] text-slate-600 dark:text-slate-300 hover:bg-slate-200/70 dark:hover:bg-white/10'
              }`}
            >
              {ft.label}
            </button>
          ))}
        </div>

        {/* Only show hint & Try chips when query is empty so results take 100% of screen while searching! */}
        {!query.trim() && (
          <div className="space-y-1.5 pt-0.5">
            <p className="text-[11px] text-slate-500 dark:text-slate-400">{currentModeMeta.hint}</p>
            <div className="flex items-center gap-1 overflow-x-auto no-scrollbar">
              <span className="text-[11px] text-slate-400 shrink-0 mr-0.5">Try:</span>
              {QUICK_CONCEPTS.map((concept) => (
                <button
                  key={concept}
                  type="button"
                  onClick={() => {
                    if (concept.includes('AND') || concept.includes('OR')) setMode('boolean');
                    else if (concept.includes('*')) setMode('wildcard');
                    else setMode('quick');
                    setQuery(concept);
                    setActiveMatchIdx(0);
                  }}
                  className="h-6 px-2 rounded-md text-[11px] font-medium bg-slate-50 dark:bg-[#2C2C2E] border border-slate-200/80 dark:border-white/8 hover:border-orange-400 text-slate-700 dark:text-slate-300 whitespace-nowrap shrink-0 transition-colors"
                >
                  {concept}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Compact 1-Line Smart Indexing Strip (auto-hidden when actively viewing results unless indexing) */}
      {(!query.trim() || isIndexing) && (
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
      )}

      {/* Compact Results Bar: Match X of Y + Export */}
      {query.trim() && (
        <div className="flex items-center justify-between gap-2 px-0.5">
          <div className="flex items-center gap-1.5 text-[11px] font-mono tabular-nums text-slate-600 dark:text-slate-300">
            <span className="font-semibold">
              {results.length > 0
                ? `${safeMatchIdx + 1}/${results.length} hits`
                : '0 hits'}
            </span>
            {results.length > 1 && (
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() =>
                    setActiveMatchIdx((i) => (i - 1 + results.length) % results.length)
                  }
                  aria-label="Previous match"
                  className="w-6 h-6 rounded-md bg-white dark:bg-[#1C1C1E] border border-slate-200 dark:border-white/10 flex items-center justify-center"
                >
                  <ChevronLeft className="w-3.5 h-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => setActiveMatchIdx((i) => (i + 1) % results.length)}
                  aria-label="Next match"
                  className="w-6 h-6 rounded-md bg-white dark:bg-[#1C1C1E] border border-slate-200 dark:border-white/10 flex items-center justify-center"
                >
                  <ChevronRight className="w-3.5 h-3.5" />
                </button>
              </div>
            )}
          </div>

          {results.length > 0 && (
            <div className="flex items-center gap-1">
              <Download className="w-3 h-3 text-slate-400 mr-0.5" />
              {(['txt', 'md', 'csv', 'json'] as const).map((fmt) => (
                <button
                  key={fmt}
                  type="button"
                  onClick={() => handleExport(fmt)}
                  className="px-2 py-0.5 rounded-md text-[10px] font-mono font-semibold uppercase bg-white dark:bg-[#1C1C1E] border border-slate-200 dark:border-white/10 hover:border-orange-500 text-slate-700 dark:text-slate-200 transition-colors"
                >
                  {fmt}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* High-Density Search Results OR Saved Searches */}
      {query.trim() ? (
        results.length === 0 ? (
          <div className="bg-white dark:bg-[#1C1C1E] rounded-xl border border-slate-200/80 dark:border-white/10 p-6 text-center space-y-2">
            <h3 className="text-sm font-bold">
              {documents.length === 0
                ? 'No files indexed yet'
                : `No hits for "${query}"`}
            </h3>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              {documents.length === 0
                ? 'Index files from your device storage first to search text, OCR, and filenames.'
                : 'Try Natural Language (384-dim semantic vectors) or switch File Types to All.'}
            </p>
            {documents.length === 0 && (
              <IndexDeviceTrigger
                disabled={isIndexing}
                onOneTapIndexDevice={onOneTapIndexDevice}
                className="h-9 px-4 rounded-xl bg-orange-600 hover:bg-orange-700 text-white text-xs font-semibold inline-flex items-center justify-center"
              >
                Index Device
              </IndexDeviceTrigger>
            )}
          </div>
        ) : (
          <div className="bg-white dark:bg-[#1C1C1E] rounded-xl sm:rounded-2xl border border-slate-200/80 dark:border-white/10 divide-y divide-slate-100 dark:divide-white/8 overflow-hidden">
            {visibleResults.map((item, idx) => {
              const isFocused = idx === safeMatchIdx;
              const matchedPage = item.doc.pages[item.pageIndex] ?? item.doc.pages[0];
              return (
                <div
                  key={item.doc.id}
                  onClick={() => onOpenDocumentAtPage(item.doc.id, item.pageIndex)}
                  className={`px-2.5 py-2.5 sm:px-3.5 sm:py-3 cursor-pointer transition-colors flex gap-2.5 sm:gap-3 ${
                    isFocused
                      ? 'bg-orange-50/70 dark:bg-orange-950/25'
                      : 'hover:bg-slate-50/80 dark:hover:bg-white/[0.03]'
                  }`}
                >
                  <div className="w-10 h-14 sm:w-12 sm:h-16 rounded overflow-hidden bg-white border border-slate-200 shrink-0">
                    {matchedPage && (
                      <PageCanvasPreview page={matchedPage} className="w-full h-full" />
                    )}
                  </div>
                  <div className="min-w-0 flex-1 space-y-0.5">
                    <div className="flex items-center justify-between gap-2">
                      <h3 className="text-[13px] sm:text-sm font-bold text-slate-900 dark:text-white truncate">
                        {item.doc.title}
                      </h3>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onOpenOrganizer(item.doc.id);
                        }}
                        className="text-[11px] font-semibold text-orange-600 dark:text-orange-400 hover:underline flex items-center gap-1 shrink-0"
                      >
                        <Layers className="w-3 h-3" />
                        <span className="hidden sm:inline">Organize</span>
                      </button>
                    </div>
                    <div className="text-[11px] text-slate-500 dark:text-slate-400 font-mono tabular-nums flex flex-wrap items-center gap-x-1.5">
                      {item.doc.fileExtension && (
                        <>
                          <span className="uppercase font-semibold text-orange-600 dark:text-orange-400">
                            {item.doc.fileExtension}
                          </span>
                          <span aria-hidden="true">·</span>
                        </>
                      )}
                      <span>P{item.pageIndex + 1}</span>
                      <span aria-hidden="true">·</span>
                      <span>{item.matchCount} hit{item.matchCount > 1 ? 's' : ''}</span>
                      {item.semanticSimilarity !== undefined && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span className="text-orange-600 dark:text-orange-400 font-semibold">
                            {Math.round(item.semanticSimilarity * 100)}%
                          </span>
                        </>
                      )}
                      <span aria-hidden="true">·</span>
                      <span>{formatBytes(item.doc.sizeBytes)}</span>
                    </div>
                    {item.doc.sourcePath && (
                      <div className="text-[10px] font-mono text-slate-400 dark:text-slate-500 truncate">
                        {item.doc.sourcePath}
                      </div>
                    )}
                    <p className="text-xs text-slate-700 dark:text-slate-300 leading-snug line-clamp-2">
                      {highlightText(item.snippet, item.matchedTerms)}
                    </p>
                  </div>
                </div>
              );
            })}
            {visibleResultCount < results.length && (
              <div className="flex justify-center pt-2">
                <button
                  type="button"
                  onClick={() => setVisibleResultCount((c) => Math.min(results.length, c + 30))}
                  className="px-4 py-2 rounded-xl bg-slate-100 dark:bg-white/10 text-xs font-semibold text-slate-700 dark:text-slate-200"
                >
                  Showing {visibleResults.length} of {results.length} · Load more
                </button>
              </div>
            )}
          </div>
        )
      ) : (
        <div className="space-y-3">
          {documents.length > 0 && (
            <section className="bg-white dark:bg-[#1C1C1E] rounded-xl sm:rounded-2xl border border-slate-200/80 dark:border-white/10 p-3 sm:p-4 space-y-2">
              <div className="flex items-center justify-between">
                <h2 className="text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wide">
                  Indexed Files ({documents.length})
                </h2>
                <span className="text-[11px] text-slate-400">Tap to open or type above to search</span>
              </div>
              <div className="divide-y divide-slate-100 dark:divide-white/8 max-h-72 overflow-y-auto">
                {documents.slice(0, 20).map((doc) => (
                  <button
                    key={doc.id}
                    type="button"
                    onClick={() => onOpenDocumentAtPage(doc.id, 0)}
                    className="w-full py-2 flex items-center justify-between gap-2.5 text-left hover:bg-slate-50 dark:hover:bg-white/[0.03] px-1 rounded-lg"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="px-1.5 py-0.5 rounded bg-orange-600/12 text-orange-600 dark:text-orange-400 font-mono text-[10px] font-bold uppercase shrink-0">
                          {doc.fileExtension ?? 'pdf'}
                        </span>
                        <span className="text-xs sm:text-sm font-semibold text-slate-900 dark:text-white truncate">
                          {doc.title}
                        </span>
                      </div>
                      <div className="text-[11px] text-slate-500 truncate font-mono mt-0.5">
                        {doc.sourcePath || `${doc.pages.length}p`} · {formatBytes(doc.sizeBytes)}
                      </div>
                    </div>
                    <span className="text-[10px] font-semibold text-emerald-600 dark:text-emerald-400 shrink-0">
                      {doc.ocrStatus === 'done' ? 'OCR' : 'Indexed'}
                    </span>
                  </button>
                ))}
              </div>
            </section>
          )}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          <section className="bg-white dark:bg-[#1C1C1E] rounded-xl sm:rounded-2xl border border-slate-200/80 dark:border-white/10 p-3 sm:p-4 space-y-2">
            <h2 className="text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wide">
              Saved Searches
            </h2>
            {savedSearches.length === 0 ? (
              <p className="text-xs text-slate-500">Save frequent queries for one-tap recall.</p>
            ) : (
              <div className="divide-y divide-slate-100 dark:divide-white/8">
                {savedSearches.map((saved) => (
                  <div key={saved.id} className="py-1.5 flex items-center justify-between gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        setMode(saved.mode);
                        setQuery(saved.query);
                      }}
                      className="text-left min-w-0 flex-1"
                    >
                      <div className="text-xs sm:text-sm font-semibold text-slate-900 dark:text-white truncate hover:text-orange-600">
                        {saved.query}
                      </div>
                      <div className="text-[11px] text-slate-500 capitalize">
                        {saved.mode} · {formatShortDate(saved.createdAt)}
                      </div>
                    </button>
                    <button
                      type="button"
                      onClick={() => onDeleteSavedSearch(saved.id)}
                      className="p-1.5 text-slate-400 hover:text-red-600"
                      aria-label="Delete saved search"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="bg-white dark:bg-[#1C1C1E] rounded-xl sm:rounded-2xl border border-slate-200/80 dark:border-white/10 p-3 sm:p-4 space-y-2">
            <h2 className="text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wide">
              Starred Files
            </h2>
            {documents.filter((d) => d.isBookmarked).length === 0 ? (
              <p className="text-xs text-slate-500">Star files to keep them pinned here.</p>
            ) : (
              <div className="divide-y divide-slate-100 dark:divide-white/8">
                {documents
                  .filter((d) => d.isBookmarked)
                  .map((doc) => (
                    <button
                      key={doc.id}
                      type="button"
                      onClick={() => onOpenDocumentAtPage(doc.id, 0)}
                      className="w-full py-1.5 flex items-center justify-between gap-2 text-left hover:opacity-80"
                    >
                      <div className="min-w-0">
                        <div className="text-xs sm:text-sm font-semibold truncate">{doc.title}</div>
                        <div className="text-[11px] text-slate-500 font-mono tabular-nums">
                          {doc.pages.length}p · {formatBytes(doc.sizeBytes)}
                        </div>
                      </div>
                      <Bookmark className="w-3.5 h-3.5 fill-orange-500 text-orange-500 shrink-0" />
                    </button>
                  ))}
              </div>
            )}
          </section>
          </div>
        </div>
      )}
    </div>
  );
};
