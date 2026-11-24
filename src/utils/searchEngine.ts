import { ScanDocument, SearchMode } from '../types/filelens';
import {
  chunkDocumentPages,
  cosineSimilarity,
  generateEmbedding,
} from './embeddingEngine';

export interface SearchMatchItem {
  doc: ScanDocument;
  pageIndex: number;
  snippet: string;
  matchCount: number;
  score: number;
  semanticSimilarity?: number;
  matchedTerms: string[];
}

// Bilingual / Hinglish & concept synonyms matching FileLensMobile MultilingualEngine
const CONCEPT_EXPANSIONS: Record<string, string[]> = {
  bill: ['invoice', 'receipt', 'subtotal', 'paid', 'amount', 'tax', 'kharcha', 'raseed'],
  invoice: ['bill', 'receipt', 'paid', 'subtotal', 'due'],
  receipt: ['invoice', 'paid', 'bill', 'tax'],
  doctor: ['clinic', 'physician', 'lab', 'medical', 'cholesterol', 'glucose', 'dawai', 'hospital'],
  medical: ['clinic', 'lab', 'physician', 'blood', 'wellness', 'report'],
  dawai: ['medical', 'clinic', 'physician', 'lab'],
  contract: ['agreement', 'clause', 'confidentiality', 'signed', 'terms', 'scope'],
  agreement: ['contract', 'signed', 'provider', 'client', 'fees'],
  id: ['identification', 'member', 'pass', 'specimen', 'card', 'rank', 'aadhaar', 'pan'],
  card: ['id', 'identification', 'membership', 'pass'],
  roadmap: ['timeline', 'architecture', 'microservices', 'launch', 'api', 'whiteboard'],
  money: ['fee', 'invoice', 'paid', 'subtotal', '$', 'usd', 'tax'],
};

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

