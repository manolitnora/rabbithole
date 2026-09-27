/**
 * Brave Search Client — Privacy-first web search.
 *
 * Two modes:
 *   1. API mode: BRAVE_API_KEY returns structured JSON results (preferred)
 *   2. HTML mode: parses search.brave.com results when no key is set or the
 *      API fails, so a keyless environment can still run a dive
 */

import { execFileSync } from 'node:child_process';

// ═══════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════

export interface SearchResult {
  title: string;
  url: string;
  description: string;
}

/** Fetches search-page HTML for the fallback path; injectable for tests. */
export type HtmlFetcher = (url: string) => string;

// ═══════════════════════════════════════════════════════════════════
// CLIENT
// ═══════════════════════════════════════════════════════════════════

const API_URL = 'https://api.search.brave.com/res/v1/web/search';

function curlHtmlFetcher(url: string): string {
  return execFileSync('curl', [
    '-sL', '--max-time', '10',
    '-A', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    url,
  ], { timeout: 12_000, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 500_000 });
}

/**
 * Search the web via Brave Search.
 *
 * @param query Search query
 * @param count Number of results (default 5, max 20)
 * @param apiKey Brave API key (defaults to BRAVE_API_KEY env var)
 * @param htmlFetcher Fetches search HTML when the API is unavailable
 * @returns Array of search results, or empty array on failure
 */
export async function braveSearch(
  query: string,
  count = 5,
  apiKey?: string,
  htmlFetcher: HtmlFetcher = curlHtmlFetcher,
): Promise<SearchResult[]> {
  const key = apiKey ?? process.env.BRAVE_API_KEY;

  if (key) {
    const params = new URLSearchParams({
      q: query,
      count: String(Math.min(count, 20)),
      text_decorations: 'false',
      search_lang: 'en',
      safesearch: 'moderate',
    });

    // One retry on transient failures (429 rate-limit / 5xx / network),
    // mirroring tunnel.ts. Brave free tier allows ~1 req/s.
    for (let attempt = 0; attempt <= 1; attempt++) {
      try {
        if (attempt > 0) await new Promise(r => setTimeout(r, 1100));

        const response = await fetch(`${API_URL}?${params.toString()}`, {
          headers: {
            'Accept': 'application/json',
            'Accept-Encoding': 'gzip',
            'X-Subscription-Token': key,
          },
        });

        if (!response.ok) {
          console.error(`[rabbithole] Brave search failed: ${response.status}`);
          if (response.status === 429 || response.status >= 500) continue;
          break;
        }

        const data = await response.json() as {
          web?: { results?: Array<{ title?: string; url?: string; description?: string }> };
        };

        const results = (data.web?.results ?? []).map(r => ({
          title: r.title ?? '',
          url: r.url ?? '',
          description: r.description ?? '',
        }));
        if (results.length > 0) return results;
        break;
      } catch (err) {
        console.error('[rabbithole] Brave search error:', err instanceof Error ? err.message : String(err));
      }
    }
  }

  return braveSearchHTML(query, count, htmlFetcher);
}

/**
 * Brave Search via the search page markup — no API key required.
 */
export function braveSearchHTML(query: string, count: number, fetchHtml: HtmlFetcher = curlHtmlFetcher): SearchResult[] {
  try {
    const html = fetchHtml(`https://search.brave.com/search?q=${encodeURIComponent(query)}`);
    return parseBraveHTML(html, count);
  } catch {
    return [];
  }
}

/** Extract web results from search.brave.com markup. Exported for tests. */
export function parseBraveHTML(html: string, count: number): SearchResult[] {
  const results: SearchResult[] = [];
  const blockRegex = /data-pos="(\d+)"[^>]*data-type="web"[^>]*>([\s\S]*?)(?=data-pos="|$)/gi;
  let match;

  while ((match = blockRegex.exec(html)) !== null && results.length < count) {
    const block = match[2];

    const titleMatch = block.match(/search-snippet-title[^"]*"[^>]*title="([^"]*)"/i);
    if (!titleMatch) continue;
    const title = stripHtml(titleMatch[1]).trim();
    if (!title) continue;

    const urlMatch = block.match(/href="(https?:\/\/(?!(?:cdn|imgs|tiles|search)\.(?:search\.)?brave\.com)[^"]*)"/i);
    const url = urlMatch ? urlMatch[1] : '';

    const blockText = stripHtml(block);
    const titleIdx = blockText.indexOf(title);
    const afterTitle = titleIdx >= 0 ? blockText.slice(titleIdx + title.length) : blockText;
    let description = afterTitle.replace(/^\s*[-–—]\s*/, '').trim().slice(0, 300);
    const lastPeriod = description.lastIndexOf('. ');
    if (lastPeriod > 80) description = description.slice(0, lastPeriod + 1);

    results.push({ title, url, description });
  }

  return results;
}

function stripHtml(text: string): string {
  return text
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ').trim();
}