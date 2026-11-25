import {
  ScanDocument,
  SearchFilters,
  SearchMode,
  SortColumn,
  SortOrder,
} from '../types/filelens';
import {
  chunkDocumentPages,
  cosineSimilarity,
  generateEmbedding,
} from './embeddingEngine';
import {
  getCrossLingualConceptVariants,
  toUniversalSoundex,
  transliterateHinglishToHindi,
} from './multilingualEngine';

const docSoundexCache = new WeakMap<ScanDocument, Map<string, string[]>>();

function getDocSoundexMap(doc: ScanDocument, fullText: string): Map<string, string[]> {
  const cached = docSoundexCache.get(doc);
  if (cached) return cached;
  const map = new Map<string, string[]>();
  const tokens = fullText.split(/[\s,.;:!?()[\]{}"'<>|/\\]+/);
  for (const tok of tokens) {
    if (tok.length < 3) continue;
    const sdx = toUniversalSoundex(tok);
    if (sdx.length < 3) continue;
    let arr = map.get(sdx);
    if (!arr) {
      arr = [];
      map.set(sdx, arr);
    }
    if (arr.length < 4 && !arr.includes(tok)) {
      arr.push(tok);
    }
  }
  docSoundexCache.set(doc, map);
  return map;
}

export interface SearchMatchItem {
  doc: ScanDocument;
  pageIndex: number;
  snippet: string;
  matchCount: number;
  score: number;
  semanticSimilarity?: number;
  matchedTerms: string[];
}

export interface MatchOccurrence {
  start: number;
  end: number;
  line: number;
  column: number;
  snippet: string;
}

interface CachedDocEmbeddings {
  updatedAt: string;
  metaVec: Float32Array;
  chunkVecs: { pageIndex: number; text: string; vec: Float32Array }[];
}

const embeddingCache = new Map<string, CachedDocEmbeddings>();

function getOrBuildDocEmbeddings(doc: ScanDocument): CachedDocEmbeddings {
  const cached = embeddingCache.get(doc.id);
  if (cached && cached.updatedAt === doc.updatedAt) {
    return cached;
  }
  const metaVec = generateEmbedding(
    `${doc.title} ${doc.sourcePath ?? ''} ${doc.fileExtension ?? ''} ${doc.tags.join(' ')}`
  );
  const chunks = chunkDocumentPages(doc.pages);
  const chunkVecs = chunks.map((c) => ({
    pageIndex: c.pageIndex,
    text: c.text,
    vec: generateEmbedding(c.text),
  }));
  const entry: CachedDocEmbeddings = { updatedAt: doc.updatedAt, metaVec, chunkVecs };
  embeddingCache.set(doc.id, entry);
  return entry;
}

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildCombinedText(doc: ScanDocument): string {
  const pageText = doc.pages.map((p) => p.ocrText).join('\n');
  const pathMeta = [doc.sourcePath, doc.fileExtension ? `.${doc.fileExtension}` : '']
    .filter(Boolean)
    .join(' ');
  return `${doc.title}\n${pathMeta}\n${doc.tags.join(' ')}\n${pageText}`;
}

export function applySearchFilters(docs: ScanDocument[], filters?: SearchFilters): ScanDocument[] {
  if (!filters) return docs;
  const minBytes = filters.minSizeBytes;
  const maxBytes = filters.maxSizeBytes;
  const afterTime = filters.modifiedAfterIso ? new Date(filters.modifiedAfterIso).getTime() : null;
  const cats = filters.fileCategories;

  return docs.filter((doc) => {
    if (cats && cats.length > 0 && !cats.includes(doc.fileCategory || 'pdf')) return false;
    if (minBytes !== undefined && doc.sizeBytes < minBytes) return false;
    if (maxBytes !== undefined && doc.sizeBytes > maxBytes) return false;
    if (afterTime !== null && !Number.isNaN(afterTime)) {
      const t = new Date(doc.updatedAt).getTime();
      if (t < afterTime) return false;
    }
    return true;
  });
}

export function runDocumentSearch(
  docs: ScanDocument[],
  rawQuery: string,
  mode: SearchMode,
  options?: {
    filters?: SearchFilters;
    sortBy?: SortColumn;
    sortOrder?: SortOrder;
  }
): SearchMatchItem[] {
  let query = rawQuery.trim();
  if (!query) return [];

  // Quoted queries automatically promote to Exact Match (like FileLensMobile SearchEngine.kt)
  let effectiveMode = mode;
  if (query.length >= 2 && query.startsWith('"') && query.endsWith('"')) {
    query = query.slice(1, -1).trim();
    effectiveMode = 'exact';
    if (!query) return [];
  }

  const filteredDocs = applySearchFilters(docs, options?.filters);
  const results: SearchMatchItem[] = [];

  // Bilingual Hinglish->Hindi enrichment for Natural Language semantic mode
  const hindiQuery = effectiveMode === 'natural' ? transliterateHinglishToHindi(query) : '';
  const queryVector =
    effectiveMode === 'natural'
      ? generateEmbedding(hindiQuery ? `${query} ${hindiQuery}` : query)
      : null;

  for (const doc of filteredDocs) {
    const fullText = buildCombinedText(doc);
    let bestPageIdx = 0;
    let totalMatches = 0;
    let score = 0;
    let semanticSimilarity: number | undefined;
    let matchedTerms: string[] = [];
    let bestChunkText: string | null = null;

    if (effectiveMode === 'natural' && queryVector) {
      const { metaVec, chunkVecs } = getOrBuildDocEmbeddings(doc);
      let bestSim = cosineSimilarity(queryVector, metaVec);

      for (const chunk of chunkVecs) {
        const chunkSim = cosineSimilarity(queryVector, chunk.vec);
        if (chunkSim > bestSim) {
          bestSim = chunkSim;
          bestPageIdx = chunk.pageIndex;
          bestChunkText = chunk.text;
        }
      }

      const rawTerms = query
        .toLowerCase()
        .split(/\s+/)
        .filter(
          (t) =>
            t.length >= 2 &&
            !['the', 'for', 'and', 'with', 'show', 'find', 'my', 'me', 'all'].includes(t)
        );
      const expanded = new Set<string>(rawTerms);
      for (const t of rawTerms) {
        for (const variant of getCrossLingualConceptVariants(t)) {
          expanded.add(variant);
        }
      }

      const lower = fullText.toLowerCase();
      for (const term of expanded) {
        if (lower.includes(term)) {
          matchedTerms.push(term);
          const m = fullText.match(new RegExp(escapeRegExp(term), 'gi'));
          totalMatches += m ? m.length : 1;
        }
      }

      const lexicalBonus = totalMatches > 0 ? 0.25 : 0;
      const combinedSim = bestSim + lexicalBonus;
      if (combinedSim >= 0.22 || bestSim >= 0.14 || totalMatches > 0) {
        semanticSimilarity = Math.min(0.99, Math.max(0.15, bestSim));
        score = combinedSim * 120 + totalMatches * 8;
        if (totalMatches === 0) totalMatches = 1;
      }
    } else if (effectiveMode === 'exact') {
      const rx = new RegExp(escapeRegExp(query), 'gi');
      const matches = fullText.match(rx);
      if (matches && matches.length > 0) {
        totalMatches = matches.length;
        score = 100 + matches.length * 10;
        matchedTerms = [query];
      }
    } else if (effectiveMode === 'whole') {
      const rx = new RegExp(`\\b${escapeRegExp(query)}\\b`, 'gi');
      const matches = fullText.match(rx);
      if (matches && matches.length > 0) {
        totalMatches = matches.length;
        score = 95 + matches.length * 10;
        matchedTerms = [query];
      }
    } else if (effectiveMode === 'wildcard') {
      const pattern = escapeRegExp(query).replace(/\\\*/g, '.*').replace(/\\\?/g, '.');
      const rx = new RegExp(pattern, 'gi');
      const matches = fullText.match(rx);
      if (matches && matches.length > 0) {
        totalMatches = matches.length;
        score = 90 + matches.length * 8;
        matchedTerms = Array.from(new Set(matches.slice(0, 6)));
      }
    } else if (effectiveMode === 'boolean') {
      // Proper OR-of-AND-clauses evaluation supporting NOT <term>
      const lower = fullText.toLowerCase();
      const orClauses = query.split(/\s+OR\s+/i).filter(Boolean);
      const positives: string[] = [];
      let anyClauseMatched = false;

      for (const clause of orClauses) {
        const parts = clause
          .split(/\s+AND\s+/i)
          .flatMap((p) => p.trim().split(/\s+/))
          .filter(Boolean);

        let clauseOk = true;
        const clausePositives: string[] = [];
        for (let i = 0; i < parts.length; i++) {
          const tok = parts[i];
          if (tok.toUpperCase() === 'NOT' && i + 1 < parts.length) {
            const neg = parts[i + 1].toLowerCase();
            if (lower.includes(neg)) {
              clauseOk = false;
              break;
            }
            i++;
            continue;
          }
          const term = tok.toLowerCase();
          if (!lower.includes(term)) {
            clauseOk = false;
            break;
          }
          clausePositives.push(term);
        }

        if (clauseOk && (clausePositives.length > 0 || parts.some((p) => p.toUpperCase() === 'NOT'))) {
          anyClauseMatched = true;
          positives.push(...clausePositives);
        }
      }

      if (anyClauseMatched) {
        matchedTerms = Array.from(new Set(positives));
        totalMatches = matchedTerms.reduce((acc, t) => {
          const m = fullText.match(new RegExp(escapeRegExp(t), 'gi'));
          return acc + (m ? m.length : 0);
        }, 0);
        if (totalMatches === 0) totalMatches = 1;
        score = 88 + totalMatches * 10;
      }
    } else {
      // Quick Search (partial + Hinglish transliteration + 18 cross-lingual concept groups)
      const rawTerms = query
        .toLowerCase()
        .split(/\s+/)
        .filter(
          (t) =>
            t.length >= 2 &&
            !['the', 'for', 'and', 'with', 'show', 'find', 'my', 'me'].includes(t)
        );

      const expanded = new Set<string>(rawTerms);
      for (const term of rawTerms) {
        for (const variant of getCrossLingualConceptVariants(term)) {
          expanded.add(variant);
        }
      }

      const lower = fullText.toLowerCase();
      for (const term of expanded) {
        if (lower.includes(term)) {
          const isDirect = rawTerms.includes(term);
          const rx = new RegExp(escapeRegExp(term), 'gi');
          const m = fullText.match(rx);
          const count = m ? m.length : 1;
          totalMatches += count;
          score += isDirect ? 30 + count * 8 : 14 + count * 4;
          matchedTerms.push(term);
        }
      }

      // Cross-script phonetic Soundex fallback (e.g. "Tulsidas" <-> "तुलसीदास")
      if (totalMatches === 0) {
        const sdxMap = getDocSoundexMap(doc, fullText);
        for (const term of rawTerms) {
          if (term.length < 4) continue;
          const sdx = toUniversalSoundex(term);
          if (sdx.length < 3) continue;
          const hits = sdxMap.get(sdx);
          if (hits && hits.length > 0) {
            totalMatches += hits.length;
            score += 22 + hits.length * 6;
            for (const h of hits) matchedTerms.push(h);
          }
        }
      }
    }

    if (totalMatches > 0) {
      if (effectiveMode !== 'natural') {
        let bestPageScore = -1;
        doc.pages.forEach((pg, idx) => {
          const pLower = pg.ocrText.toLowerCase();
          const hits = matchedTerms.reduce(
            (acc, t) => acc + (pLower.includes(t.toLowerCase()) ? 1 : 0),
            0
          );
          if (hits > bestPageScore) {
            bestPageScore = hits;
            bestPageIdx = idx;
          }
        });
      }

      const pageOcr = bestChunkText || doc.pages[bestPageIdx]?.ocrText || fullText;
      const firstTerm = matchedTerms[0] || query;
      const pos = pageOcr.toLowerCase().indexOf(firstTerm.toLowerCase());
      const start = Math.max(0, pos === -1 ? 0 : pos - 56);
      const end = Math.min(pageOcr.length, (pos === -1 ? 0 : pos) + 165);
      const snippet =
        (start > 0 ? '…' : '') + pageOcr.slice(start, end).trim() + (end < pageOcr.length ? '…' : '');

      results.push({
        doc,
        pageIndex: bestPageIdx,
        snippet,
        matchCount: totalMatches,
        score,
        semanticSimilarity,
        matchedTerms,
      });
    }
  }

  const sortBy = options?.sortBy ?? 'score';
  const sortOrder = options?.sortOrder ?? 'desc';
  const dir = sortOrder === 'asc' ? 1 : -1;

  return results.sort((a, b) => {
    if (sortBy === 'name') return a.doc.title.localeCompare(b.doc.title) * dir;
    if (sortBy === 'size') return (a.doc.sizeBytes - b.doc.sizeBytes) * dir;
    if (sortBy === 'modified') {
      return (new Date(a.doc.updatedAt).getTime() - new Date(b.doc.updatedAt).getTime()) * dir;
    }
    if (sortBy === 'extension') {
      return (a.doc.fileExtension || 'pdf').localeCompare(b.doc.fileExtension || 'pdf') * dir;
    }
    return (a.score - b.score) * dir;
  });
}

/**
 * Find up to 500 MatchOccurrence positions with 1-based line & column for in-document navigation.
 */
export function findOccurrencesInText(
  text: string,
  rawQuery: string,
  mode: SearchMode = 'quick'
): MatchOccurrence[] {
  const query = rawQuery.trim();
  if (!text || !query) return [];

  let rx: RegExp;
  if (mode === 'whole') {
    rx = new RegExp(`\\b${escapeRegExp(query)}\\b`, 'gi');
  } else if (mode === 'wildcard') {
    const pattern = escapeRegExp(query).replace(/\\\*/g, '.*').replace(/\\\?/g, '.');
    rx = new RegExp(pattern, 'gi');
  } else {
    rx = new RegExp(escapeRegExp(query), 'gi');
  }

  const occurrences: MatchOccurrence[] = [];
  let match: RegExpExecArray | null;
  let line = 1;
  let lastLineIdx = 0;

  while ((match = rx.exec(text)) !== null && occurrences.length < 500) {
    if (match[0].length === 0) {
      rx.lastIndex++;
      continue;
    }
    const start = match.index;
    const end = start + match[0].length;
    for (let i = lastLineIdx; i < start; i++) {
      if (text.charCodeAt(i) === 10) line++;
    }
    const prevNl = text.lastIndexOf('\n', start - 1);
    const column = start - prevNl;
    lastLineIdx = start;

    const sStart = Math.max(0, start - 35);
    const sEnd = Math.min(text.length, end + 65);
    const snippet =
      (sStart > 0 ? '…' : '') +
      text.slice(sStart, sEnd).replace(/\s+/g, ' ').trim() +
      (sEnd < text.length ? '…' : '');

    occurrences.push({ start, end, line, column, snippet });
  }

  return occurrences;
}

export function exportSearchResults(
  results: SearchMatchItem[],
  query: string,
  format: 'txt' | 'md' | 'csv' | 'json'
): { content: string; mime: string; ext: string } {
  if (format === 'json') {
    return {
      content: JSON.stringify(
        {
          query,
          exportedAt: new Date().toISOString(),
          count: results.length,
          results: results.map((r) => ({
            title: r.doc.title,
            page: r.pageIndex + 1,
            matches: r.matchCount,
            semanticScore: r.semanticSimilarity ? Math.round(r.semanticSimilarity * 100) : undefined,
            tags: r.doc.tags,
            snippet: r.snippet,
          })),
        },
        null,
        2
      ),
      mime: 'application/json',
      ext: 'json',
    };
  }
  if (format === 'csv') {
    const header = 'Document,Page,Matches,Tags,Snippet';
    const rows = results.map((r) => {
      const esc = (s: string) => `"${s.replace(/"/g, '""')}"`;
      return [
        esc(r.doc.title),
        r.pageIndex + 1,
        r.matchCount,
        esc(r.doc.tags.join('; ')),
        esc(r.snippet),
      ].join(',');
    });
    return { content: [header, ...rows].join('\n'), mime: 'text/csv', ext: 'csv' };
  }
  if (format === 'md') {
    const lines = [
      `# FileLens OCR Search Export`,
      `Query: \`${query}\` · ${results.length} matching document(s)`,
      '',
      ...results.map(
        (r) =>
          `## ${r.doc.title}\n- Page: ${r.pageIndex + 1} · Matches: ${r.matchCount}\n- Snippet: ${r.snippet}\n`
      ),
    ];
    return { content: lines.join('\n'), mime: 'text/markdown', ext: 'md' };
  }

  const lines = [
    `FileLens OCR Search Export — Query: "${query}" (${results.length} results)`,
    '------------------------------------------------------------',
    ...results.map(
      (r, idx) =>
        `${idx + 1}. ${r.doc.title} (Page ${r.pageIndex + 1}, ${r.matchCount} match${r.matchCount === 1 ? '' : 'es'})\n   ${r.snippet}`
    ),
  ];
  return { content: lines.join('\n'), mime: 'text/plain', ext: 'txt' };
}
