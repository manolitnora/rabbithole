/**
 * Brave Search Client — Privacy-first web search.
 *
 * Uses Brave Search API: no tracking, no profiling, no ads in results.
 * Requires BRAVE_API_KEY environment variable.
 *
 * Ported from HybridEngineV3/packages/daemon/src/synthesis/braveSearchClient.ts
 * Stripped of framework dependencies — pure Node.js fetch.
 */

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

const BASE_URL = 'https://api.search.brave.com/res/v1/web/search';

/**
 * Search the web via Brave Search API.
 *
 * @param query Search query
 * @param count Number of results (default 5, max 20)
 * @param apiKey Brave API key (defaults to BRAVE_API_KEY env var)
 * @returns Array of search results, or empty array on failure
 */
export async function braveSearch(
  query: string,
  count = 5,
  apiKey?: string,
): Promise<SearchResult[]> {
  const key = apiKey ?? process.env.BRAVE_API_KEY;
  if (!key) {
    console.error('[rabbithole] BRAVE_API_KEY not set — search disabled');
    return [];
  }

  try {
    const params = new URLSearchParams({
      q: query,
      count: String(Math.min(count, 20)),
      text_decorations: 'false',
      search_lang: 'en',
      safesearch: 'moderate',
    });

    const response = await fetch(`${BASE_URL}?${params.toString()}`, {
      headers: {
        'Accept': 'application/json',
        'Accept-Encoding': 'gzip',
        'X-Subscription-Token': key,
      },
    });

    if (!response.ok) {
      console.error(`[rabbithole] Brave search failed: ${response.status}`);
      return [];
    }

    const data = await response.json() as {
      web?: { results?: Array<{ title?: string; url?: string; description?: string }> };
    };

    return (data.web?.results ?? []).map(r => ({
      title: r.title ?? '',
      url: r.url ?? '',
      description: r.description ?? '',
    }));
  } catch (err) {
    console.error('[rabbithole] Brave search error:', err instanceof Error ? err.message : String(err));
    return [];
  }
}
