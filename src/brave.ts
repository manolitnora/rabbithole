/**
 * Brave Search Client — Privacy-first web search.
 *
 * Two modes:
 *   1. API mode: uses BRAVE_API_KEY for structured JSON results (preferred)
 *   2. HTML scrape mode: parses search.brave.com HTML (no key needed, fallback)
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

// ═══════════════════════════════════════════════════════════════════
// CLIENT
// ═══════════════════════════════════════════════════════════════════

const API_URL = 'https://api.search.brave.com/res/v1/web/search';

/**
 * Search the web via Brave Search.
 * Uses API if BRAVE_API_KEY is set, falls back to HTML scraping.
 */
export async function braveSearch(
  query: string,
  count = 5,
  apiKey?: string,
): Promise<SearchResult[]> {
  const key = apiKey ?? process.env.BRAVE_API_KEY;

  // Try API first
  if (key) {
    try {
      const params = new URLSearchParams({
        q: query,
        count: String(Math.min(count, 20)),
        text_decorations: 'false',
        search_lang: 'en',
        safesearch: 'moderate',
      });

      const response = await fetch(`${API_URL}?${params.toString()}`, {
        headers: {
          'Accept': 'application/json',
          'Accept-Encoding': 'gzip',
          'X-Subscription-Token': key,
        },
      });

      if (response.ok) {
        const data = await response.json() as {
          web?: { results?: Array<{ title?: string; url?: string; description?: string }> };
        };
        const results = (data.web?.results ?? []).map(r => ({
          title: r.title ?? '',
          url: r.url ?? '',
          description: r.description ?? '',
        }));
        if (results.length > 0) return results;
      }
    } catch { /* fall through to HTML scrape */ }
  }

  // Fallback: HTML scraping (no API key needed)
  return braveSearchHTML(query, count);
}

/**
 * Brave Search via HTML scraping — no API key required.
 */
function braveSearchHTML(query: string, count: number): SearchResult[] {
  try {
    const encoded = encodeURIComponent(query);
    const html = execFileSync('curl', [
      '-sL', '--max-time', '10',
      '-A', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      `https://search.brave.com/search?q=${encoded}`,
    ], { timeout: 12_000, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 500_000 });

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
  } catch {
    return [];
  }
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
