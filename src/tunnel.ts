/**
 * Tunnel — Privacy-preserving content extraction.
 *
 * Fetches web content with anti-bot jitter and concurrency limits.
 * No browser automation, no Supabase, no cloud — pure Node.js fetch
 * with human-like timing patterns.
 *
 * Ported from HybridEngineV3/src/lib/cognition/tunnel.ts
 * Stripped of Supabase edge functions and Capacitor native bridge.
 */

// ═══════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════

export interface TunnelResult {
  success: boolean;
  url: string;
  title: string;
  content: string;
  excerpt: string;
  timestamp: number;
}

export interface TunnelConfig {
  minJitter: number;        // ms — minimum delay between requests
  maxJitter: number;        // ms — maximum delay between requests
  maxConcurrent: number;    // max parallel requests
  timeout: number;          // ms — per-request timeout
  userAgent: string;
}

// ═══════════════════════════════════════════════════════════════════
// DEFAULTS
// ═══════════════════════════════════════════════════════════════════

const DEFAULT_CONFIG: TunnelConfig = {
  minJitter: 2000,
  maxJitter: 5000,
  maxConcurrent: 3,
  timeout: 30000,
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko)',
};

// ═══════════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════════

let config: TunnelConfig = { ...DEFAULT_CONFIG };
let activeRequests = 0;

// ═══════════════════════════════════════════════════════════════════
// JITTER — Anti-bot timing
// ═══════════════════════════════════════════════════════════════════

function jitter(): number {
  return Math.floor(Math.random() * (config.maxJitter - config.minJitter)) + config.minJitter;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ═══════════════════════════════════════════════════════════════════
// CORE
// ═══════════════════════════════════════════════════════════════════

/**
 * Tunnel into a URL and extract content.
 * Applies jitter delay and concurrency limiting.
 */
export async function tunnel(url: string): Promise<TunnelResult> {
  // Normalize URL
  let normalizedUrl = url.trim();
  if (!normalizedUrl.startsWith('http://') && !normalizedUrl.startsWith('https://')) {
    normalizedUrl = `https://${normalizedUrl}`;
  }

  // Wait for slot
  while (activeRequests >= config.maxConcurrent) {
    await sleep(500);
  }

  activeRequests++;

  try {
    // Anti-bot jitter
    await sleep(jitter());

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeout);

    const response = await fetch(normalizedUrl, {
      headers: {
        'User-Agent': config.userAgent,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      },
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      return {
        success: false,
        url: normalizedUrl,
        title: '',
        content: '',
        excerpt: '',
        timestamp: Date.now(),
      };
    }

    const html = await response.text();
    const { title, content } = extractContent(html);

    return {
      success: true,
      url: normalizedUrl,
      title,
      content,
      excerpt: content.substring(0, 200),
      timestamp: Date.now(),
    };
  } catch (err) {
    return {
      success: false,
      url: normalizedUrl,
      title: '',
      content: '',
      excerpt: '',
      timestamp: Date.now(),
    };
  } finally {
    activeRequests--;
  }
}

/**
 * Batch tunnel multiple URLs with concurrency control.
 */
export async function tunnelBatch(urls: string[]): Promise<TunnelResult[]> {
  return Promise.all(urls.map(url => tunnel(url)));
}

/**
 * Configure tunnel parameters.
 */
export function configureTunnel(newConfig: Partial<TunnelConfig>): void {
  config = { ...config, ...newConfig };
}

/**
 * Get tunnel stats.
 */
export function getTunnelStats(): { active: number; config: TunnelConfig } {
  return { active: activeRequests, config };
}

// ═══════════════════════════════════════════════════════════════════
// CONTENT EXTRACTION — Lightweight HTML → text
// ═══════════════════════════════════════════════════════════════════

function extractContent(html: string): { title: string; content: string } {
  // Extract title
  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  const title = titleMatch ? titleMatch[1].trim() : '';

  // Strip scripts, styles, and tags
  let text = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
    .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
    .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();

  // Cap at 10K chars
  if (text.length > 10000) {
    text = text.substring(0, 10000) + '...';
  }

  return { title, content: text };
}
