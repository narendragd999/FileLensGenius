import React, { useEffect, useMemo, useState } from 'react';
import {
  Bookmark,
  Brain,
  Camera,
  CreditCard,
  FileText,
  Folder,
  Moon,
  Search,
  Settings,
  Sun,
} from 'lucide-react';
import {
  AppPreferences,
  AppTab,
  DocFolder,
  DocumentPage,
  FULL_QUAD,
  PdfCompressPreset,
  SavedSearch,
  SavedSignature,
  ScanDocument,
  ScanMode,
  SearchMode,
  SmartCardCategory,
  VoiceNote,
} from './types/filelens';
import {
  DEFAULT_PREFERENCES,
  INITIAL_DOCUMENTS,
  INITIAL_FOLDERS,
  INITIAL_SAVED_SEARCHES,
  INITIAL_VOICE_NOTES,
} from './data/seedData';
import { resolveNamingTemplate } from './utils/formatters';
import { DocumentsView } from './components/DocumentsView';
import { SearchHubView } from './components/SearchHubView';
import { SecondBrainView } from './components/SecondBrainView';
import { SmartCardsView } from './components/SmartCardsView';
import { ToolsAndSettingsView } from './components/ToolsAndSettingsView';
import { LiveScannerModal } from './components/LiveScannerModal';
import { PageOrganizerModal } from './components/PageOrganizerModal';
import { PdfViewerModal } from './components/PdfViewerModal';

const STORAGE_KEY = 'filelens_scan_workspace_v1';

interface PersistedState {
  documents: ScanDocument[];
  folders: DocFolder[];
  voiceNotes: VoiceNote[];
  savedSearches: SavedSearch[];
  savedSignatures: SavedSignature[];
  preferences: AppPreferences;
}

function loadInitialState(): PersistedState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<PersistedState>;
      if (Array.isArray(parsed.documents) && parsed.documents.length > 0) {
        return {
          documents: parsed.documents,
          folders: parsed.folders ?? INITIAL_FOLDERS,
          voiceNotes: parsed.voiceNotes ?? INITIAL_VOICE_NOTES,
          savedSearches: parsed.savedSearches ?? INITIAL_SAVED_SEARCHES,
          savedSignatures: parsed.savedSignatures ?? [],
          preferences: { ...DEFAULT_PREFERENCES, ...(parsed.preferences ?? {}) },
        };
      }
    }
  } catch {
    // Fallback to seed state
  }
  return {
    documents: INITIAL_DOCUMENTS,
    folders: INITIAL_FOLDERS,
    voiceNotes: INITIAL_VOICE_NOTES,
    savedSearches: INITIAL_SAVED_SEARCHES,
    savedSignatures: [],
    preferences: DEFAULT_PREFERENCES,
  };
}

