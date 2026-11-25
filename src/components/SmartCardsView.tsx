import React, { useMemo, useState } from 'react';
import {
  AlertTriangle,
  BellPlus,
  Calendar,
  Copy,
  CreditCard,
  Eye,
  EyeOff,
  FileText,
  IdCard,
  Layers,
  Lock,
  Plus,
  ShieldCheck,
  Sparkles,
  X,
} from 'lucide-react';
import { ScanDocument, SmartCardCategory } from '../types/filelens';
import { SMART_CARD_CATEGORIES } from '../data/seedData';
import {
  computeExpiryRadar,
  formatBytes,
  formatShortDate,
  triggerFileDownload,
} from '../utils/formatters';
import { redactSensitiveInfoForSharing } from '../utils/pdfExport';
import { findRelatedCards } from '../utils/smartTaxonomy';
import { extractSmartData } from '../utils/temporalExtractor';
import { PageCanvasPreview } from './PageCanvasPreview';

interface SmartCardsViewProps {
  documents: ScanDocument[];
  privacyBlur: boolean;
  biometricCardsLock?: boolean;
  cardsPinCode?: string;
  onTogglePrivacyBlur: () => void;
  onLaunchIdScanner: () => void;
  onPromoteDocumentToCard: (
    docId: string,
    category: SmartCardCategory,
    expiryDate?: string
  ) => void;
  onUpdateCardExpiry: (docId: string, expiryDate: string) => void;
  onScheduleExpiryReminder: (doc: ScanDocument, expiryDate: string, daysBefore?: number) => void;
  onOpenViewer: (docId: string) => void;
  onOpenOrganizer: (docId: string) => void;
  onToast: (message: string) => void;
}