export function runDocumentSearch(
  docs: ScanDocument[],
  rawQuery: string,
  mode: SearchMode
): SearchMatchItem[] {
  const query = rawQuery.trim();
  if (!query) return [];

  const results: SearchMatchItem[] = [];

  // Precompute 384-dim query vector once for Natural Language semantic mode
  const queryVector = mode === 'natural' ? generateEmbedding(query) : null;

  for (const doc of docs) {
    const fullText = buildCombinedText(doc);
    let bestPageIdx = 0;
    let totalMatches = 0;
    let score = 0;
    let semanticSimilarity: number | undefined;
    let matchedTerms: string[] = [];
    let bestChunkText: string | null = null;

    if (mode === 'natural' && queryVector) {
      // Real 384-dimensional chunk cosine similarity (ported from FileLensMobile SearchEngine.kt)
      const chunks = chunkDocumentPages(doc.pages);
      let bestSim = cosineSimilarity(
        queryVector,
        generateEmbedding(`${doc.title} ${doc.sourcePath ?? ''} ${doc.fileExtension ?? ''} ${doc.tags.join(' ')}`)
      );

      for (const chunk of chunks) {
        const chunkSim = cosineSimilarity(queryVector, generateEmbedding(chunk.text));
        if (chunkSim > bestSim) {
          bestSim = chunkSim;
          bestPageIdx = chunk.pageIndex;
          bestChunkText = chunk.text;
        }
      }

      // Also check keyword overlap for snippet highlighting
      const rawTerms = query
        .toLowerCase()
        .split(/\s+/)
        .filter((t) => t.length >= 2 && !['the', 'for', 'and', 'with', 'show', 'find', 'my', 'me', 'all'].includes(t));
      const expanded = new Set<string>(rawTerms);
      for (const t of rawTerms) {
        CONCEPT_EXPANSIONS[t]?.forEach((s) => expanded.add(s));
      }

      const lower = fullText.toLowerCase();
      for (const term of expanded) {
        if (lower.includes(term)) {
          matchedTerms.push(term);
          const m = fullText.match(new RegExp(escapeRegExp(term), 'gi'));
          totalMatches += m ? m.length : 1;
        }
      }

      if (bestSim >= 0.14 || totalMatches > 0) {
        semanticSimilarity = Math.min(0.99, Math.max(0.15, bestSim));
        score = bestSim * 120 + totalMatches * 8;
        if (totalMatches === 0) totalMatches = 1;
      }
    } else if (mode === 'exact') {
      const rx = new RegExp(escapeRegExp(query), 'gi');
      const matches = fullText.match(rx);
      if (matches && matches.length > 0) {
        totalMatches = matches.length;
        score = 100 + matches.length * 10;
        matchedTerms = [query];
      }
    } else if (mode === 'whole') {
      const rx = new RegExp(`\\b${escapeRegExp(query)}\\b`, 'gi');
      const matches = fullText.match(rx);
      if (matches && matches.length > 0) {
        totalMatches = matches.length;
        score = 95 + matches.length * 10;
        matchedTerms = [query];
      }
    } else if (mode === 'wildcard') {
      const pattern = escapeRegExp(query).replace(/\\\*/g, '[\\w-]*').replace(/\\\?/g, '.');
      const rx = new RegExp(pattern, 'gi');
      const matches = fullText.match(rx);
      if (matches && matches.length > 0) {
        totalMatches = matches.length;
        score = 90 + matches.length * 8;
        matchedTerms = Array.from(new Set(matches.slice(0, 6)));
      }
    } else if (mode === 'boolean') {
      const tokens = query.split(/\s+/);
      const lower = fullText.toLowerCase();
      let ok = true;
      const positives: string[] = [];
      let i = 0;
      while (i < tokens.length) {
        const tok = tokens[i];
        if (tok === 'AND') {
          i++;
          continue;
        }
        if (tok === 'NOT' && i + 1 < tokens.length) {
          const neg = tokens[i + 1].toLowerCase();
          if (lower.includes(neg)) ok = false;
          i += 2;
          continue;
        }
        if (tok === 'OR' && i + 1 < tokens.length && i > 0) {
          const prev = tokens[i - 1].toLowerCase();
          const next = tokens[i + 1].toLowerCase();
          const prevHit = lower.includes(prev);
          const nextHit = lower.includes(next);
          if (!prevHit && !nextHit) ok = false;
          if (prevHit) positives.push(prev);
          if (nextHit) positives.push(next);
          i += 2;
          continue;
        }
        if (tokens[i + 1] === 'OR') {
          i++;
          continue;
        }
        const term = tok.toLowerCase();
        if (!lower.includes(term)) ok = false;
        else positives.push(term);
        i++;
      }
      if (ok && positives.length > 0) {
        matchedTerms = Array.from(new Set(positives));
        totalMatches = matchedTerms.reduce((acc, t) => {
          const m = fullText.match(new RegExp(escapeRegExp(t), 'gi'));
          return acc + (m ? m.length : 0);
        }, 0);
        score = 88 + totalMatches * 10;
      }
    } else {
      // Quick Search (partial + concept expansion)
      const rawTerms = query
        .toLowerCase()
        .split(/\s+/)
        .filter((t) => t.length >= 2 && !['the', 'for', 'and', 'with', 'show', 'find', 'my', 'me'].includes(t));

      const expanded = new Set<string>(rawTerms);
      for (const term of rawTerms) {
        const syns = CONCEPT_EXPANSIONS[term];
        if (syns) syns.forEach((s) => expanded.add(s));
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
    }

    if (totalMatches > 0) {
      if (mode !== 'natural') {
        let bestPageScore = -1;
        doc.pages.forEach((pg, idx) => {
          const pLower = pg.ocrText.toLowerCase();
          const hits = matchedTerms.reduce((acc, t) => acc + (pLower.includes(t.toLowerCase()) ? 1 : 0), 0);
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
      const snippet = (start > 0 ? '…' : '') + pageOcr.slice(start, end).trim() + (end < pageOcr.length ? '…' : '');

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

  return results.sort((a, b) => b.score - a.score);
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
        `${idx + 1}. ${r.doc.title} [Page ${r.pageIndex + 1} · ${r.matchCount} match(es)]\n   ${r.snippet}\n`
    ),
  ];
  return { content: lines.join('\n'), mime: 'text/plain', ext: 'txt' };
}