export default function App() {
  const initial = useMemo(() => loadInitialState(), []);
  const [documents, setDocuments] = useState<ScanDocument[]>(initial.documents);
  const [folders, setFolders] = useState<DocFolder[]>(initial.folders);
  const [voiceNotes, setVoiceNotes] = useState<VoiceNote[]>(initial.voiceNotes);
  const [savedSearches, setSavedSearches] = useState<SavedSearch[]>(initial.savedSearches);
  const [savedSignatures, setSavedSignatures] = useState<SavedSignature[]>(initial.savedSignatures);
  const [preferences, setPreferences] = useState<AppPreferences>(initial.preferences);

  const [activeTab, setActiveTab] = useState<AppTab>('documents');
  const [selectedFolderId, setSelectedFolderId] = useState<string>('all');

  // Full-screen Genius Scan studios
  const [scannerState, setScannerState] = useState<{
    open: boolean;
    mode: ScanMode;
    appendToDocId?: string;
  }>({ open: false, mode: 'batch' });
  const [viewerState, setViewerState] = useState<{ docId: string; pageIndex: number } | null>(null);
  const [organizerDocId, setOrganizerDocId] = useState<string | null>(null);
  const [toastMsg, setToastMsg] = useState<string | null>(null);

  // Sync light/dark class on <html>
  useEffect(() => {
    const root = document.documentElement;
    if (preferences.theme === 'dark') {
      root.classList.add('dark');
    } else {
      root.classList.remove('dark');
    }
  }, [preferences.theme]);

  // Persist workspace cleanly to localStorage
  useEffect(() => {
    try {
      const payload: PersistedState = {
        documents,
        folders,
        voiceNotes,
        savedSearches,
        savedSignatures,
        preferences,
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    } catch {
      // Ignore quota exceeded for large custom image uploads
    }
  }, [documents, folders, voiceNotes, savedSearches, savedSignatures, preferences]);

  const showToast = (message: string) => {
    setToastMsg(message);
  };

  useEffect(() => {
    if (!toastMsg) return;
    const t = window.setTimeout(() => setToastMsg(null), 2800);
    return () => window.clearTimeout(t);
  }, [toastMsg]);

  const activeViewerDoc = useMemo(
    () => (viewerState ? documents.find((d) => d.id === viewerState.docId) ?? null : null),
    [documents, viewerState]
  );

  const activeOrganizerDoc = useMemo(
    () => (organizerDocId ? documents.find((d) => d.id === organizerDocId) ?? null : null),
    [documents, organizerDocId]
  );

  const appendTargetDoc = useMemo(
    () =>
      scannerState.appendToDocId
        ? documents.find((d) => d.id === scannerState.appendToDocId) ?? null
        : null,
    [documents, scannerState.appendToDocId]
  );

  const updateDocument = (updated: ScanDocument) => {
    setDocuments((prev) => prev.map((d) => (d.id === updated.id ? updated : d)));
  };

  const handleImportFilesAsDocument = (files: FileList) => {
    const readers = Array.from(files).map(
      (file, idx) =>
        new Promise<DocumentPage>((resolve) => {
          const reader = new FileReader();
          reader.onload = () => {
            resolve({
              id: `pg-imp-${Date.now()}-${idx}`,
              imageUrl: String(reader.result),
              rotation: 0,
              filter: preferences.defaultFilter,
              quad: FULL_QUAD,
              brightness: 1,
              contrast: 1,
              ocrText: `Imported scan from ${file.name}.`,
              signatures: [],
            });
          };
          reader.readAsDataURL(file);
        })
    );

    Promise.all(readers).then((pages) => {
      const newDoc: ScanDocument = {
        id: `doc-imp-${Date.now()}`,
        title:
          files.length === 1
            ? files[0].name.replace(/\.[^.]+$/, '')
            : resolveNamingTemplate(preferences.namingTemplate, documents.length + 1),
        folderId: selectedFolderId !== 'all' && selectedFolderId !== 'bookmarked' ? selectedFolderId : 'inbox',
        tags: ['Imported'],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        pages,
        isBookmarked: false,
        isSmartCard: false,
        pageSizePreset: preferences.defaultPageSize,
        qualityPreset: preferences.defaultQuality,
        sizeBytes: Array.from(files).reduce((acc, f) => acc + f.size, 0) || pages.length * 380_000,
        searchableOcr: preferences.searchablePdfOcrLayer,
      };
      setDocuments((prev) => [newDoc, ...prev]);
      setOrganizerDocId(newDoc.id);
      showToast(`Imported ${pages.length} page(s) — ready to organize`);
    });
  };

  const handleMergeDocuments = (docIds: string[]) => {
    const targets = documents.filter((d) => docIds.includes(d.id));
    if (targets.length < 2) return;
    const mergedPages: DocumentPage[] = targets.flatMap((d, dIdx) =>
      d.pages.map((p, pIdx) => ({ ...p, id: `pg-m-${Date.now()}-${dIdx}-${pIdx}` }))
    );
    const merged: ScanDocument = {
      ...targets[0],
      id: `doc-merged-${Date.now()}`,
      title: `${targets[0].title} + ${targets.length - 1} merged`,
      pages: mergedPages,
      sizeBytes: targets.reduce((acc, d) => acc + d.sizeBytes, 0),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    setDocuments((prev) => [merged, ...prev]);
    setOrganizerDocId(merged.id);
    showToast(`Merged ${targets.length} PDFs (${mergedPages.length} pages)`);
  };

  const handleBatchCompressPdfs = (preset: PdfCompressPreset) => {
    const ratio = preset === 'email_small' ? 0.34 : preset === 'balanced' ? 0.54 : 0.78;
    const qualityPreset =
      preset === 'email_small' ? 'compact' : preset === 'balanced' ? 'balanced' : 'high';
    let savedBytes = 0;
    setDocuments((prev) =>
      prev.map((d) => {
        const nextSize = Math.max(95_000, Math.round(d.sizeBytes * ratio));
        savedBytes += Math.max(0, d.sizeBytes - nextSize);
        return { ...d, sizeBytes: nextSize, qualityPreset, updatedAt: new Date().toISOString() };
      })
    );
    return { savedBytes, count: documents.length };
  };

  const navItems: { id: AppTab; label: string; icon: React.ReactNode }[] = [
    { id: 'documents', label: 'Documents', icon: <FileText className="w-5 h-5" /> },
    { id: 'search', label: 'Search', icon: <Search className="w-5 h-5" /> },
    { id: 'brain', label: 'Brain', icon: <Brain className="w-5 h-5" /> },
    { id: 'cards', label: 'Cards', icon: <CreditCard className="w-5 h-5" /> },
    { id: 'settings', label: 'Tools', icon: <Settings className="w-5 h-5" /> },
  ];

  return (
    <div className="min-h-screen flex bg-[#F2F2F7] dark:bg-[#000000] text-slate-900 dark:text-[#F5F5F7]">
      {/* Desktop Left Sidebar Rail (iPadOS / macOS Catalyst Genius Scan Layout) */}
      <aside className="hidden lg:flex lg:flex-col lg:w-68 xl:w-72 shrink-0 bg-white dark:bg-[#1C1C1E] border-r border-slate-200/80 dark:border-white/10 sticky top-0 h-screen">
        <div className="p-5 flex items-center justify-between">
          <span className="text-lg font-bold tracking-tight text-slate-900 dark:text-white whitespace-nowrap">
            FileLens Scan
          </span>
          <button
            type="button"
            onClick={() =>
              setPreferences((p) => ({ ...p, theme: p.theme === 'dark' ? 'light' : 'dark' }))
            }
            aria-label="Toggle color theme"
            className="w-9 h-9 rounded-xl flex items-center justify-center text-slate-500 hover:bg-slate-100 dark:hover:bg-white/10 transition-colors"
          >
            {preferences.theme === 'dark' ? (
              <Sun className="w-4 h-4" />
            ) : (
              <Moon className="w-4 h-4" />
            )}
          </button>
        </div>

        {/* Primary Genius Scan Orange CTA */}
        <div className="px-4 pb-4">
          <button
            type="button"
            onClick={() => setScannerState({ open: true, mode: 'batch' })}
            className="w-full h-11 rounded-xl bg-orange-600 hover:bg-orange-700 text-white text-sm font-semibold flex items-center justify-center gap-2 transition-colors shadow-sm shadow-orange-600/20"
          >
            <Camera className="w-4 h-4" />
            <span>Scan Document</span>
          </button>
        </div>

        {/* Primary Navigation Links */}
        <nav className="px-3 space-y-1">
          {navItems.map((item) => {
            const active = activeTab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setActiveTab(item.id)}
                className={`w-full h-11 px-3 rounded-xl text-sm font-semibold flex items-center gap-3 transition-colors ${
                  active
                    ? 'bg-orange-50 dark:bg-orange-950/40 text-orange-700 dark:text-orange-400'
                    : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-white/8'
                }`}
              >
                {item.icon}
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>

        {/* Sidebar Folders List */}
        <div className="mt-6 px-3 flex-1 overflow-y-auto">
          <div className="px-3 pb-2 text-xs font-semibold text-slate-400 dark:text-slate-500">
            Folders
          </div>
          <div className="space-y-0.5">
            <button
              type="button"
              onClick={() => {
                setSelectedFolderId('all');
                setActiveTab('documents');
              }}
              className={`w-full h-9 px-3 rounded-lg text-xs font-medium flex items-center justify-between transition-colors ${
                activeTab === 'documents' && selectedFolderId === 'all'
                  ? 'bg-slate-100 dark:bg-[#2C2C2E] text-slate-900 dark:text-white font-semibold'
                  : 'text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-white/5'
              }`}
            >
              <span className="flex items-center gap-2 truncate">
                <Folder className="w-3.5 h-3.5 text-orange-600" />
                <span>All Scans</span>
              </span>
              <span className="font-mono tabular-nums text-slate-400">{documents.length}</span>
            </button>
            <button
              type="button"
              onClick={() => {
                setSelectedFolderId('bookmarked');
                setActiveTab('documents');
              }}
              className={`w-full h-9 px-3 rounded-lg text-xs font-medium flex items-center justify-between transition-colors ${
                activeTab === 'documents' && selectedFolderId === 'bookmarked'
                  ? 'bg-slate-100 dark:bg-[#2C2C2E] text-slate-900 dark:text-white font-semibold'
                  : 'text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-white/5'
              }`}
            >
              <span className="flex items-center gap-2 truncate">
                <Bookmark className="w-3.5 h-3.5 text-orange-600" />
                <span>Starred</span>
              </span>
              <span className="font-mono tabular-nums text-slate-400">
                {documents.filter((d) => d.isBookmarked).length}
              </span>
            </button>
            {folders.map((folder) => {
              const count = documents.filter((d) => d.folderId === folder.id).length;
              return (
                <button
                  key={folder.id}
                  type="button"
                  onClick={() => {
                    setSelectedFolderId(folder.id);
                    setActiveTab('documents');
                  }}
                  className={`w-full h-9 px-3 rounded-lg text-xs font-medium flex items-center justify-between transition-colors ${
                    activeTab === 'documents' && selectedFolderId === folder.id
                      ? 'bg-slate-100 dark:bg-[#2C2C2E] text-slate-900 dark:text-white font-semibold'
                      : 'text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-white/5'
                  }`}
                >
                  <span className="flex items-center gap-2 truncate">
                    <Folder className="w-3.5 h-3.5 opacity-60" />
                    <span className="truncate">{folder.name}</span>
                  </span>
                  <span className="font-mono tabular-nums text-slate-400">{count}</span>
                </button>
              );
            })}
          </div>
        </div>
      </aside>

      {/* Main Responsive Content Column */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Compact Mobile Top Bar (< 1024px) */}
        <header className="lg:hidden sticky top-0 z-30 h-12 px-4 bg-white/90 dark:bg-[#1C1C1E]/90 backdrop-blur-md border-b border-slate-200/80 dark:border-white/10 flex items-center justify-between">
          <span className="text-base font-bold tracking-tight whitespace-nowrap">
            FileLens Scan
          </span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setActiveTab('settings')}
              aria-label="Tools and Preferences"
              className={`w-10 h-10 rounded-xl flex items-center justify-center transition-colors ${
                activeTab === 'settings'
                  ? 'text-orange-600 dark:text-orange-400 bg-orange-50 dark:bg-orange-950/40'
                  : 'text-slate-600 dark:text-slate-300'
              }`}
            >
              <Settings className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={() =>
                setPreferences((p) => ({ ...p, theme: p.theme === 'dark' ? 'light' : 'dark' }))
              }
              aria-label="Toggle light and dark theme"
              className="w-10 h-10 rounded-xl flex items-center justify-center text-slate-600 dark:text-slate-300"
            >
              {preferences.theme === 'dark' ? (
                <Sun className="w-4 h-4" />
              ) : (
                <Moon className="w-4 h-4" />
              )}
            </button>
          </div>
        </header>

        {/* Scrollable Workspace Body */}
        <main className="flex-1 px-4 sm:px-6 lg:px-8 py-5 sm:py-7 pb-24 lg:pb-10">
          <div className="max-w-6xl mx-auto">
            {activeTab === 'documents' && (
              <DocumentsView
                documents={documents}
                folders={folders}
                selectedFolderId={selectedFolderId}
                onSelectFolder={setSelectedFolderId}
                onCreateFolder={(name) => {
                  const id = `folder-${Date.now()}`;
                  setFolders((prev) => [...prev, { id, name, icon: 'folder' }]);
                  setSelectedFolderId(id);
                  showToast(`Created folder "${name}"`);
                }}
                onOpenScanner={(mode) => setScannerState({ open: true, mode })}
                onImportFilesAsDocument={handleImportFilesAsDocument}
                onOpenViewer={(docId) => setViewerState({ docId, pageIndex: 0 })}
                onOpenOrganizer={(docId) => setOrganizerDocId(docId)}
                onToggleBookmark={(docId) => {
                  setDocuments((prev) =>
                    prev.map((d) =>
                      d.id === docId ? { ...d, isBookmarked: !d.isBookmarked } : d
                    )
                  );
                }}
                onRenameDocument={(docId, newTitle) => {
                  setDocuments((prev) =>
                    prev.map((d) =>
                      d.id === docId
                        ? { ...d, title: newTitle, updatedAt: new Date().toISOString() }
                        : d
                    )
                  );
                  showToast(`Renamed to "${newTitle}"`);
                }}
                onMoveDocumentsToFolder={(docIds, folderId) => {
                  const idSet = new Set(docIds);
                  setDocuments((prev) =>
                    prev.map((d) => (idSet.has(d.id) ? { ...d, folderId } : d))
                  );
                  const folderName = folders.find((f) => f.id === folderId)?.name ?? 'folder';
                  showToast(`Moved ${docIds.length} document(s) to ${folderName}`);
                }}
                onMergeDocuments={handleMergeDocuments}
                onDeleteDocuments={(docIds) => {
                  const idSet = new Set(docIds);
                  setDocuments((prev) => prev.filter((d) => !idSet.has(d.id)));
                  showToast(`Deleted ${docIds.length} document(s)`);
                }}
                onToast={showToast}
              />
            )}

            {activeTab === 'search' && (
              <SearchHubView
                documents={documents}
                savedSearches={savedSearches}
                onSaveSearch={(query, mode: SearchMode) => {
                  setSavedSearches((prev) => [
                    { id: `ss-${Date.now()}`, query, mode, createdAt: new Date().toISOString() },
                    ...prev,
                  ]);
                }}
                onDeleteSavedSearch={(id) =>
                  setSavedSearches((prev) => prev.filter((s) => s.id !== id))
                }
                onOpenDocumentAtPage={(docId, pageIndex) => setViewerState({ docId, pageIndex })}
                onOpenOrganizer={(docId) => setOrganizerDocId(docId)}
                onToast={showToast}
              />
            )}

            {activeTab === 'brain' && (
              <SecondBrainView
                notes={voiceNotes}
                documents={documents}
                voiceLanguage={preferences.voiceLanguage}
                onChangeVoiceLanguage={(code) =>
                  setPreferences((p) => ({ ...p, voiceLanguage: code }))
                }
                onAddNote={(note) => setVoiceNotes((prev) => [note, ...prev])}
                onUpdateNote={(updated) =>
                  setVoiceNotes((prev) => prev.map((n) => (n.id === updated.id ? updated : n)))
                }
                onDeleteNote={(id) => {
                  setVoiceNotes((prev) => prev.filter((n) => n.id !== id));
                  showToast('Deleted voice note');
                }}
                onOpenDocument={(docId) => setViewerState({ docId, pageIndex: 0 })}
                onToast={showToast}
              />
            )}

            {activeTab === 'cards' && (
              <SmartCardsView
                documents={documents}
                privacyBlur={preferences.privacyBlurCards}
                onTogglePrivacyBlur={() =>
                  setPreferences((p) => ({ ...p, privacyBlurCards: !p.privacyBlurCards }))
                }
                onLaunchIdScanner={() => setScannerState({ open: true, mode: 'idcard' })}
                onPromoteDocumentToCard={(docId, category: SmartCardCategory, expiryDate) => {
                  setDocuments((prev) =>
                    prev.map((d) =>
                      d.id === docId
                        ? { ...d, isSmartCard: true, cardCategory: category, expiryDate }
                        : d
                    )
                  );
                }}
                onUpdateCardExpiry={(docId, expiryDate) => {
                  setDocuments((prev) =>
                    prev.map((d) =>
                      d.id === docId ? { ...d, expiryDate: expiryDate || undefined } : d
                    )
                  );
                }}
                onScheduleExpiryReminder={(doc, expiryDate) => {
                  const reminder: VoiceNote = {
                    id: `vn-exp-${Date.now()}`,
                    title: `Renew "${doc.title}" before ${expiryDate}`,
                    transcript: `Renewal radar alert for ${doc.title} expiring on ${expiryDate}.`,
                    temporalClass: 'upcoming',
                    scheduledDate: expiryDate,
                    recurrence: 'none',
                    linkedDocId: doc.id,
                    languageCode: preferences.voiceLanguage,
                    createdAt: new Date().toISOString(),
                    checklist: [
                      { id: `c-exp-1-${Date.now()}`, text: 'Prepare renewal application', done: false },
                      { id: `c-exp-2-${Date.now()}`, text: 'Scan updated card in FileLens', done: false },
                    ],
                  };
                  setVoiceNotes((prev) => [reminder, ...prev]);
                  showToast('Scheduled renewal alert in Second Brain');
                }}
                onOpenViewer={(docId) => setViewerState({ docId, pageIndex: 0 })}
                onOpenOrganizer={(docId) => setOrganizerDocId(docId)}
                onToast={showToast}
              />
            )}

            {activeTab === 'settings' && (
              <ToolsAndSettingsView
                documents={documents}
                preferences={preferences}
                onUpdatePreferences={setPreferences}
                onBatchCompressPdfs={handleBatchCompressPdfs}
                onExportWorkspaceBackup={() =>
                  JSON.stringify(
                    {
                      formatVersion: 1,
                      exportedAtIso: new Date().toISOString(),
                      documents,
                      folders,
                      voiceNotes,
                      savedSearches,
                      savedSignatures,
                      preferences,
                    },
                    null,
                    2
                  )
                }
                onImportWorkspaceBackup={(json) => {
                  try {
                    const parsed = JSON.parse(json) as Partial<PersistedState>;
                    if (!Array.isArray(parsed.documents)) return false;
                    setDocuments(parsed.documents);
                    if (parsed.folders) setFolders(parsed.folders);
                    if (parsed.voiceNotes) setVoiceNotes(parsed.voiceNotes);
                    if (parsed.savedSearches) setSavedSearches(parsed.savedSearches);
                    if (parsed.savedSignatures) setSavedSignatures(parsed.savedSignatures);
                    if (parsed.preferences) {
                      setPreferences({ ...DEFAULT_PREFERENCES, ...parsed.preferences });
                    }
                    return true;
                  } catch {
                    return false;
                  }
                }}
                onResetDemoWorkspace={() => {
                  setDocuments(INITIAL_DOCUMENTS);
                  setFolders(INITIAL_FOLDERS);
                  setVoiceNotes(INITIAL_VOICE_NOTES);
                  setSavedSearches(INITIAL_SAVED_SEARCHES);
                  setSavedSignatures([]);
                  setPreferences(DEFAULT_PREFERENCES);
                  localStorage.removeItem(STORAGE_KEY);
                  showToast('Restored default sample documents');
                }}
                onToast={showToast}
              />
            )}
          </div>
        </main>

        {/* Mobile Fixed Bottom Navigation Bar with Centered Genius Scan Orange Camera FAB */}
        <nav
          aria-label="Primary navigation"
          className="lg:hidden fixed bottom-0 left-0 right-0 z-30 bg-white/95 dark:bg-[#1C1C1E]/95 backdrop-blur-md border-t border-slate-200/80 dark:border-white/10 pb-safe"
        >
          <div className="grid grid-cols-5 items-center h-15 px-1">
            <MobileTabButton
              active={activeTab === 'documents'}
              label="Docs"
              icon={<FileText className="w-5 h-5" />}
              onClick={() => setActiveTab('documents')}
            />
            <MobileTabButton
              active={activeTab === 'search'}
              label="Search"
              icon={<Search className="w-5 h-5" />}
              onClick={() => setActiveTab('search')}
            />

            {/* Centered Signature Genius Scan Orange Camera FAB */}
            <div className="flex items-center justify-center">
              <button
                type="button"
                onClick={() => setScannerState({ open: true, mode: 'batch' })}
                aria-label="Scan document"
                className="-mt-5 w-13 h-13 rounded-full bg-orange-600 hover:bg-orange-700 active:scale-95 text-white shadow-lg shadow-orange-600/30 flex items-center justify-center border-4 border-[#F2F2F7] dark:border-[#000000] transition-transform"
              >
                <Camera className="w-6 h-6" />
              </button>
            </div>

            <MobileTabButton
              active={activeTab === 'brain'}
              label="Brain"
              icon={<Brain className="w-5 h-5" />}
              onClick={() => setActiveTab('brain')}
            />
            <MobileTabButton
              active={activeTab === 'cards'}
              label="Cards"
              icon={<CreditCard className="w-5 h-5" />}
              onClick={() => setActiveTab('cards')}
            />
          </div>
        </nav>
      </div>

      {/* Live Document Scanner Studio */}
      {scannerState.open && (
        <LiveScannerModal
          initialMode={scannerState.mode}
          appendTargetTitle={appendTargetDoc?.title}
          folders={folders}
          preferences={preferences}
          nextSequenceNumber={documents.length + 1}
          onClose={() => setScannerState({ open: false, mode: 'batch' })}
          onCompleteNewDocument={(newDoc) => {
            setDocuments((prev) => [newDoc, ...prev]);
            setScannerState({ open: false, mode: 'batch' });
            setActiveTab('documents');
            setOrganizerDocId(newDoc.id);
            showToast(`Saved "${newDoc.title}" (${newDoc.pages.length} page${newDoc.pages.length > 1 ? 's' : ''})`);
          }}
          onCompleteAppendPages={(newPages) => {
            if (appendTargetDoc) {
              updateDocument({
                ...appendTargetDoc,
                pages: [...appendTargetDoc.pages, ...newPages],
                sizeBytes: appendTargetDoc.sizeBytes + newPages.length * 360_000,
                updatedAt: new Date().toISOString(),
              });
              showToast(`Appended ${newPages.length} page(s) to "${appendTargetDoc.title}"`);
            }
            setScannerState({ open: false, mode: 'batch' });
          }}
          onToast={showToast}
        />
      )}

      {/* Full-Screen PDF Reader & Annotator */}
      {activeViewerDoc && (
        <PdfViewerModal
          document={activeViewerDoc}
          initialPageIndex={viewerState?.pageIndex ?? 0}
          savedSignatures={savedSignatures}
          onSaveSignature={(sig) => setSavedSignatures((prev) => [sig, ...prev])}
          onDeleteSavedSignature={(id) =>
            setSavedSignatures((prev) => prev.filter((s) => s.id !== id))
          }
          onUpdateDocument={updateDocument}
          onOpenOrganizer={() => {
            const id = activeViewerDoc.id;
            setViewerState(null);
            setOrganizerDocId(id);
          }}
          onClose={() => setViewerState(null)}
          onToast={showToast}
        />
      )}

      {/* Dedicated Genius Scan + FileLens Page Organizer Studio */}
      {activeOrganizerDoc && (
        <PageOrganizerModal
          document={activeOrganizerDoc}
          allDocuments={documents}
          onUpdateDocument={updateDocument}
          onExtractNewDocument={(extracted) => {
            setDocuments((prev) => [extracted, ...prev]);
          }}
          onLaunchAppendScan={() =>
            setScannerState({ open: true, mode: 'batch', appendToDocId: activeOrganizerDoc.id })
          }
          onClose={() => setOrganizerDocId(null)}
          onToast={showToast}
        />
      )}

      {/* Subtle Floating Toast */}
      {toastMsg && (
        <div
          role="status"
          aria-live="polite"
          className="fixed bottom-20 lg:bottom-6 left-1/2 -translate-x-1/2 z-[60] px-4 py-2.5 rounded-2xl bg-slate-900/95 dark:bg-white/95 text-white dark:text-slate-900 text-xs font-semibold shadow-xl backdrop-blur-md whitespace-nowrap max-w-[90vw] truncate"
        >
          {toastMsg}
        </div>
      )}
    </div>
  );
}

interface MobileTabButtonProps {
  active: boolean;
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
}

const MobileTabButton: React.FC<MobileTabButtonProps> = ({ active, label, icon, onClick }) => (
  <button
    type="button"
    onClick={onClick}
    className={`min-h-[44px] flex flex-col items-center justify-center gap-0.5 transition-colors ${
      active
        ? 'text-orange-600 dark:text-orange-400'
        : 'text-slate-500 dark:text-slate-400'
    }`}
  >
    {icon}
    <span className="text-[10px] font-semibold tracking-tight">{label}</span>
  </button>
);