export const SmartCardsView: React.FC<SmartCardsViewProps> = ({
  documents,
  privacyBlur,
  biometricCardsLock = false,
  cardsPinCode = '',
  onTogglePrivacyBlur,
  onLaunchIdScanner,
  onPromoteDocumentToCard,
  onUpdateCardExpiry,
  onScheduleExpiryReminder,
  onOpenViewer,
  onOpenOrganizer,
  onToast,
}) => {
  const [selectedCategory, setSelectedCategory] = useState<SmartCardCategory | null>(null);
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [showPromoteModal, setShowPromoteModal] = useState<boolean>(false);
  const [promoteDocId, setPromoteDocId] = useState<string>('');
  const [promoteCat, setPromoteCat] = useState<SmartCardCategory>('Govt IDs');
  const [promoteExpiry, setPromoteExpiry] = useState<string>('');
  const [editingExpiryDoc, setEditingExpiryDoc] = useState<ScanDocument | null>(null);
  const [expiryDraft, setExpiryDraft] = useState<string>('');
  const [detailCard, setDetailCard] = useState<ScanDocument | null>(null);
  const [isMasking, setIsMasking] = useState<boolean>(false);
  const [isVaultUnlocked, setIsVaultUnlocked] = useState<boolean>(!biometricCardsLock);
  const [pinAttempt, setPinAttempt] = useState<string>('');

  const cards = useMemo(() => documents.filter((d) => d.isSmartCard), [documents]);
  const nonCardDocs = useMemo(() => documents.filter((d) => !d.isSmartCard), [documents]);
  const radarItems = useMemo(() => computeExpiryRadar(documents), [documents]);

  const categoryCounts = useMemo(() => {
    const map: Record<string, number> = {};
    SMART_CARD_CATEGORIES.forEach((cat) => {
      map[cat] = cards.filter((c) => (c.cardCategory ?? 'Personal') === cat).length;
    });
    return map;
  }, [cards]);

  const visibleCards = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return cards.filter((c) => {
      if (selectedCategory && (c.cardCategory ?? 'Personal') !== selectedCategory) return false;
      if (!q) return true;
      return (
        c.title.toLowerCase().includes(q) ||
        (c.cardCategory ?? '').toLowerCase().includes(q) ||
        c.pages.some((p) => p.ocrText.toLowerCase().includes(q))
      );
    });
  }, [cards, selectedCategory, searchQuery]);

  const urgencyLabel = (urgency: 'expired' | 'critical' | 'upcoming' | 'safe', days: number) => {
    if (urgency === 'expired') return `Expired ${Math.abs(days)}d ago`;
    if (urgency === 'critical') return `Expires in ${days}d (Urgent)`;
    if (urgency === 'upcoming') return `Expires in ${days}d`;
    return `Valid · ${days}d left`;
  };

  const relatedCards = useMemo(
    () => (detailCard ? findRelatedCards(detailCard, cards) : []),
    [detailCard, cards]
  );

  const detailSmartData = useMemo(
    () =>
      detailCard
        ? extractSmartData(detailCard.pages.map((p) => p.ocrText).join('\n'))
        : { dates: [], amounts: [], phones: [], emails: [], ids: [] },
    [detailCard]
  );

  const handleMaskAndShareCard = async (card: ScanDocument) => {
    if (!card.pages[0]) return;
    setIsMasking(true);
    try {
      const { redactedDataUrl, redactedCount } = await redactSensitiveInfoForSharing(
        card.pages[0].imageUrl
      );
      const res = await fetch(redactedDataUrl);
      const blob = await res.blob();
      const safeName = card.title.replace(/[^a-zA-Z0-9._ -]/g, '').trim() || 'SmartCard';
      triggerFileDownload(blob, `${safeName}_Masked.jpg`);
      onToast(
        redactedCount > 0
          ? `Masked ${redactedCount} sensitive field(s) & exported safely`
          : 'Exported with privacy footer'
      );
    } catch {
      onToast('Privacy masking failed');
    } finally {
      setIsMasking(false);
    }
  };

  if (biometricCardsLock && !isVaultUnlocked) {
    return (
      <div className="bg-white dark:bg-[#1C1C1E] rounded-2xl border border-slate-200/80 dark:border-white/10 p-8 sm:p-12 text-center max-w-md mx-auto mt-6 space-y-4">
        <div className="w-14 h-14 rounded-2xl bg-orange-50 dark:bg-orange-950/40 text-orange-600 dark:text-orange-400 flex items-center justify-center mx-auto">
          <Lock className="w-7 h-7" />
        </div>
        <div>
          <h2 className="text-base font-bold text-slate-900 dark:text-white">
            Smart Cards Vault Locked
          </h2>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
            {cardsPinCode
              ? 'Enter your vault PIN to access Govt IDs, Medical & Finance cards.'
              : 'Tap Unlock to verify access to your Smart Cards Wallet.'}
          </p>
        </div>
        {cardsPinCode && (
          <input
            type="password"
            value={pinAttempt}
            onChange={(e) => setPinAttempt(e.target.value)}
            placeholder="Enter Vault PIN…"
            className="w-full h-11 px-3.5 rounded-xl bg-slate-50 dark:bg-[#2C2C2E] border border-slate-200 dark:border-white/10 text-sm text-center tracking-widest"
          />
        )}
        <button
          type="button"
          onClick={() => {
            if (!cardsPinCode || pinAttempt === cardsPinCode) {
              setIsVaultUnlocked(true);
              setPinAttempt('');
              onToast('Smart Cards Vault unlocked');
            } else {
              onToast('Incorrect Vault PIN');
            }
          }}
          className="w-full h-11 rounded-xl bg-orange-600 hover:bg-orange-700 text-white text-sm font-semibold"
        >
          Unlock Smart Cards
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-lg sm:text-xl font-bold tracking-tight text-slate-900 dark:text-white">
          Smart Cards
        </h1>

        <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar">
          <button
            type="button"
            onClick={onLaunchIdScanner}
            className="h-8 px-3 rounded-lg bg-orange-600 hover:bg-orange-700 text-white text-xs font-semibold flex items-center gap-1.5 transition-colors whitespace-nowrap"
          >
            <IdCard className="w-3.5 h-3.5" />
            <span>2-in-1 ID</span>
          </button>
          <button
            type="button"
            onClick={() => {
              setPromoteDocId(nonCardDocs[0]?.id ?? '');
              setShowPromoteModal(true);
            }}
            className="h-8 px-2.5 rounded-lg bg-white dark:bg-[#1C1C1E] border border-slate-200 dark:border-white/10 hover:border-orange-400 text-xs font-semibold flex items-center gap-1 whitespace-nowrap"
          >
            <Plus className="w-3.5 h-3.5 text-orange-600" />
            <span>Promote</span>
          </button>
          <button
            type="button"
            onClick={onTogglePrivacyBlur}
            className={`h-8 px-2.5 rounded-lg border text-xs font-semibold flex items-center gap-1 transition-colors whitespace-nowrap ${
              privacyBlur
                ? 'bg-slate-900 dark:bg-white text-white dark:text-slate-900 border-transparent'
                : 'bg-white dark:bg-[#1C1C1E] border-slate-200 dark:border-white/10 text-slate-700 dark:text-slate-200'
            }`}
          >
            {privacyBlur ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />}
            <span>{privacyBlur ? 'Reveal' : 'Blur'}</span>
          </button>
        </div>
      </div>

      {/* Expiry & Renewal Radar */}
      {radarItems.length > 0 && (
        <section className="bg-white dark:bg-[#1C1C1E] rounded-2xl border border-slate-200/80 dark:border-white/10 p-4 sm:p-5 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-orange-600 dark:text-orange-400" />
              <h2 className="text-sm font-bold">
                Expiry &amp; Renewal Radar ({radarItems.length})
              </h2>
            </div>
            <span className="text-xs text-slate-500 dark:text-slate-400">
              Auto-tracked from card dates
            </span>
          </div>

          <div className="divide-y divide-slate-100 dark:divide-white/8">
            {radarItems.map((item) => (
              <div
                key={item.doc.id}
                className="py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-2.5"
              >
                <div className="min-w-0">
                  <button
                    type="button"
                    onClick={() => onOpenViewer(item.doc.id)}
                    className="text-sm font-semibold text-slate-900 dark:text-white hover:text-orange-600 truncate block text-left"
                  >
                    {item.doc.title}
                  </button>
                  <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs font-mono tabular-nums">
                    <span
                      className={
                        item.urgency === 'expired'
                          ? 'text-red-600 dark:text-red-400 font-semibold'
                          : item.urgency === 'critical'
                          ? 'text-amber-600 dark:text-amber-400 font-semibold'
                          : item.urgency === 'upcoming'
                          ? 'text-orange-600 dark:text-orange-400 font-semibold'
                          : 'text-emerald-600 dark:text-emerald-400 font-semibold'
                      }
                    >
                      {urgencyLabel(item.urgency, item.daysRemaining)}
                    </span>
                    <span className="text-slate-400" aria-hidden="true">·</span>
                    <span className="text-slate-500 dark:text-slate-400">
                      Date: {formatShortDate(item.expiryDate)}
                    </span>
                  </div>
                </div>

                <div className="flex items-center gap-1.5 self-start sm:self-center shrink-0">
                  <button
                    type="button"
                    onClick={() => onScheduleExpiryReminder(item.doc, item.expiryDate)}
                    className="min-h-[34px] px-2.5 rounded-xl bg-orange-50 dark:bg-orange-950/40 text-orange-700 dark:text-orange-300 hover:bg-orange-100 dark:hover:bg-orange-950/60 text-xs font-semibold flex items-center gap-1 whitespace-nowrap"
                  >
                    <BellPlus className="w-3.5 h-3.5" />
                    <span>Alert</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      onScheduleExpiryReminder(item.doc, item.expiryDate, 30);
                      onScheduleExpiryReminder(item.doc, item.expiryDate, 7);
                      onScheduleExpiryReminder(item.doc, item.expiryDate, 1);
                      onToast(`Scheduled 30d, 7d & 1d renewal alerts for "${item.doc.title}"`);
                    }}
                    className="min-h-[34px] px-2.5 rounded-xl bg-slate-100 dark:bg-[#2C2C2E] hover:bg-orange-50 dark:hover:bg-orange-950/40 text-slate-700 dark:text-slate-200 text-xs font-semibold whitespace-nowrap"
                  >
                    30d/7d/1d
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* 6 Smart Folders Filter Grid */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2.5">
        {SMART_CARD_CATEGORIES.map((cat) => {
          const active = selectedCategory === cat;
          return (
            <button
              key={cat}
              type="button"
              onClick={() => setSelectedCategory(active ? null : cat)}
              className={`p-3.5 rounded-2xl border text-left transition-all ${
                active
                  ? 'bg-orange-600 text-white border-orange-600'
                  : 'bg-white dark:bg-[#1C1C1E] border-slate-200/80 dark:border-white/10 hover:border-orange-400'
              }`}
            >
              <div className="text-xs font-semibold truncate">{cat}</div>
              <div
                className={`mt-1 text-lg font-bold font-mono tabular-nums ${
                  active ? 'text-white' : 'text-slate-900 dark:text-white'
                }`}
              >
                {categoryCounts[cat] ?? 0}
              </div>
            </button>
          );
        })}
      </div>

      {/* Filter Bar */}
      <div className="flex items-center justify-between gap-3">
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="Search IDs, clinic reports, bills, or OCR text…"
          className="flex-1 max-w-md h-10 px-3.5 rounded-xl bg-white dark:bg-[#1C1C1E] border border-slate-200/80 dark:border-white/10 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
        />
        {selectedCategory && (
          <button
            type="button"
            onClick={() => setSelectedCategory(null)}
            className="text-xs font-semibold text-orange-600 dark:text-orange-400 hover:underline whitespace-nowrap"
          >
            Show All ({cards.length})
          </button>
        )}
      </div>

      {/* Smart Cards Grid */}
      {visibleCards.length === 0 ? (
        <div className="bg-white dark:bg-[#1C1C1E] rounded-2xl border border-slate-200/80 dark:border-white/10 p-10 text-center space-y-2.5">
          <CreditCard className="w-8 h-8 text-orange-500 mx-auto" />
          <h3 className="text-sm font-bold">No Smart Cards in this folder</h3>
          <p className="text-xs text-slate-500 dark:text-slate-400 max-w-sm mx-auto">
            Scan a Front + Back ID card onto a single printable A4 sheet, or promote any existing PDF into your Smart Cards Wallet.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {visibleCards.map((card) => (
            <div
              key={card.id}
              onClick={() => setDetailCard(card)}
              className="bg-white dark:bg-[#1C1C1E] rounded-2xl border border-slate-200/80 dark:border-white/10 p-4 cursor-pointer hover:border-slate-300 dark:hover:border-white/20 transition-all flex flex-col gap-3"
            >
              <div className="relative aspect-[4/3] rounded-xl bg-slate-100 dark:bg-[#121214] p-2 overflow-hidden">
                {card.pages[0] && (
                  <PageCanvasPreview
                    page={card.pages[0]}
                    blurContent={privacyBlur}
                    className="w-full h-full rounded shadow-xs"
                  />
                )}
                {privacyBlur && (
                  <div className="absolute inset-0 flex items-center justify-center bg-black/20">
                    <span className="px-3 py-1 rounded-full bg-black/75 text-white text-xs font-semibold flex items-center gap-1.5">
                      <ShieldCheck className="w-3.5 h-3.5 text-orange-400" />
                      <span>Protected</span>
                    </span>
                  </div>
                )}
              </div>

              <div className="min-w-0">
                <h3 className="text-sm font-bold text-slate-900 dark:text-white truncate">
                  {card.title}
                </h3>
                <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
                  <span className="font-semibold text-orange-700 dark:text-orange-400">
                    {card.cardCategory ?? 'Personal'}
                  </span>
                  <span aria-hidden="true">·</span>
                  <span className="font-mono tabular-nums">{formatBytes(card.sizeBytes)}</span>
                  {card.expiryDate && (
                    <>
                      <span aria-hidden="true">·</span>
                      <span className="font-mono tabular-nums">
                        Exp {formatShortDate(card.expiryDate)}
                      </span>
                    </>
                  )}
                </div>
              </div>

              <div
                className="pt-2.5 mt-auto border-t border-slate-100 dark:border-white/8 flex items-center justify-between gap-2"
                onClick={(e) => e.stopPropagation()}
              >
                <button
                  type="button"
                  onClick={() => {
                    setEditingExpiryDoc(card);
                    setExpiryDraft(card.expiryDate ?? '');
                  }}
                  className="text-xs font-semibold text-slate-600 dark:text-slate-300 hover:text-orange-600 flex items-center gap-1"
                >
                  <Calendar className="w-3.5 h-3.5" />
                  <span>{card.expiryDate ? 'Edit Expiry' : 'Set Expiry'}</span>
                </button>
                <button
                  type="button"
                  onClick={() => onOpenOrganizer(card.id)}
                  className="text-xs font-semibold text-orange-600 dark:text-orange-400 hover:underline flex items-center gap-1"
                >
                  <Layers className="w-3.5 h-3.5" />
                  <span>Organize</span>
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Promote Existing PDF Modal */}
      {showPromoteModal && (
        <div
          className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm flex items-end sm:items-center justify-center p-0 sm:p-4"
          onClick={() => setShowPromoteModal(false)}
        >
          <div
            className="w-full sm:max-w-md bg-white dark:bg-[#1C1C1E] rounded-t-3xl sm:rounded-3xl p-5 pb-safe space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <h3 className="text-base font-bold">Promote Document to Smart Card</h3>
              <button
                type="button"
                onClick={() => setShowPromoteModal(false)}
                className="w-9 h-9 rounded-full flex items-center justify-center hover:bg-slate-100 dark:hover:bg-white/10"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            {nonCardDocs.length === 0 ? (
              <p className="text-sm text-slate-500 py-4 text-center">
                All indexed documents are already filed in your Smart Cards Wallet.
              </p>
            ) : (
              <div className="space-y-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-600 dark:text-slate-300 mb-1">
                    Document
                  </label>
                  <select
                    value={promoteDocId}
                    onChange={(e) => setPromoteDocId(e.target.value)}
                    className="w-full h-11 px-3 rounded-xl bg-slate-50 dark:bg-[#2C2C2E] border border-slate-200 dark:border-white/10 text-sm"
                  >
                    {nonCardDocs.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.title}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-600 dark:text-slate-300 mb-1.5">
                    Smart Folder
                  </label>
                  <div className="flex flex-wrap gap-1.5">
                    {SMART_CARD_CATEGORIES.map((cat) => (
                      <button
                        key={cat}
                        type="button"
                        onClick={() => setPromoteCat(cat)}
                        className={`px-3 py-1.5 rounded-lg text-xs font-semibold ${
                          promoteCat === cat
                            ? 'bg-orange-600 text-white'
                            : 'bg-slate-100 dark:bg-[#2C2C2E] text-slate-600 dark:text-slate-300'
                        }`}
                      >
                        {cat}
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-600 dark:text-slate-300 mb-1">
                    Optional Expiry / Renewal Date
                  </label>
                  <input
                    type="date"
                    value={promoteExpiry}
                    onChange={(e) => setPromoteExpiry(e.target.value)}
                    className="w-full h-11 px-3 rounded-xl bg-slate-50 dark:bg-[#2C2C2E] border border-slate-200 dark:border-white/10 text-sm"
                  />
                </div>

                <button
                  type="button"
                  disabled={!promoteDocId}
                  onClick={() => {
                    onPromoteDocumentToCard(promoteDocId, promoteCat, promoteExpiry || undefined);
                    setShowPromoteModal(false);
                    setPromoteExpiry('');
                    onToast(`Added card to ${promoteCat}`);
                  }}
                  className="w-full h-11 rounded-xl bg-orange-600 hover:bg-orange-700 text-white text-sm font-semibold"
                >
                  Save to Wallet
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Set Expiry Date Modal */}
      {editingExpiryDoc && (
        <div
          className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm flex items-end sm:items-center justify-center p-0 sm:p-4"
          onClick={() => setEditingExpiryDoc(null)}
        >
          <div
            className="w-full sm:max-w-sm bg-white dark:bg-[#1C1C1E] rounded-t-3xl sm:rounded-3xl p-5 pb-safe space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-base font-bold truncate">Expiry Date · {editingExpiryDoc.title}</h3>
            <input
              type="date"
              value={expiryDraft}
              onChange={(e) => setExpiryDraft(e.target.value)}
              className="w-full h-11 px-3 rounded-xl bg-slate-50 dark:bg-[#2C2C2E] border border-slate-200 dark:border-white/10 text-sm"
            />
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setEditingExpiryDoc(null)}
                className="h-10 px-4 rounded-xl text-sm font-semibold text-slate-500"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  onUpdateCardExpiry(editingExpiryDoc.id, expiryDraft);
                  setEditingExpiryDoc(null);
                  onToast('Updated expiry date on Expiry Radar');
                }}
                className="h-10 px-4 rounded-xl bg-orange-600 text-white text-sm font-semibold"
              >
                Save Date
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Rich Card Detail Modal with Smart Data, Mask & Share Safely, and Related Cards */}
      {detailCard && (
        <div
          className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm flex items-end sm:items-center justify-center p-0 sm:p-4"
          onClick={() => setDetailCard(null)}
        >
          <div
            className="w-full sm:max-w-lg bg-white dark:bg-[#1C1C1E] rounded-t-3xl sm:rounded-3xl p-5 pb-safe space-y-4 max-h-[88vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-orange-600 dark:text-orange-400">
                  {detailCard.cardCategory ?? 'Personal'}
                </span>
                <h3 className="text-base font-bold truncate">{detailCard.title}</h3>
              </div>
              <button
                type="button"
                onClick={() => setDetailCard(null)}
                className="w-8 h-8 rounded-full flex items-center justify-center hover:bg-slate-100 dark:hover:bg-white/10 shrink-0"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {detailCard.pages[0] && (
              <div className="aspect-[16/10] rounded-2xl bg-slate-100 dark:bg-[#121214] p-2 overflow-hidden">
                <PageCanvasPreview
                  page={detailCard.pages[0]}
                  blurContent={privacyBlur}
                  className="w-full h-full rounded-xl"
                />
              </div>
            )}

            <div className="grid grid-cols-3 gap-2">
              <button
                type="button"
                onClick={() => {
                  const id = detailCard.id;
                  setDetailCard(null);
                  onOpenViewer(id);
                }}
                className="py-2.5 px-2 rounded-xl bg-orange-600 hover:bg-orange-700 text-white text-xs font-semibold flex items-center justify-center gap-1.5"
              >
                <FileText className="w-3.5 h-3.5" />
                <span>Open PDF</span>
              </button>
              <button
                type="button"
                disabled={isMasking}
                onClick={() => handleMaskAndShareCard(detailCard)}
                className="py-2.5 px-2 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-semibold flex items-center justify-center gap-1.5 disabled:opacity-60"
              >
                <ShieldCheck className="w-3.5 h-3.5" />
                <span>{isMasking ? 'Masking…' : 'Mask & Share'}</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  const txt = detailCard.pages.map((p) => p.ocrText).join('\n').trim();
                  if (txt) {
                    navigator.clipboard?.writeText(txt).catch(() => undefined);
                    onToast('Copied card OCR text');
                  } else {
                    onToast('No OCR text on this card');
                  }
                }}
                className="py-2.5 px-2 rounded-xl bg-slate-100 dark:bg-[#2C2C2E] hover:bg-slate-200 text-xs font-semibold flex items-center justify-center gap-1.5"
              >
                <Copy className="w-3.5 h-3.5" />
                <span>Copy OCR</span>
              </button>
            </div>

            {/* Smart Data Chips */}
            {(detailSmartData.ids.length > 0 ||
              detailSmartData.dates.length > 0 ||
              detailSmartData.amounts.length > 0 ||
              detailSmartData.phones.length > 0) && (
              <div className="space-y-1.5">
                <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                  Detected Smart Data (Tap to Copy)
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {[
                    ...detailSmartData.ids,
                    ...detailSmartData.dates,
                    ...detailSmartData.amounts,
                    ...detailSmartData.phones,
                  ].map((val) => (
                    <button
                      key={val}
                      type="button"
                      onClick={() => {
                        navigator.clipboard?.writeText(val).catch(() => undefined);
                        onToast(`Copied "${val}"`);
                      }}
                      className="px-2.5 py-1 rounded-lg bg-slate-100 dark:bg-[#2C2C2E] text-xs font-mono flex items-center gap-1"
                    >
                      <span>{val}</span>
                      <Copy className="w-3 h-3 text-slate-400" />
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Related Cards */}
            {relatedCards.length > 0 && (
              <div className="space-y-2 pt-2 border-t border-slate-100 dark:border-white/10">
                <div className="flex items-center gap-1.5 text-xs font-bold text-slate-700 dark:text-slate-200">
                  <Sparkles className="w-3.5 h-3.5 text-orange-500" />
                  <span>Related Smart Cards</span>
                </div>
                <div className="space-y-1.5">
                  {relatedCards.map((rel) => (
                    <button
                      key={rel.doc.id}
                      type="button"
                      onClick={() => setDetailCard(rel.doc)}
                      className="w-full p-2.5 rounded-xl bg-slate-50 dark:bg-[#2C2C2E] hover:bg-orange-50 dark:hover:bg-orange-950/30 flex items-center justify-between text-left"
                    >
                      <div className="min-w-0">
                        <div className="text-xs font-semibold truncate">{rel.doc.title}</div>
                        <div className="text-[11px] text-slate-500">
                          {rel.doc.cardCategory ?? 'Personal'}
                        </div>
                      </div>
                      <span className="text-[11px] font-mono text-orange-600 dark:text-orange-400 shrink-0">
                        {Math.round(rel.similarity * 100)}% match
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
