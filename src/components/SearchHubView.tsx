import React, { useMemo, useState } from 'react';
import {
  Bookmark,
  BookmarkPlus,
  ChevronLeft,
  ChevronRight,
  Download,
  Layers,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import { SavedSearch, ScanDocument, SearchMode } from '../types/filelens';
import { formatBytes, formatShortDate, triggerFileDownload } from '../utils/formatters';
import { exportSearchResults, runDocumentSearch } from '../utils/searchEngine';
import { PageCanvasPreview } from './PageCanvasPreview';

interface SearchHubViewProps {
  documents: ScanDocument[];
  savedSearches: SavedSearch[];
  onSaveSearch: (query: string, mode: SearchMode) => void;
  onDeleteSavedSearch: (id: string) => void;
  onOpenDocumentAtPage: (docId: string, pageIndex: number) => void;
  onOpenOrganizer: (docId: string) => void;
  onToast: (message: string) => void;
}

const SEARCH_MODES: { id: SearchMode; label: string; hint: string }[] = [
  { id: 'quick', label: 'Quick Search', hint: 'Partial + bilingual Hinglish/concept expansion (try "bill", "doctor", "dawai")' },
  { id: 'natural', label: 'Natural Language', hint: 'Semantic phrase discovery (try "show my paid studio invoice")' },
  { id: 'exact', label: 'Exact Match', hint: 'Exact phrase substring match (try "Apex Solutions")' },
  { id: 'whole', label: 'Whole Word', hint: 'Strict word boundary matching (try "PAID")' },
  { id: 'wildcard', label: 'Wildcard', hint: 'Use * and ? wildcards (try "Micro*" or "NDS-????")' },
  { id: 'boolean', label: 'Boolean', hint: 'Combine AND / OR / NOT operators (try "PAID AND Invoice")' },
];

const QUICK_CONCEPTS = ['PAID AND Invoice', 'cholesterol', 'Apex*', 'doctor', 'API Gateway', 'ID Card'];

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
  onSaveSearch,
  onDeleteSavedSearch,
  onOpenDocumentAtPage,
  onOpenOrganizer,
  onToast,
}) => {
  const [query, setQuery] = useState<string>('');
  const [mode, setMode] = useState<SearchMode>('quick');
  const [activeMatchIdx, setActiveMatchIdx] = useState<number>(0);

  const results = useMemo(() => runDocumentSearch(documents, query, mode), [documents, query, mode]);

  const safeMatchIdx = results.length > 0 ? Math.min(activeMatchIdx, results.length - 1) : 0;
  const currentModeMeta = SEARCH_MODES.find((m) => m.id === mode)!;

  const handleExport = (format: 'txt' | 'md' | 'csv' | 'json') => {
    if (results.length === 0) return;
    const { content, mime, ext } = exportSearchResults(results, query, format);
    const blob = new Blob([content], { type: mime });
    triggerFileDownload(blob, `FileLens_Search_${Date.now()}.${ext}`);
    onToast(`Exported ${results.length} OCR result(s) as ${ext.toUpperCase()}`);
  };

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-slate-900 dark:text-white">
          OCR Search Hub
        </h1>
        <p className="text-xs sm:text-sm text-slate-500 dark:text-slate-400 mt-0.5">
          6 offline intelligence modes across {documents.length} indexed PDFs and{' '}
          {documents.reduce((acc, d) => acc + d.pages.length, 0)} scanned pages
        </p>
      </div>

      {/* Search Input Bar */}
      <div className="bg-white dark:bg-[#1C1C1E] rounded-2xl p-4 border border-slate-200/80 dark:border-white/10 space-y-3.5">
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="w-4 h-4 text-orange-600 dark:text-orange-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setActiveMatchIdx(0);
              }}
              placeholder="Search inside scanned PDFs, receipts, lab values, or clauses…"
              className="w-full h-12 pl-10 pr-9 rounded-xl bg-slate-50 dark:bg-[#2C2C2E] border border-slate-200 dark:border-white/10 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery('')}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
              >
                <X className="w-4 h-4" />
              </button>
            )}
          </div>
          <button
            type="button"
            disabled={!query.trim()}
            onClick={() => {
              onSaveSearch(query.trim(), mode);
              onToast('Saved search query');
            }}
            title="Save this search"
            className="h-12 px-3.5 rounded-xl bg-slate-100 dark:bg-[#2C2C2E] hover:bg-orange-50 dark:hover:bg-orange-950/40 text-slate-700 dark:text-slate-200 hover:text-orange-600 disabled:opacity-40 flex items-center gap-1.5 text-xs font-semibold whitespace-nowrap transition-colors"
          >
            <BookmarkPlus className="w-4 h-4" />
            <span className="hidden sm:inline">Save</span>
          </button>
        </div>

        {/* 6 Search Modes Segmented Bar */}
        <div className="flex items-center gap-1.5 overflow-x-auto pb-0.5">
          {SEARCH_MODES.map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={() => {
                setMode(m.id);
                setActiveMatchIdx(0);
              }}
              className={`min-h-[36px] px-3 rounded-lg text-xs font-semibold transition-colors whitespace-nowrap shrink-0 ${
                mode === m.id
                  ? 'bg-orange-600 text-white'
                  : 'bg-slate-100 dark:bg-[#2C2C2E] text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-white/15'
              }`}
            >
              {m.label}
            </button>
          ))}
        </div>

        <p className="text-xs text-slate-500 dark:text-slate-400">{currentModeMeta.hint}</p>

        {/* Quick Concept Suggestions */}
        <div className="flex items-center gap-1.5 overflow-x-auto pt-1">
          <span className="text-xs text-slate-400 shrink-0 mr-1">Try:</span>
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
              className="px-2.5 py-1 rounded-lg text-xs font-medium bg-slate-50 dark:bg-[#2C2C2E] border border-slate-200/80 dark:border-white/8 hover:border-orange-400 text-slate-700 dark:text-slate-300 whitespace-nowrap shrink-0 transition-colors"
            >
              {concept}
            </button>
          ))}
        </div>
      </div>

      {/* Results Header: Match X of Y Navigation + Export Extracted Text */}
      {query.trim() && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-xs font-mono tabular-nums text-slate-600 dark:text-slate-300">
            <span className="font-semibold">
              {results.length > 0
                ? `Match ${safeMatchIdx + 1} of ${results.length}`
                : '0 matching documents'}
            </span>
            {results.length > 1 && (
              <div className="flex items-center gap-1 ml-1">
                <button
                  type="button"
                  onClick={() =>
                    setActiveMatchIdx((i) => (i - 1 + results.length) % results.length)
                  }
                  className="w-7 h-7 rounded-lg bg-white dark:bg-[#1C1C1E] border border-slate-200 dark:border-white/10 flex items-center justify-center"
                >
                  <ChevronLeft className="w-3.5 h-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => setActiveMatchIdx((i) => (i + 1) % results.length)}
                  className="w-7 h-7 rounded-lg bg-white dark:bg-[#1C1C1E] border border-slate-200 dark:border-white/10 flex items-center justify-center"
                >
                  <ChevronRight className="w-3.5 h-3.5" />
                </button>
              </div>
            )}
          </div>

          {results.length > 0 && (
            <div className="flex items-center gap-1.5">
              <span className="text-xs text-slate-500 flex items-center gap-1 mr-1">
                <Download className="w-3.5 h-3.5" />
                <span>Export:</span>
              </span>
              {(['txt', 'md', 'csv', 'json'] as const).map((fmt) => (
                <button
                  key={fmt}
                  type="button"
                  onClick={() => handleExport(fmt)}
                  className="px-2.5 py-1.5 rounded-lg text-[11px] font-mono font-semibold uppercase bg-white dark:bg-[#1C1C1E] border border-slate-200 dark:border-white/10 hover:border-orange-500 text-slate-700 dark:text-slate-200 transition-colors"
                >
                  {fmt}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Search Results OR Saved Searches */}
      {query.trim() ? (
        results.length === 0 ? (
          <div className="bg-white dark:bg-[#1C1C1E] rounded-2xl border border-slate-200/80 dark:border-white/10 p-10 text-center space-y-2">
            <h3 className="text-sm font-bold">No OCR hits for &ldquo;{query}&rdquo;</h3>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Switch to Quick Search for bilingual/concept matching or Natural Language for broader recall.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {results.map((item, idx) => {
              const isFocused = idx === safeMatchIdx;
              const matchedPage = item.doc.pages[item.pageIndex] ?? item.doc.pages[0];
              return (
                <div
                  key={item.doc.id}
                  onClick={() => onOpenDocumentAtPage(item.doc.id, item.pageIndex)}
                  className={`bg-white dark:bg-[#1C1C1E] rounded-2xl p-4 border cursor-pointer transition-all flex gap-4 ${
                    isFocused
                      ? 'border-orange-500 ring-2 ring-orange-500/20'
                      : 'border-slate-200/80 dark:border-white/10 hover:border-slate-300'
                  }`}
                >
                  <div className="w-14 h-20 rounded-lg overflow-hidden bg-white border border-slate-200 shrink-0">
                    {matchedPage && (
                      <PageCanvasPreview page={matchedPage} className="w-full h-full" />
                    )}
                  </div>
                  <div className="min-w-0 flex-1 space-y-1.5">
                    <div className="flex items-start justify-between gap-2">
                      <h3 className="text-sm font-bold text-slate-900 dark:text-white truncate">
                        {item.doc.title}
                      </h3>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onOpenOrganizer(item.doc.id);
                        }}
                        className="text-xs font-semibold text-orange-600 dark:text-orange-400 hover:underline flex items-center gap-1 shrink-0"
                      >
                        <Layers className="w-3.5 h-3.5" />
                        <span>Organize</span>
                      </button>
                    </div>
                    <div className="text-xs text-slate-500 dark:text-slate-400 font-mono tabular-nums">
                      Jump to Page {item.pageIndex + 1} · {item.matchCount} match
                      {item.matchCount > 1 ? 'es' : ''} · {formatBytes(item.doc.sizeBytes)} ·{' '}
                      {formatShortDate(item.doc.updatedAt)}
                    </div>
                    <p className="text-xs sm:text-sm text-slate-700 dark:text-slate-300 leading-relaxed">
                      {highlightText(item.snippet, item.matchedTerms)}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
        )
      ) : (
        /* Saved Searches & Bookmarked Documents Overview */
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          <section className="bg-white dark:bg-[#1C1C1E] rounded-2xl border border-slate-200/80 dark:border-white/10 p-4 sm:p-5 space-y-3">
            <h2 className="text-sm font-bold">Saved Searches</h2>
            {savedSearches.length === 0 ? (
              <p className="text-xs text-slate-500">Save frequent queries for one-tap recall.</p>
            ) : (
              <div className="divide-y divide-slate-100 dark:divide-white/8">
                {savedSearches.map((saved) => (
                  <div key={saved.id} className="py-2.5 flex items-center justify-between gap-3">
                    <button
                      type="button"
                      onClick={() => {
                        setMode(saved.mode);
                        setQuery(saved.query);
                      }}
                      className="text-left min-w-0 flex-1"
                    >
                      <div className="text-sm font-semibold text-slate-900 dark:text-white truncate hover:text-orange-600">
                        {saved.query}
                      </div>
                      <div className="text-xs text-slate-500 capitalize">
                        {saved.mode} mode · {formatShortDate(saved.createdAt)}
                      </div>
                    </button>
                    <button
                      type="button"
                      onClick={() => onDeleteSavedSearch(saved.id)}
                      className="p-2 text-slate-400 hover:text-red-600"
                      aria-label="Delete saved search"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="bg-white dark:bg-[#1C1C1E] rounded-2xl border border-slate-200/80 dark:border-white/10 p-4 sm:p-5 space-y-3">
            <h2 className="text-sm font-bold">Starred Documents</h2>
            {documents.filter((d) => d.isBookmarked).length === 0 ? (
              <p className="text-xs text-slate-500">Star documents to keep them pinned here.</p>
            ) : (
              <div className="divide-y divide-slate-100 dark:divide-white/8">
                {documents
                  .filter((d) => d.isBookmarked)
                  .map((doc) => (
                    <button
                      key={doc.id}
                      type="button"
                      onClick={() => onOpenDocumentAtPage(doc.id, 0)}
                      className="w-full py-2.5 flex items-center justify-between gap-3 text-left hover:opacity-80"
                    >
                      <div className="min-w-0">
                        <div className="text-sm font-semibold truncate">{doc.title}</div>
                        <div className="text-xs text-slate-500 font-mono tabular-nums">
                          {doc.pages.length} pages · {formatBytes(doc.sizeBytes)}
                        </div>
                      </div>
                      <Bookmark className="w-4 h-4 fill-orange-500 text-orange-500 shrink-0" />
                    </button>
                  ))}
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  );
};
